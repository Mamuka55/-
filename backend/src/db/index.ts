/**
 * EPIC AI — слой доступа к БД.
 *
 * Один и тот же код работает на:
 *   • SQLite через better-sqlite3  — основной локальный драйвер ;
 *   • SQLite через sql.js (WASM)   — fallback без нативных зависимостей;
 *   • PostgreSQL                   — production на VPS.
 *
 * Перенос local → VPS = смена DB_DRIVER в.env, без переписывания
 * клиентского интерфейса и бизнес-логики.
 *
 * Соглашения:
 *   - в SQL всегда пишется плейсхолдер `?`; для postgres он транслируется в $1..$n
 *   - boolean хранится как 0/1
 *   - даты: SQLite — TEXT ISO8601, Postgres — timestamptz
 */
import { mkdirSync, readFileSync, writeFileSync, existsSync, rmSync, renameSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import config from '../config/index.js';

export type Row = Record<string, any>;
export type Driver = 'sqlite' | 'postgres';

export interface DbClient {
  driver: Driver;
  /** Имя используемого sqlite-движка ('better-sqlite3' | 'sql.js') или 'pg'. */
  engine: string;
  all<T = Row>(sql: string, params?: unknown[]): Promise<T[]>;
  get<T = Row>(sql: string, params?: unknown[]): Promise<T | null>;
  run(sql: string, params?: unknown[]): Promise<{ changes: number; lastInsertId: number | string | null }>;
  transaction<T>(fn: (tx: DbClient) => Promise<T>): Promise<T>;
  flush(): Promise<void>;
  close(): Promise<void>;
}

/** `?` -> `$n` для PostgreSQL. Игнорирует `?` внутри строковых литералов и комментариев. */
export function toDriverSql(sql: string, driver: Driver): string {
  if (driver !== 'postgres') return sql;
  let out = '';
  let i = 0;
  let n = 0;
  let quote: string | null = null;
  while (i < sql.length) {
    const ch = sql[i]!;
    if (quote) {
      out += ch;
      if (ch === quote) {
        if (sql[i + 1] === quote) { out += sql[i + 1]!; i += 2; continue; }
        quote = null;
      }
      i++; continue;
    }
    if (ch === "'" || ch === '"') { quote = ch; out += ch; i++; continue; }
    if (ch === '-' && sql[i + 1] === '-') {
      while (i < sql.length && sql[i] !== '\n') { out += sql[i]!; i++; }
      continue;
    }
    if (ch === '?') { n++; out += `$${n}`; i++; continue; }
    out += ch; i++;
  }
  return out;
}

export function normalizeParams(params: unknown[] = []): unknown[] {
  return params.map((p) => {
    if (p === undefined) return null;
    if (typeof p === 'boolean') return p ? 1 : 0;
    if (p instanceof Date) return p.toISOString();
    if (p !== null && typeof p === 'object') return JSON.stringify(p);
    return p;
  });
}

/** Простейший мьютекс: SQLite пишет в один поток. */
const mutex = (() => {
  let tail: Promise<void> = Promise.resolve();
  let unlock: (() => void) | null = null;
  return {
    acquire(): Promise<void> {
      const prev = tail;
      tail = new Promise<void>((res) => { unlock = res; });
      return prev;
    },
    release(): void { const u = unlock; unlock = null; u?.(); },
  };
})();

/* ------------------------------------------------------------------ */
/*  SQLite: better-sqlite3                                             */
/* ------------------------------------------------------------------ */

class BetterSqliteClient implements DbClient {
  driver: Driver = 'sqlite';
  engine = 'better-sqlite3';
  constructor(private db: any) {}
  async all<T = Row>(sql: string, params: unknown[] = []): Promise<T[]> {
    return this.db.prepare(sql).all(...normalizeParams(params)) as T[];
  }
  async get<T = Row>(sql: string, params: unknown[] = []): Promise<T | null> {
    return (this.db.prepare(sql).get(...normalizeParams(params)) as T) ?? null;
  }
  async run(sql: string, params: unknown[] = []) {
    const info = this.db.prepare(sql).run(...normalizeParams(params));
    return { changes: Number(info.changes ?? 0), lastInsertId: info.lastInsertRowid ?? null };
  }
  async transaction<T>(fn: (tx: DbClient) => Promise<T>): Promise<T> {
    await mutex.acquire();
    try {
      this.db.exec('BEGIN');
      const res = await fn(this);
      this.db.exec('COMMIT');
      return res;
    } catch (e) {
      try { this.db.exec('ROLLBACK'); } catch { /* ignore */ }
      throw e;
    } finally { mutex.release(); }
  }
  async flush(): Promise<void> { /* WAL checkpoint happens automatically */ }
  async close(): Promise<void> { this.db.close(); }
}

/* ------------------------------------------------------------------ */
/*  SQLite: sql.js (WASM) — файловая персистенция                       */
/* ------------------------------------------------------------------ */

class SqlJsClient implements DbClient {
  driver: Driver = 'sqlite';
  engine = 'sql.js';
  private db: any;
  private dirty = false;
  private timer: NodeJS.Timeout | null = null;
  private filePath: string;

  constructor(db: any, filePath: string) {
    this.db = db;
    this.filePath = filePath;
  }

  static async open(filePath: string): Promise<SqlJsClient> {
    const initSqlJs: any = (await import('sql.js')).default;
    const SQL = await initSqlJs();
    mkdirSync(dirname(filePath), { recursive: true });
    const db = existsSync(filePath) ? new SQL.Database(readFileSync(filePath)) : new SQL.Database();
    return new SqlJsClient(db, filePath);
  }

  private markDirty(): void {
    this.dirty = true;
    if (this.timer) return;
    this.timer = setTimeout(() => { void this.flush(); }, 250);
    if (typeof this.timer.unref === 'function') this.timer.unref();
  }

  async flush(): Promise<void> {
    if (this.timer) { clearTimeout(this.timer); this.timer = null; }
    if (!this.dirty) return;
    const data: Uint8Array = this.db.export();
    const tmp = `${this.filePath}.tmp`;
    writeFileSync(tmp, Buffer.from(data));
    if (existsSync(this.filePath)) {
      try { rmSync(`${this.filePath}.bak`); } catch { /* ignore */ }
      try { renameSync(this.filePath, `${this.filePath}.bak`); } catch { /* ignore */ }
    }
    renameSync(tmp, this.filePath);
    this.dirty = false;
  }

  private exec(sql: string, params: unknown[]): any[] {
    const norm = normalizeParams(params);
    // sql.js: run() для DML/DDL, prepare+step для SELECT
    const trimmed = sql.replace(/^\s*(--[^\n]*\n|\s)*/, '');
    const isSelect = /^(WITH|SELECT|PRAGMA)\b/i.test(trimmed);
    if (!isSelect) {
      this.db.run(sql, norm as any[]);
      this.markDirty();
      const res = this.db.exec('SELECT changes() AS c, last_insert_rowid() AS r');
      const row = res?.[0] ? { c: res[0].values[0][0], r: res[0].values[0][1] } : { c: 0, r: 0 };
      return [{ __changes: Number(row.c), __lastInsertId: Number(row.r) }];
    }
    const stmt = this.db.prepare(sql);
    try {
      if (norm.length) stmt.bind(norm as any[]);
      const rows: any[] = [];
      while (stmt.step()) rows.push(stmt.getAsObject());
      return rows;
    } finally { stmt.free(); }
  }

  async all<T = Row>(sql: string, params: unknown[] = []): Promise<T[]> {
    return this.exec(sql, params) as T[];
  }
  async get<T = Row>(sql: string, params: unknown[] = []): Promise<T | null> {
    const rows = this.exec(sql, params);
    return (rows[0] as T) ?? null;
  }
  async run(sql: string, params: unknown[] = []) {
    const r = this.exec(sql, params)[0] as any;
    return { changes: Number(r?.__changes ?? 0), lastInsertId: r?.__lastInsertId ?? null };
  }
  async transaction<T>(fn: (tx: DbClient) => Promise<T>): Promise<T> {
    await mutex.acquire();
    try {
      this.db.run('BEGIN');
      const res = await fn(this);
      this.db.run('COMMIT');
      this.markDirty();
      return res;
    } catch (e) {
      try { this.db.run('ROLLBACK'); } catch { /* ignore */ }
      throw e;
    } finally { mutex.release(); }
  }
  async close(): Promise<void> { await this.flush(); this.db.close(); }
}

/* ------------------------------------------------------------------ */
/*  PostgreSQL                                                         */
/* ------------------------------------------------------------------ */

class PgClient implements DbClient {
  driver: Driver = 'postgres';
  engine = 'pg';
  constructor(private pool: any) {}
  private q(sql: string, params: unknown[] = []) {
    return this.pool.query(toDriverSql(sql, 'postgres'), normalizeParams(params));
  }
  async all<T = Row>(sql: string, params: unknown[] = []): Promise<T[]> {
    return (await this.q(sql, params)).rows as T[];
  }
  async get<T = Row>(sql: string, params: unknown[] = []): Promise<T | null> {
    const r = await this.q(sql, params);
    return (r.rows[0] as T) ?? null;
  }
  async run(sql: string, params: unknown[] = []) {
    const r = await this.q(sql, params);
    return { changes: r.rowCount ?? 0, lastInsertId: r.rows?.[0]?.id ?? null };
  }
  async transaction<T>(fn: (tx: DbClient) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    const tx: DbClient = {
      driver: 'postgres',
      engine: 'pg',
      all: async (sql, params = []) => (await client.query(toDriverSql(sql, 'postgres'), normalizeParams(params))).rows,
      get: async (sql, params = []) => (await client.query(toDriverSql(sql, 'postgres'), normalizeParams(params))).rows[0] ?? null,
      run: async (sql, params = []) => {
        const r = await client.query(toDriverSql(sql, 'postgres'), normalizeParams(params));
        return { changes: r.rowCount ?? 0, lastInsertId: r.rows?.[0]?.id ?? null };
      },
      transaction: async (inner) => inner(tx),
      flush: async () => {},
      close: async () => client.release(),
    };
    try {
      await client.query('BEGIN');
      const res = await fn(tx);
      await client.query('COMMIT');
      return res;
    } catch (e) {
      try { await client.query('ROLLBACK'); } catch { /* ignore */ }
      throw e;
    } finally { client.release(); }
  }
  async flush(): Promise<void> {}
  async close(): Promise<void> { await this.pool.end(); }
}

/* ------------------------------------------------------------------ */
/*  Фабрика                                                            */
/* ------------------------------------------------------------------ */

let instance: DbClient | null = null;
let opening: Promise<DbClient> | null = null;

async function openSqlite(): Promise<DbClient> {
  const file = resolve(config.db.sqlitePath);
  mkdirSync(dirname(file), { recursive: true });
  const pref = (process.env.DB_SQLITE_ENGINE ?? 'auto').toLowerCase(); // auto | better-sqlite3 | sql.js

  if (pref !== 'sql.js') {
    try {
      const mod: any = await import('better-sqlite3');
      const Database = mod.default ?? mod;
      const db = new Database(file);
      db.pragma('journal_mode = WAL');
      db.pragma('foreign_keys = ON');
      db.pragma('busy_timeout = 5000');
      return new BetterSqliteClient(db);
    } catch (e: any) {
      if (pref === 'better-sqlite3') throw e;
      console.warn(`[epic-ai][db] better-sqlite3 недоступен (${String(e?.message).split('\n')[0]}), переключаюсь на sql.js (WASM).`);
    }
  }
  return SqlJsClient.open(file);
}

export async function getDb(): Promise<DbClient> {
  if (instance) return instance;
  if (!opening) {
    opening = (async () => {
      if (config.db.driver === 'postgres') {
        const { default: pg } = await import('pg');
        instance = new PgClient(new pg.Pool({...config.db.pg, max: 10 }));
      } else {
        instance = await openSqlite();
      }
      return instance;
    })().finally(() => { opening = null; });
  }
  return opening;
}

export async function flushDb(): Promise<void> { if (instance) await instance.flush(); }
export async function closeDb(): Promise<void> {
  if (instance) { await instance.close(); instance = null; }
}

/* ------------------------------------------------------------------ */
/*  Утилиты                                                            */
/* ------------------------------------------------------------------ */

export async function insertReturningId(db: DbClient, table: string, data: Row): Promise<number> {
  const keys = Object.keys(data);
  const sql = db.driver === 'postgres'
    ? `INSERT INTO ${table} (${keys.join(', ')}) VALUES (${keys.map((_, i) => `$${i + 1}`).join(', ')}) RETURNING id`
    : `INSERT INTO ${table} (${keys.join(', ')}) VALUES (${keys.map(() => '?').join(', ')})`;
  const values = keys.map((k) => data[k]);

  if (db.driver === 'postgres') {
    const rows = await db.all<Row>(sql, values);
    return Number(rows[0]?.id ?? 0);
  }
  const res = await db.run(sql, values);
  return Number(res.lastInsertId ?? 0);
}

export const nowIso = (): string => new Date().toISOString();
export const toBool = (v: unknown): boolean => v === true || v === 1 || v === '1' || v === 't' || v === 'true';

export function toDate(v: unknown): Date | null {
  if (v == null) return null;
  if (v instanceof Date) return v;
  if (typeof v === 'number') return new Date(v);
  let s = String(v);
  // SQLite: 'YYYY-MM-DD HH:MM:SS' → парсим как UTC
  if (/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(s)) s = s.replace(' ', 'T') + 'Z';
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? null : d;
}

/** Формат : 05.10.2026 20:14 */
export function formatDateTime(v: unknown, withTime = true): string {
  const d = toDate(v);
  if (!d) return '—';
  const p = (n: number) => String(n).padStart(2, '0');
  const date = `${p(d.getDate())}.${p(d.getMonth() + 1)}.${d.getFullYear()}`;
  return withTime ? `${date} ${p(d.getHours())}:${p(d.getMinutes())}` : date;
}

export function parseJson<T = any>(v: unknown, fallback: T = null as any): T {
  if (v == null) return fallback;
  if (typeof v === 'object') return v as T;
  try { return JSON.parse(String(v)) as T; } catch { return fallback; }
}
