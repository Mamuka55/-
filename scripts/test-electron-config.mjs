/**
 * Проверка electron/main/config.js вне Electron.
 * Electron подменяется заглушкой, чтобы прогнать логику чтения/создания конфига.
 *   node scripts/test-electron-config.mjs
 */
import { createRequire } from 'node:module';
import { mkdirSync, writeFileSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const require_ = createRequire(import.meta.url);

let pass = 0, fail = 0;
const ok = (n, d = '') => { pass++; console.log(`  \x1b[32m✓\x1b[0m ${n}${d ? ' — ' + d : ''}`); };
const no = (n, d = '') => { fail++; console.log(`  \x1b[31m✗\x1b[0m ${n}${d ? ': ' + d : ''}`); };
const check = (c, n, d = '') => (c ? ok(n, d) : no(n, d));

const USER_DATA = resolve(ROOT, '.tmp-config-test');
rmSync(USER_DATA, { recursive: true, force: true });
mkdirSync(USER_DATA, { recursive: true });

/* ---- заглушка модуля electron ---- */
const state = { isPackaged: false };
const electronPath = require_.resolve('node:path'); // любой существующий путь
const stub = {
  app: {
    getPath: () => USER_DATA,
    getAppPath: () => resolve(ROOT, 'electron'),
    get isPackaged() { return state.isPackaged; },
    getVersion: () => '1.0.0',
  },
};
// регистрируем заглушку под именем 'electron'
const Module = require_('node:module');
const origResolve = Module._resolveFilename;
Module._resolveFilename = function (request, ...args) {
  if (request === 'electron') return 'electron-stub';
  return origResolve.call(this, request, ...args);
};
require_.cache['electron-stub'] = { id: 'electron-stub', filename: 'electron-stub', loaded: true, exports: stub };

function freshConfig() {
  const p = resolve(ROOT, 'electron/main/config.js');
  delete require_.cache[require_.resolve(p)];
  return require_(p);
}

console.log('\n\x1b[1m1. Дефолтный JSON-конфиг\x1b[0m');
const defaultFile = resolve(ROOT, 'electron/assets/client-config.default.json');
let parsed = null;
try {
  parsed = JSON.parse(readFileSync(defaultFile, 'utf8'));
  ok('client-config.default.json — валидный JSON');
} catch (e) {
  no('client-config.default.json — валидный JSON', e.message);
}
check(parsed && typeof parsed.backendUrl === 'string', 'в конфиге есть backendUrl', parsed?.backendUrl);
check(parsed && !('dev' in parsed), 'в файле нет служебного блока dev');
const raw = readFileSync(defaultFile, 'utf8');
check(!/\/\*|^\s*\/\//m.test(raw), 'в файле нет комментариев (JSON их не поддерживает)');

console.log('\n\x1b[1m2. Первый запуск: конфиг создаётся автоматически\x1b[0m');
{
  const cfgMod = freshConfig();
  const cfg = cfgMod.loadClientConfig();
  check(cfg.backendUrl === 'http://127.0.0.1:8787', 'backendUrl по умолчанию', cfg.backendUrl);
  check(cfg.embeddedBackend === true, 'embeddedBackend по умолчанию true');
  check(existsSync(resolve(USER_DATA, 'config.json')), 'config.json создан в userData');
  const created = JSON.parse(readFileSync(resolve(USER_DATA, 'config.json'), 'utf8'));
  check(!('dev' in created), 'в созданный конфиг не попал блок dev');
}

console.log('\n\x1b[1m3. Режим разработки: команда запуска backend подставляется автоматически\x1b[0m');
{
  state.isPackaged = false;
  const cfg = freshConfig().loadClientConfig();
  check(cfg.backendCommand === 'npx', 'backendCommand = npx', cfg.backendCommand);
  check(Array.isArray(cfg.backendArgs) && cfg.backendArgs.join(' ') === 'tsx src/index.ts', 'backendArgs = tsx src/index.ts', String(cfg.backendArgs));
  check(cfg.backendCwd === '../backend', 'backendCwd = ../backend', cfg.backendCwd);
  const abs = resolve(stub.app.getAppPath(), cfg.backendCwd);
  check(existsSync(resolve(abs, 'package.json')), 'путь ../backend от electron/ существует', abs);
  check(existsSync(resolve(abs, 'src/index.ts')), 'backend/src/index.ts найден');
}

console.log('\n\x1b[1m4. Production: backend запускается из dist\x1b[0m');
{
  state.isPackaged = true;
  const cfg = freshConfig().loadClientConfig();
  check(cfg.backendCommand === 'node', 'backendCommand = node', cfg.backendCommand);
  check(cfg.backendArgs.join(' ') === 'dist/index.js', 'backendArgs = dist/index.js', String(cfg.backendArgs));
  state.isPackaged = false;
}

console.log('\n\x1b[1m5. Пользовательский конфиг имеет приоритет\x1b[0m');
{
  writeFileSync(resolve(USER_DATA, 'config.json'), JSON.stringify({
    backendUrl: 'https://api.epic-ai.example',
    embeddedBackend: false,
  }, null, 2));
  const cfg = freshConfig().loadClientConfig();
  check(cfg.backendUrl === 'https://api.epic-ai.example', 'backendUrl из файла (сценарий VPS)', cfg.backendUrl);
  check(cfg.embeddedBackend === false, 'embeddedBackend=false — Electron не поднимает backend');
}

console.log('\n\x1b[1m6. Битый JSON не роняет приложение\x1b[0m');
{
  writeFileSync(resolve(USER_DATA, 'config.json'), '{ "backendUrl": "http://x", /* комментарий */ }');
  const cfg = freshConfig().loadClientConfig();
  check(typeof cfg.backendUrl === 'string' && cfg.backendUrl.length > 0, 'при ошибке разбора берётся дефолт', cfg.backendUrl);
}
{
  writeFileSync(resolve(USER_DATA, 'config.json'), 'не json вообще');
  const cfg = freshConfig().loadClientConfig();
  check(cfg.backendUrl === 'http://127.0.0.1:8787', 'полностью битый файл → дефолт');
}

console.log('\n\x1b[1m7. Настройки интерфейса\x1b[0m');
{
  rmSync(resolve(USER_DATA, 'config.json'), { force: true });
  const cfgMod = freshConfig();
  const s = cfgMod.loadSettings();
  check(s.hotkey === 'F10', 'горячая клавиша по умолчанию F10 ', s.hotkey);
  check(s.panelWidth === 900 && s.panelHeight === 56, 'панель 900×56 (ширина зафиксирована пользователем)', `${s.panelWidth}×${s.panelHeight}`);
  check(s.comboHistory === 'Ctrl+H' && s.comboSources === 'Ctrl+O' && s.comboPin === 'Ctrl+P', 'локальные сочетания по умолчанию Ctrl+H/O/P');
  check(s.alwaysOnTop === true, 'always-on-top включён ');
  check(s.hideOnOutsideClick === true, 'скрытие при клике вне окна ');
  check(s.hardwareAcceleration === true, 'аппаратное ускорение включено ');
  check(s.opacity === 0.82, 'прозрачность 0.82 ', String(s.opacity));
  check(s.confirmAiAsk === true, 'подтверждение вопроса окном «Спросить ИИ?» включено по умолчанию');
  check(s.streamerMode === false && s.streamerNick === null, 'режим стримера выключен по умолчанию');
  check(s.micDeviceId === null, 'микрофон по умолчанию — системное устройство (micDeviceId=null, п.13)');
  check(!('blur' in s) && !('blurRadius' in s), 'blur/blurRadius убраны из настроек (живой фон удалён)');
  const saved = cfgMod.saveSettings({ hotkey: 'F9', blur: false });
  check(saved.hotkey === 'F9' && saved.blur === false, 'сохранение настроек');
  const reloaded = cfgMod.loadSettings();
  check(reloaded.hotkey === 'F9', 'настройки переживают перезапуск');
  check(reloaded.panelWidth === 900, 'несохранённые ключи остаются дефолтными (ширина 900)');
}

console.log('\n\x1b[1m8. Прочие main-модули синтаксически корректны\x1b[0m');
for (const f of ['main.js', 'windows.js', 'tray.js', 'hotkey.js', 'ipc.js', 'backend.js', 'config.js']) {
  const p = resolve(ROOT, 'electron/main', f);
  try {
    new Module(p, null, () => {});
    const src = readFileSync(p, 'utf8');
    // грубая, но достаточная проверка: парсим как script
    require_('node:vm').compileFunction(src, [], { filename: p });
    ok(f);
  } catch (e) {
    no(f, e.message.split('\n')[0]);
  }
}
for (const f of ['index.js']) {
  const p = resolve(ROOT, 'electron/preload', f);
  try {
    require_('node:vm').compileFunction(readFileSync(p, 'utf8'), [], { filename: p });
    ok('preload/' + f);
  } catch (e) { no('preload/' + f, e.message.split('\n')[0]); }
}

console.log('\n\x1b[1m9. hotkey.js экспортирует всё, что деконструирует main.js\x1b[0m');
{
  // Регрессия: при конвертации mjs→js строка module.exports однажды потерялась,
  // из-за чего F10 не регистрировался, а выход из приложения падал с
  // «unregisterAll is not a function».
  const stubExports = require_.cache['electron-stub'].exports;
  stubExports.globalShortcut = { register: () => true, unregister() {}, unregisterAll() {} };

  const hp = resolve(ROOT, 'electron/main/hotkey.js');
  delete require_.cache[require_.resolve(hp)];
  const h = require_(hp);

  for (const fn of ['registerHotkey', 'unregisterHotkey', 'unregisterAll', 'getCurrentHotkey', 'normalizeAccelerator', 'registerCombos', 'unregisterCombos', 'getCurrentCombos']) {
    check(typeof h[fn] === 'function', `hotkey.${fn} — функция`);
  }

  const wanted = new Set();
  for (const consumer of ['main.js', 'ipc.js']) {
    const src = readFileSync(resolve(ROOT, 'electron/main', consumer), 'utf8');
    const m = src.match(/const\s*\{([^}]+)\}\s*=\s*require\('\.\/hotkey\.js'\)/);
    if (m) for (const name of m[1].split(',').map((x) => x.trim()).filter(Boolean)) wanted.add(name);
  }
  const missing = [...wanted].filter((w) => h[w] === undefined);
  check(missing.length === 0, 'все имена из main.js/ipc.js есть в module.exports', missing.join(', ') || [...wanted].join(', '));

  check(h.normalizeAccelerator('F9') === 'F9', 'валидное сочетание проходит', h.normalizeAccelerator('F9'));
  check(h.normalizeAccelerator('NOT A KEY!!') === 'F10', 'мусор откатывается к F10');
  const reg = h.registerHotkey('F10', () => {});
  check(reg.ok === true && reg.registered === 'F10', 'registerHotkey возвращает ok/registered');
  h.unregisterAll();
  check(h.getCurrentHotkey() === null, 'unregisterAll сбрасывает текущее сочетание');
}

rmSync(USER_DATA, { recursive: true, force: true });
console.log(`\n\x1b[1mИТОГ: ${pass} проверок пройдено, ${fail} провалено\x1b[0m`);
process.exitCode = fail ? 1 : 0;
