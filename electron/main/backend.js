/**
 * EPIC AI — управление backend'ом из Electron.
 *
 * Локальная разработка : Electron сам поднимает backend рядом с собой.
 * Production : embeddedBackend=false, клиент ходит на https://… —
 * этот файл просто опрашивает /api/health и ничего не запускает.
 *
 * Никакие секреты через этот процесс не проходят: backend читает их из
 * собственного backend/.env.
 */
'use strict';

const { spawn } = require('node:child_process');
const path = require('node:path');
const fs = require('node:fs');

let child = null;
let logTail = [];

function tail(line) {
  logTail.push(line);
  if (logTail.length > 200) logTail.shift();
}

async function health(backendUrl, timeoutMs = 2500) {
  try {
    const res = await fetch(`${backendUrl.replace(/\/$/, '')}/api/health`, { signal: AbortSignal.timeout(timeoutMs) });
    if (!res.ok) return { ok: false, status: res.status };
    const json = await res.json();
    return { ok: Boolean(json.ok), status: res.status, info: json };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

/**
 * Поднять встроенный backend (только в локальной разработке).
 * @param {(stage:string, detail?:string)=>void} onProgress
 */
async function startEmbedded(cfg, { appPath, isPackaged, onProgress } = {}) {
  const backendUrl = cfg.backendUrl;
  const existing = await health(backendUrl, 1200);
  if (existing.ok) {
    onProgress?.('backend', 'backend уже запущен');
    return { started: false, reason: 'already-running', info: existing.info };
  }
  if (isPackaged && !cfg.backendCommand) {
    // В собранном приложении backend обычно живёт на VPS
    return { started: false, reason: 'not-configured' };
  }

  const cwd = cfg.backendCwd
    ? path.resolve(appPath, cfg.backendCwd)
    : path.join(appPath, '..', 'backend');

  if (!fs.existsSync(cwd)) return { started: false, reason: 'no-backend-dir', cwd };

  const command = cfg.backendCommand ?? (isPackaged ? 'node' : 'npx');
  const args = cfg.backendArgs ?? (isPackaged ? ['dist/index.js'] : ['tsx', 'src/index.ts']);

  onProgress?.('backend', `запуск: ${command} ${args.join(' ')}`);
  child = spawn(command, args, {
    cwd,
    env: {...process.env, ELECTRON_RUN_AS_NODE: undefined },
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
    shell: process.platform === 'win32',
  });
  child.stdout?.on('data', (d) => tail(String(d)));
  child.stderr?.on('data', (d) => tail(String(d)));
  child.on('exit', (code) => { tail(`[backend exited code=${code}]`); child = null; });

  // Ждём готовности
  const deadline = Date.now() + 90_000;
  while (Date.now() < deadline) {
    const h = await health(backendUrl, 1500);
    if (h.ok) return { started: true, info: h.info };
    if (!child) break;
    await new Promise((r) => setTimeout(r, 700));
  }
  return { started: false, reason: 'timeout', logs: logTail.slice(-30) };
}

function stopEmbedded() {
  if (!child) return;
  try { child.kill('SIGTERM'); } catch { /* ignore */ }
  const c = child;
  child = null;
  setTimeout(() => { try { c.kill('SIGKILL'); } catch { /* ignore */ } }, 2500);
}

function isEmbeddedRunning() { return Boolean(child); }
function getLogs() { return logTail.slice(-60); }

module.exports = { health, startEmbedded, stopEmbedded, isEmbeddedRunning, getLogs };
