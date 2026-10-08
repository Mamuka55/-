/**
 * Собирает epic-ai.zip без внешних зависимостей (в песочнице нет утилиты zip).
 * Формат: local file header + данные (deflate) + central directory + EOCD.
 * Флаг 0x800 — имена в UTF-8.
 */
import { readFileSync, writeFileSync, statSync, readdirSync, existsSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { deflateRawSync, crc32 } from 'node:zlib';

const ROOT = resolve(process.argv[2] ?? '.');
const OUT = resolve(process.argv[3] ?? 'epic-ai.zip');
const PREFIX = process.argv[4] ?? ''; // каталог внутри архива, например 'epic-ai/'

const EXCLUDE_DIRS = new Set([
  'node_modules', '.git', '.arena', '.cache', '.mypy_cache', '.next', '.nox', '.npm',
  '.nuxt', '.output', '.parcel-cache', '.pytest_cache', '.ruff_cache', '.svelte-kit',
  '.tox', '.turbo', '.venv', '.vite', '__pycache__', 'build', 'coverage', 'dist',
  'out', 'target', 'release', 'data',
]);
const EXCLUDE_FILES = new Set(['.env', 'backend.lock', 'epic-ai.zip']);
const EXCLUDE_EXT = new Set(['.sqlite', '.sqlite-wal', '.sqlite-shm', '.log']);

function walk(dir, acc = []) {
  for (const name of readdirSync(dir).sort()) {
    const full = join(dir, name);
    const st = statSync(full);
    if (st.isDirectory()) {
      if (EXCLUDE_DIRS.has(name)) continue;
      walk(full, acc);
    } else {
      if (EXCLUDE_FILES.has(name)) continue;
      const rel = relative(ROOT, full);
      if (EXCLUDE_EXT.has('.' + rel.split('.').slice(1).join('.'))) continue;
      if (/\.sqlite(\.|-)/.test(rel) || rel.endsWith('.bak')) continue;
      acc.push(full);
    }
  }
  return acc;
}

const DOS_TIME = (() => {
  const d = new Date();
  return {
    time: (d.getHours() << 11) | (d.getMinutes() << 5) | (Math.floor(d.getSeconds() / 2)),
    date: ((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate(),
  };
})();

const files = walk(ROOT);
const chunks = [];
const central = [];
let offset = 0;

for (const file of files) {
  const rel = relative(ROOT, file).split('\\').join('/');
  const name = PREFIX + rel;
  const nameBuf = Buffer.from(name, 'utf8');
  const data = readFileSync(file);
  const crc = crc32(data) >>> 0;
  const deflated = deflateRawSync(data, { level: 9 });
  const useDeflate = deflated.length < data.length;
  const payload = useDeflate ? deflated : data;
  const method = useDeflate ? 8 : 0;

  const local = Buffer.alloc(30);
  local.writeUInt32LE(0x04034b50, 0);
  local.writeUInt16LE(20, 4);            // version needed
  local.writeUInt16LE(0x800, 6);         // UTF-8 names
  local.writeUInt16LE(method, 8);
  local.writeUInt16LE(DOS_TIME.time, 10);
  local.writeUInt16LE(DOS_TIME.date, 12);
  local.writeUInt32LE(crc, 14);
  local.writeUInt32LE(payload.length, 18);
  local.writeUInt32LE(data.length, 22);
  local.writeUInt16LE(nameBuf.length, 26);
  local.writeUInt16LE(0, 28);

  chunks.push(local, nameBuf, payload);

  const cd = Buffer.alloc(46);
  cd.writeUInt32LE(0x02014b50, 0);
  cd.writeUInt16LE(20, 4);               // version made by
  cd.writeUInt16LE(20, 6);               // version needed
  cd.writeUInt16LE(0x800, 8);
  cd.writeUInt16LE(method, 10);
  cd.writeUInt16LE(DOS_TIME.time, 12);
  cd.writeUInt16LE(DOS_TIME.date, 14);
  cd.writeUInt32LE(crc, 16);
  cd.writeUInt32LE(payload.length, 20);
  cd.writeUInt32LE(data.length, 24);
  cd.writeUInt16LE(nameBuf.length, 28);
  cd.writeUInt16LE(0, 30);               // extra
  cd.writeUInt16LE(0, 32);               // comment
  cd.writeUInt16LE(0, 34);               // disk
  cd.writeUInt16LE(0, 36);               // internal attrs
  cd.writeUInt32LE(0, 38);               // external attrs
  cd.writeUInt32LE(offset, 42);
  central.push(Buffer.concat([cd, nameBuf]));

  offset += local.length + nameBuf.length + payload.length;
}

const centralBuf = Buffer.concat(central);
const eocd = Buffer.alloc(22);
eocd.writeUInt32LE(0x06054b50, 0);
eocd.writeUInt16LE(0, 4);
eocd.writeUInt16LE(0, 6);
eocd.writeUInt16LE(files.length, 8);
eocd.writeUInt16LE(files.length, 10);
eocd.writeUInt32LE(centralBuf.length, 12);
eocd.writeUInt32LE(offset, 16);
eocd.writeUInt16LE(0, 20);

writeFileSync(OUT, Buffer.concat([...chunks, centralBuf, eocd]));

const size = statSync(OUT).size;
console.log(`[zip] ${OUT}`);
console.log(`[zip] файлов: ${files.length}, размер: ${(size / 1024 / 1024).toFixed(2)} MB`);
