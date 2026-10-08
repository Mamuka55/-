/**
 * EPIC AI — Version Manager: приём содержимого документа в Knowledge Base.
 *
 * Одинаковый путь для двух источников:
 *   1) crawler форума (автоматическая синхронизация, );
 *   2) ручной импорт/правка администратором.
 *
 * Логика версионирования :
 *   нет документа          → NEW, version 1
 *   хэш совпал             → UNCHANGED
 *   хэш изменился          → UPDATED, version N+1 + word-level diff
 *   документ пропал/архив  → ARCHIVED
 */
import { getDb, insertReturningId, type DbClient, type Row } from '../db/index.js';
import { config } from '../config/index.js';
import { chunkText, contentHash, normalizeForHash } from './text.js';
import { diffText } from './diff.js';
import { indexChunk, removeChunkFromIndex } from './search.js';
import { localDay } from './service.js';

export interface IngestInput {
  docType: 'RULE' | 'LAW';
  title: string;
  text: string;
  html?: string | null;
  url: string;
  threadId: number;
  postId?: number | null;
  nodeId?: number | null;
  section?: string | null;
  category?: string | null;
  authorName?: string | null;
  sourceCreatedAt?: string | null;
  sourceModifiedAt?: string | null;
  status?: 'active' | 'archive';
  day?: string;
  syncLogId?: number | null;
}

export type IngestOutcome = 'NEW' | 'UPDATED' | 'UNCHANGED' | 'ARCHIVED';

export interface IngestResult {
  outcome: IngestOutcome;
  documentId: number;
  versionId: number;
  version: number;
  changeId: number | null;
  changedWords?: number;
  totalWords?: number;
  chunks: number;
  contentHash: string;
}

export async function ingestDocument(input: IngestInput): Promise<IngestResult> {
  const db = await getDb();
  const day = input.day ?? localDay();

  const normalized = normalizeForHash(input.text);
  if (!normalized) throw Object.assign(new Error('Пустое содержимое документа'), { statusCode: 400 });

  const hash = contentHash(normalized);
  const title = String(input.title).slice(0, 500);
  const status = input.status ?? 'active';
  const sourceModified = input.sourceModifiedAt ?? new Date().toISOString();
  const sourceCreated = input.sourceCreatedAt ?? sourceModified;

  const existing = await db.get<Row>('SELECT * FROM documents WHERE thread_id = ?', [input.threadId]);

  /* ---------- НОВЫЙ ДОКУМЕНТ ---------- */
  if (!existing) {
    const documentId = await insertReturningId(db, 'documents', {
      doc_type: input.docType,
      category: input.category ?? null,
      node_id: input.nodeId ?? null,
      title,
      section: input.section ?? null,
      url: input.url,
      thread_id: input.threadId,
      post_id: input.postId ?? null,
      author_name: input.authorName ?? null,
      content_hash: hash,
      source_created_at: sourceCreated,
      source_modified_at: sourceModified,
      status,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    });
    const versionId = await insertReturningId(db, 'document_versions', {
      document_id: documentId, version: 1, title,
      content_text: normalized, content_html: input.html ?? null,
      content_hash: hash, word_count: countWords(normalized), change_kind: 'NEW',
      diff_from_prev: null,
      source_created_at: sourceCreated, source_modified_at: sourceModified,
      fetched_at: new Date().toISOString(), created_at: new Date().toISOString(),
    });
    await db.run('UPDATE documents SET current_version_id = ? WHERE id = ?', [versionId, documentId]);
    const chunks = await rebuildChunks(db, documentId, versionId, normalized, input.docType);
    const changeId = await recordChange(db, {
      day, documentId, versionId, changeKind: 'NEW', title, docType: input.docType,
      nodeId: input.nodeId ?? null, url: input.url,
      changedWords: countWords(normalized), totalWords: countWords(normalized), diff: null,
      syncLogId: input.syncLogId ?? null,
    });
    void import('../telegram/notify.js').then((m) => m.notifyKbUpdate({
      title, category: input.category ?? null, outcome: 'NEW',
      added: countWords(normalized), removed: 0, url: input.url,
    }));
    return { outcome: 'NEW', documentId, versionId, version: 1, changeId, changedWords: countWords(normalized), totalWords: countWords(normalized), chunks, contentHash: hash };
  }

  const documentId = Number(existing.id);

  /* ---------- БЕЗ ИЗМЕНЕНИЙ ---------- */
  if (String(existing.content_hash) === hash) {
    const statusChanged = status === 'archive' && String(existing.status) !== 'archive';
    await db.run(
      'UPDATE documents SET title = ?, category = COALESCE(?, category), section = COALESCE(?, section), url = ?, status = ?, source_modified_at = ?, updated_at = ? WHERE id = ?',
      [title, input.category ?? null, input.section ?? null, input.url, status, sourceModified, new Date().toISOString(), documentId],
    );
    if (statusChanged) await deactivateChunks(db, documentId);
    return {
      outcome: statusChanged ? 'ARCHIVED' : 'UNCHANGED',
      documentId,
      versionId: Number(existing.current_version_id),
      version: Number((await db.get<Row>('SELECT version FROM document_versions WHERE id = ?', [Number(existing.current_version_id)]))?.version ?? 1),
      changeId: null, chunks: 0, contentHash: hash,
    };
  }

  /* ---------- ИЗМЕНЁННЫЙ ДОКУМЕНТ ---------- */
  const prev = await db.get<Row>('SELECT * FROM document_versions WHERE id = ?', [Number(existing.current_version_id)]);
  const prevText = prev ? String(prev.content_text) : '';
  const d = diffText(prevText, normalized);
  const nextVersion = Number(prev?.version ?? 0) + 1;

  const versionId = await insertReturningId(db, 'document_versions', {
    document_id: documentId, version: nextVersion, title,
    content_text: normalized, content_html: input.html ?? null,
    content_hash: hash, word_count: countWords(normalized), change_kind: 'UPDATED',
    diff_from_prev: JSON.stringify({ ops: d.ops, removedText: d.removedText, addedText: d.addedText, changedRatio: d.changedRatio }),
    source_created_at: existing.source_created_at ?? sourceCreated,
    source_modified_at: sourceModified,
    fetched_at: new Date().toISOString(), created_at: new Date().toISOString(),
  });

  await db.run(
    `UPDATE documents SET title = ?, content_hash = ?, current_version_id = ?, status = ?, url = ?,
            node_id = COALESCE(?, node_id), section = COALESCE(?, section), category = COALESCE(?, category),
            source_modified_at = ?, updated_at = ? WHERE id = ?`,
    [title, hash, versionId, status, input.url, input.nodeId ?? null, input.section ?? null, input.category ?? null,
     sourceModified, new Date().toISOString(), documentId],
  );

  const chunks = await rebuildChunks(db, documentId, versionId, normalized, input.docType);
  const changeId = await recordChange(db, {
    day, documentId, versionId, changeKind: 'UPDATED', title, docType: input.docType,
    nodeId: input.nodeId ?? Number(existing.node_id ?? 0), url: input.url,
    changedWords: d.changedWords, totalWords: d.totalWords,
    diff: { ops: d.ops, removedText: d.removedText, addedText: d.addedText },
    syncLogId: input.syncLogId ?? null,
  });

  if (status === 'archive' && String(existing.status) !== 'archive') {
    return { outcome: 'ARCHIVED', documentId, versionId, version: nextVersion, changeId, changedWords: d.changedWords, totalWords: d.totalWords, chunks, contentHash: hash };
  }
  void import('../telegram/notify.js').then((m) => m.notifyKbUpdate({
    title, category: input.category ?? null, outcome: 'UPDATED',
    added: d.addedText ? countWords(d.addedText) : 0,
    removed: d.removedText ? countWords(d.removedText) : 0,
    url: input.url,
  }));
  return { outcome: 'UPDATED', documentId, versionId, version: nextVersion, changeId, changedWords: d.changedWords, totalWords: d.totalWords, chunks, contentHash: hash };
}

/* ------------------------------------------------------------------ */

export async function rebuildChunks(db: DbClient, documentId: number, versionId: number, text: string, docType: string): Promise<number> {
  const old = await db.all<Row>('SELECT id FROM document_chunks WHERE document_id = ? AND is_current = 1', [documentId]);
  for (const o of old) await removeChunkFromIndex(Number(o.id), docType);
  await db.run('UPDATE document_chunks SET is_current = 0 WHERE document_id = ?', [documentId]);

  const chunks = chunkText(text, { maxChars: config.rag.chunkChars, overlap: config.rag.chunkOverlap });
  for (const c of chunks) {
    const chunkId = await insertReturningId(db, 'document_chunks', {
      document_id: documentId, version_id: versionId, seq: c.seq, heading: c.heading,
      content: c.content, token_estimate: c.tokenEstimate,
      char_start: c.charStart, char_end: c.charEnd, embedding: null, is_current: 1,
      created_at: new Date().toISOString(),
    });
    await indexChunk({ chunkId, docType: docType as 'RULE' | 'LAW', heading: c.heading, content: c.content });
  }
  return chunks.length;
}

export async function deactivateChunks(db: DbClient, documentId: number): Promise<void> {
  const rows = await db.all<Row>('SELECT id FROM document_chunks WHERE document_id = ? AND is_current = 1', [documentId]);
  const doc = await db.get<Row>('SELECT doc_type FROM documents WHERE id = ?', [documentId]);
  for (const r of rows) await removeChunkFromIndex(Number(r.id), String(doc?.doc_type ?? 'RULE'));
  await db.run('UPDATE document_chunks SET is_current = 0 WHERE document_id = ?', [documentId]);
}

async function recordChange(db: DbClient, c: {
  day: string; documentId: number; versionId: number; changeKind: string; title: string;
  docType: string; nodeId: number | null; url: string; changedWords: number; totalWords: number;
  diff: unknown; syncLogId: number | null;
}): Promise<number> {
  const id = await insertReturningId(db, 'document_changes', {
    day: c.day, document_id: c.documentId, version_id: c.versionId, change_kind: c.changeKind,
    title: c.title.slice(0, 500), doc_type: c.docType, node_id: c.nodeId, url: c.url,
    changed_words: c.changedWords, total_words: c.totalWords,
    diff_json: c.diff ? JSON.stringify(c.diff) : null,
    sync_log_id: c.syncLogId, created_at: new Date().toISOString(),
  });
  return id;
}

function countWords(t: string): number {
  return (String(t ?? '').match(/[A-Za-zА-Яа-яЁё0-9]+/g) ?? []).length;
}
