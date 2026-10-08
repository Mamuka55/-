/**
 * EPIC AI — локальный прогон smoke-тестов.
 *
 *   node scripts/run-smoke.mjs
 *
 * Делает: сброс БД → миграции → сиды → запуск backend → smoke-тест → остановка.
 */
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, rmSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const BACKEND = resolve(ROOT, 'backend');
const DB_FILE = resolve(BACKEND, 'data/epic-ai.sqlite');
const PORT = Number(process.env.PORT ?? 8799);
const SECRET = process.env.SECRET ?? 'dev-secret-0123456789abcdef0123456789abcdef';

/** Запуск admin-cli и возврат stdout. */
function cliOut(args) {
  const res = spawnSync('npx', ['tsx', 'src/bootstrap/admin-cli.ts', ...args],
    { cwd: BACKEND, encoding: 'utf8', env: { ...process.env, PORT: String(PORT) } });
  return `${res.stdout ?? ''}${res.stderr ?? ''}`;
}

function cli(args, opts = {}) {
  const res = spawnSync('npx', ['tsx', ...args], { cwd: BACKEND, encoding: 'utf8', stdio: 'inherit', env: { ...process.env, PORT: String(PORT) }, ...opts });
  if (res.status !== 0) throw new Error(`CLI failed: npx tsx ${args.join(' ')} (exit ${res.status})`);
}

async function waitForHealth(base, timeoutMs = 40_000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    try {
      const r = await fetch(`${base}/api/health`, { signal: AbortSignal.timeout(2000) });
      if (r.ok) {
        const j = await r.json();
        if (j.ok) return j;
      }
    } catch { /* ещё не поднялся */ }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error('Backend не поднялся за отведённое время');
}

/**
 * Убиваем backend, осиротевший от предыдущего запуска.
 * На драйвере sql.js база целиком живёт в памяти процесса, поэтому такой
 * процесс может перезаписать свежий файл своими устаревшими данными.
 */
function killStaleServers() {
  const killed = [];
  let procs = [];
  try { procs = readdirSync('/proc').filter((d) => /^\d+$/.test(d)); } catch { return killed; }
  for (const pid of procs) {
    if (Number(pid) === process.pid) continue;
    let cmd = '';
    try { cmd = readFileSync(`/proc/${pid}/cmdline`, 'utf8').replace(/\0/g, ' '); } catch { continue; }
    // tsx запускает сервер как `node --require .../tsx .../src/index.ts`,
    // поэтому ищем по любому упоминанию проекта в cmdline.
    if (!/epic-ai/.test(cmd)) continue;
    if (/run-smoke|smoke\.mjs|cli\.ts|bootstrap/.test(cmd)) continue; // не убивать себя и CLI
    if (!/index\.ts|tsx/.test(cmd)) continue;
    try { process.kill(Number(pid), 'SIGKILL'); killed.push(pid); } catch { /* ignore */ }
  }
  return killed;
}

async function main() {
  console.log('=== EPIC AI: smoke ===');

  const killed = killStaleServers();
  if (killed.length) console.log(`• остановлены осиротевшие backend-процессы: ${killed.join(', ')}`);
  // Убитый SIGKILL процесс не успевает снять lock-файл
  const lockFile = resolve(BACKEND, 'data/backend.lock');
  if (existsSync(lockFile)) { rmSync(lockFile, { force: true }); console.log('• удалён устаревший backend.lock'); }
  await new Promise((r) => setTimeout(r, 400));

  if (process.env.KEEP_DB !== '1') {
    for (const suffix of ['', '-wal', '-shm', '.bak']) {
      const p = `${DB_FILE}${suffix}`;
      if (existsSync(p)) rmSync(p);
    }
    console.log('• БД очищена; файл существует:', existsSync(DB_FILE));
  }

  cli(['src/db/cli.ts', 'migrate']);
  cli(['src/db/cli.ts', 'seed']);

  // Bootstrap первого Developer выполняется ДО старта сервера: на sqlite/sql.js
  // база держится в памяти процесса, поэтому параллельная запись недопустима.
  cli(['src/bootstrap/developer.ts', '--local', 'developer', '--force']);

  // ---- CLI администратора (backend/src/bootstrap/admin-cli.ts) ----
  // Проверяем сценарий «заблокировали → не пускает → разблокировали»,
  // из-за которого окно блокировки раньше было тупиковым.
  {
    const tmp = resolve(BACKEND, 'cli-test-user.mts');
    const writeOnce = (code) => { writeFileSync(tmp, code, 'utf8'); };

    // 1. создаём подопытного пользователя напрямую в БД
    writeOnce(`
      import { getDb, closeDb, insertReturningId } from './src/db/index.js';
      const db = await getDb();
      const id = await insertReturningId(db, 'users', {
        username: 'cli_test_user', display_name: 'CLI Test', avatar_url: null,
        status: 'active', created_at: new Date().toISOString(), updated_at: new Date().toISOString(),
      });
      const role = await db.get("SELECT id FROM roles WHERE code = 'player'");
      await db.run('INSERT INTO user_roles (user_id, role_id, assigned_at) VALUES (?, ?, ?)', [id, Number(role.id), new Date().toISOString()]);
      console.log('CREATED ' + id);
      await closeDb();
    `);
    const created = spawnSync('npx', ['tsx', 'cli-test-user.mts'], { cwd: BACKEND, encoding: 'utf8' }).stdout ?? '';
    const testId = Number((created.match(/CREATED (\d+)/) ?? [])[1] ?? 0);
    if (!testId) throw new Error('CLI-тест: не удалось создать подопытного пользователя\n' + created);
    console.log(`• CLI-тест: создан пользователь #${testId}`);

    // 2. блокируем его (имитация действия администратора)
    writeOnce(`
      import { getDb, closeDb } from './src/db/index.js';
      const db = await getDb();
      await db.run("UPDATE users SET status='blocked', blocked_reason='cli test', blocked_at=? WHERE id=?", [new Date().toISOString(), ${testId}]);
      console.log('BLOCKED');
      await closeDb();
    `);
    spawnSync('npx', ['tsx', 'cli-test-user.mts'], { cwd: BACKEND, encoding: 'utf8', stdio: 'inherit' });

    // 3. --doctor должен это увидеть
    let out = cliOut(['--doctor']);
    if (!/Developer:/.test(out)) throw new Error('CLI --doctor не выдал диагноз:\n' + out.slice(0, 400));
    if (!/Заблокированы:/.test(out)) throw new Error('CLI --doctor не показал заблокированного:\n' + out.slice(0, 400));
    console.log('• CLI --doctor: видит Developer и заблокированного пользователя');

    // 4. список пользователей показывает blocked
    out = cliOut([]);
    if (!/blocked/.test(out) || !/cli_test_user/.test(out)) throw new Error('CLI не показал заблокированного в списке:\n' + out.slice(0, 400));
    console.log('• CLI: заблокированный виден в списке пользователей');

    // 5. разблокировка
    out = cliOut(['--unblock', String(testId)]);
    if (!/разблокирован/i.test(out)) throw new Error('CLI --unblock не сработал:\n' + out.slice(0, 400));
    out = cliOut([]);
    const line = out.split('\n').find((l) => l.includes('cli_test_user')) ?? '';
    if (!/active/.test(line)) throw new Error('После --unblock статус не active:\n' + line);
    console.log('• CLI --unblock: статус вернулся в active');

    // 6. выдача Developer и удаление
    out = cliOut(['--developer', String(testId)]);
    if (!/Developer/i.test(out)) throw new Error('CLI --developer не сработал:\n' + out.slice(0, 400));
    out = cliOut([]);
    if (!/cli_test_user/.test(out) || !/developer/.test(out.split('\n').find((l) => l.includes('cli_test_user')) ?? '')) {
      throw new Error('CLI --developer не отразился в списке:\n' + out.slice(0, 500));
    }
    console.log('• CLI --developer: роль выдана (обход RBAC-ограничения интерфейса)');

    out = cliOut(['--delete', String(testId)]);
    if (!/удалён/i.test(out)) throw new Error('CLI --delete не сработал:\n' + out.slice(0, 400));
    console.log('• CLI --delete: пользователь удалён вместе с identity и сессиями');

    rmSync(tmp, { force: true });
  }

  const server = spawn('npx', ['tsx', 'src/index.ts'], {
    cwd: BACKEND,
    env: { ...process.env, PORT: String(PORT), LOG_LEVEL: 'warn', SESSION_SECRET: SECRET, AI_PROVIDER: 'mock', DB_DRIVER: 'sqlite',
      // Telegram Login проверяется в smoke на фейговом токене: подпись
      // считается тем же алгоритмом, что и на боевом боте.
      TELEGRAM_ENABLED: 'true', TELEGRAM_BOT_TOKEN: 'smoke-tg-token', TELEGRAM_BOT_USERNAME: 'epicai_smoke_bot' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let serverLog = '';
  server.stdout.on('data', (d) => { serverLog += d.toString(); });
  server.stderr.on('data', (d) => { serverLog += d.toString(); });

  const base = `http://127.0.0.1:${PORT}`;
  let exitCode = 0;
  try {
    const health = await waitForHealth(base);
    console.log(`• backend поднят на ${base} (db: ${health.db.driver}/${health.db.engine}, ai: ${health.ai.provider})\n`);
    const smoke = spawnSync(process.execPath, [resolve(ROOT, 'scripts/smoke.mjs')], {
      cwd: ROOT, encoding: 'utf8', stdio: 'inherit', env: { ...process.env, BASE: base, SECRET },
    });
    exitCode = smoke.status ?? 1;
  } catch (e) {
    console.error('• ошибка:', e.message);
    console.error(serverLog.slice(-3000));
    exitCode = 1;
  } finally {
    server.kill('SIGTERM');
    await new Promise((r) => setTimeout(r, 400));
    if (!server.killed) server.kill('SIGKILL');
  }
  process.exit(exitCode);
}

main().catch((e) => { console.error(e); process.exit(1); });
