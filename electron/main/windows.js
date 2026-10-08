/**
 * EPIC AI — окно окон: создание, геометрия, always-on-top, прозрачность.
 *
 * Основное окно — компактная горизонтальная панель:
 *   56 px высотой, 900 px шириной (фиксировано), frameless, transparent, skipTaskbar.
 *   Положение на экране свободное: панель остаётся там, куда её перетащили.
 * Окно источников — ОТДЕЛЬНЫЙ BrowserWindow справа от панели, размер фиксированный.
 * Настройки отдельного окна НЕ открывают: панель разворачивается вниз.
 */
'use strict';

const { BrowserWindow, screen, shell } = require('electron');
const path = require('node:path');
const { loadSettings, saveSettings } = require('./config.js');

const RENDERER_DIR = path.join(__dirname, '..', '..', 'renderer');

/** Единая партиция сессии: cookie авторизации общая для всех окон. */
const SESSION_PARTITION = 'persist:epic-ai';

const state = {
  splash: null,
  main: null,
  sources: null,
  auth: null,
  admin: null,
  blocked: null,
  history: null,
  confirm: null,
  /** Было ли видно окно истории в момент сворачивания оверлея. */
  historyWasVisible: false,
  /** Развёрнута ли панель настроек внутри основного окна. */
  settingsOpen: false,
  /** Высота панели в развёрнутом состоянии (сообщает renderer). */
  expandedHeight: 0,
};

/**
 * Положения окон В ТЕЧЕНИЕ СЕАНСА (требование пользователя): окна истории,
 * источников и профиля пересоздаются при закрытии, и раньше каждое открытие
 * снова ставило их в «дефолтное» место. Теперь положение, куда окно перетащил
 * пользователь, запоминается здесь и восстанавливается до конца сеанса;
 * позиции по умолчанию вычисляются только если пользователь окно не двигал.
 */
const memBounds = new Map();   // key → { x, y, width, height, userMoved }

/**
 * Следим за перемещением окна пользователем. Программные setBounds тоже
 * порождают 'moved', поэтому сравниваем с последними АВТОМАТИЧЕСКИМИ
 * границами (win.__lastAuto): совпало — значит двигали мы, не пользователь.
 */
function trackUserPosition(key, win) {
  win.on('moved', () => {
    if (win.isDestroyed()) return;
    const b = win.getBounds();
    const a = win.__lastAuto;
    if (a && a.x === b.x && a.y === b.y && a.width === b.width && a.height === b.height) return;
    memBounds.set(key, { ...b, userMoved: true });
  });
}

/** Запомненные пользовательские границы окна (или null). */
function rememberedBounds(key) {
  const m = memBounds.get(key);
  if (!m || !m.userMoved) return null;
  const wa = screen.getDisplayNearestPoint({ x: m.x, y: m.y }).workArea;
  return {
    x: clampInt(m.x, wa.x - m.width + 80, wa.x + wa.width - 80, Math.round(m.x)),
    y: clampInt(m.y, wa.y, wa.y + wa.height - 40, Math.round(m.y)),
    width: m.width,
    height: m.height,
  };
}

/** Двигал ли пользователь окно в этом сеансе. */
function isUserMoved(key) { return Boolean(memBounds.get(key)?.userMoved); }

/** Поставить окно в запомненную позицию или вычислить позицию по умолчанию. */
function placeWindow(key, win, autoPosition) {
  const rb = rememberedBounds(key);
  if (rb) {
    win.setBounds(rb);
    win.__lastAuto = rb;
  } else {
    autoPosition();
  }
}

/**
 * Положение панели переживает перезапуск приложения (п.1 требований
 * пользователя). Renderer шлёт 'epic:panel:move' только при перетаскивании
 * «свободным местом»; за логотип панель тянется нативно
 * (-webkit-app-region: drag) и renderer об этом не знает — поэтому пишем
 * panelX/panelY ещё и здесь, по событию 'moved' (debounce 250 мс).
 */
let panelSaveTimer = null;
let panelSaveLast = null;
function rememberPanelBounds(x, y) {
  panelSaveLast = { x: Math.round(x), y: Math.round(y) };
  if (panelSaveTimer) clearTimeout(panelSaveTimer);
  panelSaveTimer = setTimeout(() => {
    panelSaveTimer = null;
    if (panelSaveLast) saveSettings({ panelX: panelSaveLast.x, panelY: panelSaveLast.y });
    panelSaveLast = null;
  }, 250);
}

function rendererUrl(page, query = {}) {
  const qs = new URLSearchParams(query).toString();
  return `file://${path.join(RENDERER_DIR, page)}${qs ? `?${qs}` : ''}`;
}

function commonWindowOptions() {
  const s = loadSettings();
  return {
    icon: path.join(__dirname, '..', 'assets', 'logo.png'),   // фирменный знак (раунд 28)
    show: false,
    frame: false,
    transparent: true,
    resizable: false,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: true,          // : приложение не отображается на панели задач
    hasShadow: false,
    backgroundColor: '#00000000',
    webPreferences: {
      preload: path.join(__dirname, '..', 'preload', 'index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      spellcheck: false,
      partition: SESSION_PARTITION,
      backgroundThrottling: false,
      // Аппаратное ускорение включено по умолчанию ,
      // отключается глобально до app.ready — см. main.js
    },
  };
}

function applyAlwaysOnTop(win, level = 'screen-saver') {
  const s = loadSettings();
  if (!win || win.isDestroyed()) return;
  if (s.alwaysOnTop) {
    // 'screen-saver' — уровень поверх полноэкранных приложений 
    win.setAlwaysOnTop(true, level, 1);
    win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  } else {
    win.setAlwaysOnTop(false);
    win.setVisibleOnAllWorkspaces(false);
  }
}

/* ------------------------------------------------------------------ */
/*  Splash                                                 */
/* ------------------------------------------------------------------ */

function createSplash() {
  const { width, height } = { width: 360, height: 220 };
  const win = new BrowserWindow({
   ...commonWindowOptions(),
    width, height,
    alwaysOnTop: true,
    focusable: false,
    webPreferences: {...commonWindowOptions().webPreferences },
  });
  win.setMenuBarVisibility(false);
  win.loadURL(rendererUrl('splash.html'));
  centerOn(win);
  applyAlwaysOnTop(win, 'screen-saver');
  win.once('ready-to-show', () => win.show());
  state.splash = win;
  win.on('closed', () => { if (state.splash === win) state.splash = null; });
  return win;
}

function splashStep(stepId, status, detail) {
  const win = state.splash;
  if (win && !win.isDestroyed()) win.webContents.send('splash:step', { id: stepId, status, detail: detail ?? null });
}

function closeSplash() {
  const win = state.splash;
  if (win && !win.isDestroyed()) {
    win.webContents.send('splash:done');
    setTimeout(() => { if (!win.isDestroyed()) win.close(); }, 260);
  }
  state.splash = null;
}

/* ------------------------------------------------------------------ */
/*  Основная панель                                           */
/* ------------------------------------------------------------------ */

/**
 * Ширина панели ЗАФИКСИРОВАНА требованием пользователя: всегда 900 px,
 * независимо от экрана, положения и раскрытых областей. Меняется только
 * высота (настройки / ответ / база знаний разворачивают панель вниз).
 */
const PANEL_WIDTH = 900;

/** Размер окна источников фиксированный (ползунки убраны из настроек). */
const SOURCES_WIDTH = 420;
const SOURCES_HEIGHT = 560;

/**
 * Положение панели — СВОБОДНОЕ: она остаётся там, куда её перетащили
 * (координаты запоминаются в panelX/panelY). До первого перетаскивания —
 * вверху по центру. Координаты прижимаются к рабочей области, чтобы панель
 * нельзя было увести за экран.
 */
function computePanelBounds(width, height) {
  const s = loadSettings();
  const display = screen.getDisplayNearestPoint(screen.getCursorScreenPoint());
  const wa = display.workArea;
  const margin = 16;

  if (Number.isFinite(Number(s.panelX)) && Number.isFinite(Number(s.panelY)) && s.panelX != null && s.panelY != null) {
    const x = clampInt(s.panelX, wa.x - width + 120, wa.x + wa.width - 120, Math.round(Number(s.panelX)));
    const y = clampInt(s.panelY, wa.y, wa.y + wa.height - 40, Math.round(Number(s.panelY)));
    return { x, y, width, height };
  }
  const x = wa.x + Math.round((wa.width - width) / 2);
  return { x, y: wa.y + margin, width, height };
}

function createMainPanel() {
  const s = loadSettings();
  const width = PANEL_WIDTH;
  const height = clampInt(s.panelHeight, 48, 72, 56);
  const bounds = computePanelBounds(width, height);

  const win = new BrowserWindow({...commonWindowOptions(),...bounds });
  win.setMenuBarVisibility(false);
  win.setMinimumSize(PANEL_WIDTH, 48);
  win.setMaximumSize(PANEL_WIDTH, 4096);
  win.loadURL(rendererUrl('main.html'));
  applyAlwaysOnTop(win);
  win.__lastAuto = bounds;
  // Нативное перетаскивание (за логотип и любые app-region: drag зоны):
  // программные setBounds помечаем __lastAuto и не считаем действием пользователя.
  win.on('moved', () => {
    if (win.isDestroyed()) return;
    const b = win.getBounds();
    const a = win.__lastAuto;
    if (a && a.x === b.x && a.y === b.y && a.width === b.width && a.height === b.height) return;
    rememberPanelBounds(b.x, b.y);
  });
  win.once('ready-to-show', () => win.show());
  state.main = win;
  state.settingsOpen = false;
  state.expandedHeight = 0;

  win.on('closed', () => {
    if (state.main === win) state.main = null;
  });
  // Ссылки из панели (например «Открыть источник») — во внешнем браузере
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/i.test(url)) { void shell.openExternal(url); return { action: 'deny' }; }
    return { action: 'deny' };
  });
  return win;
}

/**
 * Изменение высоты панели: настройки разворачиваются ВНУТРИ панели,
 * поэтому окно растёт вниз от текущего положения (положение свободное —
 * к краю не прижимаем). Если вниз не помещается — приподнимаем, не давая
 * окну уйти за рабочую область.
 */
function setPanelHeight(height, opts = {}) {
  const win = state.main;
  if (!win || win.isDestroyed()) return;
  const s = loadSettings();
  const collapsed = clampInt(s.panelHeight, 48, 72, 56);

  // ВАЖНО: getBounds() возвращает объект {x,y,width,height}, а не массив —
  // array-деструктуризация здесь падала с «object is not iterable».
  const b = win.getBounds();
  const wa = screen.getDisplayMatching(b).workArea;

  // Ответ должен помещаться ЦЕЛИКОМ: предел поднят с 900 до 2000 px, но не
  // выше рабочей области экрана (иначе окно уйдёт за край монитора).
  const ceiling = Math.max(collapsed, Math.min(2000, wa.height - 8));
  const h = Math.round(clampInt(height, collapsed, ceiling, collapsed));
  state.expandedHeight = h > collapsed ? h : 0;
  state.settingsOpen = h > collapsed;

  let y = b.y;
  if (y + h > wa.y + wa.height) y = Math.max(wa.y, wa.y + wa.height - h);
  const nb = { x: b.x, y: Math.round(y), width: b.width, height: h };
  win.setBounds(nb);
  win.__lastAuto = nb;
  void opts;

  if (state.sources && !state.sources.isDestroyed()) positionSourcesWindow();
  if (state.history && !state.history.isDestroyed()) positionHistoryWindow();
}

function applyPanelGeometry() {
  const win = state.main;
  if (!win || win.isDestroyed()) return;
  const s = loadSettings();
  const width = PANEL_WIDTH;
  const height = state.settingsOpen && state.expandedHeight ? state.expandedHeight : clampInt(s.panelHeight, 48, 72, 56);
  const b = computePanelBounds(width, height);
  win.setBounds(b);
  win.__lastAuto = b;
  applyAlwaysOnTop(win);
  repositionSatellites();
}

/* ------------------------------------------------------------------ */
/*  Окно источников                                         */
/* ------------------------------------------------------------------ */

function createSourcesWindow(payload) {
  // Размер окна источников ФИКСИРОВАН: отдельные ползунки ширины/высоты
  // убраны из настроек по требованию пользователя.
  const width = SOURCES_WIDTH;
  const height = SOURCES_HEIGHT;
  const win = new BrowserWindow({...commonWindowOptions(), width, height, x: 0, y: 0 });
  win.setMenuBarVisibility(false);
  win.loadURL(rendererUrl('sources.html'));
  applyAlwaysOnTop(win);
  trackUserPosition('sources', win);
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/i.test(url)) { void shell.openExternal(url); return { action: 'deny' }; }
    return { action: 'deny' };
  });
  // Положение по умолчанию — справа от панели; если пользователь уже двигал
  // окно в этом сеансе — возвращаем на его место (позиция живёт до выхода).
  placeWindow('sources', win, positionSourcesWindow);
  win.once('ready-to-show', () => {
    placeWindow('sources', win, positionSourcesWindow);
    win.show();
    if (payload !== undefined) win.webContents.send('sources:data', payload);
  });
  win.webContents.on('did-finish-load', () => {
    if (payload !== undefined) win.webContents.send('sources:data', payload);
  });
  win.on('closed', () => { if (state.sources === win) state.sources = null; });
  state.sources = win;
  return win;
}

/** Окно источников располагается СПРАВА от основной панели. */
function positionSourcesWindow() {
  const main = state.main;
  const src = state.sources;
  if (!src || src.isDestroyed()) return;
  // Пользователь сам передвинул окно в этом сеансе — не «притягиваем» обратно.
  if (isUserMoved('sources')) return;
  const s = loadSettings();
  const gap = clampInt(s.sourcesGap, 0, 80, 12);
  const { width: sw, height: sh } = src.getBounds();
  const display = main && !main.isDestroyed() ? screen.getDisplayMatching(main.getBounds()) : screen.getDisplayNearestPoint(screen.getCursorScreenPoint());
  const wa = display.workArea;

  let x; let y;
  if (main && !main.isDestroyed()) {
    const mb = main.getBounds();
    x = mb.x + mb.width + gap;
    // выравниваем по нижнему краю панели (панель обычно внизу экрана)
    y = mb.y + mb.height - sh;
    if (x + sw > wa.x + wa.width) {
      // справа не помещается → ставим слева от панели
      x = mb.x - sw - gap;
    }
    if (x < wa.x) x = Math.max(wa.x, wa.x + wa.width - sw - 8);
  } else {
    x = wa.x + wa.width - sw - 16;
    y = wa.y + wa.height - sh - 16;
  }
  y = Math.min(Math.max(y, wa.y + 8), wa.y + wa.height - sh - 8);
  const nb = { x: Math.round(x), y: Math.round(y), width: sw, height: sh };
  src.setBounds(nb);
  src.__lastAuto = nb;
  applyAlwaysOnTop(src);
}

function sendSourcesData(payload) {
  const win = state.sources;
  if (win && !win.isDestroyed()) win.webContents.send('sources:data', payload);
}

/* ------------------------------------------------------------------ */
/*  Окно истории ответов (открывается как окно источников)               */
/* ------------------------------------------------------------------ */

/**
 * История вопросов и ответов ИИ. По требованию пользователя открывается
 * ОТДЕЛЬНЫМ окном СЛЕВА от панели (окно источников — справа), а не вкладкой
 * настроек.
 */
function createHistoryWindow() {
  if (state.history && !state.history.isDestroyed()) {
    state.history.show();
    positionHistoryWindow();
    applyAlwaysOnTop(state.history);
    state.history.webContents.send('history:refresh', {});
    return state.history;
  }
  const win = new BrowserWindow({...commonWindowOptions(), width: 460, height: 600, x: 0, y: 0 });
  win.setMenuBarVisibility(false);
  win.loadURL(rendererUrl('history.html'));
  trackUserPosition('history', win);
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/i.test(url)) { void shell.openExternal(url); }
    return { action: 'deny' };
  });
  // Позиция по умолчанию — слева от панели; если пользователь уже двигал
  // окно истории в этом сеансе — возвращаем на его место.
  placeWindow('history', win, positionHistoryWindow);
  win.once('ready-to-show', () => {
    placeWindow('history', win, positionHistoryWindow);
    win.show();
    win.webContents.send('history:refresh', {});
  });
  win.on('closed', () => { if (state.history === win) state.history = null; });
  state.history = win;
  return win;
}

/**
 * Окно истории располагается СЛЕВА от основной панели (требование
 * пользователя: источники справа, история слева). Если слева не хватает
 * места — ставим справа, как раньше.
 */
function positionHistoryWindow() {
  const win = state.history;
  if (!win || win.isDestroyed()) return;
  // Пользователь сам передвинул окно в этом сеансе — не «притягиваем» обратно.
  if (isUserMoved('history')) return;
  const s = loadSettings();
  const gap = clampInt(s.sourcesGap, 0, 80, 12);
  const { width: hw, height: hh } = win.getBounds();
  const main = state.main;
  const display = main && !main.isDestroyed() ? screen.getDisplayMatching(main.getBounds()) : screen.getDisplayNearestPoint(screen.getCursorScreenPoint());
  const wa = display.workArea;

  let x; let y;
  if (main && !main.isDestroyed()) {
    const mb = main.getBounds();
    x = mb.x - hw - gap;                       // сначала — ЛЕВО от панели
    if (x < wa.x) x = mb.x + mb.width + gap;   // слева не помещается → справа
    if (x + hw > wa.x + wa.width) x = Math.max(wa.x, wa.x + wa.width - hw - 8);
    y = mb.y + mb.height - hh;
  } else {
    x = wa.x + 16;
    y = wa.y + wa.height - hh - 16;
  }
  y = Math.min(Math.max(y, wa.y + 8), wa.y + wa.height - hh - 8);
  const nb = { x: Math.round(x), y: Math.round(y), width: hw, height: hh };
  win.setBounds(nb);
  win.__lastAuto = nb;
  applyAlwaysOnTop(win);
}

/** Переставить оба «спутника» панели (источники справа, история слева). */
function repositionSatellites() {
  positionSourcesWindow();
  positionHistoryWindow();
}

/* ------------------------------------------------------------------ */
/*  Окно подтверждения «Спросить ИИ?» (отдельное, не внутри панели)     */
/* ------------------------------------------------------------------ */

const CONFIRM_WIDTH = 380;
const CONFIRM_HEIGHT = 236;

/**
 * Подтверждение вопроса — ОТДЕЛЬНОЕ окно (требование пользователя:
 * раньше модалка рисовалась внутри панели и перекрывала её).
 * Результат (Спросить/Отмена) уходит в main process каналом
 * 'epic:ask:confirm:result' — см. ipc.js.
 */
function createConfirmWindow() {
  if (state.confirm && !state.confirm.isDestroyed()) {
    state.confirm.show();
    state.confirm.focus();
    return state.confirm;
  }
  const win = new BrowserWindow({...commonWindowOptions(), width: CONFIRM_WIDTH, height: CONFIRM_HEIGHT, x: 0, y: 0 });
  win.setMenuBarVisibility(false);
  win.loadURL(rendererUrl('confirm.html'));
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  positionConfirmWindow();
  win.once('ready-to-show', () => { positionConfirmWindow(); win.show(); win.focus(); });
  win.on('closed', () => { if (state.confirm === win) state.confirm = null; });
  state.confirm = win;
  return win;
}

/** Окно подтверждения — по центру панели, чуть ниже бара. */
function positionConfirmWindow() {
  const win = state.confirm;
  if (!win || win.isDestroyed()) return;
  const { width: cw, height: ch } = win.getBounds();
  const main = state.main;
  const display = main && !main.isDestroyed() ? screen.getDisplayMatching(main.getBounds()) : screen.getDisplayNearestPoint(screen.getCursorScreenPoint());
  const wa = display.workArea;
  let x; let y;
  if (main && !main.isDestroyed()) {
    const mb = main.getBounds();
    x = mb.x + Math.round((mb.width - cw) / 2);
    y = mb.y + 72;   // сразу под баром панели
  } else {
    x = wa.x + Math.round((wa.width - cw) / 2);
    y = wa.y + Math.round((wa.height - ch) / 2);
  }
  const nb = {
    x: clampInt(x, wa.x + 8, wa.x + wa.width - cw - 8, Math.round(x)),
    y: clampInt(y, wa.y + 8, wa.y + wa.height - ch - 8, Math.round(y)),
    width: cw, height: ch,
  };
  win.setBounds(nb);
  applyAlwaysOnTop(win);
}

/* ------------------------------------------------------------------ */
/*  Auth / Blocked / Admin                                               */
/* ------------------------------------------------------------------ */

function createAuthWindow(backendUrl) {
  // Раунд 23: окно Auth больше НЕ загружает серверные страницы авторизации.
  // Локальная страница renderer/login.html: кнопки «Войти через …» открывают
  // ВНЕШНИЙ браузер (shell.openExternal через setWindowOpenHandler), а сессию
  // приложение забирает одноразовым тикетом (/api/auth/desktop/claim).
  void backendUrl;
  const win = new BrowserWindow({
    width: 460, height: 520,
    frame: false, transparent: true, resizable: false,
    skipTaskbar: true, show: false, backgroundColor: '#00000000',
    webPreferences: {
      preload: path.join(__dirname, '..', 'preload', 'index.js'),
      contextIsolation: true, nodeIntegration: false, partition: SESSION_PARTITION,
    },
  });
  win.setMenuBarVisibility(false);
  win.loadURL(rendererUrl('login.html'));
  // П.2 раунда 33: окно входа должно быть ПОВЕРХ игры, как и оверлей, —
  // без этого оно показывалось под полноэкранным приложением и выглядело
  // как «ничего не происходит» и «хоткей не работает».
  applyAlwaysOnTop(win);
  // Отладка: EPIC_AI_AUTH_DEVTOOLS=1 открывает DevTools отдельным окном.
  if (process.env.EPIC_AI_AUTH_DEVTOOLS) {
    try { win.webContents.openDevTools({ mode: 'detach' }); } catch { /* ignore */ }
  }
  win.once('ready-to-show', () => { centerOn(win); win.show(); win.focus(); });
  state.auth = win;
  win.on('closed', () => { if (state.auth === win) state.auth = null; });
  // Ссылки (t.me, discord.com) уходят во внешний браузер, не в это окно
  win.webContents.setWindowOpenHandler(({ url }) => {
    // П.2 раунда 29: discord:// и tg:// тоже уходят в ОС — иначе deep-link
    // в приложение Discord молча отклонялся и открывался только сайт.
    if (/^(https?|discord|tg):/i.test(url)) { void shell.openExternal(url); return { action: 'deny' }; }
    return { action: 'deny' };
  });
  return win;
}

function createBlockedWindow(message) {
  const win = new BrowserWindow({
    width: 460, height: 320, frame: false, transparent: true, resizable: false,
    skipTaskbar: true, show: false, alwaysOnTop: true, backgroundColor: '#00000000',
    webPreferences: { preload: path.join(__dirname, '..', 'preload', 'index.js'), contextIsolation: true, nodeIntegration: false, partition: SESSION_PARTITION },
  });
  win.setMenuBarVisibility(false);
  win.loadURL(rendererUrl('blocked.html', { message: message ?? 'Аккаунт заблокирован' }));
  win.once('ready-to-show', () => { centerOn(win); win.show(); });
  state.blocked = win;
  win.on('closed', () => { if (state.blocked === win) state.blocked = null; });
  return win;
}

function createAdminWindow() {
  if (state.admin && !state.admin.isDestroyed()) { state.admin.show(); state.admin.focus(); return state.admin; }
  const win = new BrowserWindow({
    width: 1280, height: 820, minWidth: 1024, minHeight: 640,
    frame: false, transparent: false, resizable: true, show: false,
    backgroundColor: '#0C0C0C', skipTaskbar: false,
    title: 'Epic AI — Админ панель',
    webPreferences: { preload: path.join(__dirname, '..', 'preload', 'index.js'), contextIsolation: true, nodeIntegration: false, partition: SESSION_PARTITION },
  });
  win.setMenuBarVisibility(false);
  win.loadURL(rendererUrl('admin.html'));
  centerOn(win);
  win.once('ready-to-show', () => win.show());
  state.admin = win;
  win.on('closed', () => { if (state.admin === win) state.admin = null; });
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/i.test(url)) { void shell.openExternal(url); return { action: 'deny' }; }
    return { action: 'deny' };
  });
  return win;
}

/* ------------------------------------------------------------------ */
/*  Показ / скрытие overlay                                 */
/* ------------------------------------------------------------------ */

function overlayWindows() {
  return [state.main, state.sources].filter((w) => w && !w.isDestroyed());
}

/** Любые собственные окна приложения: клик по ним НЕ считается кликом «вне». */
function ownWindows() {
  return [state.main, state.sources, state.history, state.confirm, state.admin, state.auth, state.blocked]
   .filter((w) => w && !w.isDestroyed());
}

function isOverlayVisible() {
  return overlayWindows().some((w) => w.isVisible() && !w.isMinimized());
}

/**
 * Показывает/скрывает overlay. Приложение НЕ завершается и остаётся в трее.
 */
function toggleOverlay(force) {
  const visible = typeof force === 'boolean' ? force : !isOverlayVisible();
  if (visible) showOverlay(); else hideOverlay();
  return visible;
}

function showOverlay() {
  const main = state.main;
  if (!main || main.isDestroyed()) return;
  applyPanelGeometry();
  main.show();
  // Фокус обязателен: автоскрытие при клике вне окна  работает через
  // событие 'blur' панели. Без фокуса клик по игре не породил бы blur.
  if (!main.isFocused()) main.focus();
  applyAlwaysOnTop(main);
  if (state.sources && !state.sources.isDestroyed()) {
    state.sources.show();
    positionSourcesWindow();
    applyAlwaysOnTop(state.sources);
  }
  // Окно истории сворачивается вместе с приложением и возвращается обратно
  if (state.historyWasVisible && state.history && !state.history.isDestroyed()) {
    state.history.show();
    positionHistoryWindow();
    applyAlwaysOnTop(state.history);
  }
}

/**
 * Скрыть оверлей. Окно истории прячется ВМЕСТЕ с панелью (иначе приложение
 * «не сворачивалось», пока история открыта); факт видимости запоминаем,
 * чтобы при показе вернуть историю на место. Окно подтверждения вопроса
 * закрывается (неподтверждённый вопрос отменяется — см. ipc.js).
 */
function hideOverlay() {
  state.historyWasVisible = Boolean(state.history && !state.history.isDestroyed() && state.history.isVisible());
  for (const w of overlayWindows()) {
    if (!w.isDestroyed()) w.hide();
  }
  const hist = state.history;
  if (hist && !hist.isDestroyed()) hist.hide();
  const cf = state.confirm;
  if (cf && !cf.isDestroyed()) cf.close();
}

function centerOn(win) {
  const display = screen.getDisplayNearestPoint(screen.getCursorScreenPoint());
  const b = win.getBounds();
  win.setPosition(
    Math.round(display.workArea.x + (display.workArea.width - b.width) / 2),
    Math.round(display.workArea.y + (display.workArea.height - b.height) / 2),
  );
}

function clampInt(v, min, max, fallback) {
  const n = Number(v);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.round(n)));
}

module.exports = {
  state,
  SESSION_PARTITION,
  rendererUrl,
  createSplash, splashStep, closeSplash,
  createMainPanel, applyPanelGeometry, setPanelHeight,
  createSourcesWindow, positionSourcesWindow, sendSourcesData,
  createAuthWindow, createBlockedWindow, createAdminWindow,
  toggleOverlay, showOverlay, hideOverlay, isOverlayVisible,
  applyAlwaysOnTop, overlayWindows, ownWindows, computePanelBounds,
  createHistoryWindow, positionHistoryWindow, PANEL_WIDTH,
  createConfirmWindow, positionConfirmWindow,
  repositionSatellites, memBounds, isUserMoved,
};
