/**
 * EPIC AI — парсер XenForo 2.x.
 *
 * forum.epic-gta.com работает на XenForo 2.3, поэтому разметка стабильна
 * и предсказуема. Парсер намеренно опирается на структурные классы XenForo
 * (node--idN, structItem--thread, message-body/bbWrapper, time[data-timestamp])
 * и имеет запасные варианты на случай смены темы оформления.
 */
import * as cheerio from 'cheerio';
import type { CheerioAPI } from 'cheerio';
import { htmlToText, decodeEntities } from '../knowledge/text.js';

export interface ForumNode {
  nodeId: number;
  parentNodeId: number | null;
  title: string;
  url: string;
  depth: number;
  kind: 'category' | 'forum' | 'link' | 'page';
}

export interface ThreadSummary {
  threadId: number;
  title: string;
  url: string;
  authorName: string | null;
  prefix: string | null;
  createdAt: string | null;
  lastPostAt: string | null;
  replies: number | null;
  views: number | null;
  isSticky: boolean;
  isLocked: boolean;
}

export interface ParsedPost {
  postId: number | null;
  position: number;
  authorName: string | null;
  createdAt: string | null;
  editedAt: string | null;
  html: string;
  text: string;
}

export interface ParsedThread {
  threadId: number;
  title: string;
  url: string;
  authorName: string | null;
  createdAt: string | null;
  lastPostAt: string | null;
  pageCount: number;
  page: number;
  posts: ParsedPost[];
}

/* ------------------------------------------------------------------ */
/*  Узлы форума                                                         */
/* ------------------------------------------------------------------ */

const NODE_ID_RE = /node--id(\d+)/;
const NODE_DEPTH_RE = /node--depth(\d+)/;
const NODE_URL_RE = /\/(forums|categories|pages|links)\/[^/]*?\.(\d+)\/?$/;

export function parseForumIndex(html: string, baseUrl: string): ForumNode[] {
  const $ = cheerio.load(html);
  const nodes: ForumNode[] = [];
  const seen = new Set<number>();

  // 1) Основные узлы списка форумов
  $('div.node[class*="node--id"]').each((_i, el) => {
    const $el = $(el);
    const cls = String($el.attr('class') ?? '');
    const idMatch = cls.match(NODE_ID_RE);
    if (!idMatch) return;
    const nodeId = Number(idMatch[1]);
    if (seen.has(nodeId)) return;

    const depthMatch = cls.match(NODE_DEPTH_RE);
    const depth = depthMatch ? Number(depthMatch[1]) : 1;
    const kind = /node--category/.test(cls) ? 'category'
      : /node--forum/.test(cls) ? 'forum'
      : /node--link/.test(cls) ? 'link'
      : /node--page/.test(cls) ? 'page' : 'forum';

    const $title = $el.find('h3.node-title a,.node-title a').first();
    const href = String($title.attr('href') ?? '');
    const title = cleanText($title.text());
    if (!href || !title) return;

    seen.add(nodeId);
    nodes.push({ nodeId, parentNodeId: null, title, url: absolute(baseUrl, href), depth, kind });
  });

  // 2) Дерево подразделов (node_subNodeMenu) — даёт parent/child связи
  const menuNodes: ForumNode[] = [];
  $('ol.subNodeMenu,.node_subNodeMenu').each((_i, menu) => {
    walk($(menu), null, 1);
  });

  function walk($ol: cheerio.Cheerio<any>, parentId: number | null, depth: number) {
    $ol.children('li').each((_j, li) => {
      const $li = $(li);
      const $a = $li.children('a').first();
      const href = String($a.attr('href') ?? '');
      const m = href.match(NODE_URL_RE);
      if (href && m) {
        const nodeId = Number(m[2]);
        const kind = (m[1] === 'categories' ? 'category' : m[1] === 'forums' ? 'forum' : m[1] === 'pages' ? 'page' : 'link') as ForumNode['kind'];
        const title = cleanText($a.text());
        if (title && !menuNodes.some((n) => n.nodeId === nodeId)) {
          menuNodes.push({ nodeId, parentNodeId: parentId, title, url: absolute(baseUrl, href), depth, kind });
        }
        const $nested = $li.children('ol');
        if ($nested.length) walk($nested, nodeId, depth + 1);
        return;
      }
      const $nested = $li.children('ol');
      if ($nested.length) walk($nested, parentId, depth);
    });
  }

  // 3) Объединяем: основные узлы + узлы из меню (с родителями)
  const parentOf = new Map<number, number | null>();
  for (const n of menuNodes) if (!parentOf.has(n.nodeId)) parentOf.set(n.nodeId, n.parentNodeId);

  const merged = new Map<number, ForumNode>();
  for (const n of [...nodes,...menuNodes]) {
    const prev = merged.get(n.nodeId);
    if (!prev) { merged.set(n.nodeId, {...n, parentNodeId: parentOf.get(n.nodeId) ?? n.parentNodeId }); continue; }
    merged.set(n.nodeId, {
     ...prev,
      parentNodeId: prev.parentNodeId ?? parentOf.get(n.nodeId) ?? n.parentNodeId ?? null,
      depth: Math.min(prev.depth || 99, n.depth || 99),
      title: prev.title || n.title,
    });
  }
  return [...merged.values()].sort((a, b) => a.nodeId - b.nodeId);
}

/* ------------------------------------------------------------------ */
/*  Список тем в разделе                                                */
/* ------------------------------------------------------------------ */

export function parseThreadList(html: string, baseUrl: string): { threads: ThreadSummary[]; nextPage: string | null } {
  const $ = cheerio.load(html);
  const threads: ThreadSummary[] = [];

  const collect = ($el: cheerio.Cheerio<any>, sticky: boolean) => {
    const cls = String($el.attr('class') ?? '');
    const idMatch = cls.match(/js-threadListItem-(\d+)/);
    const $title = $el.find('.structItem-title a[data-tp-primary],.structItem-title a[href*="/threads/"]').first();
    const href = String($title.attr('href') ?? '');
    const tid = idMatch ? Number(idMatch[1]) : threadIdFromUrl(href);
    if (!tid || !href) return;
    if (threads.some((t) => t.threadId === tid)) return;

    const title = cleanText($title.text());
    const $author = $el.find('.structItem-minor.username, a.username').first();
    const prefix = cleanText($el.find('.structItem-title.label').first().text()) || null;
    const $times = $el.find('time[data-timestamp]');
    const startTs = Number($times.eq(0).attr('data-timestamp') ?? 0);
    const lastTs = Number($el.find('.structItem-latestDate[data-timestamp]').attr('data-timestamp') ?? $times.eq(1).attr('data-timestamp') ?? 0);

    const replies = intOrNull($el.find('.structItem-cell--meta dl').eq(0).find('dd').text());
    const views = intOrNull($el.find('.structItem-cell--meta dl').eq(1).find('dd').text());

    threads.push({
      threadId: tid,
      title: title || `Тема ${tid}`,
      url: absolute(baseUrl, href.split('#')[0]!),
      authorName: cleanText($author.text()) || String($el.attr('data-author') ?? '') || null,
      prefix,
      createdAt: startTs ? new Date(startTs * 1000).toISOString() : null,
      lastPostAt: lastTs ? new Date(lastTs * 1000).toISOString() : null,
      replies,
      views,
      isSticky: sticky || /is-sticky/.test(cls),
      isLocked: /is-locked/.test(cls),
    });
  };

  $('.stickyItemContainer-group.structItem--thread,.stickyItemContainer.structItem--thread').each((_i, el) => collect($(el), true));
  $('.structItemContainer.structItem--thread').each((_i, el) => collect($(el), false));

  const nextHref = $('link[rel="next"]').attr('href') ?? null;
  return { threads, nextPage: nextHref ? absolute(baseUrl, nextHref) : null };
}

/* ------------------------------------------------------------------ */
/*  Страница темы                                                       */
/* ------------------------------------------------------------------ */

export function parseThread(html: string, baseUrl: string, expectedId?: number): ParsedThread | null {
  const $ = cheerio.load(html);
  const canonical = $('link[rel="canonical"]').attr('href') ?? '';
  const url = canonical ? absolute(baseUrl, canonical) : baseUrl;
  const threadId = expectedId ?? threadIdFromUrl(url) ?? threadIdFromUrl(String($('span.u-anchorTarget[id^="thread-"]').attr('id') ?? ''));
  if (!threadId) return null;

  // Префикс темы («Важно», «Архив»…) — отдельная метка XenForo,
  // в название документа она попасть не должна.
  const $h1 = $('h1.p-title-value,.p-title h1').first();
  const title = cleanText($h1.clone().find('.label,.labelLink').remove().end().text())
    || cleanText($('meta[property="og:title"]').attr('content') ?? '')
    || cleanText($('title').text()).replace(/\s*\|.*$/, '');

  const posts: ParsedPost[] = [];
  let position = 0;

  $('article.message, li.message').each((_i, el) => {
    const $el = $(el);
    if ($el.closest('.block--messages').length === 0 && !$el.hasClass('message')) return;
    const $body = $el.find('.message-body.bbWrapper,.message-userContent.bbWrapper,.bbWrapper').first();
    if (!$body.length) return;

    position += 1;
    const dataLbId = String($el.find('.message-userContent').attr('data-lb-id') ?? '');
    const postAnchor = dataLbId.match(/post-(\d+)/)?.[1];
    const shareHref = String($el.find('.message-attribution-gadget').attr('data-href') ?? '');
    const shareId = shareHref.match(/\/posts\/(\d+)\//)?.[1];
    const attributionHref = String($el.find('.message-attribution a[href*="/post-"]').first().attr('href') ?? '');
    const attributionId = attributionHref.match(/post-(\d+)/)?.[1];
    const postId = Number(postAnchor ?? shareId ?? attributionId ?? 0) || null;

    const $time = $el.find('.message-attribution time[data-timestamp]').first();
    const ts = Number($time.attr('data-timestamp') ?? 0);

    const authorName = cleanText($el.find('.username,.message-name.username').first().text())
      || String($el.attr('data-author') ?? '') || null;

    const editedAt = extractEditedAt($el, $);
    const rawHtml = $body.html() ?? '';

    posts.push({
      postId,
      position,
      authorName,
      createdAt: ts ? new Date(ts * 1000).toISOString() : null,
      editedAt,
      html: rawHtml,
      text: htmlToText(rawHtml),
    });
  });

  // Номер текущей страницы и общее число страниц
  let page = 1;
  const canonicalPage = url.match(/page-(\d+)/);
  if (canonicalPage) page = Number(canonicalPage[1]);
  let pageCount = page;
  $('.pageNav-page').each((_i, el) => {
    const n = Number(cleanText($(el).text()).replace(/\D/g, ''));
    if (Number.isFinite(n) && n > pageCount) pageCount = n;
  });
  const $next = $('link[rel="next"]').attr('href');
  if ($next) {
    const n = Number(($next.match(/page-(\d+)/) ?? [])[1] ?? 0);
    if (n > pageCount) pageCount = Math.max(pageCount, n);
  }

  const first = posts[0];
  const lastTs = posts.map((p) => (p.createdAt ? Date.parse(p.createdAt) : 0)).filter(Boolean).sort((a, b) => b - a)[0] ?? 0;

  return {
    threadId,
    title,
    url: absolute(baseUrl, url.split('#')[0]!),
    authorName: first?.authorName ?? (cleanText(String($('.structItem--thread').first().attr('data-author') ?? '')) || null),
    createdAt: first?.createdAt ?? null,
    lastPostAt: lastTs ? new Date(lastTs).toISOString() : null,
    pageCount,
    page,
    posts,
  };
}

function extractEditedAt($el: cheerio.Cheerio<any>, $: CheerioAPI): string | null {
  const $edit = $el.find('.message-lastEdit,.message-footer.message-lastEdit').first();
  if (!$edit.length) return null;
  const ts = Number($edit.find('time[data-timestamp]').attr('data-timestamp') ?? 0);
  if (ts) return new Date(ts * 1000).toISOString();
  return null;
}

/* ------------------------------------------------------------------ */
/*  RSS  — дополнительный механизм обнаружения нового            */
/* ------------------------------------------------------------------ */

export interface RssItem {
  title: string;
  link: string;
  pubDate: string | null;
  threadId: number | null;
}

export function parseRss(xml: string): RssItem[] {
  const $ = cheerio.load(xml, { xmlMode: true });
  const items: RssItem[] = [];
  $('item').each((_i, el) => {
    const $el = $(el);
    const link = cleanText($el.find('link').first().text());
    const title = cleanText($el.find('title').first().text());
    const pub = cleanText($el.find('pubDate').first().text());
    if (!link) return;
    items.push({
      title,
      link,
      pubDate: pub && !Number.isNaN(Date.parse(pub)) ? new Date(pub).toISOString() : null,
      threadId: threadIdFromUrl(link),
    });
  });
  return items;
}

/* ------------------------------------------------------------------ */
/*  Утилиты                                                             */
/* ------------------------------------------------------------------ */

export function threadIdFromUrl(url: string): number | null {
  const m = String(url ?? '').match(/\/threads\/[^/?#]*?\.(\d+)(?:[/?#]|$)/);
  if (m) return Number(m[1]);
  const m2 = String(url ?? '').match(/thread-(\d+)/);
  return m2 ? Number(m2[1]) : null;
}

export function nodeIdFromUrl(url: string): number | null {
  const m = String(url ?? '').match(/\/(?:forums|categories|pages|links)\/[^/?#]*?\.(\d+)/);
  return m ? Number(m[1]) : null;
}

export function slugFromUrl(url: string): string | null {
  const m = String(url ?? '').match(/\/(?:forums|threads|categories)\/([^./?#]+)\./);
  return m ? decodeURIComponent(m[1]!) : null;
}

export function absolute(baseUrl: string, href: string): string {
  if (!href) return baseUrl;
  if (/^https?:\/\//i.test(href)) return href;
  if (href.startsWith('//')) return `https:${href}`;
  return `${baseUrl.replace(/\/$/, '')}${href.startsWith('/') ? '' : '/'}${href}`;
}

export function cleanText(s: string): string {
  return decodeEntities(String(s ?? '')).replace(/\s+/g, ' ').trim();
}

function intOrNull(s: string): number | null {
  const t = String(s ?? '').replace(/[^\d]/g, '');
  return t ? Number(t) : null;
}
