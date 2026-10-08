/**
 * EPIC AI — миграции и сиды.
 *
 * Файлы миграций: database/migrations/NNN_name.common.sql
 *                database/migrations/NNN_name.<driver>.sql   (опционально)
 * Плейсхолдеры в SQL: {PK}, {TIMESTAMP}, {NOW}, {BOOL} — подставляются по драйверу.
 *
 * Сиды: database/seeds/NNN_name.sql — должны быть идемпотентными (ON CONFLICT ...),
 * поэтому их можно запускать повторно.
 */
import { readdirSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { join, basename } from 'node:path';
import config from '../config/index.js';
import { getDb, closeDb, type DbClient, type Row } from './index.js';

const MIGRATIONS_TABLE = `CREATE TABLE IF NOT EXISTS schema_migrations (
  name VARCHAR(255) PRIMARY KEY,
  applied_at TIMESTAMP NOT NULL
)`;

function dialectTokens(driver: 'sqlite' | 'postgres'): Record<string, string> {
  return driver === 'sqlite'
    ? {
        '{PK}': 'INTEGER PRIMARY KEY AUTOINCREMENT',
        '{TIMESTAMP}': 'TEXT',
        '{NOW}': "(datetime('now'))",
        '{BOOL}': 'INTEGER',
      }
    : {
        '{PK}': 'BIGSERIAL PRIMARY KEY',
        '{TIMESTAMP}': 'TIMESTAMPTZ',
        '{NOW}': 'NOW()',
        '{BOOL}': 'SMALLINT',
      };
}

function applyTokens(sql: string, driver: 'sqlite' | 'postgres'): string {
  const t = dialectTokens(driver);
  return sql.replace(/\{(PK|TIMESTAMP|NOW|BOOL)\}/g, (m) => t[m] ?? m);
}

/**
 * Разбиение SQL-скрипта на инструкции.
 * Учитывает: `--` комментарии, строковые литералы, скобки (CREATE VIRTUAL TABLE ... (...)).
 */
export function splitStatements(sql: string): string[] {
  const out: string[] = [];
  let buf = '';
  let depth = 0;
  let quote: string | null = null;
  let i = 0;
  while (i < sql.length) {
    const ch = sql[i]!;
    if (quote) {
      buf += ch;
      if (ch === quote) {
        if (sql[i + 1] === quote) { buf += sql[i + 1]!; i += 2; continue; }
        quote = null;
      }
      i++; continue;
    }
    if (ch === '-' && sql[i + 1] === '-') {
      while (i < sql.length && sql[i] !== '\n') i++;
      buf += '\n';
      continue;
    }
    if (ch === "'" || ch === '"' || ch === '`') { quote = ch; buf += ch; i++; continue; }
    if (ch === '(') depth++;
    if (ch === ')') depth = Math.max(0, depth - 1);
    if (ch === ';' && depth === 0) {
      const s = buf.trim();
      if (s) out.push(s);
      buf = '';
      i++; continue;
    }
    buf += ch;
    i++;
  }
  const tail = buf.trim();
  if (tail) out.push(tail);
  return out;
}

async function ensureMigrationsTable(db: DbClient): Promise<void> {
  const stmts = splitStatements(MIGRATIONS_TABLE);
  for (const s of stmts) await db.run(s);
}

interface MigrationFile { name: string; path: string; }

function collectMigrations(driver: 'sqlite' | 'postgres'): MigrationFile[] {
  const dir = config.db.migrationsDir;
  if (!existsSync(dir)) return [];
  const files = readdirSync(dir).filter((f) => f.endsWith('.sql')).sort();
  const result: MigrationFile[] = [];
  const bases = new Set<string>();
  for (const f of files) {
    const m = f.match(/^(\d+)_(.+?)\.(common|sqlite|postgres)\.sql$/);
    if (m) bases.add(`${m[1]}_${m[2]}`);
  }
  for (const base of [...bases].sort()) {
    const commonPath = join(dir, `${base}.common.sql`);
    const driverPath = join(dir, `${base}.${driver}.sql`);
    const parts: string[] = [];
    if (existsSync(commonPath)) parts.push(commonPath);
    if (existsSync(driverPath)) parts.push(driverPath);
    if (parts.length) result.push({ name: base, path: parts.join('|') });
  }
  return result;
}

export async function migrate(): Promise<{ applied: string[]; skipped: string[] }> {
  const db = await getDb();
  await ensureMigrationsTable(db);
  const appliedRows = await db.all<Row>('SELECT name FROM schema_migrations');
  const appliedSet = new Set(appliedRows.map((r) => String(r.name)));
  const applied: string[] = [];
  const skipped: string[] = [];

  for (const mf of collectMigrations(db.driver)) {
    if (appliedSet.has(mf.name)) { skipped.push(mf.name); continue; }
    const files = mf.path.split('|');
    const sql = files.map((f) => readFileSync(f, 'utf8')).join('\n;\n');
    const statements = splitStatements(applyTokens(sql, db.driver));
    await db.transaction(async (tx) => {
      for (const s of statements) {
        try {
          await tx.run(s);
        } catch (e: any) {
          // «IF NOT EXISTS»-семантика для повторяющихся объектов
          const msg = String(e?.message ?? e);
          if (/already exists/i.test(msg)) continue;
          throw new Error(`Migration ${mf.name} failed on:\n${s.slice(0, 400)}\n→ ${msg}`);
        }
      }
      await tx.run('INSERT INTO schema_migrations (name, applied_at) VALUES (?, ?)', [mf.name, new Date().toISOString()]);
    });
    applied.push(mf.name);
  }
  return { applied, skipped };
}

export async function seed(): Promise<string[]> {
  const db = await getDb();
  const dir = config.db.seedsDir;
  if (!existsSync(dir)) return [];
  const files = readdirSync(dir).filter((f) => f.endsWith('.sql')).sort();
  const done: string[] = [];
  for (const f of files) {
    const sql = readFileSync(join(dir, f), 'utf8');
    const statements = splitStatements(applyTokens(sql, db.driver));
    for (const s of statements) {
      try {
        await db.run(s);
      } catch (e: any) {
        const msg = String(e?.message ?? e);
        if (/already exists|UNIQUE constraint|duplicate key/i.test(msg)) continue;
        throw new Error(`Seed ${f} failed on:\n${s.slice(0, 400)}\n→ ${msg}`);
      }
    }
    done.push(basename(f));
  }
  return done;
}

export async function status(): Promise<{ driver: string; applied: string[]; pending: string[] }> {
  const db = await getDb();
  await ensureMigrationsTable(db);
  const rows = await db.all<Row>('SELECT name FROM schema_migrations ORDER BY name');
  const applied = rows.map((r) => String(r.name));
  const all = collectMigrations(db.driver).map((m) => m.name);
  return { driver: db.driver, applied, pending: all.filter((n) => !applied.includes(n)) };
}

export async function reset(): Promise<void> {
  await closeDb();
  if (config.db.driver === 'sqlite') {
    for (const suffix of ['', '-wal', '-shm']) {
      const p = `${config.db.sqlitePath}${suffix}`;
      if (existsSync(p)) rmSync(p);
    }
  } else {
    const db = await getDb();
    const tables = await db.all<Row>(`SELECT tablename FROM pg_tables WHERE schemaname = 'public'`);
    for (const t of tables) await db.run(`DROP TABLE IF EXISTS "${t.tablename}" CASCADE`);
  }
  await migrate();
  await seed();
}
