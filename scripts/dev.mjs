/**
 * EPIC AI — корневой dev-скрипт.
 *
 *   npm run dev
 *
 * Поднимает backend и Electron одним процессом и корректно гасит оба по Ctrl+C.
 * Electron устанавливается отдельно (он большой и в CI/песочнице не нужен):
 *   cd electron && npm install
 */
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const BACKEND = resolve(ROOT, 'backend');
const ELECTRON = resolve(ROOT, 'electron');

const children = [];
let shuttingDown = false;

function run(name, command, args, cwd, opts = {}) {
  const child = spawn(command, args, {
    cwd,
    stdio: 'inherit',
    env: { ...process.env, ...(opts.env ?? {}) },
    shell: process.platform === 'win32',
  });
  child.on('exit', (code) => {
    console.log(`\n[epic-ai] ${name} завершился (code ${code})`);
    if (!shuttingDown) shutdown(code ?? 0);
  });
  children.push({ name, child });
  return child;
}

function shutdown(code = 0) {
  if (shuttingDown) return;
  shuttingDown = true;
  for (const { child } of children) {
    try { child.kill('SIGTERM'); } catch { /* ignore */ }
  }
  setTimeout(() => process.exit(code), 600);
}

async function waitForBackend(url, timeoutMs = 90_000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    try {
      const r = await fetch(`${url}/api/health`, { signal: AbortSignal.timeout(1500) });
      if (r.ok && (await r.json()).ok) return true;
    } catch { /* ещё не поднялся */ }
    await new Promise((r) => setTimeout(r, 600));
  }
  return false;
}

async function main() {
  if (!existsSync(resolve(BACKEND, 'node_modules'))) {
    console.error('[epic-ai] backend/node_modules не найден. Выполните: cd backend && npm install');
    process.exit(1);
  }

  const backendUrl = process.env.PUBLIC_URL ?? 'http://127.0.0.1:8787';
  console.log('[epic-ai] запуск backend…');
  run('backend', 'npx', ['tsx', 'src/index.ts'], BACKEND);

  const ok = await waitForBackend(backendUrl);
  if (!ok) {
    console.error(`[epic-ai] backend не ответил на ${backendUrl}/api/health — продолжаю без Electron`);
  }

  if (!existsSync(resolve(ROOT, 'node_modules/electron')) && !existsSync(resolve(ELECTRON, 'node_modules/electron'))) {
    console.warn('[epic-ai] Electron не установлен. Backend доступен на ' + backendUrl);
    console.warn('[epic-ai] Для установки клиента: cd electron && npm install');
    console.warn('[epic-ai] Админ-панель и страница входа доступны в браузере:');
    console.warn(`            ${backendUrl}/login`);
    console.warn(`            ${backendUrl}/ui/admin.html`);
    return;
  }

  console.log('[epic-ai] запуск Electron…');
  run('electron', 'npx', ['electron', '.'], ELECTRON);
}

process.on('SIGINT', () => shutdown(0));
process.on('SIGTERM', () => shutdown(0));

void main();
