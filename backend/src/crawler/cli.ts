/**
 * CLI crawler'а: разведка форума без записи в базу.
 *
 *   npm run crawl                      — preflight + структура разделов
 *   npm run crawl -- --threads         — + списки тем
 *   npm run crawl -- --thread 13       — содержимое конкретной темы
 *   npm run crawl -- --rss             — проверка RSS
 *   npm run crawl -- --force           — игнорировать CRAWLER_ENABLED=false
 *
 * Команда ничего не пишет в БД — это инструмент разведки и отладки парсера.
 */
import { ForumCrawler } from './index.js';
import { config } from '../config/index.js';

const argv = process.argv.slice(2);
const has = (f: string) => argv.includes(f);
const val = (f: string) => { const i = argv.indexOf(f); return i >= 0 ? argv[i + 1] : undefined; };

async function main() {
  const crawler = new ForumCrawler();
  const force = has('--force');

  const pre = await crawler.preflight();
  console.log(`[crawl] baseUrl=${config.crawler.baseUrl}`);
  console.log(`[crawl] enabled=${config.crawler.enabled} respectRobots=${config.crawler.respectRobots} aiBotBlocked=${pre.aiBotBlocked}`);
  if (!pre.allowed && !force) {
    console.log(`[crawl] ОТКАЗ: ${pre.reason}`);
    console.log('[crawl] Для разведки добавьте --force (только для ручной отладки на своей машине).');
    return;
  }
  if (!pre.allowed && force) console.log('[crawl] --force: продолжаю в режиме ручной отладки');

  const threadId = val('--thread');
  if (threadId) {
    const url = `${config.crawler.baseUrl}/threads/x.${threadId}/`;
    console.log(`[crawl] fetch thread ${threadId}`);
    const t = await crawler.fetchThread(url, Number(threadId), { maxPages: Number(val('--pages') ?? 2) });
    if (!t) { console.log('[crawl] не удалось получить тему'); return; }
    console.log(`[crawl] title: ${t.title}`);
    console.log(`[crawl] author: ${t.authorName}, created: ${t.createdAt}, last: ${t.lastPostAt}`);
    console.log(`[crawl] posts: ${t.posts.length}, pageCount: ${t.pageCount}`);
    for (const p of t.posts) {
      console.log(`  --- post #${p.position} id=${p.postId} by ${p.authorName} at ${p.createdAt} (${p.text.length} chars)`);
      console.log(p.text.slice(0, 700));
    }
    return;
  }

  const nodes = await crawler.discoverNodes();
  console.log(`[crawl] разделов: ${nodes.length}`);
  for (const n of nodes) {
    const mark = n.docType ? (n.docType === 'RULE' ? 'RULE' : 'LAW ') : '    ';
    console.log(`  ${mark} [${String(n.nodeId).padStart(3)}] d${n.depth} ${n.isArchive ? 'ARCHIVE ' : '        '}${n.path}`);
  }

  if (has('--threads')) {
    const threads = await crawler.discoverThreads(nodes, { onProgress: (s, d) => console.log(`  … ${s}: ${d ?? ''}`) });
    console.log(`[crawl] тем: ${threads.length}`);
    for (const t of threads) {
      console.log(`  ${t.docType} ${t.isArchive ? '[архив]' : '       '} #${String(t.threadId).padStart(4)} ${t.title}  (${t.nodeTitle})`);
    }
  }

  if (has('--rss')) {
    const urls = nodes.filter((n) => n.docType && !n.isArchive).slice(0, 6).map((n) => n.url);
    const items = await crawler.fetchRss(urls);
    console.log(`[crawl] RSS записей: ${items.length}`);
    for (const i of items.slice(0, 20)) console.log(`  ${i.pubDate?.slice(0, 10)} #${i.threadId} ${i.title}`);
  }

  console.log(`[crawl] страниц загружено: ${crawler.http.stats.pagesFetched}`);
  const warnings = (crawler as any).warnings as string[] | undefined;
  if (warnings?.length) { console.log('[crawl] предупреждения:'); for (const w of warnings) console.log(`  ! ${w}`); }
}

main().catch((e) => { console.error(e); process.exit(1); });
