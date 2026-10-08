/**
 * EPIC AI — полнотекстовый поиск по Knowledge Base.
 *
 * Собственный BM25-движок поверх таблицы search_terms. Причины не брать
 * FTS5/tsvector в качестве единственного механизма:
 *   1) одинаковое поведение на SQLite (better-sqlite3 И sql.js/WASM) и PostgreSQL;
 *   2) русская морфология: FTS5 не умеет стемминг ru, а «правило/правила/правил»
 *      должны находиться одним запросом;
 *   3) жёсткое разделение баз RULE/LAW на уровне индекса.
 *
 * Индекс хранится в виде postings-списков: term → [[chunkId, tf],...].
 */
import { getDb, parseJson, type Row } from '../db/index.js';
import { config } from '../config/index.js';

/* ------------------------------------------------------------------ */
/*  Токенизация и простой русский стеммер                               */
/* ------------------------------------------------------------------ */

const STOPWORDS = new Set([
  'и', 'в', 'во', 'не', 'что', 'он', 'на', 'я', 'с', 'со', 'как', 'а', 'то', 'все', 'она', 'так',
  'его', 'но', 'да', 'ты', 'к', 'у', 'же', 'вы', 'за', 'бы', 'по', 'только', 'ее', 'мне', 'было',
  'вот', 'от', 'меня', 'еще', 'нет', 'о', 'из', 'ему', 'теперь', 'когда', 'даже', 'ну', 'вдруг',
  'ли', 'если', 'уже', 'или', 'ни', 'быть', 'был', 'него', 'до', 'вас', 'нибудь', 'опять', 'уж',
  'вам', 'ведь', 'там', 'потом', 'себя', 'ничего', 'ей', 'может', 'они', 'тут', 'где', 'есть',
  'надо', 'ней', 'для', 'мы', 'тебя', 'их', 'чем', 'была', 'сам', 'чтоб', 'без', 'будто', 'чего',
  'раз', 'тоже', 'себе', 'под', 'будет', 'ж', 'тогда', 'кто', 'этот', 'того', 'потому', 'этого',
  'какой', 'совсем', 'ним', 'здесь', 'этом', 'один', 'почти', 'мой', 'тем', 'чтобы', 'нее',
  'были', 'куда', 'зачем', 'всех', 'никогда', 'можно', 'при', 'наконец', 'два', 'об', 'другой',
  'хоть', 'после', 'над', 'больше', 'тот', 'через', 'эти', 'нас', 'про', 'всего', 'них', 'какая',
  'много', 'разве', 'три', 'эту', 'моя', 'впрочем', 'хорошо', 'свою', 'этой', 'перед', 'иногда',
  'лучше', 'чуть', 'том', 'нельзя', 'такой', 'им', 'более', 'всегда', 'конечно', 'всю', 'между',
]);

/** Русские окончания, срезаемые стеммером (порядок важен: длинные первыми). */
const ENDINGS = [
  'иями', 'ями', 'ами', 'иях', 'ях', 'иям', 'ям', 'ах',
  'иями', 'иях',
  'ова', 'ева', 'ава',
  'ейш', 'айш',
  'енн', 'онн', 'ани', 'яни', 'ост', 'еств',
  'ией', 'ей', 'ий', 'ой', 'ый', 'ая', 'яя', 'ое', 'ее', 'ие', 'ые',
  'ов', 'ев', 'ёв', 'ам', 'ям', 'ах', 'ях', 'ом', 'ем', 'им', 'ым',
  'ию', 'ью', 'ую', 'юю', 'ия', 'я', 'а', 'о', 'е', 'и', 'ы', 'у', 'ю', 'й', 'ь',
];

const MIN_STEM = 3;

export function stem(word: string): string {
  const w = word.toLowerCase().replace(/ё/g, 'е');
  if (w.length <= MIN_STEM) return w;
  // Отделяем существительное окончание (упрощённый алгоритм Соболева)
  const perfective = w.replace(/(ив|ыв|ши|щь)$/,'');
  let base = perfective.length >= MIN_STEM ? perfective : w.replace(/(ла|на|ли|но|ло|ны|ли)$/,'');
  if (base.length < MIN_STEM) base = w;
  const reflexive = base.replace(/(ся|сь)$/,'');
  if (reflexive.length >= MIN_STEM) base = reflexive;

  let stem = base;
  for (const e of ENDINGS) {
    if (stem.length - e.length >= MIN_STEM && stem.endsWith(e)) {
      stem = stem.slice(0, stem.length - e.length);
      break;
    }
  }
  if (stem.length < MIN_STEM) stem = base;
  // срезаем производный суффикс
  const deriv = stem.replace(/(ова|ева|ава|ивш|ывш|ующ|ующ)$/,'');
  if (deriv.length >= MIN_STEM) stem = deriv;
  return stem;
}

/** Токены текста: исходное слово + основа (для морфологической устойчивости). */
export function tokenize(text: string, opts: { withStems?: boolean; keepStopwords?: boolean } = {}): string[] {
  const withStems = opts.withStems !== false;
  const raw = String(text ?? '').toLowerCase().match(/[a-zа-яё0-9]+(?:[.\-][a-zа-яё0-9]+)*/gi) ?? [];
  const out: string[] = [];
  for (const t of raw) {
    const clean = t.replace(/[.\-]+$/,'');
    if (clean.length < 2) continue;
    if (!opts.keepStopwords && STOPWORDS.has(clean) && !/\d/.test(clean)) continue;
    out.push(clean);
    if (withStems) {
      const s = stem(clean);
      if (s !== clean && s.length >= MIN_STEM) out.push(s);
    }
  }
  return out;
}

/** Термы запроса: слова + основы. Цифры (номера пунктов) сохраняются всегда. */
export function queryTerms(query: string): string[] {
  const raw = String(query ?? '').toLowerCase().match(/[a-zа-яё0-9]+(?:[.\-][a-z0-9]+)*/gi) ?? [];
  const set = new Set<string>();
  for (const t of raw) {
    const clean = t.replace(/[.\-]+$/,'');
    if (clean.length < 2) continue;
    if (!/\d/.test(clean) && STOPWORDS.has(clean)) continue;
    set.add(clean);
    const s = stem(clean);
    if (s.length >= MIN_STEM) set.add(s);
  }
  return [...set];
}

/* ------------------------------------------------------------------ */
/*  Индексация                                                          */
/* ------------------------------------------------------------------ */

export interface IndexableChunk {
  chunkId: number;
  docType: 'RULE' | 'LAW';
  heading: string | null;
  content: string;
}

/**
 * Полная переиндексация chunk'а: удаляем старые postings и пишем новые.
 * Вызывается при создании новой версии документа.
 */
export async function indexChunk(c: IndexableChunk): Promise<void> {
  const db = await getDb();
  const fields: { field: 'heading' | 'body'; text: string }[] = [
    { field: 'body', text: c.content },
   ...(c.heading ? [{ field: 'heading' as const, text: c.heading }] : []),
  ];
  for (const f of fields) {
    await removeFromField(c.chunkId, c.docType, f.field);
    const tf = new Map<string, number>();
    for (const term of tokenize(f.text)) tf.set(term, (tf.get(term) ?? 0) + 1);
    for (const [term, count] of tf) {
      await addPosting('search_terms', term, c.docType, f.field, c.chunkId, count);
    }
  }
}

export async function removeChunkFromIndex(chunkId: number, docType: string): Promise<void> {
  for (const field of ['body', 'heading'] as const) await removeFromField(chunkId, docType as any, field);
}

async function removeFromField(chunkId: number, docType: string, field: string): Promise<void> {
  const db = await getDb();
  // Пострадавшие термы находим через сканирование только тех строк, где chunk встречается.
  // Для скорости поддерживаем обратный список chunk_terms.
  const rows = await db.all<Row>('SELECT term FROM chunk_terms WHERE chunk_id = ? AND field = ?', [chunkId, field]);
  for (const r of rows) {
    const term = String(r.term);
    const row = await db.get<Row>('SELECT postings, df FROM search_terms WHERE term = ? AND doc_type = ? AND field = ?', [term, docType, field]);
    if (!row) continue;
    const postings: [number, number][] = parseJson(row.postings, []);
    const next = postings.filter((p) => Number(p[0]) !== chunkId);
    if (next.length === postings.length) continue;
    if (!next.length) {
      await db.run('DELETE FROM search_terms WHERE term = ? AND doc_type = ? AND field = ?', [term, docType, field]);
    } else {
      await db.run('UPDATE search_terms SET postings = ?, df = ?, updated_at = ? WHERE term = ? AND doc_type = ? AND field = ?',
        [JSON.stringify(next), next.length, new Date().toISOString(), term, docType, field]);
    }
  }
  await db.run('DELETE FROM chunk_terms WHERE chunk_id = ? AND field = ?', [chunkId, field]);
}

async function addPosting(table: 'search_terms', term: string, docType: string, field: string, id: number, tf: number): Promise<void> {
  const db = await getDb();
  const existing = await db.get<Row>(`SELECT postings FROM ${table} WHERE term = ? AND doc_type = ? AND field = ?`, [term, docType, field]);
  const postings: [number, number][] = existing ? parseJson(existing.postings, []) : [];
  const idx = postings.findIndex((p) => Number(p[0]) === id);
  if (idx >= 0) postings[idx] = [id, tf];
  else postings.push([id, tf]);
  if (existing) {
    await db.run(`UPDATE ${table} SET postings = ?, df = ?, updated_at = ? WHERE term = ? AND doc_type = ? AND field = ?`,
      [JSON.stringify(postings), postings.length, new Date().toISOString(), term, docType, field]);
  } else {
    await db.run(`INSERT INTO ${table} (term, doc_type, field, postings, df, updated_at) VALUES (?, ?, ?, ?, ?, ?)`,
      [term, docType, field, JSON.stringify(postings), postings.length, new Date().toISOString()]);
  }
  await db.run(`INSERT INTO chunk_terms (chunk_id, field, term) VALUES (?, ?, ?) ON CONFLICT DO NOTHING`, [id, field, term]);
}

/* ------------------------------------------------------------------ */
/*  BM25-поиск                                                          */
/* ------------------------------------------------------------------ */

const K1 = 1.4;
const B = 0.72;

export interface SearchHit {
  chunkId: number;
  documentId: number;
  versionId: number;
  score: number;
  heading: string | null;
  content: string;
  matchedTerms: string[];
}

export interface SearchOptions {
  docType: 'RULE' | 'LAW';
  limit?: number;
  maxCandidates?: number;
  /** Исключить архивные документы (по умолчанию true — ). */
  excludeArchive?: boolean;
}

export async function searchChunks(query: string, opts: SearchOptions): Promise<SearchHit[]> {
  const terms = queryTerms(query);
  if (!terms.length) return [];
  const db = await getDb();
  const limit = opts.limit ?? config.rag.topK;
  const maxCandidates = opts.maxCandidates ?? config.rag.maxCandidates;
  const excludeArchive = opts.excludeArchive !== false;

  const stats = await db.get<Row>(
    `SELECT COUNT(*) AS n, AVG(token_estimate) AS avgdl FROM document_chunks WHERE is_current = 1`,
  );
  const N = Math.max(1, Number(stats?.n ?? 1));
  const avgdl = Math.max(50, Number(stats?.avgdl ?? 220));

  const scores = new Map<number, { score: number; matched: Set<string> }>();

  for (const term of terms) {
    const rows = await db.all<Row>(
      `SELECT postings, df FROM search_terms WHERE term = ? AND doc_type = ? AND field IN ('body','heading')`,
      [term, opts.docType],
    );
    if (!rows.length) continue;
    for (const row of rows) {
      const df = Math.max(1, Number(row.df ?? 1));
      const idf = Math.log(1 + (N - df + 0.5) / (df + 0.5));
      const postings: [number, number][] = parseJson(row.postings, []);
      for (const [chunkId, tf] of postings) {
        const cid = Number(chunkId);
        const cur = scores.get(cid);
        // Первый проход: грубая оценка idf * tf для отбора кандидатов.
        // Точная BM25-нормализация по длине chunk'а выполняется вторым проходом.
        const add = idf * ((tf * (K1 + 1)) / (tf + K1));
        if (cur) { cur.score += add; cur.matched.add(term); }
        else scores.set(cid, { score: add, matched: new Set([term]) });
      }
    }
  }
  if (!scores.size) return [];

  // Уточнение по длине документа (настоящий BM25 требует dl)
  const ids = [...scores.keys()]
   .sort((a, b) => scores.get(b)!.score - scores.get(a)!.score)
   .slice(0, Math.max(maxCandidates, limit * 4));
  if (!ids.length) return [];

  const chunkRows = await db.all<Row>(
    `SELECT c.id, c.document_id, c.version_id, c.heading, c.content, c.token_estimate, d.status
       FROM document_chunks c JOIN documents d ON d.id = c.document_id
      WHERE c.id IN (${ids.map(() => '?').join(', ')}) AND c.is_current = 1`,
    ids,
  );

  const hits: SearchHit[] = [];
  for (const r of chunkRows) {
    if (excludeArchive && String(r.status) !== 'active') continue;
    const cid = Number(r.id);
    const s = scores.get(cid);
    if (!s) continue;
    // Второй проход: нормализуем грубую оценку по длине chunk'а (BM25).
    const dl = Math.max(20, Number(r.token_estimate) || 200);
    const norm = 1 - B + B * (dl / avgdl);
    hits.push({
      chunkId: cid,
      documentId: Number(r.document_id),
      versionId: Number(r.version_id),
      score: s.score / Math.max(0.2, norm),
      heading: r.heading == null ? null : String(r.heading),
      content: String(r.content),
      matchedTerms: [...s.matched],
    });
  }

  hits.sort((a, b) => b.score - a.score);
  // Дедупликация: не больше 2 chunk'ов одного документа в выдаче —
  // иначе один длинный закон вытеснит все остальные источники.
  const perDoc = new Map<number, number>();
  const diverse: SearchHit[] = [];
  for (const h of hits) {
    const c = perDoc.get(h.documentId) ?? 0;
    if (c >= 2) continue;
    perDoc.set(h.documentId, c + 1);
    diverse.push(h);
    if (diverse.length >= limit) break;
  }
  return diverse.length ? diverse : hits.slice(0, limit);
}

/** Поиск по заголовкам документов — используется как fallback и для «навигации». */
export async function searchDocuments(query: string, docType: 'RULE' | 'LAW', limit = 10): Promise<{ documentId: number; title: string; score: number }[]> {
  const terms = queryTerms(query);
  if (!terms.length) return [];
  const db = await getDb();
  const rows = await db.all<Row>(
    `SELECT id, title, section, status FROM documents WHERE doc_type = ? AND status = 'active'`,
    [docType],
  );
  const scored = rows.map((r) => {
    const title = String(r.title).toLowerCase();
    const section = String(r.section ?? '').toLowerCase();
    let score = 0;
    for (const t of terms) {
      if (title.includes(t)) score += 3;
      else if (stem(t) && title.includes(stem(t))) score += 2;
      if (section.includes(t)) score += 1;
    }
    return { documentId: Number(r.id), title: String(r.title), score };
  }).filter((x) => x.score > 0);
  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, limit);
}
