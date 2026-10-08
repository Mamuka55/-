/**
 * EPIC AI — вежливый HTTP-клиент crawler'а.
 *
 * Принципы:
 *  • один поток запросов + обязательная пауза (CRAWLER_DELAY_MS / Crawl-delay);
 *  • условные GET (ETag / Last-Modified) — не качаем то, что не менялось;
 *  • backoff на 429/503 и уважение Retry-After;
 *  • честный User-Agent с контактом для связи с администрацией;
 *  • проверка robots.txt перед каждым запросом.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { config } from '../config/index.js';
import { parseRobots, type RobotsPolicy } from './robots.js';

export interface FetchResult {
  url: string;
  status: number;
  body: string;
  etag: string | null;
  lastModified: string | null;
  fromCache: boolean;
  notModified: boolean;
  ms: number;
  contentType: string;
}

interface CacheEntry {
  url: string;
  etag: string | null;
  lastModified: string | null;
  fetchedAt: string;
  status: number;
  bodyHash: string;
}

export class ForumHttpClient {
  private robots: RobotsPolicy | null = null;
  private robotsLoaded = false;
  private lastRequestAt = 0;
  private pagesFetched = 0;
  private cacheDir: string;
  private bodiesDir: string;
  private onWarn?: (msg: string) => void;

  /** Полностью офлайн: только кэш, ни одного сетевого запроса. */
  offline = false;

  constructor(opts: { baseUrl?: string; userAgent?: string; cacheDir?: string; offline?: boolean; onWarn?: (m: string) => void } = {}) {
    this.baseUrl = (opts.baseUrl ?? config.crawler.baseUrl).replace(/\/$/, '');
    this.userAgent = opts.userAgent ?? config.crawler.userAgent;
    this.cacheDir = opts.cacheDir ?? config.crawler.cacheDir;
    this.bodiesDir = join(this.cacheDir, 'bodies');
    this.onWarn = opts.onWarn;
    this.offline = Boolean(opts.offline);
    mkdirSync(this.bodiesDir, { recursive: true });
  }

  readonly baseUrl: string;
  readonly userAgent: string;

  get stats() { return { pagesFetched: this.pagesFetched }; }

  private cacheKey(url: string): string {
    return createHash('sha256').update(url).digest('hex').slice(0, 40);
  }
  private metaPath(url: string): string { return join(this.cacheDir, `${this.cacheKey(url)}.json`); }
  private bodyPath(url: string): string { return join(this.bodiesDir, `${this.cacheKey(url)}.html`); }

  private readMeta(url: string): CacheEntry | null {
    const p = this.metaPath(url);
    if (!existsSync(p)) return null;
    try { return JSON.parse(readFileSync(p, 'utf8')) as CacheEntry; } catch { return null; }
  }
  private writeMeta(url: string, meta: CacheEntry): void {
    try { writeFileSync(this.metaPath(url), JSON.stringify(meta, null, 2)); } catch { /* ignore */ }
  }
  private readBody(url: string): string | null {
    const p = this.bodyPath(url);
    if (!existsSync(p)) return null;
    try { return readFileSync(p, 'utf8'); } catch { return null; }
  }
  private writeBody(url: string, body: string): void {
    try { writeFileSync(this.bodyPath(url), body); } catch { /* ignore */ }
  }

  /* ---------------- robots.txt ---------------- */

  async loadRobots(): Promise<RobotsPolicy | null> {
    if (this.robotsLoaded) return this.robots;
    this.robotsLoaded = true;
    if (!config.crawler.respectRobots) return null;
    try {
      const res = await fetch(`${this.baseUrl}/robots.txt`, {
        headers: { 'User-Agent': this.userAgent, Accept: 'text/plain' },
        signal: AbortSignal.timeout(config.crawler.timeoutMs),
      });
      if (!res.ok) return null;
      const text = await res.text();
      this.robots = parseRobots(text, this.userAgent);
      if (this.robots.aiBotBlocked) {
        this.onWarn?.(
          'robots.txt форума запрещает доступ AI-краулерам. Epic AI по умолчанию НЕ обходит это ограничение. ' +
          'Получите письменное разрешение администрации форума (см. docs/LEGAL.md).',
        );
      }
      return this.robots;
    } catch (e: any) {
      this.onWarn?.(`Не удалось загрузить robots.txt: ${e.message}`);
      return null;
    }
  }

  async isAllowed(url: string): Promise<boolean> {
    if (!config.crawler.respectRobots) return true;
    const robots = await this.loadRobots();
    if (!robots) return true;
    const path = new URL(url).pathname + new URL(url).search;
    return robots.allowed(path);
  }

  /* ---------------- throttling ---------------- */

  private async throttle(): Promise<void> {
    const robotsDelay = this.robots?.crawlDelaySec ? this.robots.crawlDelaySec * 1000 : 0;
    const delay = Math.max(config.crawler.delayMs, robotsDelay, 500);
    const wait = this.lastRequestAt + delay - Date.now();
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    this.lastRequestAt = Date.now();
  }

  /* ---------------- fetch ---------------- */

  async get(pathOrUrl: string, opts: { useCache?: boolean; allowRobotsBlocked?: boolean } = {}): Promise<FetchResult | null> {
    const url = pathOrUrl.startsWith('http') ? pathOrUrl : `${this.baseUrl}${pathOrUrl.startsWith('/') ? '' : '/'}${pathOrUrl}`;

    if (this.pagesFetched >= config.crawler.maxPagesPerRun) {
      this.onWarn?.(`Достигнут лимит страниц за прогон (${config.crawler.maxPagesPerRun})`);
      return null;
    }
    if (!opts.allowRobotsBlocked && !(await this.isAllowed(url))) {
      this.onWarn?.(`Пропущено (robots.txt запрещает): ${url}`);
      return null;
    }

    const meta = this.readMeta(url);

    // Offline-режим: не трогаем сеть вообще, работаем только по кэшу.
    if (this.offline) {
      const cachedBody = this.readBody(url);
      if (cachedBody == null || !meta) return null;
      return {
        url, status: meta.status, body: cachedBody, etag: meta.etag, lastModified: meta.lastModified,
        fromCache: true, notModified: true, ms: 0, contentType: 'text/html',
      };
    }

    const headers: Record<string, string> = {
      'User-Agent': this.userAgent,
      Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      'Accept-Language': 'ru-RU,ru;q=0.9,en;q=0.6',
      Connection: 'keep-alive',
    };
    if (opts.useCache !== false && meta) {
      if (meta.etag) headers['If-None-Match'] = meta.etag;
      if (meta.lastModified) headers['If-Modified-Since'] = meta.lastModified;
    }

    await this.throttle();
    const started = Date.now();
    let res: Response;
    try {
      res = await fetch(url, { headers, redirect: 'follow', signal: AbortSignal.timeout(config.crawler.timeoutMs) });
    } catch (e: any) {
      this.onWarn?.(`Сетевая ошибка ${url}: ${e.message}`);
      const cachedBody = this.readBody(url);
      if (cachedBody != null && meta) {
        return { url, status: meta.status, body: cachedBody, etag: meta.etag, lastModified: meta.lastModified, fromCache: true, notModified: false, ms: 0, contentType: 'text/html' };
      }
      return null;
    }

    if (res.status === 304) {
      this.pagesFetched++;
      const cachedBody = this.readBody(url);
      if (cachedBody != null) {
        return {
          url, status: 304, body: cachedBody, etag: meta?.etag ?? null, lastModified: meta?.lastModified ?? null,
          fromCache: true, notModified: true, ms: Date.now() - started, contentType: 'text/html',
        };
      }
    }

    if (res.status === 429 || res.status === 503) {
      const retryAfter = Number(res.headers.get('retry-after') ?? 0) * 1000;
      const wait = Math.max(retryAfter, 30_000);
      this.onWarn?.(`${res.status} от форума, пауза ${Math.round(wait / 1000)} c: ${url}`);
      await new Promise((r) => setTimeout(r, wait));
      return this.get(pathOrUrl, {...opts, useCache: false });
    }

    const body = await res.text();
    const ms = Date.now() - started;
    this.pagesFetched++;

    if (res.ok) {
      this.writeBody(url, body);
      this.writeMeta(url, {
        url,
        etag: res.headers.get('etag'),
        lastModified: res.headers.get('last-modified'),
        fetchedAt: new Date().toISOString(),
        status: res.status,
        bodyHash: createHash('sha256').update(body).digest('hex'),
      });
    }

    return {
      url,
      status: res.status,
      body,
      etag: res.headers.get('etag'),
      lastModified: res.headers.get('last-modified'),
      fromCache: false,
      notModified: false,
      ms,
      contentType: res.headers.get('content-type') ?? '',
    };
  }
}
