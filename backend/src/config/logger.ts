/**
 * EPIC AI — логгер backend.
 *
 * Почему не pino (логгер Fastify по умолчанию):
 * pino пишет байты UTF-8 в stdout напрямую, минуя `console.log`. В Windows
 * консоль по умолчанию находится в OEM-кодировке (cp866/cp1251), а Node
 * транскодирует в неё только вывод `console.*`. Из-за этого русские сообщения
 * в логах превращались в «тАФ ╨░╨▓╤В╨╛╨╝╨░╤В╨╕╤З╨╡╤Б╨║╨░╤П».
 *
 * Этот логгер реализует тот же интерфейс, что нужен Fastify (`info/warn/error/
 * debug/trace/fatal/child`), но печатает через `console.*` — и в Windows,
 * и в Linux, и в PowerShell, и в cmd текст остаётся читаемым.
 *
 * Формат намеренно человекочитаемый, а не JSON: локальный backend смотрят
 * глазами в консоли. Для production-стенда с агрегатором логов достаточно
 * вернуть `logger: true` в buildServer() — интерфейс совместим.
 */

export type LogLevel = 'fatal' | 'error' | 'warn' | 'info' | 'debug' | 'trace' | 'silent';

const LEVELS: Record<LogLevel, number> = {
  silent: 0, fatal: 1, error: 2, warn: 3, info: 4, debug: 5, trace: 6,
};

const PREFIX: Record<string, string> = {
  fatal: '✖',
  error: '✖',
  warn: '⚠',
  info: '•',
  debug: '‧',
  trace: '‧',
};

/** ANSI-цвета применяются только если вывод — TTY и не включён NO_COLOR. */
const COLOR = (() => {
  if (process.env.NO_COLOR) return false;
  if (process.env.FORCE_COLOR) return true;
  return Boolean(process.stdout.isTTY);
})();

const C = {
  dim: (s: string) => (COLOR ? `\u001b[90m${s}\u001b[0m` : s),
  yellow: (s: string) => (COLOR ? `\u001b[33m${s}\u001b[0m` : s),
  red: (s: string) => (COLOR ? `\u001b[31m${s}\u001b[0m` : s),
  cyan: (s: string) => (COLOR ? `\u001b[36m${s}\u001b[0m` : s),
};

export interface EpicLogger {
  level: LogLevel;
  fatal(...args: unknown[]): void;
  error(...args: unknown[]): void;
  warn(...args: unknown[]): void;
  info(...args: unknown[]): void;
  debug(...args: unknown[]): void;
  trace(...args: unknown[]): void;
  child(bindings: Record<string, unknown>): EpicLogger;
}

function timestamp(): string {
  const d = new Date();
  const p = (n: number, l = 2) => String(n).padStart(l, '0');
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}.${p(d.getMilliseconds(), 3)}`;
}

/**
 * Fastify передаёт первым аргументом объект (bindings/err/req), а сообщение —
 * вторым. Приводим к одной строке, чтобы в консоли не было «слепых» JSON-объектов.
 *
 * Объекты запроса/ответа Fastify содержат циклические ссылки
 * (socket → parser → socket), поэтому наивный JSON.stringify на них падал с
 * «Converting circular structure to JSON». Такие объекты сворачиваем в
 * человекочитаемое резюме, всё остальное сериализуем с защитой от циклов.
 */
const RESERVED_BINDING_KEYS = new Set(['msg', 'level', 'time', 'pid', 'hostname', 'req', 'res', 'responseTime']);

function format(args: unknown[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a == null) continue;
    if (a instanceof Error) {
      out.push(a.stack ?? `${a.name}: ${a.message}`);
      continue;
    }
    if (typeof a === 'object') {
      const o = a as Record<string, any>;
      if (o.err instanceof Error) { out.push(o.err.stack ?? o.err.message); continue; }

      // Fastify-биндинги: logger.info({ req }, 'incoming request')
      //                logger.info({ req, res, responseTime }, 'request completed')
      const bind = bindingSummary(o);
      if (typeof o.msg === 'string') {
        const parts: string[] = [];
        const bind = bindingSummary(o);
        if (bind) parts.push(bind);
        for (const [k, v] of Object.entries(o)) {
          if (RESERVED_BINDING_KEYS.has(k)) continue;
          parts.push(`${k}=${stringify(v)}`);
        }
        out.push(parts.length ? `${o.msg} ${C.dim(parts.join(' '))}` : o.msg);
        continue;
      }
      if (bind !== null) {
        const next = args[i + 1];
        if (typeof next === 'string') { out.push(`${next} ${C.dim(bind)}`); i++; }
        else out.push(C.dim(bind));
        continue;
      }
      const selfSum = asRequestSummary(o);
      if (selfSum) { out.push(selfSum); continue; }
      out.push(C.dim(stringify(a)));
      continue;
    }
    out.push(String(a));
  }
  return out.length ? out : [''];
}

/** `{ req, res, responseTime }` → «GET /api/health → 200 4.0 ms». Иначе null. */
function bindingSummary(o: Record<string, any>): string | null {
  const hasReq = o.req && typeof o.req === 'object';
  const hasRes = o.res && typeof o.res === 'object';
  if (!hasReq && !hasRes) return null;
  const bits: string[] = [];
  const rq = asRequestSummary(o.req);
  if (rq) bits.push(rq);
  const rs = asResponseSummary(o.res);
  if (rs) bits.push(`→ ${rs}`);
  if (typeof o.responseTime === 'number') bits.push(`${o.responseTime.toFixed(1)} ms`);
  return bits.join(' ');
}

function asResponseSummary(v: unknown): string | null {
  if (!v || typeof v !== 'object') return null;
  const o = v as Record<string, any>;
  const raw = o.raw && typeof o.raw === 'object' ? o.raw : o;
  if (typeof raw.statusCode === 'number' &&
      (typeof raw.getHeader === 'function' || 'statusMessage' in raw || '_header' in raw)) {
    return String(raw.statusCode);
  }
  return null;
}

/**
 * Распознаёт объект запроса/ответа (Fastify Request/Reply или «сырой»
 * IncomingMessage/ServerResponse) и возвращает короткое резюме:
 * `GET /api/health` или `HTTP 200`. Иначе — null.
 */
function asRequestSummary(v: unknown): string | null {
  if (!v || typeof v !== 'object') return null;
  const o = v as Record<string, any>;
  const raw = o.raw && typeof o.raw === 'object' ? o.raw : o;
  if (typeof raw.method === 'string' && typeof raw.url === 'string' &&
      ('httpVersion' in raw || 'socket' in raw || 'headers' in raw)) {
    return `${raw.method} ${raw.url}`;
  }
  if (typeof raw.statusCode === 'number' && typeof raw.getHeader === 'function') {
    return `HTTP ${raw.statusCode}`;
  }
  return null;
}

function safeReplacer(_key: string, value: unknown): unknown {
  if (value instanceof Error) return { name: value.name, message: value.message };
  if (typeof value === 'bigint') return value.toString();
  return value;
}

/** JSON.stringify с защитой от циклических ссылок. */
function stringify(v: unknown): string {
  if (v == null) return String(v);
  if (typeof v === 'string') return v.includes(' ') ? JSON.stringify(v) : v;
  if (typeof v !== 'object') return String(v);
  const seen = new WeakSet<object>();
  try {
    return JSON.stringify(v, (key, value) => {
      if (value && typeof value === 'object') {
        const sum = asRequestSummary(value) ?? asResponseSummary(value);
        if (sum) return sum;
      }
      const r = safeReplacer(key, value);
      if (r && typeof r === 'object') {
        if (seen.has(r)) return '[Circular]';
        seen.add(r);
      }
      return r;
    });
  } catch {
    try { return String(v); } catch { return '[unserializable]'; }
  }
}

class Logger implements EpicLogger {
  level: LogLevel;
  constructor(level: LogLevel, private prefix = '') {
    this.level = level;
  }

  private enabled(l: LogLevel): boolean {
    return LEVELS[l] <= LEVELS[this.level];
  }

  /** Fastify логирует каждый запрос этими сообщениями — на info они затапливают консоль. */
  private static CHATTY = new Set(['incoming request', 'request completed']);

  private write(l: LogLevel, args: unknown[]): void {
    let level = l;
    if (level === 'info' && args.some((x) => typeof x === 'string' && Logger.CHATTY.has(x))) {
      level = 'debug';   // видно при LOG_LEVEL=debug
    }
    if (!this.enabled(level)) return;
    const head = `${C.dim(timestamp())} ${PREFIX[level] ?? '•'}${this.prefix ? C.cyan(this.prefix) : ''}`;
    const parts = format(args);
    const paint = level === 'error' || level === 'fatal' ? C.red : level === 'warn' ? C.yellow : (s: string) => s;
    const line = `${head} ${paint(parts[0] ?? '')}`;
    const sink = l === 'error' || l === 'fatal' ? console.error : l === 'warn' ? console.warn : l === 'debug' || l === 'trace' ? console.debug : console.log;
    if (parts.length > 1) sink(line, ...parts.slice(1));
    else sink(line);
  }

  fatal(...a: unknown[]) { this.write('fatal', a); }
  error(...a: unknown[]) { this.write('error', a); }
  warn(...a: unknown[]) { this.write('warn', a); }
  info(...a: unknown[]) { this.write('info', a); }
  debug(...a: unknown[]) { this.write('debug', a); }
  trace(...a: unknown[]) { this.write('trace', a); }

  child(bindings: Record<string, unknown>): EpicLogger {
    const tag = bindings?.name ?? bindings?.module ?? bindings?.component;
    const suffix = tag ? `[${String(tag)}] ` : '';
    return new Logger(this.level, `${this.prefix}${suffix ? C.dim('') + suffix : ''}`);
  }
}

export function createLogger(level?: string): EpicLogger {
  const l = (level ?? process.env.LOG_LEVEL ?? 'info') as LogLevel;
  return new Logger(LEVELS[l] !== undefined ? l : 'info');
}

export default createLogger();
