/**
 * EPIC AI — unit-тесты оконной геометрии Electron (без самого Electron).
 *
 * Регрессия, которую ловим: win.getBounds() возвращает ОБЪЕКТ {x,y,width,height},
 * а не массив. Array-деструктуризация в setPanelHeight падала с
 * «object is not iterable» на каждом изменении высоты панели.
 *
 *   node scripts/test-electron-windows.mjs
 */
import { createRequire } from 'node:module';
import { mkdirSync, rmSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const USER_DATA = resolve(ROOT, '.tmp-windows-test');
rmSync(USER_DATA, { recursive: true, force: true });
mkdirSync(USER_DATA, { recursive: true });

let pass = 0, fail = 0;
const ok = (n, d = '') => { pass++; console.log(`  \x1b[32m✓\x1b[0m ${n}${d ? ' — ' + d : ''}`); };
const no = (n, d = '') => { fail++; console.log(`  \x1b[31m✗\x1b[0m ${n}${d ? ': ' + d : ''}`); };
const check = (c, n, d = '') => (c ? ok(n, d) : no(n, d));

/* ---------------- заглушка Electron ---------------- */

class BrowserWindow {
  constructor(opts = {}) {
    this.opts = opts;
    this.bounds = { x: opts.x ?? 0, y: opts.y ?? 0, width: opts.width ?? 100, height: opts.height ?? 100 };
    this.destroyed = false;
    this.visible = false;
    this.alwaysOnTop = false;
    this.listeners = new Map();
    this.webContents = {
      send: () => {},
      on: () => {},
      once: () => {},
      setWindowOpenHandler: () => {},
    };
    BrowserWindow.instances.push(this);
  }
  static instances = [];
  setMenuBarVisibility() {}
  setMinimumSize() {}
  setMaximumSize() {}
  loadURL(url) { this.url = url; }
  on(ev, fn) { (this.listeners.get(ev) ?? this.listeners.set(ev, []).get(ev)).push(fn); }
  once() {}
  removeListener() {}
  emit(ev, ...a) { for (const fn of this.listeners.get(ev) ?? []) fn(...a); }
  show() { this.visible = true; }
  hide() { this.visible = false; }
  isVisible() { return this.visible; }
  isMinimized() { return false; }
  isDestroyed() { return this.destroyed; }
  getBounds() { return { ...this.bounds }; }          // ← объект, как в настоящем Electron
  setBounds(b) { this.bounds = { ...this.bounds, ...b }; }
  setPosition(x, y) { this.bounds.x = x; this.bounds.y = y; }
  setSize(w, h) { this.bounds.width = w; this.bounds.height = h; }
  setAlwaysOnTop(v) { this.alwaysOnTop = Boolean(v); }
  setOpacity(v) { this.opacity = v; }
  setVisibleOnAllWorkspaces() {}
  isFocused() { return Boolean(this.focused); }
  focus() { this.focused = true; }
  close() { this.destroyed = true; }
  destroy() { this.destroyed = true; }
}

const WORK_AREA = { x: 0, y: 0, width: 1920, height: 1080 };
const electronStub = {
  app: {
    getPath: () => USER_DATA,
    getAppPath: () => resolve(ROOT, 'electron'),
    isPackaged: false,
    getVersion: () => '1.0.0',
  },
  BrowserWindow,
  screen: {
    getDisplayNearestPoint: () => ({ workArea: WORK_AREA }),
    getDisplayMatching: () => ({ workArea: WORK_AREA }),
    getCursorScreenPoint: () => ({ x: 960, y: 540 }),
    on: () => {},
    removeListener: () => {},
  },
  shell: { openExternal: async () => {} },
  session: { fromPartition: () => ({ cookies: { get: async () => [] } }) },
};

const require_ = createRequire(import.meta.url);
const Module = require_('node:module');
const origResolve = Module._resolveFilename;
Module._resolveFilename = function (request, ...args) {
  if (request === 'electron') return 'electron-stub';
  return origResolve.call(this, request, ...args);
};
require_.cache['electron-stub'] = { id: 'electron-stub', filename: 'electron-stub', loaded: true, exports: electronStub };

const W = require_(resolve(ROOT, 'electron/main/windows.js'));

console.log('\n\x1b[1mГеометрия основной панели \x1b[0m');

const main = W.createMainPanel();
const b0 = main.getBounds();
check(b0.width === 900 && b0.height === 56, 'панель создаётся 900×56 (ширина зафиксирована)', `${b0.width}×${b0.height}`);
check(b0.y === 16 && b0.x === 510, 'позиция по умолчанию: вверху по центру (до первого перетаскивания)', `x=${b0.x}, y=${b0.y}`);

// Главный регресс-тест: раскрытие панели вниз не падает и меняет высоту
let threw = null;
try { W.setPanelHeight(420, { anchor: 'bottom' }); } catch (e) { threw = e; }
check(threw === null, 'setPanelHeight не падает на object-границах (регресс «not iterable»)', threw?.message ?? '');
const b1 = main.getBounds();
check(b1.height === 420, 'высота применилась', String(b1.height));
check(b1.y === b0.y, 'верхний край остался на месте (панель растёт вниз от своего места)', `y=${b1.y}`);
check(W.state.settingsOpen === true, 'состояние «настройки открыты» зафиксировано');

W.setPanelHeight(56, { anchor: 'top' });
const b2 = main.getBounds();
check(b2.height === 56 && W.state.settingsOpen === false, 'сворачивание возвращает 56 px', `${b2.height}`);

console.log('\n\x1b[1mВысота раскрытия: ответ помещается целиком \x1b[0m');
W.setPanelHeight(900);
check(main.getBounds().height === 900, 'высота 900 применяется (старый потолок больше не режет ответ)', String(main.getBounds().height));
W.setPanelHeight(1400);
check(main.getBounds().height === WORK_AREA.height - 8, 'потолок: рабочая область − 8 px (окно не уходит за экран)', String(main.getBounds().height));
W.setPanelHeight(56);

console.log('\n\x1b[1mОкно источников справа от панели \x1b[0m');
W.setPanelHeight(56);
const src = W.createSourcesWindow({ sources: [] });
W.positionSourcesWindow();
const sb = src.getBounds();
const mb = main.getBounds();
check(sb.x === mb.x + mb.width + 12, 'источники стоят справа от панели с зазором 12 px', `x=${sb.x}`);
check(sb.y + sb.height <= WORK_AREA.height, 'окно источников внутри рабочей области');

// Если справа не помещается — переносим влево
main.setBounds({ x: WORK_AREA.width - 700, y: mb.y, width: 900, height: 56 });
W.positionSourcesWindow();
const sb2 = src.getBounds();
check(sb2.x < main.getBounds().x, 'у правого края окно источников переносится влево от панели', `x=${sb2.x}`);

console.log('\n\x1b[1mСвободное положение панели (остаётся там, куда перетащили)\x1b[0m');
const C = require_(resolve(ROOT, 'electron/main/config.js'));
W.setPanelHeight(56);
C.saveSettings({ panelX: 300, panelY: 120 });
W.applyPanelGeometry();
let pb = main.getBounds();
check(pb.x === 300 && pb.y === 120, 'сохранённые координаты применяются к окну', `x=${pb.x}, y=${pb.y}`);
C.saveSettings({ panelX: -5000, panelY: 99999 });
W.applyPanelGeometry();
pb = main.getBounds();
check(pb.x >= -780 && pb.y <= WORK_AREA.height - 40, 'координаты прижимаются к рабочей области', `x=${pb.x}, y=${pb.y}`);
C.saveSettings({ panelX: null, panelY: null });
W.applyPanelGeometry();
pb = main.getBounds();
check(pb.x === 510 && pb.y === 16, 'до первого перетаскивания — вверху по центру', `x=${pb.x}, y=${pb.y}`);

console.log('\n\x1b[1mОкно истории ответов — отдельное окно СЛЕВА от панели\x1b[0m');
const hw = W.createHistoryWindow();
check(Boolean(hw) && W.state.history === hw, 'окно истории создаётся и регистрируется в state');
check(W.createHistoryWindow() === hw, 'повторный вызов не создаёт второе окно истории');
check(W.ownWindows().includes(hw), 'окно истории — своё: клик по нему не считается кликом «вне»');
// п.8: история — СЛЕВА от панели (источники остаются справа)
const hb0 = hw.getBounds();
const mb2 = main.getBounds();
check(hb0.x + hb0.width + 12 === mb2.x, 'окно истории располагается СЛЕВА от панели с зазором 12 px (п.8)', `x=${hb0.x}, панель x=${mb2.x}`);
check(hb0.x >= 0, 'окно истории внутри рабочей области');
// п.15 (прошлый раунд): при открытом окне истории приложение ДОЛЖНО сворачиваться
hw.show();
W.hideOverlay();
check(!hw.isVisible() && W.state.historyWasVisible === true, 'hideOverlay прячет окно истории вместе с панелью');
W.showOverlay();
check(hw.isVisible(), 'showOverlay возвращает окно истории на место');
W.hideOverlay();
// п.10: положение окна запоминается в пределах сеанса — пересозданное окно
// возвращается туда, куда его перетащил пользователь
hw.setBounds({ x: 700, y: 300, width: 460, height: 600 });
hw.emit('moved');
check(W.memBounds.get('history')?.userMoved === true, 'ручное перемещение окна истории запоминается (п.10)');
hw.destroy();
W.state.history = null;
const hw2 = W.createHistoryWindow();
const hb2 = hw2.getBounds();
check(hb2.x === 700 && hb2.y === 300, 'пересозданное окно истории возвращается на пользовательскую позицию (п.10)', `x=${hb2.x}, y=${hb2.y}`);
W.positionHistoryWindow();
check(hw2.getBounds().x === 700, 'дефолтная позиция не перетирает пользовательскую в том же сеансе (п.10)');
hw2.destroy();
W.state.history = null;
W.state.historyWasVisible = false;
W.memBounds.clear();

console.log('\n\x1b[1mОкна подтверждения «Спросить ИИ?» и профиля (отдельные окна)\x1b[0m');
// п.1: подтверждение вопроса — отдельное окно, не inline-модалка в панели
const cw = W.createConfirmWindow();
check(Boolean(cw) && W.state.confirm === cw, 'окно подтверждения создаётся и регистрируется в state (п.1)');
check(W.ownWindows().includes(cw), 'окно подтверждения — своё: клик по нему не скрывает оверлей');
const cwb = cw.getBounds();
check(cwb.width === 380 && cwb.height === 236, 'размер окна подтверждения 380×236', `${cwb.width}×${cwb.height}`);
check(cwb.x >= 0 && cwb.y >= 0 && cwb.x + cwb.width <= WORK_AREA.width && cwb.y + cwb.height <= WORK_AREA.height, 'окно подтверждения внутри рабочей области');
check(W.createConfirmWindow() === cw, 'повторный вызов не создаёт второе окно подтверждения');
cw.destroy();
W.state.confirm = null;
// п.5: профиль БОЛЬШЕ НЕ отдельное окно — он вкладка настроек в панели
check(W.createProfileWindow === undefined, 'createProfileWindow удалён: профиль живёт в настройках (п.5)');
check(!('profile' in W.state), 'в state окон нет ключа profile (п.5)');

console.log('\n\x1b[1mПоложение панели и прозрачность (п.1, п.7) \x1b[0m');
// п.1: нативное перетаскивание (событие 'moved') сохраняет panelX/panelY
C.saveSettings({ panelX: null, panelY: null });
main.setPosition(640, 220);
main.emit('moved');
await new Promise((r) => setTimeout(r, 400));
{
  const s2 = C.loadSettings();
  check(s2.panelX === 640 && s2.panelY === 220, 'событие moved сохраняет panelX/panelY (п.1)', `panelX=${s2.panelX}, panelY=${s2.panelY}`);
}
// программное перемещение НЕ считается действием пользователя
W.applyPanelGeometry();
main.emit('moved');
await new Promise((r) => setTimeout(r, 400));
{
  const s3 = C.loadSettings();
  check(s3.panelX === 640 && s3.panelY === 220, 'программные setBounds не перезаписывают позицию (п.1)', `panelX=${s3.panelX}, panelY=${s3.panelY}`);
}
// п.7: прозрачность живёт в CSS-переменных страницы; ОС-уровень (setOpacity)
// НЕ используется — на Windows он конфликтует с per-pixel alpha прозрачных
// окон и окно перестаёт отображаться.
{
  check(main.opts.transparent === true && main.opts.backgroundColor === '#00000000',
    'окна создаются transparent + полностью прозрачным фоном (п.7)');
  check(W.applyWindowOpacity === undefined, 'setOpacity не применяется к прозрачным окнам (регресс «окно не видно»)');
  const css = readFileSync(resolve(ROOT, 'renderer/styles/sources.css'), 'utf8');
  check(css.includes('var(--panel-alpha'), 'поверхности окна источников зависят от ползунка прозрачности (п.7)');
  const kbcss = readFileSync(resolve(ROOT, 'renderer/styles/kb.css'), 'utf8');
  check(kbcss.includes('var(--panel-alpha'), 'поверхности окна истории зависят от ползунка прозрачности (п.7)');
}
W.memBounds.clear();

console.log('\n\x1b[1mОкно входа (п.1–2 раунда 33) \x1b[0m');
{
  const aw = W.createAuthWindow('http://127.0.0.1:8787');
  check(aw.alwaysOnTop === true, 'окно входа создаётся поверх полноэкранных приложений (always-on-top)');
  check(String(aw.url ?? '').includes('login.html'), 'окно входа грузит локальную login.html');
  aw.destroy();
  W.state.auth = null;
}

console.log('\n\x1b[1mПоказ/скрытие overlay \x1b[0m');
W.showOverlay();
check(main.isVisible(), 'showOverlay показывает панель');
check(main.isFocused() === true, 'showOverlay передаёт панели фокус (без него blur-скрытие не сработало бы)');
W.hideOverlay();
check(!main.isVisible() && !src.isVisible(), 'hideOverlay прячет панель и источники');
check(W.isOverlayVisible() === false, 'isOverlayVisible=false после скрытия');
check(W.toggleOverlay(true) === true && main.isVisible(), 'toggleOverlay(true) показывает');
W.toggleOverlay(false);

rmSync(USER_DATA, { recursive: true, force: true });
console.log(`\n\x1b[1mИТОГ: ${pass} проверок пройдено, ${fail} провалено\x1b[0m`);
process.exitCode = fail ? 1 : 0;
