/**
 * EPIC AI — чтение Knowledge Base: статус, изменения за день, история, версии, diff.
 * Питает раздел «Настройки → Правила»  и админку.
 */
import { getDb, parseJson, toDate, formatDateTime, type Row } from '../db/index.js';
import { diffText, type DiffResult } from './diff.js';
import { getKbVersion } from '../ai/rag/retrieval.js';
import { isSyncRunning } from './sync.js';

/* ------------------------------------------------------------------ */
/*  Статус базы                                            */
/* ------------------------------------------------------------------ */

export interface KbStatus {
  /** ok | updates | error | running */
  state: 'ok' | 'updates' | 'error' | 'running';
  stateLabel: string;
  stateColor: string;
  lastSyncAt: string | null;
  lastSyncLabel: string;
  lastSyncStatus: string | null;
  lastError: string | null;
  nextSyncAt: string | null;
  intervalMinutes: number;
  documents: { total: number; active: number; archive: number; rules: number; laws: number };
  versions: number;
  chunks: number;
  today: { newCount: number; updatedCount: number; archivedCount: number };
  kbVersion: string;
}

export async function getKbStatus(): Promise<KbStatus> {
  const db = await getDb();
  const last = await db.get<Row>('SELECT * FROM sync_logs ORDER BY id DESC LIMIT 1');
  const interval = await getSetting('sync.interval_minutes', 30);

  const docs = await db.get<Row>(
    `SELECT COUNT(*) AS total,
            SUM(CASE WHEN status = 'active' THEN 1 ELSE 0 END) AS active,
            SUM(CASE WHEN status = 'archive' THEN 1 ELSE 0 END) AS archive,
            SUM(CASE WHEN doc_type = 'RULE' THEN 1 ELSE 0 END) AS rules,
            SUM(CASE WHEN doc_type = 'LAW' THEN 1 ELSE 0 END) AS laws
       FROM documents`,
  );
  const versions = Number((await db.get<Row>('SELECT COUNT(*) AS c FROM document_versions'))?.c ?? 0);
  const chunks = Number((await db.get<Row>('SELECT COUNT(*) AS c FROM document_chunks WHERE is_current = 1'))?.c ?? 0);

  const today = localDay(new Date());
  const todayStats = await db.get<Row>(
    `SELECT SUM(CASE WHEN change_kind = 'NEW' THEN 1 ELSE 0 END) AS n,
            SUM(CASE WHEN change_kind = 'UPDATED' THEN 1 ELSE 0 END) AS u,
            SUM(CASE WHEN change_kind = 'ARCHIVED' THEN 1 ELSE 0 END) AS a
       FROM document_changes WHERE day = ?`,
    [today],
  );

  const running = isSyncRunning() || String(last?.status ?? '') === 'running';
  const lastStatus = last ? String(last.status) : null;
  const state: KbStatus['state'] = running ? 'running'
    : lastStatus === 'error' ? 'error'
    : (Number(todayStats?.n ?? 0) + Number(todayStats?.u ?? 0) + Number(todayStats?.a ?? 0)) > 0 ? 'updates'
    : 'ok';

  const stateLabel = { ok: 'База актуальна', updates: 'Есть обновления', error: 'Ошибка', running: 'Обновление' }[state];
  const stateColor = { ok: '#ACE72E', updates: '#F87171', error: '#E74C3C', running: '#72CE1C' }[state];

  const lastSyncAt = last?.started_at ? String(last.started_at) : null;
  const nextSyncAt = lastSyncAt && interval > 0
    ? new Date(toDate(lastSyncAt)!.getTime() + interval * 60_000).toISOString()
    : null;

  return {
    state, stateLabel, stateColor,
    lastSyncAt,
    lastSyncLabel: lastSyncAt ? formatDateTime(lastSyncAt) : '—',
    lastSyncStatus: lastStatus,
    lastError: last?.error ? String(last.error) : null,
    nextSyncAt,
    intervalMinutes: interval,
    documents: {
      total: Number(docs?.total ?? 0),
      active: Number(docs?.active ?? 0),
      archive: Number(docs?.archive ?? 0),
      rules: Number(docs?.rules ?? 0),
      laws: Number(docs?.laws ?? 0),
    },
    versions,
    chunks,
    today: {
      newCount: Number(todayStats?.n ?? 0),
      updatedCount: Number(todayStats?.u ?? 0),
      archivedCount: Number(todayStats?.a ?? 0),
    },
    kbVersion: await getKbVersion(),
  };
}

/* ------------------------------------------------------------------ */
/*  Изменения за день                                  */
/* ------------------------------------------------------------------ */

export interface ChangeListItem {
  id: number;
  day: string;
  documentId: number;
  versionId: number;
  changeKind: 'NEW' | 'UPDATED' | 'ARCHIVED';
  title: string;
  docType: 'RULE' | 'LAW';
  url: string | null;
  changedWords: number;
  totalWords: number;
  createdAt: string;
}

export async function listDayChanges(day: string): Promise<{ day: string; items: ChangeListItem[]; counts: { new: number; updated: number; archived: number } }> {
  const db = await getDb();
  const rows = await db.all<Row>(
    `SELECT id, day, document_id, version_id, change_kind, title, doc_type, url, changed_words, total_words, created_at
       FROM document_changes WHERE day = ? ORDER BY change_kind = 'NEW' DESC, document_id`,
    [day],
  );
  const items: ChangeListItem[] = rows.map((r) => ({
    id: Number(r.id), day: String(r.day), documentId: Number(r.document_id), versionId: Number(r.version_id),
    changeKind: String(r.change_kind) as ChangeListItem['changeKind'],
    title: String(r.title), docType: String(r.doc_type) as 'RULE' | 'LAW',
    url: r.url == null ? null : String(r.url),
    changedWords: Number(r.changed_words ?? 0), totalWords: Number(r.total_words ?? 0),
    createdAt: String(r.created_at),
  }));
  return {
    day,
    items,
    counts: {
      new: items.filter((i) => i.changeKind === 'NEW').length,
      updated: items.filter((i) => i.changeKind === 'UPDATED').length,
      archived: items.filter((i) => i.changeKind === 'ARCHIVED').length,
    },
  };
}

/** История изменений по дням. */
export async function listChangeHistory(limit = 60): Promise<{ day: string; newCount: number; updatedCount: number; archivedCount: number; total: number }[]> {
  const db = await getDb();
  const rows = await db.all<Row>(
    `SELECT day,
            SUM(CASE WHEN change_kind = 'NEW' THEN 1 ELSE 0 END) AS n,
            SUM(CASE WHEN change_kind = 'UPDATED' THEN 1 ELSE 0 END) AS u,
            SUM(CASE WHEN change_kind = 'ARCHIVED' THEN 1 ELSE 0 END) AS a,
            COUNT(*) AS c
       FROM document_changes GROUP BY day ORDER BY day DESC LIMIT ?`,
    [limit],
  );
  return rows.map((r) => ({
    day: String(r.day),
    newCount: Number(r.n ?? 0),
    updatedCount: Number(r.u ?? 0),
    archivedCount: Number(r.a ?? 0),
    total: Number(r.c ?? 0),
  }));
}

/* ------------------------------------------------------------------ */
/*  Карточка изменения: Было / Стало + цветной diff     */
/* ------------------------------------------------------------------ */

export interface ChangeDetail {
  change: ChangeListItem;
  document: {
    id: number; title: string; docType: string; section: string | null; category: string | null;
    url: string; threadId: number; postId: number | null; status: string;
    sourceCreatedAt: string | null; sourceModifiedAt: string | null;
  };
  /** v(N-1) — «Было». Для NEW = null. */
  before: { versionId: number; version: number; text: string; createdAt: string } | null;
  /** vN — «Стало». */
  after: { versionId: number; version: number; text: string; createdAt: string };
  diff: DiffResult | null;
  isNew: boolean;
}

export async function getChangeDetail(changeId: number): Promise<ChangeDetail | null> {
  const db = await getDb();
  const c = await db.get<Row>('SELECT * FROM document_changes WHERE id = ?', [changeId]);
  if (!c) return null;

  const doc = await db.get<Row>('SELECT * FROM documents WHERE id = ?', [Number(c.document_id)]);
  if (!doc) return null;

  const after = await db.get<Row>('SELECT * FROM document_versions WHERE id = ?', [Number(c.version_id)]);
  if (!after) return null;

  const before = await db.get<Row>(
    'SELECT * FROM document_versions WHERE document_id = ? AND version = ? LIMIT 1',
    [Number(c.document_id), Number(after.version) - 1],
  );

  const beforeText = before ? String(before.content_text) : '';
  const afterText = String(after.content_text);
  const isNew = String(c.change_kind) === 'NEW' || !before;

  return {
    change: {
      id: Number(c.id), day: String(c.day), documentId: Number(c.document_id), versionId: Number(c.version_id),
      changeKind: String(c.change_kind) as ChangeListItem['changeKind'], title: String(c.title),
      docType: String(c.doc_type) as 'RULE' | 'LAW', url: c.url == null ? null : String(c.url),
      changedWords: Number(c.changed_words ?? 0), totalWords: Number(c.total_words ?? 0),
      createdAt: String(c.created_at),
    },
    document: {
      id: Number(doc.id), title: String(doc.title), docType: String(doc.doc_type),
      section: doc.section == null ? null : String(doc.section),
      category: doc.category == null ? null : String(doc.category),
      url: String(doc.url ?? ''), threadId: Number(doc.thread_id),
      postId: doc.post_id == null ? null : Number(doc.post_id),
      status: String(doc.status),
      sourceCreatedAt: doc.source_created_at == null ? null : String(doc.source_created_at),
      sourceModifiedAt: doc.source_modified_at == null ? null : String(doc.source_modified_at),
    },
    before: before ? { versionId: Number(before.id), version: Number(before.version), text: beforeText, createdAt: String(before.created_at) } : null,
    after: { versionId: Number(after.id), version: Number(after.version), text: afterText, createdAt: String(after.created_at) },
    diff: isNew ? null : diffText(beforeText, afterText),
    isNew,
  };
}

/* ------------------------------------------------------------------ */
/*  Документы и версии                                           */
/* ------------------------------------------------------------------ */

export async function listDocuments(opts: {
  docType?: 'RULE' | 'LAW'; status?: string; search?: string; limit?: number; offset?: number;
} = {}): Promise<{ total: number; items: any[] }> {
  const db = await getDb();
  const where: string[] = [];
  const params: unknown[] = [];
  if (opts.docType) { where.push('d.doc_type = ?'); params.push(opts.docType); }
  if (opts.status) { where.push('d.status = ?'); params.push(opts.status); }
  if (opts.search) { where.push('(d.title LIKE ? OR d.section LIKE ? OR d.category LIKE ?)'); params.push(`%${opts.search}%`, `%${opts.search}%`, `%${opts.search}%`); }
  const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const limit = Math.min(Math.max(opts.limit ?? 50, 1), 500);
  const offset = Math.max(opts.offset ?? 0, 0);

  const total = Number((await db.get<Row>(`SELECT COUNT(*) AS c FROM documents d ${whereSql}`, params))?.c ?? 0);
  const rows = await db.all<Row>(
    `SELECT d.id, d.doc_type, d.title, d.section, d.category, d.url, d.thread_id, d.status,
            d.source_modified_at, d.updated_at, d.content_hash,
            (SELECT COUNT(*) FROM document_versions v WHERE v.document_id = d.id) AS versions,
            (SELECT v.version FROM document_versions v WHERE v.id = d.current_version_id) AS current_version
       FROM documents d ${whereSql}
      ORDER BY d.updated_at DESC LIMIT ? OFFSET ?`,
    [...params, limit, offset],
  );

  return {
    total,
    items: rows.map((r) => ({
      id: Number(r.id), docType: String(r.doc_type), title: String(r.title),
      section: r.section, category: r.category, url: String(r.url ?? ''), threadId: Number(r.thread_id),
      status: String(r.status), sourceModifiedAt: r.source_modified_at, updatedAt: r.updated_at,
      contentHash: r.content_hash, versions: Number(r.versions ?? 0), currentVersion: r.current_version == null ? null : Number(r.current_version),
    })),
  };
}

export async function getDocumentVersions(documentId: number): Promise<any[]> {
  const db = await getDb();
  const rows = await db.all<Row>(
    `SELECT id, version, title, word_count, content_hash, change_kind, source_modified_at, fetched_at, created_at
       FROM document_versions WHERE document_id = ? ORDER BY version DESC`,
    [documentId],
  );
  return rows.map((r) => ({
    versionId: Number(r.id), version: Number(r.version), title: String(r.title),
    wordCount: Number(r.word_count ?? 0), contentHash: String(r.content_hash),
    changeKind: String(r.change_kind), sourceModifiedAt: r.source_modified_at,
    fetchedAt: r.fetched_at, createdAt: r.created_at,
  }));
}

/** Сравнение двух конкретных версий. */
export async function diffVersions(documentId: number, fromVersion: number, toVersion: number): Promise<{ from: string; to: string; diff: DiffResult } | null> {
  const db = await getDb();
  const a = await db.get<Row>('SELECT content_text FROM document_versions WHERE document_id = ? AND version = ?', [documentId, fromVersion]);
  const b = await db.get<Row>('SELECT content_text FROM document_versions WHERE document_id = ? AND version = ?', [documentId, toVersion]);
  if (!a || !b) return null;
  return { from: String(a.content_text), to: String(b.content_text), diff: diffText(String(a.content_text), String(b.content_text)) };
}

export async function getDocumentFull(documentId: number): Promise<Row | null> {
  const db = await getDb();
  const doc = await db.get<Row>(
    `SELECT d.*, v.version, v.content_text, v.content_html, v.word_count, v.source_modified_at AS ver_modified
       FROM documents d LEFT JOIN document_versions v ON v.id = d.current_version_id
      WHERE d.id = ?`,
    [documentId],
  );
  return doc;
}

/* ------------------------------------------------------------------ */
/*  Журналы синхронизации                                               */
/* ------------------------------------------------------------------ */

export async function listSyncLogs(limit = 30): Promise<any[]> {
  const db = await getDb();
  const rows = await db.all<Row>('SELECT * FROM sync_logs ORDER BY id DESC LIMIT ?', [limit]);
  return rows.map((r) => ({
    id: Number(r.id), startedAt: r.started_at, finishedAt: r.finished_at,
    triggerType: String(r.trigger_type), status: String(r.status),
    docsNew: Number(r.docs_new ?? 0), docsUpdated: Number(r.docs_updated ?? 0),
    docsArchived: Number(r.docs_archived ?? 0), docsUnchanged: Number(r.docs_unchanged ?? 0),
    pagesFetched: Number(r.pages_fetched ?? 0), error: r.error,
    meta: parseJson(r.meta, null),
  }));
}

export async function getSetting(key: string, fallback: any = null): Promise<any> {
  const db = await getDb();
  const row = await db.get<Row>('SELECT value FROM app_settings WHERE key = ?', [key]);
  if (!row || row.value == null) return fallback;
  const s = String(row.value);
  if (/^-?\d+$/.test(s)) return Number(s);
  if (s === 'true') return true;
  if (s === 'false') return false;
  try { return JSON.parse(s); } catch { return s; }
}

export async function setSetting(key: string, value: unknown, actorId: number | null = null): Promise<void> {
  const db = await getDb();
  const v = typeof value === 'string' ? value : JSON.stringify(value);
  await db.run(
    `INSERT INTO app_settings (key, value, updated_by, updated_at) VALUES (?, ?, ?, ?)
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_by = EXCLUDED.updated_by, updated_at = EXCLUDED.updated_at`,
    [key, v, actorId, new Date().toISOString()],
  );
}

export function localDay(d: Date = new Date()): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

export { getKbVersion };
