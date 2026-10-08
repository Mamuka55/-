/**
 * EPIC AI — защита от второго запущенного backend на одной машине.
 *
 * На локальной разработке  база — это один SQLite-файл. Два
 * одновременно работающих backend'а тихо затрут данные друг друга
 * (особенно на WASM-драйвере sql.js, который держит БД в памяти).
 * Поэтому второй экземпляр не запускается вовсе, а пишет понятную ошибку.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { config } from '../config/index.js';

const LOCK_FILE = join(config.paths.dataDir, 'backend.lock');

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e: any) {
    return e?.code === 'EPERM';
  }
}

export function acquireInstanceLock(): void {
  mkdirSync(config.paths.dataDir, { recursive: true });
  if (existsSync(LOCK_FILE)) {
    let prev: { pid: number; port: number; startedAt: string } | null = null;
    try { prev = JSON.parse(readFileSync(LOCK_FILE, 'utf8')); } catch { prev = null; }
    if (prev && isAlive(prev.pid)) {
      console.error('');
      console.error('[epic-ai] Уже запущен другой экземпляр backend:');
      console.error(`          pid=${prev.pid} port=${prev.port} startedAt=${prev.startedAt}`);
      console.error('          Остановите его или удалите файл ' + LOCK_FILE);
      console.error('');
      process.exit(1);
    }
    if (prev) rmSync(LOCK_FILE, { force: true }); // устаревший lock
  }
  writeFileSync(LOCK_FILE, JSON.stringify({ pid: process.pid, port: config.port, startedAt: new Date().toISOString() }, null, 2));

  const release = () => {
    try {
      if (existsSync(LOCK_FILE)) {
        const cur = JSON.parse(readFileSync(LOCK_FILE, 'utf8'));
        if (cur?.pid === process.pid) rmSync(LOCK_FILE, { force: true });
      }
    } catch { /* ignore */ }
  };
  process.on('exit', release);
  process.on('SIGINT', () => { release(); process.exit(130); });
  process.on('SIGTERM', () => { release(); process.exit(143); });
}

export function releaseInstanceLock(): void {
  try { rmSync(LOCK_FILE, { force: true }); } catch { /* ignore */ }
}
