/**
 * EPIC AI — полный прогон тестов.
 *
 *   node scripts/test-all.mjs
 *
 *  1) backend: typecheck → чистая БД → миграции → сиды → bootstrap → smoke-тест API
 *  2) UI: сборка демо-страниц → проверка renderer'а в jsdom
 *  3) Electron: конфигурация клиента (подмена модуля electron заглушкой)
 *
 * Оба блока работают без Electron и без обращения к forum.epic-gta.com.
 */
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const step = (n) => console.log(`\n\x1b[1m\x1b[36m▶ ${n}\x1b[0m`);

function run(cmd, args, cwd, label) {
  const res = spawnSync(cmd, args, { cwd, stdio: 'inherit', shell: process.platform === 'win32' });
  if (res.status !== 0) {
    console.error(`\n\x1b[31m✗ ${label} завершился с кодом ${res.status}\x1b[0m`);
    process.exit(res.status ?? 1);
  }
  console.log(`\x1b[32m✓ ${label}\x1b[0m`);
}

step('1/8  TypeScript: проверка типов backend');
run('npx', ['tsc', '-p', 'tsconfig.json', '--noEmit'], resolve(ROOT, 'backend'), 'typecheck');

step('2/8  Backend: smoke-тест API + unit-тесты');
run(process.execPath, [resolve(ROOT, 'scripts/run-smoke.mjs')], ROOT, 'backend smoke');
{
  // ВАЖНО: `tsx --test test/` молча не находит .ts-файлы (раннер Node без
  // лоадера не матчит TypeScript в каталоге) — передаём список явно.
  const { readdirSync } = await import('node:fs');
  const tests = readdirSync(resolve(ROOT, 'backend/test'))
    .filter((f) => f.endsWith('.test.ts')).sort()
    .map((f) => `test/${f}`);   // пути относительно backend/, иначе раннер их не найдёт
  if (!tests.length) { console.error('✗ в backend/test нет ни одного .test.ts'); process.exit(1); }
  run('npx', ['tsx', '--test', ...tests], resolve(ROOT, 'backend'), `backend unit (${tests.length} файла: ${tests.join(', ')})`);
}

step('3/8  UI: сборка демо-страниц');
run(process.execPath, [resolve(ROOT, 'scripts/build-demo.mjs')], ROOT, 'build-demo');

step('4/8  UI: проверка renderer в jsdom');
if (!existsSync('/tmp/domtest/node_modules/jsdom') && !existsSync(resolve(ROOT, 'node_modules/jsdom'))) {
  console.warn('⚠ jsdom не найден — пропускаю UI-тесты.');
  console.warn('  Установка: cd /tmp/domtest && npm i jsdom   (или npm i -D jsdom в корне проекта)');
} else {
  run(process.execPath, [resolve(ROOT, 'scripts/test-demo-dom.mjs')], ROOT, 'UI smoke');
}

step('5/8  Все .json в проекте валидны');
{
  const { readdirSync, readFileSync, statSync } = await import('node:fs');
  const bad = [];
  let count = 0;
  const skip = new Set(['node_modules', '.git', 'dist', 'release', 'data']);
  const walk = (dir) => {
    for (const name of readdirSync(dir)) {
      const full = resolve(dir, name);
      if (statSync(full).isDirectory()) { if (!skip.has(name)) walk(full); continue; }
      if (!name.endsWith('.json')) continue;
      count++;
      try { JSON.parse(readFileSync(full, 'utf8')); }
      catch (e) { bad.push(`${full.replace(ROOT, '')}: ${e.message}`); }
    }
  };
  walk(ROOT);
  if (bad.length) {
    console.error('\n\x1b[31m✗ Невалидный JSON (комментарии в .json недопустимы):\x1b[0m');
    for (const b of bad) console.error('   ' + b);
    process.exit(1);
  }
  console.log(`\x1b[32m✓ ${count} JSON-файлов валидны\x1b[0m`);
}

step('6/8  Electron: конфигурация клиента');
run(process.execPath, [resolve(ROOT, 'scripts/test-electron-config.mjs')], ROOT, 'electron config');

step('7/8  Electron: геометрия окон');
run(process.execPath, [resolve(ROOT, 'scripts/test-electron-windows.mjs')], ROOT, 'electron windows');

step('8/8  Готово');
console.log('Все проверки пройдены.');
