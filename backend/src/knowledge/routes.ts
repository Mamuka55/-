/**
 * EPIC AI — маршруты Knowledge Base.
 */
import type { FastifyInstance } from 'fastify';
import { getDb, type Row } from '../db/index.js';
import { requirePermission, BadRequestError, NotFoundError } from '../http/guards.js';
import {
  getKbStatus, listDayChanges, listChangeHistory, getChangeDetail,
  listDocuments, getDocumentVersions, diffVersions, getDocumentFull, listSyncLogs,
  localDay, setSetting, getSetting,
} from './service.js';
import { runSync, isSyncRunning } from './sync.js';
import { ingestDocument } from './ingest.js';
import { bumpKbVersion } from '../ai/rag/retrieval.js';
import { audit, AUDIT_ACTIONS } from '../audit/index.js';
import { config } from '../config/index.js';
import { formatDateTime } from '../db/index.js';

export async function registerKnowledgeRoutes(app: FastifyInstance): Promise<void> {
  /**
   * GET /api/kb/status — блок «ПРАВИЛА / ● База актуальна / Обновлено: …».
   * Доступен любому авторизованному: он же показывается в настройках клиента.
   */
  app.get('/api/kb/status', { preHandler: [requirePermission('settings.view')] }, async (_req, reply) => {
    const status = await getKbStatus();
    return reply.send({
     ...status,
      crawlerEnabled: config.crawler.enabled,
      lastSyncLabelShort: status.lastSyncAt ? formatDateTime(status.lastSyncAt) : '—',
    });
  });

  /** POST /api/kb/sync — «ОБНОВИТЬ БАЗУ». */
  app.post('/api/kb/sync', { preHandler: [requirePermission('knowledge.sync')] }, async (req, reply) => {
    if (isSyncRunning()) return reply.code(409).send({ error: 'sync_in_progress', message: 'Синхронизация уже выполняется' });
    if (!config.crawler.enabled) {
      return reply.code(403).send({
        error: 'crawler_disabled',
        message: 'Crawler отключён (CRAWLER_ENABLED=false). Включите его в backend/.env после согласования с администрацией форума — см. docs/LEGAL.md.',
      });
    }
    const body = (req.body ?? {}) as { full?: boolean };
    // Запускаем фоново, чтобы клиент не висел на таймауте
    void runSync({ triggerType: 'manual', triggeredBy: req.auth!.user.id, full: Boolean(body.full) })
     .then((s) => {
        void audit({
          actorId: req.auth!.user.id, actorName: req.auth!.user.username,
          action: AUDIT_ACTIONS.SYNC_MANUAL, entityType: 'sync_log', entityId: s.syncLogId,
          meta: { new: s.docsNew, updated: s.docsUpdated, archived: s.docsArchived, status: s.status }, ip: req.ip,
        });
      })
     .catch((e) => req.log.error(e));

    return reply.code(202).send({ ok: true, message: 'Синхронизация запущена' });
  });

  /** GET /api/kb/sync/logs — журнал синхронизаций. */
  app.get('/api/kb/sync/logs', { preHandler: [requirePermission('knowledge.view')] }, async (req, reply) => {
    const q = (req.query ?? {}) as { limit?: string };
    return reply.send({ items: await listSyncLogs(Math.min(Number(q.limit ?? 30) || 30, 200)), running: isSyncRunning() });
  });

  /** GET /api/kb/changes/today — «Обновления сегодня». */
  app.get('/api/kb/changes/today', { preHandler: [requirePermission('knowledge.view')] }, async (_req, reply) => {
    return reply.send(await listDayChanges(localDay()));
  });

  /** GET /api/kb/changes?day=YYYY-MM-DD — изменения за конкретный день. */
  app.get('/api/kb/changes', { preHandler: [requirePermission('knowledge.view')] }, async (req, reply) => {
    const q = (req.query ?? {}) as { day?: string };
    const day = q.day && /^\d{4}-\d{2}-\d{2}$/.test(q.day) ? q.day : localDay();
    return reply.send(await listDayChanges(day));
  });

  /** GET /api/kb/changes/history — список дней для «История изменений». */
  app.get('/api/kb/changes/history', { preHandler: [requirePermission('knowledge.view')] }, async (req, reply) => {
    const q = (req.query ?? {}) as { limit?: string };
    const items = await listChangeHistory(Math.min(Number(q.limit ?? 60) || 60, 365));
    return reply.send({
      items: items.map((i) => ({
        day: i.day,
        dayLabel: formatDateTime(`${i.day}T12:00:00Z`, false),
        newCount: i.newCount, updatedCount: i.updatedCount, archivedCount: i.archivedCount, total: i.total,
        summary: `${i.newCount} новых · ${i.updatedCount} изменений`,
      })),
    });
  });

  /**
   * GET /api/kb/changes/:id — карточка изменения: «Было / Стало» + цветной diff.
   */
  app.get('/api/kb/changes/:id', { preHandler: [requirePermission('knowledge.history')] }, async (req, reply) => {
    const p = req.params as { id: string };
    const detail = await getChangeDetail(Number(p.id));
    if (!detail) throw new NotFoundError('Изменение не найдено');
    return reply.send({
     ...detail,
      diff: detail.diff ? {
        ops: detail.diff.ops,
        removedText: detail.diff.removedText,
        addedText: detail.diff.addedText,
        changedWords: detail.diff.changedWords,
        totalWords: detail.diff.totalWords,
        changedRatio: detail.diff.changedRatio,
      } : null,
    });
  });

  /** GET /api/kb/documents — «Knowledge Base → Документы». */
  app.get('/api/kb/documents', { preHandler: [requirePermission('knowledge.view')] }, async (req, reply) => {
    const q = (req.query ?? {}) as Record<string, string>;
    return reply.send(await listDocuments({
      docType: q.type === 'LAW' || q.type === 'RULE' ? (q.type as 'RULE' | 'LAW') : undefined,
      status: q.status || undefined,
      search: q.search || undefined,
      limit: Number(q.limit ?? 50),
      offset: Number(q.offset ?? 0),
    }));
  });

  /** GET /api/kb/documents/:id */
  app.get('/api/kb/documents/:id', { preHandler: [requirePermission('knowledge.view')] }, async (req, reply) => {
    const p = req.params as { id: string };
    const doc = await getDocumentFull(Number(p.id));
    if (!doc) throw new NotFoundError('Документ не найден');
    return reply.send({
      id: Number(doc.id),
      docType: String(doc.doc_type),
      title: String(doc.title),
      section: doc.section, category: doc.category,
      url: String(doc.url ?? ''), threadId: Number(doc.thread_id), postId: doc.post_id,
      status: String(doc.status),
      version: doc.version == null ? null : Number(doc.version),
      content: doc.content_text ?? null,
      wordCount: doc.word_count ?? null,
      sourceCreatedAt: doc.source_created_at,
      sourceModifiedAt: doc.source_modified_at ?? doc.ver_modified,
      updatedAt: doc.updated_at,
      versions: await getDocumentVersions(Number(doc.id)),
    });
  });

  /** GET /api/kb/documents/:id/versions — «Версии». */
  app.get('/api/kb/documents/:id/versions', { preHandler: [requirePermission('knowledge.history')] }, async (req, reply) => {
    const p = req.params as { id: string };
    return reply.send({ items: await getDocumentVersions(Number(p.id)) });
  });

  /** GET /api/kb/documents/:id/diff?from=1&to=2 — сравнение версий. */
  app.get('/api/kb/documents/:id/diff', { preHandler: [requirePermission('knowledge.history')] }, async (req, reply) => {
    const p = req.params as { id: string };
    const q = (req.query ?? {}) as { from?: string; to?: string };
    const from = Number(q.from ?? 0);
    const to = Number(q.to ?? 0);
    if (!from || !to) throw new BadRequestError('Укажите from и to');
    const res = await diffVersions(Number(p.id), from, to);
    if (!res) throw new NotFoundError('Версии не найдены');
    return reply.send({ documentId: Number(p.id), from, to, diff: res.diff });
  });

  /** GET /api/kb/nodes — разделы форума, которые попали в базу. */
  app.get('/api/kb/nodes', { preHandler: [requirePermission('knowledge.view')] }, async (_req, reply) => {
    const db = await getDb();
    const rows = await db.all<Row>('SELECT * FROM kb_nodes ORDER BY depth, node_id');
    return reply.send({
      items: rows.map((r) => ({
        nodeId: Number(r.node_id), parentNodeId: r.parent_node_id == null ? null : Number(r.parent_node_id),
        title: String(r.title), url: r.url, depth: Number(r.depth),
        docType: r.doc_type, isArchive: Boolean(Number(r.is_archive)),
        crawlEnabled: Boolean(Number(r.crawl_enabled)), syncedAt: r.synced_at,
      })),
    });
  });

  /** PATCH /api/kb/nodes/:nodeId — включить/выключить обход раздела (knowledge.manage). */
  app.patch('/api/kb/nodes/:nodeId', { preHandler: [requirePermission('knowledge.manage')] }, async (req, reply) => {
    const p = req.params as { nodeId: string };
    const body = (req.body ?? {}) as { crawlEnabled?: boolean; docType?: 'RULE' | 'LAW' | null; isArchive?: boolean };
    const db = await getDb();
    const sets: string[] = [];
    const params: unknown[] = [];
    if (body.crawlEnabled !== undefined) { sets.push('crawl_enabled = ?'); params.push(body.crawlEnabled ? 1 : 0); }
    if (body.docType !== undefined) { sets.push('doc_type = ?'); params.push(body.docType); }
    if (body.isArchive !== undefined) { sets.push('is_archive = ?'); params.push(body.isArchive ? 1 : 0); }
    if (!sets.length) throw new BadRequestError('Нечего обновлять');
    const res = await db.run(`UPDATE kb_nodes SET ${sets.join(', ')} WHERE node_id = ?`, [...params, Number(p.nodeId)]);
    if (!res.changes) throw new NotFoundError('Раздел не найден');
    await audit({ actorId: req.auth!.user.id, actorName: req.auth!.user.username, action: AUDIT_ACTIONS.KB_CHANGE, entityType: 'kb_node', entityId: p.nodeId, meta: body, ip: req.ip });
    return reply.send({ ok: true });
  });

  /**
   * POST /api/kb/ingest — ручной приём документа в базу знаний.
   * Тот же Version Manager, что и у crawler'а: создаёт версию, считает diff,
   * переиндексирует chunks. Используется для ручного импорта и для тестов.
   */
  app.post('/api/kb/ingest', { preHandler: [requirePermission('knowledge.manage')] }, async (req, reply) => {
    const b = (req.body ?? {}) as Record<string, any>;
    if (!b.title || !b.text || !b.url || !b.threadId) {
      throw new BadRequestError('Обязательные поля: title, text, url, threadId');
    }
    if (!['RULE', 'LAW'].includes(String(b.docType))) throw new BadRequestError('docType: RULE | LAW');
    const res = await ingestDocument({
      docType: String(b.docType) as 'RULE' | 'LAW',
      title: String(b.title),
      text: String(b.text),
      html: b.html == null ? null : String(b.html),
      url: String(b.url),
      threadId: Number(b.threadId),
      postId: b.postId == null ? null : Number(b.postId),
      nodeId: b.nodeId == null ? null : Number(b.nodeId),
      section: b.section == null ? null : String(b.section),
      category: b.category == null ? null : String(b.category),
      authorName: b.authorName == null ? null : String(b.authorName),
      sourceCreatedAt: b.sourceCreatedAt ?? null,
      sourceModifiedAt: b.sourceModifiedAt ?? null,
      status: b.status === 'archive' ? 'archive' : 'active',
    });
    await bumpKbVersion();
    await audit({
      actorId: req.auth!.user.id, actorName: req.auth!.user.username,
      action: AUDIT_ACTIONS.KB_CHANGE, entityType: 'document', entityId: res.documentId,
      meta: { outcome: res.outcome, version: res.version, title: String(b.title).slice(0, 120), threadId: Number(b.threadId) },
      ip: req.ip,
    });
    return reply.send({ ok: true,...res });
  });

  /** PATCH /api/kb/settings — серверные настройки синхронизации (system.settings). */
  app.patch('/api/kb/settings', { preHandler: [requirePermission('system.settings')] }, async (req, reply) => {
    const body = (req.body ?? {}) as { syncIntervalMinutes?: number; syncAutomatic?: boolean };
    if (body.syncIntervalMinutes !== undefined) {
      const v = Number(body.syncIntervalMinutes);
      if (!Number.isFinite(v) || v < 5 || v > 1440) throw new BadRequestError('Интервал синхронизации: от 5 до 1440 минут');
      await setSetting('sync.interval_minutes', Math.round(v), req.auth!.user.id);
    }
    if (body.syncAutomatic !== undefined) await setSetting('sync.automatic', Boolean(body.syncAutomatic), req.auth!.user.id);
    await audit({ actorId: req.auth!.user.id, actorName: req.auth!.user.username, action: AUDIT_ACTIONS.SETTINGS_CHANGE, entityType: 'kb_settings', meta: body, ip: req.ip });
    return reply.send({
      syncIntervalMinutes: await getSetting('sync.interval_minutes', 30),
      syncAutomatic: await getSetting('sync.automatic', true),
    });
  });
}
