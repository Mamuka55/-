/**
 * EPIC AI — Version Manager + синхронизация Knowledge Base.
 *
 *   Parser → Normalizer → Version Manager → Knowledge Base
 *
 * Ключевые правила:
 *  • старая версия документа НЕ удаляется ;
 *  • новый документ → NEW ;
 *  • изменилось содержимое → UPDATED + word-level diff ;
 *  • архивные документы помечаются status='archive' и не участвуют в обычном
 *    поиске ;
 *  • каждый прогон пишется в sync_logs, каждое изменение — в document_changes.
 */
import { getDb, insertReturningId, type DbClient, type Row } from '../db/index.js';
import { config } from '../config/index.js';
import { ForumCrawler, type DiscoveredNode, type DiscoveredThread } from '../crawler/index.js';
import { ingestDocument, deactivateChunks } from './ingest.js';
import { bumpKbVersion, getKbVersion } from '../ai/rag/retrieval.js';

export interface SyncStats {
  syncLogId: number;
  startedAt: string;
  finishedAt: string;
  triggerType: 'auto' | 'manual';
  docsNew: number;
  docsUpdated: number;
  docsArchived: number;
  docsUnchanged: number;
  pagesFetched: number;
  status: 'success' | 'error' | 'running';
  error?: string;
  warnings: string[];
  kbVersion: string;
}

export interface SyncOptions {
  triggerType?: 'auto' | 'manual';
  triggeredBy?: number | null;
  /** Полный обход (иначе — только уже известные разделы). */
  full?: boolean;
  /** Не обращаться к сети: только переиндексация того, что уже в кэше/БД. */
  offline?: boolean;
  /** Ограничить прогон конкретными разделами форума (node id). */
  nodeIds?: number[];
  onProgress?: (step: string, detail?: string) => void;
  /**
   * Сколько постов темы считать содержимым документа.
   * По умолчанию ВСЕ: законодательные документы EpicRP разбиты на главы
   * отдельными постами (Penal Code — 22 поста), поэтому первый пост
   * часто содержит только оглавление.
   */
  postsPerDocument?: number;
}

let running = false;

export function isSyncRunning(): boolean { return running; }

export async function runSync(opts: SyncOptions = {}): Promise<SyncStats> {
  if (running) {
    throw Object.assign(new Error('Синхронизация уже выполняется'), { statusCode: 409, code: 'sync_in_progress' });
  }
  running = true;
  const db = await getDb();
  const startedAt = new Date().toISOString();
  const triggerType = opts.triggerType ?? 'auto';

  const syncLogId = await insertReturningId(db, 'sync_logs', {
    started_at: startedAt,
    trigger_type: triggerType,
    triggered_by: opts.triggeredBy ?? null,
    status: 'running',
  });

  const stats: SyncStats = {
    syncLogId, startedAt, finishedAt: startedAt, triggerType,
    docsNew: 0, docsUpdated: 0, docsArchived: 0, docsUnchanged: 0,
    pagesFetched: 0, status: 'running', warnings: [], kbVersion: await getKbVersion(),
  };

  try {
    const crawler = new ForumCrawler({ offline: opts.offline });
    const pre = await crawler.preflight();
    if (!pre.allowed && !opts.offline) {
      throw Object.assign(new Error(pre.reason ?? 'Crawler отключён'), { statusCode: 403, code: 'crawler_disabled' });
    }

    opts.onProgress?.('discover', 'Структура форума');
    const nodes = opts.offline ? await loadStoredNodes(db) : await crawler.discoverNodes();
    await storeNodes(db, nodes);

    opts.onProgress?.('threads', 'Списки тем');
    const threads = opts.offline ? await loadStoredThreads(db) : await crawler.discoverThreads(nodes, {
      full: opts.full,
      nodeIds: opts.nodeIds,
      onProgress: opts.onProgress,
      onWarn: (m) => stats.warnings.push(m),
    });

    const day = new Date().toISOString().slice(0, 10);
    const seenThreadIds = new Set<number>();
    let i = 0;

    for (const t of threads) {
      i++;
      seenThreadIds.add(t.threadId);
      opts.onProgress?.('documents', `${i}/${threads.length}: ${t.title}`);
      try {
        const outcome = await ingestThread(db, crawler, t, {
          day,
          syncLogId,
          offline: Boolean(opts.offline),
          postsPerDocument: opts.postsPerDocument ?? Number.MAX_SAFE_INTEGER,
        });
        if (outcome === 'NEW') stats.docsNew++;
        else if (outcome === 'UPDATED') stats.docsUpdated++;
        else if (outcome === 'ARCHIVED') stats.docsArchived++;
        else stats.docsUnchanged++;
      } catch (e: any) {
        stats.warnings.push(`Тема ${t.threadId} (${t.title}): ${e.message}`);
      }
    }

    // Темы, которые пропали из выдачи → помечаем архивными.
    // При частичном прогоне (nodeIds) этого делать нельзя: иначе в архив
    // улетели бы все документы остальных разделов.
    if (!opts.nodeIds?.length && !opts.offline) {
      stats.docsArchived += await archiveMissing(db, seenThreadIds, day, syncLogId);
    }

    stats.pagesFetched = crawler.http.stats.pagesFetched;
    stats.kbVersion = await bumpKbVersion();
    stats.status = 'success';
  } catch (e: any) {
    stats.status = 'error';
    stats.error = String(e?.message ?? e);
    stats.warnings.push(stats.error);
  } finally {
    stats.finishedAt = new Date().toISOString();
    await db.run(
      `UPDATE sync_logs SET finished_at = ?, status = ?, docs_new = ?, docs_updated = ?, docs_archived = ?,
              docs_unchanged = ?, pages_fetched = ?, error = ?, meta = ? WHERE id = ?`,
      [
        stats.finishedAt, stats.status, stats.docsNew, stats.docsUpdated, stats.docsArchived,
        stats.docsUnchanged, stats.pagesFetched, stats.error ?? null,
        JSON.stringify({ warnings: stats.warnings.slice(0, 50), kbVersion: stats.kbVersion }),
        syncLogId,
      ],
    );
    running = false;
  }
  return stats;
}

/* ------------------------------------------------------------------ */
/*  Приём одной темы                                                    */
/* ------------------------------------------------------------------ */

type Outcome = 'NEW' | 'UPDATED' | 'UNCHANGED' | 'ARCHIVED';

async function ingestThread(
  db: DbClient,
  crawler: ForumCrawler,
  t: DiscoveredThread,
  ctx: { day: string; syncLogId: number; offline: boolean; postsPerDocument: number },
): Promise<Outcome> {
  const existing = await db.get<Row>('SELECT * FROM documents WHERE thread_id = ?', [t.threadId]);

  // Быстрая проверка без загрузки страницы: если тема не менялась с прошлого
  // прогона (по lastPostAt из списка тем) — документ трогать не нужно.
  if (existing && existing.source_modified_at && t.lastPostAt
      && String(existing.source_modified_at) === t.lastPostAt
      && (t.isArchive ? String(existing.status) === 'archive' : String(existing.status) === 'active')) {
    return 'UNCHANGED';
  }

  const parsed = ctx.offline ? null : await crawler.fetchThread(t.url, t.threadId, { maxPages: 4 });
  if (!parsed || !parsed.posts.length) return 'UNCHANGED';

  const posts = parsed.posts.slice(0, ctx.postsPerDocument);
  const text = posts.map((p) => p.text).join('\n\n').trim();
  const html = posts.map((p) => p.html).join('\n\n');
  if (!text) return 'UNCHANGED';

  // Вся работа с версиями, diff, chunks и поисковым индексом — в Version Manager.
  const res = await ingestDocument({
    docType: t.docType,
    title: parsed.title || t.title || `Тема ${t.threadId}`,
    text,
    html,
    url: parsed.url || t.url,
    threadId: t.threadId,
    postId: posts[0]?.postId ?? null,
    nodeId: t.nodeId,
    section: t.nodePath || t.nodeTitle,
    category: t.prefix ?? t.nodeTitle,
    authorName: parsed.authorName ?? t.authorName,
    sourceCreatedAt: parsed.createdAt ?? t.createdAt,
    sourceModifiedAt: parsed.lastPostAt ?? t.lastPostAt ?? parsed.createdAt ?? t.createdAt,
    status: t.isArchive ? 'archive' : 'active',
    day: ctx.day,
    syncLogId: ctx.syncLogId,
  });
  return res.outcome;
}

async function archiveMissing(db: DbClient, seen: Set<number>, _day: string, _syncLogId: number): Promise<number> {
  const rows = await db.all<Row>("SELECT id, thread_id FROM documents WHERE status = 'active'");
  let n = 0;
  for (const r of rows) {
    if (seen.has(Number(r.thread_id))) continue;
    await db.run("UPDATE documents SET status = 'archive', updated_at = ? WHERE id = ?", [new Date().toISOString(), Number(r.id)]);
    await deactivateChunks(db, Number(r.id));
    n++;
  }
  return n;
}

/* ------------------------------------------------------------------ */
/*  Хранение структуры форума (нужно для offline-режима)                 */
/* ------------------------------------------------------------------ */

async function storeNodes(db: DbClient, nodes: DiscoveredNode[]): Promise<void> {
  for (const n of nodes) {
    const existing = await db.get<Row>('SELECT id FROM kb_nodes WHERE node_id = ?', [n.nodeId]);
    if (existing) {
      await db.run(
        'UPDATE kb_nodes SET parent_node_id = ?, title = ?, url = ?, depth = ?, doc_type = ?, is_archive = ?, synced_at = ? WHERE node_id = ?',
        [n.parentNodeId, n.title, n.url, n.depth, n.docType, n.isArchive ? 1 : 0, new Date().toISOString(), n.nodeId],
      );
    } else {
      await insertReturningId(db, 'kb_nodes', {
        node_id: n.nodeId, parent_node_id: n.parentNodeId, title: n.title, url: n.url, depth: n.depth,
        doc_type: n.docType, is_archive: n.isArchive ? 1 : 0, crawl_enabled: 1,
        synced_at: new Date().toISOString(), created_at: new Date().toISOString(),
      });
    }
  }
}

async function loadStoredNodes(db: DbClient): Promise<DiscoveredNode[]> {
  const rows = await db.all<Row>('SELECT * FROM kb_nodes ORDER BY node_id');
  return rows.map((r) => ({
    nodeId: Number(r.node_id),
    parentNodeId: r.parent_node_id == null ? null : Number(r.parent_node_id),
    title: String(r.title),
    url: String(r.url ?? ''),
    depth: Number(r.depth ?? 1),
    kind: 'forum' as const,
    docType: (r.doc_type as 'RULE' | 'LAW' | null) ?? null,
    isArchive: Boolean(Number(r.is_archive)),
    path: String(r.title),
  }));
}

async function loadStoredThreads(db: DbClient): Promise<DiscoveredThread[]> {
  const rows = await db.all<Row>('SELECT * FROM documents ORDER BY id');
  return rows.map((r) => ({
    threadId: Number(r.thread_id),
    title: String(r.title),
    url: String(r.url ?? ''),
    authorName: r.author_name == null ? null : String(r.author_name),
    prefix: r.category == null ? null : String(r.category),
    createdAt: r.source_created_at == null ? null : String(r.source_created_at),
    lastPostAt: r.source_modified_at == null ? null : String(r.source_modified_at),
    replies: null, views: null, isSticky: false, isLocked: false,
    nodeId: Number(r.node_id ?? 0),
    nodeTitle: String(r.section ?? ''),
    docType: (String(r.doc_type) === 'LAW' ? 'LAW' : 'RULE') as 'RULE' | 'LAW',
    isArchive: String(r.status) === 'archive',
    nodePath: String(r.section ?? ''),
  }));
}

export { getKbVersion };
