/**
 * EPIC AI — парсер robots.txt.
 *
 * Система «не должна обходить авторизацию, CAPTCHA или технические ограничения
 * сайта». robots.txt — это и есть заявленное владельцем техническое ограничение,
 * поэтому crawler обязан его соблюдать.
 *
 * ВАЖНО: robots.txt forum.epic-gta.com запрещает доступ всем AI-краулерам
 * (GPTBot, ClaudeBot, PerplexityBot, CCBot,... — Disallow: /).
 * См. docs/LEGAL.md.
 */

interface Rule { path: string; allow: boolean; }

export interface RobotsPolicy {
  /** Наш user-agent совпал с группой, закрытой для AI-ботов? */
  aiBotBlocked: boolean;
  /** Группы, которые нас описывают. */
  matchedAgents: string[];
  crawlDelaySec: number | null;
  allowed(path: string): boolean;
  raw: string;
}

function pathToRegExp(p: string): RegExp {
  let out = '';
  for (let i = 0; i < p.length; i++) {
    const ch = p[i]!;
    if (ch === '*') out += '.*';
    else if (ch === '$' && i === p.length - 1) out += '$';
    else out += ch.replace(/[.+?^{}()|[\]\\]/g, '\\$&');
  }
  if (!out.endsWith('$') && !out.endsWith('.*')) out += '(?:$|[/?#])';
  return new RegExp(`^${out}`);
}

export function parseRobots(text: string, userAgent: string): RobotsPolicy {
  const ua = userAgent.toLowerCase();
  const uaToken = (ua.match(/^[a-z0-9._\-]+/) ?? [ua])[0]!;

  const lines = String(text ?? '').split(/\r?\n/);
  const groups: { agents: string[]; rules: Rule[]; delay: number | null }[] = [];
  let cur: { agents: string[]; rules: Rule[]; delay: number | null } | null = null;

  for (const raw of lines) {
    const line = raw.replace(/#.*$/, '').trim();
    if (!line) continue;
    const idx = line.indexOf(':');
    if (idx === -1) continue;
    const key = line.slice(0, idx).trim().toLowerCase();
    const val = line.slice(idx + 1).trim();
    if (key === 'user-agent') {
      if (cur && cur.rules.length) { groups.push(cur); cur = null; }
      if (!cur) cur = { agents: [], rules: [], delay: null };
      cur.agents.push(val.toLowerCase());
    } else if (!cur) {
      continue;
    } else if (key === 'disallow') {
      if (val) cur.rules.push({ path: val, allow: false });
      else cur.rules.push({ path: '/', allow: true }); // пустой Disallow = ничего не запрещено
    } else if (key === 'allow') {
      if (val) cur.rules.push({ path: val, allow: true });
    } else if (key === 'crawl-delay') {
      const n = parseFloat(val);
      if (Number.isFinite(n)) cur.delay = n;
    }
  }
  if (cur) groups.push(cur);

  // Выбираем наиболее специфичную подходящую группу
  const exact = groups.filter((g) => g.agents.includes(uaToken) || g.agents.includes(ua));
  const wildcard = groups.filter((g) => g.agents.includes('*'));
  const matched = exact.length ? exact : wildcard;
  const matchedAgents = matched.flatMap((g) => g.agents);

  // Отдельно проверяем: закрыт ли сайт для «AI-ботов» вообще.
  const AI_BOT_TOKENS = ['bot', 'crawler', 'spider', 'gpt', 'claude', 'anthropic', 'perplexity', 'ccbot', 'ai', 'indexer', 'fetcher', 'scrape'];
  const aiGroups = groups.filter((g) => g.agents.some((a) => AI_BOT_TOKENS.some((t) => a.includes(t))));
  const aiBotBlocked = aiGroups.some((g) => g.rules.some((r) => !r.allow && (r.path === '/' || r.path === '/*')));

  const rules = matched.flatMap((g) => g.rules);
  const crawlDelaySec = matched.map((g) => g.delay).find((d) => d != null) ?? null;

  const compiled = rules.map((r) => ({...r, re: pathToRegExp(r.path) }));

  return {
    aiBotBlocked,
    matchedAgents,
    crawlDelaySec,
    raw: String(text ?? ''),
    allowed(path: string): boolean {
      const p = path.startsWith('/') ? path : `/${path}`;
      // Наиболее специфичное (длинное) правило побеждает, как в стандарте.
      let best: { len: number; allow: boolean } | null = null;
      for (const r of compiled) {
        if (r.re.test(p)) {
          if (!best || r.path.length > best.len) best = { len: r.path.length, allow: r.allow };
        }
      }
      return best ? best.allow : true;
    },
  };
}
