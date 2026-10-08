/**
 * EPIC AI — retrieval: поиск по Knowledge Base и сборка источников.
 *
 * Всё, что попадёт в окно источников и в цитаты AI, берётся ОТСЮДА:
 * название документа, категория, номер пункта, дата редакции, версия, URL.
 * AI не имеет права придумывать эти поля сам.
 */
import { getDb, parseJson, formatDateTime, type Row } from '../../db/index.js';
import { config } from '../../config/index.js';
import { searchChunks, searchDocuments, type SearchHit } from '../../knowledge/search.js';

export interface RetrievedSource {
  index: number;
  chunkId: number;
  documentId: number;
  versionId: number;
  version: number;
  docType: 'RULE' | 'LAW';
  title: string;
  category: string | null;
  section: string | null;
  heading: string | null;
  content: string;
  url: string;
  revisionLabel: string;
  sourceModifiedAt: string | null;
  score: number;
  matchedTerms: string[];
  threadId: number;
  postId: number | null;
}

export interface RetrievalResult {
  mode: 'rules' | 'laws';
  docType: 'RULE' | 'LAW';
  query: string;
  sources: RetrievedSource[];
  kbVersion: string;
  searchMs: number;
  /** Заголовки документов, которые релевантны, но чьи фрагменты не прошли в top-K. */
  relatedDocuments: { documentId: number; title: string }[];
}

/** Текущая версия базы знаний — попадает в AI Report. */
export async function getKbVersion(): Promise<string> {
  const db = await getDb();
  const row = await db.get<Row>("SELECT value FROM kb_state WHERE key = 'version'");
  if (row?.value) return String(row.value);
  const agg = await db.get<Row>(
    `SELECT COUNT(*) AS docs, MAX(updated_at) AS last FROM documents WHERE status = 'active'`,
  );
  const docs = Number(agg?.docs ?? 0);
  const last = agg?.last ? String(agg.last).slice(0, 10).replace(/-/g, '') : '00000000';
  const v = `${docs}-${last}`;
  await db.run(
    "INSERT INTO kb_state (key, value, updated_at) VALUES ('version', ?, ?) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = EXCLUDED.updated_at",
    [v, new Date().toISOString()],
  );
  return v;
}

export async function bumpKbVersion(): Promise<string> {
  const db = await getDb();
  await db.run("DELETE FROM kb_state WHERE key = 'version'");
  return getKbVersion();
}

export interface RetrieveOptions {
  query: string;
  mode: 'rules' | 'laws';
  topK?: number;
  /** Явный поиск по архиву. */
  includeArchive?: boolean;
}

export async function retrieve(opts: RetrieveOptions): Promise<RetrievalResult> {
  const started = Date.now();
  const docType: 'RULE' | 'LAW' = opts.mode === 'laws' ? 'LAW' : 'RULE';
  const topK = opts.topK ?? config.rag.topK;
  const db = await getDb();

  const hits: SearchHit[] = await searchChunks(opts.query, {
    docType,
    limit: topK,
    maxCandidates: config.rag.maxCandidates,
    excludeArchive: !opts.includeArchive,
  });

  const sources: RetrievedSource[] = [];
  const docCache = new Map<number, Row | null>();

  for (let i = 0; i < hits.length; i++) {
    const h = hits[i]!;
    if (!docCache.has(h.documentId)) {
      docCache.set(h.documentId, await db.get<Row>('SELECT * FROM documents WHERE id = ?', [h.documentId]));
    }
    const doc = docCache.get(h.documentId);
    if (!doc) continue;
    const ver = await db.get<Row>('SELECT version, source_modified_at FROM document_versions WHERE id = ?', [h.versionId]);

    const revision = ver?.source_modified_at ?? doc.source_modified_at ?? doc.updated_at;
    sources.push({
      index: sources.length,
      chunkId: h.chunkId,
      documentId: h.documentId,
      versionId: h.versionId,
      version: Number(ver?.version ?? 1),
      docType: String(doc.doc_type) === 'LAW' ? 'LAW' : 'RULE',
      title: String(doc.title),
      category: doc.category == null ? null : String(doc.category),
      section: doc.section == null ? null : String(doc.section),
      heading: h.heading,
      content: h.content,
      url: buildSourceUrl(String(doc.url ?? ''), doc.thread_id == null ? null : Number(doc.thread_id), doc.post_id == null ? null : Number(doc.post_id)),
      revisionLabel: formatDateTime(revision),
      sourceModifiedAt: revision == null ? null : String(revision),
      score: Number(h.score.toFixed(4)),
      matchedTerms: h.matchedTerms,
      threadId: Number(doc.thread_id),
      postId: doc.post_id == null ? null : Number(doc.post_id),
    });
  }

  // Если chunk-поиск пуст — пробуем найти хотя бы документ, чтобы честно
  // сказать «есть такой закон, но по вашему вопросу в нём ничего не найдено».
  let relatedDocuments: { documentId: number; title: string }[] = [];
  if (sources.length < 2) {
    const docs = await searchDocuments(opts.query, docType, 5);
    const have = new Set(sources.map((s) => s.documentId));
    relatedDocuments = docs.filter((d) => !have.has(d.documentId)).map((d) => ({ documentId: d.documentId, title: d.title }));
  }

  return {
    mode: opts.mode,
    docType,
    query: opts.query,
    sources,
    kbVersion: await getKbVersion(),
    searchMs: Date.now() - started,
    relatedDocuments,
  };
}

/**
 * Ссылка на оригинал.
 * XenForo позволяет перейти к конкретному посту: /threads/<slug>.<id>/post-<postId>
 */
export function buildSourceUrl(url: string, threadId: number | null, postId: number | null): string {
  const base = String(url || '').trim();
  if (!base) return config.crawler.baseUrl;
  const absolute = base.startsWith('http') ? base : `${config.crawler.baseUrl}${base.startsWith('/') ? '' : '/'}${base}`;
  if (!postId || absolute.includes(`post-${postId}`)) return absolute;
  // убираем page-N и якоря, добавляем якорь конкретного поста
  const clean = absolute.replace(/\/page-\d+/, '').split('#')[0]!;
  return `${clean}${clean.endsWith('/') ? '' : ''}#post-${postId}`;
}

/** Полный контекст документа (для окна источников и админки). */
export async function getDocumentContext(documentId: number): Promise<Row | null> {
  const db = await getDb();
  const doc = await db.get<Row>('SELECT * FROM documents WHERE id = ?', [documentId]);
  if (!doc) return null;
  const versions = await db.all<Row>(
    'SELECT id, version, content_hash, word_count, change_kind, source_modified_at, created_at FROM document_versions WHERE document_id = ? ORDER BY version DESC',
    [documentId],
  );
  return {...doc, versions };
}
