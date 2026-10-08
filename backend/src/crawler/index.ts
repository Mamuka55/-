/**
 * EPIC AI — crawler форума.
 *
 *   forum.epic-gta.com → Crawler → Parser → Normalizer → Version Manager → Knowledge Base
 *
 * Crawler работает на backend, НЕ в Electron. Работает только с публичными
 * страницами, не обходит авторизацию, CAPTCHA и robots.txt.
 *
 * По умолчанию crawler ВЫКЛЮЧЕН (CRAWLER_ENABLED=false) — см. docs/LEGAL.md.
 */
import { config } from '../config/index.js';
import { ForumHttpClient } from './http.js';
import {
  parseForumIndex, parseThreadList, parseThread, parseRss,
  nodeIdFromUrl, type ForumNode, type ThreadSummary, type ParsedThread, type RssItem,
} from './xenforo.js';

export interface CrawlOptions {
  /** Полный обход разделов (иначе — только RSS/быстрая проверка). */
  full?: boolean;
  /** Только конкретные node id. */
  nodeIds?: number[];
  /** Не читать/не писать HTTP-кэш. */
  noCache?: boolean;
  /** Колбэк прогресса для UI/лога. */
  onProgress?: (step: string, detail?: string) => void;
  onWarn?: (msg: string) => void;
}

export interface DiscoveredNode extends ForumNode {
  docType: 'RULE' | 'LAW' | null;
  isArchive: boolean;
  path: string;
}

export interface DiscoveredThread extends ThreadSummary {
  nodeId: number;
  nodeTitle: string;
  docType: 'RULE' | 'LAW';
  isArchive: boolean;
  nodePath: string;
}

export interface CrawlResult {
  nodes: DiscoveredNode[];
  threads: DiscoveredThread[];
  rssHints: RssItem[];
  pagesFetched: number;
  warnings: string[];
  startedAt: string;
  finishedAt: string;
}

export class ForumCrawler {
  readonly http: ForumHttpClient;
  private warnings: string[] = [];

  constructor(opts: { baseUrl?: string; userAgent?: string; offline?: boolean } = {}) {
    this.http = new ForumHttpClient({
      baseUrl: opts.baseUrl,
      userAgent: opts.userAgent,
      offline: opts.offline,
      onWarn: (m) => this.warnings.push(m),
    });
  }

  /** Разрешено ли вообще запускать crawler. */
  async preflight(): Promise<{ allowed: boolean; reason?: string; aiBotBlocked: boolean }> {
    if (!config.crawler.enabled) {
      return {
        allowed: false,
        aiBotBlocked: false,
        reason: 'Crawler отключён (CRAWLER_ENABLED=false). Включайте только после согласования с администрацией форума — см. docs/LEGAL.md.',
      };
    }
    const robots = await this.http.loadRobots();
    if (robots?.aiBotBlocked && config.crawler.respectRobots) {
      const testPath = '/forums/obshchiye-pravila.38/';
      if (!robots.allowed(testPath)) {
        return {
          allowed: false,
          aiBotBlocked: true,
          reason: 'robots.txt форума запрещает автоматический доступ. Требуется письменное разрешение администрации forum.epic-gta.com.',
        };
      }
    }
    return { allowed: true, aiBotBlocked: Boolean(robots?.aiBotBlocked) };
  }

  /* ---------------------------------------------------------------- */
  /*  Шаг 1: структура форума                                           */
  /* ---------------------------------------------------------------- */

  async discoverNodes(): Promise<DiscoveredNode[]> {
    const res = await this.http.get('/', { useCache: true });
    if (!res || !res.body) {
      this.warnings.push('Не удалось загрузить главную страницу форума');
      return [];
    }
    const raw = parseForumIndex(res.body, this.http.baseUrl);
    return classifyNodes(raw);
  }

  /* ---------------------------------------------------------------- */
  /*  Шаг 2: темы в разделах                                            */
  /* ---------------------------------------------------------------- */

  async discoverThreads(nodes: DiscoveredNode[], opts: CrawlOptions = {}): Promise<DiscoveredThread[]> {
    const targets = nodes.filter((n) => {
      if (n.kind !== 'forum') return false;
      if (opts.nodeIds?.length && !opts.nodeIds.includes(n.nodeId)) return false;
      // Только разделы правил и законов: остальное (RP-биографии, предложения,
      // жалобы) в базу знаний не попадает.
      return n.docType === 'RULE' || n.docType === 'LAW';
    });

    const byId = new Map(nodes.map((n) => [n.nodeId, n]));
    const out: DiscoveredThread[] = [];
    let i = 0;
    for (const node of targets) {
      i++;
      opts.onProgress?.('threads', `Раздел ${i}/${targets.length}: ${node.title}`);
      let url = node.url;
      let page = 0;
      while (url && page < 12) {
        page++;
        const res = await this.http.get(url, { useCache: true });
        if (!res || !res.body || !res.notModified === false) { /* 304 с кэшем — ок */ }
        if (!res || !res.body) break;
        const parsed = parseThreadList(res.body, this.http.baseUrl);
        for (const t of parsed.threads) {
          if (out.some((x) => x.threadId === t.threadId)) continue;
          out.push({
           ...t,
            nodeId: node.nodeId,
            nodeTitle: node.title,
            docType: node.docType!,
            isArchive: node.isArchive || isArchivePath(node.path, t.title) || Boolean(t.prefix && /архив/i.test(t.prefix)),
            nodePath: node.path,
          });
        }
        if (!parsed.nextPage) break;
        url = parsed.nextPage;
      }
    }
    return out;
  }

  /* ---------------------------------------------------------------- */
  /*  Шаг 3: содержимое тем                                             */
  /* ---------------------------------------------------------------- */

  async fetchThread(threadUrl: string, threadId: number, opts: { maxPages?: number; noCache?: boolean } = {}): Promise<ParsedThread | null> {
    let url: string | null = threadUrl;
    let merged: ParsedThread | null = null;
    let page = 0;
    const maxPages = opts.maxPages ?? 6;

    while (url && page < maxPages) {
      page++;
      const res = await this.http.get(url, { useCache: opts.noCache ? false : true });
      if (!res || !res.body) break;
      const parsed = parseThread(res.body, this.http.baseUrl, threadId);
      if (!parsed) break;
      if (!merged) merged = parsed;
      else {
        // Склеиваем посты со всех страниц
        const known = new Set(merged.posts.map((p) => p.postId ?? p.position));
        for (const p of parsed.posts) {
          const key = p.postId ?? p.position;
          if (!known.has(key)) merged.posts.push(p);
        }
        merged.pageCount = Math.max(merged.pageCount, parsed.pageCount);
        if (parsed.lastPostAt && (!merged.lastPostAt || parsed.lastPostAt > merged.lastPostAt)) merged.lastPostAt = parsed.lastPostAt;
      }
      if (merged.pageCount <= page) break;
      url = `${threadUrl.replace(/\/$/, '')}/page-${page + 1}`;
    }
    if (merged) {
    // ВАЖНО: страницы темы склеиваются в порядке обхода, а не в порядке
    // документа, поэтому сортируем по postId — это и есть хронология XenForo.
    merged.posts.sort((a, b) => {
      const ka = a.postId ?? Number.MAX_SAFE_INTEGER;
      const kb = b.postId ?? Number.MAX_SAFE_INTEGER;
      if (ka !== kb) return ka - kb;
      return a.position - b.position;
    });
    merged.posts.forEach((p, i) => { p.position = i + 1; });
  }
    return merged;
  }

  /* ---------------------------------------------------------------- */
  /*  RSS — дополнительный механизм обнаружения                  */
  /* ---------------------------------------------------------------- */

  async fetchRss(nodeUrls: string[]): Promise<RssItem[]> {
    const items: RssItem[] = [];
    for (const u of nodeUrls) {
      const rssUrl = u.replace(/\/$/, '') + '/index.rss';
      if (!(await this.http.isAllowed(rssUrl))) continue;
      const res = await this.http.get(rssUrl, { useCache: false });
      if (!res || !res.body) continue;
      for (const it of parseRss(res.body)) if (!items.some((x) => x.link === it.link)) items.push(it);
    }
    return items;
  }

  /* ---------------------------------------------------------------- */
  /*  Полный прогон                                                     */
  /* ---------------------------------------------------------------- */

  async run(opts: CrawlOptions = {}): Promise<CrawlResult> {
    const startedAt = new Date().toISOString();
    this.warnings = [];

    const pre = await this.preflight();
    if (!pre.allowed) {
      return {
        nodes: [], threads: [], rssHints: [], pagesFetched: 0,
        warnings: [pre.reason ?? 'Crawler отключён'],
        startedAt, finishedAt: new Date().toISOString(),
      };
    }

    opts.onProgress?.('nodes', 'Читаю структуру форума…');
    const nodes = await this.discoverNodes();
    opts.onProgress?.('nodes', `Найдено разделов: ${nodes.length}`);

    const threads = await this.discoverThreads(nodes, opts);
    opts.onProgress?.('threads', `Найдено тем: ${threads.length}`);

    let rssHints: RssItem[] = [];
    if (opts.full) {
      const rssNodes = nodes.filter((n) => (n.docType === 'RULE' || n.docType === 'LAW') && !n.isArchive).map((n) => n.url);
      rssHints = await this.fetchRss(rssNodes.slice(0, 10));
      opts.onProgress?.('rss', `RSS: ${rssHints.length} записей`);
    }

    return {
      nodes, threads, rssHints,
      pagesFetched: this.http.stats.pagesFetched,
      warnings: [...this.warnings,...(pre.aiBotBlocked ? ['ВНИМАНИЕ: robots.txt форума помечает AI-ботов как запрещённых. Проверьте docs/LEGAL.md.'] : [])],
      startedAt,
      finishedAt: new Date().toISOString(),
    };
  }
}

/* ------------------------------------------------------------------ */
/*  Классификация разделов                             */
/* ------------------------------------------------------------------ */

const RULES_NODE_IDS = new Set(config.crawler.rulesNodes);
const LAWS_NODE_IDS = new Set(config.crawler.lawsNodes);

const RULES_HINTS = /правила|правило|регламент|устав|инструкция|обязанност/i;
const LAWS_HINTS = /закон|кодекс|конституци|penal code|прецедент|судебн|сенат|правительств|юридич|адвокат|ордер|законодатель/i;
// Разделы, которые точно не являются ни правилами, ни законодательными документами.
// «Жалобы» формально лежат внутри Министерства Юстиции, но это обращения граждан,
// а не нормы права — в базу знаний они попадать не должны.
const IGNORE_HINTS = /биограф|предложени|жалоб|претензи|мероприят|rp-ситуа|новост|конкурс|розыгрыш|поиск|ваканс|отчет|отчёт|заявк/i;

/**
 * Классификация всего дерева разделов.
 *
 * Два прохода:
 *  1) по заголовку и явно заданным node id (CRAWLER_RULES_NODES / LAWS_NODES);
 *  2) наследование от родителя — подразделы «Правил сервера» и «Законодательной
 *     базы» получают тип родителя. Без этого теряются разделы, в названии
 *     которых нет слова «правила» (например «Правила зелёных зон» → ок,
 *     а вот подраздел без ключевого слова → нет).
 *
 * Организационные разделы (LSPD, FBI, синдикаты, РП-биографии, предложения,
 * жалобы) в базу знаний не попадают: ограничивает базу правилами
 * и законодательными документами.
 */
export function classifyNodes(raw: ForumNode[]): DiscoveredNode[] {
  const byId = new Map<number, ForumNode>();
  for (const n of raw) byId.set(n.nodeId, n);

  const pathOf = (n: ForumNode): string => {
    const chain: string[] = [];
    let cur: ForumNode | undefined = n;
    let guard = 0;
    while (cur && guard++ < 24) {
      chain.unshift(cur.title);
      cur = cur.parentNodeId == null ? undefined : byId.get(cur.parentNodeId);
    }
    return chain.join(' / ');
  };

  const out = new Map<number, DiscoveredNode>();
  for (const n of raw) {
    const path = pathOf(n);
    out.set(n.nodeId, {
     ...n,
      docType: classifyNode(n, path),
      isArchive: isArchivePath(path, n.title),
      path,
    });
  }

  // Проход 2: наследование типа от родителя
  const INHERIT_RULE = /правила сервера|правила проекта|правила для/i;
  const INHERIT_LAW = /законодательная база|законодательн/i;
  for (let pass = 0; pass < 3; pass++) {
    let changed = false;
    for (const n of out.values()) {
      if (n.docType || n.parentNodeId == null) continue;
      const parent = out.get(n.parentNodeId);
      if (!parent) continue;
      if (parent.docType === 'RULE' && (INHERIT_RULE.test(parent.title) || INHERIT_RULE.test(parent.path))) {
        n.docType = 'RULE'; changed = true;
      } else if (parent.docType === 'LAW' && (INHERIT_LAW.test(parent.title) || INHERIT_LAW.test(parent.path))) {
        n.docType = 'LAW'; changed = true;
      } else if (parent.docType) {
        n.docType = parent.docType; changed = true;
      }
    }
    if (!changed) break;
  }
  return [...out.values()].sort((a, b) => a.nodeId - b.nodeId);
}

export function classifyNode(node: ForumNode, path: string): 'RULE' | 'LAW' | null {
  if (node.kind !== 'forum' && node.kind !== 'category') return null;
  if (IGNORE_HINTS.test(node.title)) return null;

  // Явно перечисленные в конфиге разделы — всегда в базе
  if (LAWS_NODE_IDS.has(node.nodeId)) return 'LAW';
  if (RULES_NODE_IDS.has(node.nodeId)) return 'RULE';

  // Категория «Правила сервера» — корень дерева правил (нужна для наследования)
  if (node.kind === 'category' && /правила/i.test(node.title)) return 'RULE';

  if (LAWS_HINTS.test(node.title)) return 'LAW';
  if (RULES_HINTS.test(node.title)) return 'RULE';
  if (pathHasAny(path, RULES_NODE_IDS, node)) return 'RULE';
  return null;
}

function pathHasAny(path: string, ids: Set<number>, node: ForumNode): boolean {
  // Эвристика: раздел «Правила сервера» — родитель всех подразделов правил.
  return /правила сервера/i.test(path) || /законодатель/i.test(path) || ids.has(node.nodeId);
}

export function isArchivePath(path: string, title: string): boolean {
  const hay = `${path} ${title}`.toLowerCase();
  return config.crawler.archiveMarkers.some((m) => hay.includes(m.toLowerCase()));
}

export { nodeIdFromUrl };
