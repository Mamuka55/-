/**
 * EPIC AI — нормализация текста форума и разбиение на chunks для RAG.
 *
 * XenForo отдаёт HTML с bbWrapper. Нам нужен чистый, стабильный текст:
 * из него считаются хэши (версионирование, ) и chunks (RAG).
 * Стабильность важнее красоты: любая «плавающая» разметка ломала бы diff.
 */
import { createHash } from 'node:crypto';

const BLOCK_TAGS = new Set(['P', 'DIV', 'BR', 'LI', 'TR', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'BLOCKQUOTE', 'PRE', 'SECTION', 'ARTICLE']);

export interface ExtractOptions {
  /** Ограничить извлечение элементом с этим классом (по умолчанию bbWrapper). */
  rootClass?: string;
}

/**
 * HTML → текст с сохранением структуры строк.
 * Реализовано на регулярных выражениях, чтобы не тянуть DOM в горячий путь;
 * для сложных страниц используется cheerio (см. crawler/xenoforo.ts).
 */
export function htmlToText(html: string): string {
  if (!html) return '';
  let s = html;

  // Удаляем служебное
  s = s.replace(/<script[\s\S]*?<\/script>/gi, ' ');
  s = s.replace(/<style[\s\S]*?<\/style>/gi, ' ');
  s = s.replace(/<!--[\s\S]*?-->/g, ' ');
  // zero-width space, который вставляет XenForo — и entity, и литералом
  s = s.replace(/&#8203;|&ZeroWidthSpace;/g, '');
  s = s.replace(/[\u200B-\u200F\u2060\uFEFF]/g, '');
  s = s.replace(/<svg[\s\S]*?<\/svg>/gi, ' ');

  // Блочные теги → перевод строки
  s = s.replace(/<br\s*\/?>/gi, '\n');
  s = s.replace(/<\/(p|div|li|tr|h[1-6]|blockquote|pre|section|article|ul|ol|table)>/gi, '\n');
  s = s.replace(/<(li|tr)[^>]*>/gi, '\n• ');
  s = s.replace(/<(h1|h2|h3|h4|h5|h6)[^>]*>/gi, '\n## ');

  // Удаляем остальные теги
  s = s.replace(/<[^>]+>/g, '');

  // HTML entities
  s = decodeEntities(s);

  // Нормализация пробелов и переносов
  s = s.replace(/\u00a0/g, ' ');
  s = s.replace(/[ \t\f\v]+/g, ' ');
  s = s.replace(/ ?\n ?/g, '\n');
  s = s.replace(/\n{3,}/g, '\n\n');
  return s.trim();
}

const ENTITIES: Record<string, string> = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', copy: '©', reg: '®',
  mdash: '—', ndash: '–', hellip: '…', laquo: '«', raquo: '»', bull: '•',
  deg: '°', plusmn: '±', times: '×', divide: '÷', euro: '€', trade: '™',
};

export function decodeEntities(s: string): string {
  return s
   .replace(/&#x([0-9a-fA-F]+);/g, (_, h) => {
      const cp = parseInt(h, 16);
      return Number.isFinite(cp) && cp > 0 && cp <= 0x10ffff ? String.fromCodePoint(cp) : '';
    })
   .replace(/&#(\d+);/g, (_, d) => {
      const cp = parseInt(d, 10);
      return Number.isFinite(cp) && cp > 0 && cp <= 0x10ffff ? String.fromCodePoint(cp) : '';
    })
   .replace(/&([a-zA-Z][a-zA-Z0-9]{1,10});/g, (m, name) => ENTITIES[String(name).toLowerCase()] ?? m);
}

export interface Chunk {
  seq: number;
  heading: string | null;
  content: string;
  charStart: number;
  charEnd: number;
  tokenEstimate: number;
}

/** Похоже на номер пункта/статьи: «4.2», «4.2.1», «Статья 12», «§ 3», «1)». */
const ITEM_HEAD_RE = /^\s*(?:(статья|ст\.|пункт|п\.|параграф|§|раздел|глава)\s*)?(\d{1,3}(?:\.\d{1,3}){0,3})[.)\s—-]/i;
const HEADING_RE = /^\s*(#{1,6}\s+.+|[A-ZА-ЯЁ][A-ZА-ЯЁ0-9 ,.\-]{6,})\s*$/;

/**
 * Заголовок раздела/статьи: «1. Основные термины Roleplay», «ГЛАВА 1. …»,
 * «Статья 12.4. Убийство первой степени». Именно он попадает в chunk.heading
 * и показывается пользователю как «Пункт …» в окне источников.
 */
const SECTION_HEAD_RE = /^\s*(?:#{1,6}\s+)?(?:(\d{1,2})[.)]\s+([A-Za-zА-Яа-яЁё][^\n]{2,90})|(§{1,2}|глава|статья|раздел|параграф|часть|ст\.)\s*([IVXLCDM0-9]{1,7}(?:\.\d{1,3})*)\s*[.)]?\s*([^\n]{0,90}))\s*$/i;

function sectionHeading(line: string): string | null {
  const t = line.trim().replace(/\s+/g, ' ');
  if (!t || t.length > 120) return null;
  if (!SECTION_HEAD_RE.test(t)) return null;

  // «ГЛАВА 1. …», «Статья 12.4. …», «§801. …», «Часть I. …» — заголовок всегда
  if (/^(?:#{1,6}\s+)?(?:§{1,2}|глава|статья|раздел|параграф|часть|ст\.)\s*[IVX0-9]/i.test(t)) {
    return t.replace(/^#{1,6}\s+/, '').slice(0, 120);
  }
  if (/^#{1,6}\s+\S/.test(t)) return t.replace(/^#{1,6}\s+/, '').slice(0, 120);

  // Числовая нумерация («4. Поведение при проверке документов»).
  // Отсекаем обычные предложения, которые просто начинаются с номера:
  // они длинные и содержат пунктуацию предложения.
  const tail = t.replace(/^\d{1,2}[.)]\s*/, '');
  if (!tail) return null;
  if (tail.length > 72) return null;
  if (/[!?;:]$/.test(tail)) return null;
  if ((tail.match(/,/g) ?? []).length > 1) return null;
  return t.slice(0, 120);
}

/**
 * Похожа ли строка на заголовок: короткая, без конечной точки, не «термин — определение».
 */
function isTitleLike(line: string): boolean {
  const t = line.trim().replace(/^#{1,6}\s+/, '');
  if (!t || t.length < 4 || t.length > 72) return false;
  if (/[.!?;,:]$/.test(t)) return false;
  if (t.includes(' - ') || t.includes(' — ')) return false;   // «RP - (RolePlay) - игра по ролям»
  if ((t.match(/,/g) ?? []).length > 1) return false;
  if (/^\d{1,3}\.\d/.test(t)) return false;                 // «4.2. …» — это пункт, не заголовок
  if (/^\d+$/.test(t)) return false;
  return /[A-Za-zА-Яа-яЁё]/.test(t);
}

/**
 * Документы на форуме нередко вставлены ОДНОЙ строкой (Penal Code — 86 КБ
 * без единого переноса). Без подготовки такой текст невозможно ни разбить
 * на пункты, ни показать человеку, поэтому длинные строки разрезаются
 * по границам предложений и по маркерам «Статья/Глава/Пункт/номер».
 */
export function reflowLongLines(text: string, maxLineChars = 160): string {
  const lines = String(text ?? '').split('\n');
  if (!lines.some((l) => l.length > maxLineChars)) return String(text ?? '');

  const out: string[] = [];
  for (const line of lines) {
    if (line.length <= maxLineChars) { out.push(line); continue; }

    const sentences = line
     .replace(/(?<=[.!?…])\s+(?=[A-ZА-ЯЁ0-9«(§])/g, '\n')
     .replace(/(?<=\S)\s+(?=(?:Статья|Глава|Раздел|Параграф|Пункт|Ст\.)\s*\d)/gi, '\n')
     .replace(/(?<=\S)\s+(?=\d{1,3}\.\d{1,3}(?:\.\d{1,3})?\s)/g, '\n')
     .split('\n');

    // Добираем слишком длинные «предложения» жёстким резом по пробелу
    for (const s of sentences) {
      if (!s.trim()) continue;
      if (s.length <= maxLineChars * 2) { out.push(s); continue; }
      let rest = s;
      while (rest.length > maxLineChars * 2) {
        const cut = rest.lastIndexOf(' ', maxLineChars * 2);
        const at = cut > maxLineChars ? cut : maxLineChars * 2;
        out.push(rest.slice(0, at));
        rest = rest.slice(at).trimStart();
      }
      if (rest.trim()) out.push(rest);
    }
  }
  return out.join('\n');
}

/**
 * XenForo часто оформляет номер раздела отдельной строкой (цветной «1.», «2.»),
 * а сам заголовок идёт следующим абзацем. Для chunking это useless, поэтому
 * склеиваем «маркер + следующая строка» в одну.
 */
function joinStandaloneMarkers(text: string): string {
  return text
   .replace(/(^|\n)\s*(\d{1,2}[.)])\s*(\n)\s*([^\n]{2,90})(?=\n|$)/g, (_m, pre, num, _nl, rest) => {
      // не склеиваем, если «следующая строка» сама выглядит как предложение
      if (/[.!?]$/.test(rest.trim()) && rest.trim().length > 60) return `${pre}${num}${_nl}${rest}`;
      return `${pre}${num} ${rest.trim()}`;
    });
}

export interface ChunkOptions {
  maxChars: number;
  overlap: number;
}

/**
 * Разбиение документа на chunks.
 *
 * Стратегия: сначала режем по смысловым границам (пустая строка, нумерованный
 * пункт, заголовок), затем склеиваем соседние фрагменты до maxChars. Так пункт
 * правила почти всегда попадает в chunk целиком — это критично для цитирования
 * и для того, чтобы AI не «придумывал» номера пунктов.
 */
export function chunkText(text: string, opts: ChunkOptions): Chunk[] {
  const src = joinStandaloneMarkers(reflowLongLines(String(text ?? '').trim()));
  if (!src) return [];

  const max = Math.max(200, opts.maxChars);
  const overlap = Math.max(0, Math.min(opts.overlap, Math.floor(max / 2)));

  // 1) Атомарные фрагменты
  const atoms: { text: string; start: number; heading: string | null }[] = [];
  let cursor = 0;
  for (const block of splitKeepOffsets(src)) {
    const lines = block.text.split('\n');
    let buf: string[] = [];
    let bufStart = block.start;
    let heading: string | null = null;

    const flush = (endOffset: number) => {
      const t = buf.join('\n').trim();
      if (t) atoms.push({ text: t, start: bufStart, heading });
      buf = [];
      bufStart = endOffset;
    };

    let pos = block.start;

    // Первая короткая «заголовочная» строка абзаца — тоже заголовок
    // («Основные термины Roleplay», «Порядок задержания»). Без этого у многих
    // фрагментов не было бы пункта, а окно источников обязано его показывать.
    const firstIdx = lines.findIndex((l) => l.trim().length > 0);
    if (firstIdx >= 0) {
      const cand = lines[firstIdx]!.trim();
      if (isTitleLike(cand)) {
        heading = cand.replace(/^#{1,6}\s*/, '').slice(0, 120);
        lines.splice(firstIdx, 1);
        pos += cand.length + 1;
      }
    }

    for (const line of lines) {
      const section = sectionHeading(line);
      const isHeading = Boolean(section) || (HEADING_RE.test(line) && line.trim().length <= 120);
      const isItemStart = ITEM_HEAD_RE.test(line);
      if ((isItemStart || isHeading) && buf.length) {
        flush(pos);
        heading = section ?? (isHeading ? line.replace(/^#{1,6}\s*/, '').trim() : null);
      } else if (isHeading && !buf.length) {
        heading = section ?? line.replace(/^#{1,6}\s*/, '').trim();
      }
      buf.push(line);
      pos += line.length + 1;
    }
    flush(block.start + block.text.length);
  }

  // 2) Склейка атомов до maxChars
  const chunks: Chunk[] = [];
  let cur = '';
  let curStart = 0;
  let curHeading: string | null = null;

  const push = () => {
    const t = cur.trim();
    if (!t) return;
    chunks.push({
      seq: chunks.length,
      heading: curHeading,
      content: t,
      charStart: curStart,
      charEnd: curStart + t.length,
      tokenEstimate: estimateTokens(t),
    });
  };

  for (const a of atoms) {
    if (!cur) { curStart = a.start; curHeading = a.heading; }
    if (cur.length + a.text.length + 1 > max && cur.length > 0) {
      push();
      // overlap: оставляем хвост предыдущего chunk'а
      const tail = overlap > 0 ? cur.slice(-overlap) : '';
      cur = tail ? `${tail.trim()}\n${a.text}` : a.text;
      curStart = tail ? Math.max(curStart, a.start - tail.length) : a.start;
      curHeading = a.heading ?? curHeading;
    } else {
      cur = cur ? `${cur}\n${a.text}` : a.text;
      if (a.heading && !curHeading) curHeading = a.heading;
    }
  }
  push();

  // 3) Совсем длинные атомы режем жёстко (граница предложения)
  const finalChunks: Chunk[] = [];
  for (const c of chunks) {
    if (c.content.length <= max * 1.6) {
      finalChunks.push({...c, seq: finalChunks.length });
      continue;
    }
    for (const part of hardSplit(c.content, max, overlap)) {
      finalChunks.push({...c, content: part, seq: finalChunks.length, tokenEstimate: estimateTokens(part) });
    }
  }
  return finalChunks;
}

function splitKeepOffsets(text: string): { text: string; start: number }[] {
  const out: { text: string; start: number }[] = [];
  const re = /\n\s*\n/g;
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    const seg = text.slice(last, m.index);
    if (seg.trim()) out.push({ text: seg, start: last });
    last = m.index + m[0].length;
  }
  const tail = text.slice(last);
  if (tail.trim()) out.push({ text: tail, start: last });
  if (!out.length && text.trim()) out.push({ text, start: 0 });
  return out;
}

function hardSplit(text: string, max: number, overlap: number): string[] {
  const out: string[] = [];
  let rest = text;
  while (rest.length > max) {
    const window = rest.slice(0, max);
    const cut = Math.max(window.lastIndexOf('. '), window.lastIndexOf('\n'), window.lastIndexOf('! '), window.lastIndexOf('? '));
    const at = cut > max * 0.5 ? cut + 1 : max;
    out.push(rest.slice(0, at).trim());
    const back = overlap > 0 ? rest.slice(Math.max(0, at - overlap), at).trim() : '';
    rest = (back ? `${back} ` : '') + rest.slice(at).trim();
    if (out.length > 500) break;
  }
  if (rest.trim()) out.push(rest.trim());
  return out;
}

export function estimateTokens(text: string): number {
  // Грубая оценка: ~3.5 символа на токен для смешанного ru/en текста
  return Math.ceil(String(text ?? '').length / 3.5);
}

/** Стабильный хэш содержимого. */
export function contentHash(text: string): string {
  return createHash('sha256').update(normalizeForHash(text), 'utf8').digest('hex');
}

/** Нормализация перед хэшем: убираем незначащие различия пробелов/переносов. */
export function normalizeForHash(text: string): string {
  return String(text ?? '')
   .replace(/\r\n?/g, '\n')
   .replace(/\u00a0/g, ' ')
   .replace(/[ \t]+/g, ' ')
   .replace(/ ?\n ?/g, '\n')
   .replace(/\n{2,}/g, '\n')
   .trim();
}

export { BLOCK_TAGS };
