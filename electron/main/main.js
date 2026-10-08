/**
 * EPIC AI — main process.
 *
 * Последовательность запуска :
 *   Конфигурация → Локальные данные → Сессия → Пользователь → Статус →
 *   Роль → Permissions → Интерфейс → Основное окно
 *
 * Если действующей сессии нет — Splash → Auth.
 * Если аккаунт заблокирован — показывается окно блокировки, overlay не создаётся.
 */
'use strict';

const { app, BrowserWindow, session, ipcMain } = require('electron');
const path = require('node:path');

const { loadClientConfig, loadSettings, saveSettings, generateStreamerNick } = require('./config.js');
const W = require('./windows.js');
const tray = require('./tray.js');
const { registerHotkey, unregisterAll, normalizeAccelerator } = require('./hotkey.js');
const ipc = require('./ipc.js');
const backend = require('./backend.js');

/**
 * Кириллица в консоли Windows.
 *
 * Node транскодирует вывод console.* в OEM-кодировку консоли, но PowerShell
 * читает stdout как ASCII/ANSI, поэтому UTF-8-байты превращаются в
 * «╨╜╨╡ ╤Г╨┤╨░╨╗╨╛╤Б╤М». Переключаем кодовую страницу консоли на UTF-8
 * до первого вывода. Работает только в режиме разработки из исходников —
 * в собранном приложении окна своей консоли нет.
 */
function setupWindowsConsole() {
  if (process.platform !== 'win32') return;
  if (app.isPackaged) return;
  try {
    require('node:child_process').spawnSync('chcp.com', ['65001'], {
      stdio: 'ignore',
      windowsHide: true,
      timeout: 3000,
    });
  } catch { /* не критично: логи останутся читаемыми в файле */ }
}

setupWindowsConsole();

/* Аппаратное ускорение: вместо обычного GPU-рендера Chromium используем
 * Vulkan через ANGLE (--use-angle=vulkan) — быстрее и стабильнее на Windows.
 * Отключается настройкой hardwareAcceleration=false, но применяется только
 * до app.ready — поэтому читаем файл настроек напрямую. */
const bootSettings = loadSettings();
if (bootSettings.hardwareAcceleration === false) {
  // app.disableHardwareAcceleration() НЕ вызываем: на Windows он убивает
  // per-pixel прозрачность transparent-окон (окна становятся непрозрачными,
  // п.4 раунда 19). Программный растр SwiftShader сохраняет альфа-канал.
  app.commandLine.appendSwitch('use-gl', 'angle');
  app.commandLine.appendSwitch('use-angle', 'swiftshader');
}
// Форсированный --use-angle=vulkan убран: на части драйверов Windows он
// ломает композицию прозрачных окон. «Режим снижения нагрузки» больше не
// трогает GPU вовсе — анимации и эффекты выключает CSS (data-lowperf).

const SINGLE_INSTANCE_LOCK = app.requestSingleInstanceLock();
if (!SINGLE_INSTANCE_LOCK) {
  app.quit();
}

let cfg = loadClientConfig();
let bootState = {
  backendUrl: cfg.backendUrl.replace(/\/$/, ''),
  user: null,
  permissions: [],
  isDeveloper: false,
  maxRoleLevel: 0,
  bootError: null,
};
let quitting = false;

/* ------------------------------------------------------------------ */
/*  HTTP к backend (cookie живёт в партиции Electron)                    */
/* ------------------------------------------------------------------ */

async function api(method, urlPath, body) {
  const url = `${bootState.backendUrl}${urlPath}`;
  const res = await fetch(url, {
    method,
    headers: {
      'Content-Type': 'application/json',
      'X-Epic-Client': 'desktop',
     ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
    redirect: 'manual',
    signal: AbortSignal.timeout(20_000),
  });
  let json = null;
  const text = await res.text();
  try { json = text ? JSON.parse(text) : null; } catch { json = { raw: text.slice(0, 400) }; }
  return { status: res.status, ok: res.ok, json };
}

async function fetchMe() {
  // cookie из партиции Electron добавляем вручную: node-fetch в main не имеет доступа к ним
  const ses = session.fromPartition(W.SESSION_PARTITION);
  const cookies = await ses.cookies.get({ url: bootState.backendUrl });
  const cookieHeader = cookies.map((c) => `${c.name}=${c.value}`).join('; ');
  const res = await fetch(`${bootState.backendUrl}/api/auth/me`, {
    headers: { 'X-Epic-Client': 'desktop',...(cookieHeader ? { Cookie: cookieHeader } : {}) },
    redirect: 'manual',
    signal: AbortSignal.timeout(20_000),
  });
  const text = await res.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch { json = null; }
  return { status: res.status, json };
}

/* ------------------------------------------------------------------ */
/*  Выход из аккаунта и повторная проверка статуса                       */
/* ------------------------------------------------------------------ */

/** Чистит cookie-сессию в партиции Electron. */
async function clearSessionCookies() {
  try {
    const ses = session.fromPartition(W.SESSION_PARTITION);
    await ses.clearStorageData({ storages: ['cookies'] });
  } catch (e) {
    console.warn('[epic-ai] не удалось очистить cookie:', e.message);
  }
}

/** Закрыть все окна, кроме трея, чтобы начать инициализацию заново. */
function closeAllWindowsExceptTray() {
  for (const key of ['sources', 'admin', 'auth', 'blocked', 'main', 'splash', 'history', 'confirm']) {
    const win = W.state[key];
    if (win && !win.isDestroyed()) { try { win.destroy(); } catch { /* ignore */ } }
    W.state[key] = null;
  }
  W.state.settingsOpen = false;
  W.state.expandedHeight = 0;
  W.state.historyWasVisible = false;
}

/** «Выйти из аккаунта» из окна блокировки: отзыв сессии + окно входа. */
async function accountLogout() {
  try {
    await api('POST', '/api/auth/logout', {});
  } catch (e) {
    console.warn('[epic-ai] logout failed:', e.message);
  }
  await clearSessionCookies();
  bootState = {...bootState, user: null, permissions: [], isDeveloper: false, maxRoleLevel: 0 };
  closeAllWindowsExceptTray();
  W.createSplash();
  await bootSequence();
}

/** «Проверить снова»: перечитать статус с backend (например, после разблокировки через CLI). */
async function accountRecheck() {
  closeAllWindowsExceptTray();
  W.createSplash();
  await bootSequence();
}

/* ------------------------------------------------------------------ */
/*  Автозапуск / tray / hotkey                                          */
/* ------------------------------------------------------------------ */

function trayCallbacks() {
  return {
    // «готово» = оверлей создан и аккаунт активен
    ready: Boolean(W.state.main) && bootState.user != null && bootState.user.status !== 'blocked',
    adminVisible: bootState.permissions.includes('users.view') || bootState.permissions.includes('ai.reports.view'),
    canSync: bootState.permissions.includes('knowledge.sync'),
    onOpen: () => {
      // Клик по трею до входа показывает окно входа (или поднимает заново),
      // после входа — оверлей
      if (!W.state.main) {
        const auth = W.state.auth;
        if (auth && !auth.isDestroyed()) { toggleAuthWindow(); return; }
        void accountRecheck();
        return;
      }
      W.showOverlay();
    },
    onRecheck: () => { void accountRecheck(); },
    onSettings: () => {
      W.showOverlay();
      setTimeout(() => {
        const win = W.state.main;
        if (win && !win.isDestroyed()) {
          win.webContents.send('main:open-settings', true);
          W.setPanelHeight(520, { anchor: 'top' });
        }
      }, 120);
    },
    onAutostart: (enabled) => { tray.applyAutostart(enabled); tray.refreshTray(trayCallbacks()); },
    onAlwaysOnTop: (enabled) => {
      saveSettings({ alwaysOnTop: enabled });
      W.applyAlwaysOnTop(W.state.main);
      if (W.state.sources) W.applyAlwaysOnTop(W.state.sources);
      tray.refreshTray(trayCallbacks());
      broadcastSettings();
    },
    onAdmin: () => { W.createAdminWindow(); },
    onSync: () => { void triggerSync(); },
    onQuit: () => { quitting = true; app.quit(); },
  };
}

function broadcastSettings() {
  // Прозрачность и прочие визуальные настройки применяют ВСЕ окна приложения
  // (панель, источники, история, профиль, подтверждение, админка, блокировка) —
  // раньше список был короче, и окно истории/профиль игнорировали настройку.
  ipc.broadcastToWindows(loadSettings());
}

async function triggerSync() {
  const r = await api('POST', '/api/kb/sync', { full: false });
  tray.setTrayHint(r.ok ? 'синхронизация запущена' : `ошибка синхронизации (${r.status})`);
  setTimeout(() => tray.setTrayHint(null), 6000);
  return r;
}

/* ------------------------------------------------------------------ */
/*  Автоскрытие при клике вне Epic AI                            */
/* ------------------------------------------------------------------ */

/**
 * Клик вне окон Epic AI отлавливается событием 'blur' основной панели
 * (см. createOverlay): любой клик по игре / рабочему столу / другому
 * приложению забирает фокус → панель прячется в трей.
 *
 * Ранее здесь использовался «screen-spy» на событии 'screen-spy-captured',
 * которого в Electron НЕ СУЩЕСТВУЕТ: слушатели только накапливались на
 * объекте screen (MaxListenersExceededWarning), поэтому механизм удалён.
 */

function notifyOverlay(visible) {
  for (const win of [W.state.main, W.state.sources]) {
    if (win && !win.isDestroyed()) win.webContents.send('overlay:visibility', { visible });
  }
  tray.setTrayHint(visible ? null : 'скрыто (нажмите горячую клавишу)');
}

/**
 * П.3 раунда 24: пока основного окна нет (идёт вход), глобальная горячая
 * клавиша показывает/скрывает ОКНО ВХОДА — так же, как позже оверлей.
 */
function toggleAuthWindow() {
  const win = W.state.auth;
  if (!win || win.isDestroyed()) return false;
  if (win.isVisible()) { win.hide(); return false; }
  win.show();
  win.focus();
  // Поверх полноэкранных приложений + принудительная перерисовка:
  // прозрачные окна Windows после hide/show могут не реpaint'иться сами.
  W.applyAlwaysOnTop(win);
  try { win.moveTop(); } catch { /* ignore */ }
  try { const b = win.getBounds(); win.setBounds({ ...b }); } catch { /* ignore */ }
  console.log(`[epic-ai] окно входа показано, visible=${win.isVisible()}`);
  return true;
}

let hotkeyRetryTimer = null;

/**
 * Регистрация хоткея с ретраем (п.5 раунда 27): если ОС или другое приложение
 * держит сочетание, повторяем каждые 3 с (до 10 раз) и пишем причину в лог —
 * раньше неудача была тихой, и окно входа «не реагировало» на клавишу.
 */
/**
 * Регистрация хоткея с фолбэк-цепочкой (п.2 раунда 31): если пользовательское
 * сочетание занято ОС или другой программой, пробуем F10 → F9 → F11 → F12 →
 * Ctrl+Alt+W и сообщаем, какое сочетение реально работает (лог + тултип трея).
 * Без этого регистрация молча падала и «горячие клавиши не работали».
 */
function ensureHotkey() {
  const wanted = normalizeAccelerator(loadSettings().hotkey);
  const candidates = [wanted, 'F10', 'F9', 'F11', 'F12', 'Ctrl+Alt+W'].filter((v, i, a) => a.indexOf(v) === i);
  const tryAll = () => {
    for (const acc of candidates) {
      let res = null;
      try { res = registerHotkey(acc, hotkeyToggle); } catch (e) { res = { ok: false, error: e.message }; }
      if (res?.ok) {
        if (acc !== wanted) {
          console.warn(`[epic-ai] хоткей ${wanted} занят/недоступен — зарегистрирован запасной ${acc}`);
          try { tray.setTrayHint(`хоткей: ${acc} (ваш ${wanted} занят)`); } catch { /* ignore */ }
        } else {
          console.log(`[epic-ai] хоткей зарегистрирован: ${acc}`);
        }
        return acc;
      }
      console.warn(`[epic-ai] хоткей ${acc}: регистрация отклонена (${JSON.stringify(res ?? {})})`);
    }
    return null;
  };
  if (tryAll()) {
    if (hotkeyRetryTimer) { clearInterval(hotkeyRetryTimer); hotkeyRetryTimer = null; }
    return true;
  }
  if (!hotkeyRetryTimer) {
    let n = 0;
    hotkeyRetryTimer = setInterval(() => {
      n += 1;
      const ok = tryAll();
      if (ok || n > 30) { clearInterval(hotkeyRetryTimer); hotkeyRetryTimer = null; }
    }, 3000);
  }
  return false;
}

function hotkeyToggle() {
  // Диагностика п.5 раунда 30: видно, какую ветку выбрал обработчик
  console.log(`[epic-ai] hotkey: main=${Boolean(W.state.main)} auth=${Boolean(W.state.auth && !W.state.auth.isDestroyed())} authVisible=${Boolean(W.state.auth && !W.state.auth.isDestroyed() && W.state.auth.isVisible())}`);
  if (!W.state.main) {
    // П.3 раунда 26: окно входа поднято снова даже после закрытия крестиком —
    // хоткей перезапускает boot-цепочку (splash → проверка сессии → login).
    const auth = W.state.auth;
    if (auth && !auth.isDestroyed()) { toggleAuthWindow(); return; }
    void accountRecheck();
    return;
  }
  const visible = W.toggleOverlay();
  console.log(`[epic-ai] hotkey: overlay visible=${visible}`);
  notifyOverlay(visible);
  const win = W.state.main;
  if (win && !win.isDestroyed()) win.webContents.send('overlay:visibility', { visible });
}

/* ------------------------------------------------------------------ */
/*  Последовательность инициализации                             */
/* ------------------------------------------------------------------ */

async function bootSequence() {
  const step = (id, status, detail) => W.splashStep(id, status, detail);
  bootState.bootError = null;

  // 1. Конфигурация
  step('config', 'active');
  cfg = loadClientConfig();
  bootState.backendUrl = cfg.backendUrl.replace(/\/$/, '');
  step('config', 'done', bootState.backendUrl);

  // 2. Локальные данные
  step('local_data', 'active');
  try {
    await session.fromPartition(W.SESSION_PARTITION);
    // Режим стримера: ник перегенерируется при КАЖДОМ запуске приложения —
    // одно и то же имя не должно кочевать между стримами (требование пользователя).
    saveSettings({ streamerNick: generateStreamerNick() });
    const s = loadSettings();
    step('local_data', 'done', `настроек: ${Object.keys(s).length}`);
  } catch (e) {
    step('local_data', 'error', e.message);
  }

  // 3. Сессия / backend
  step('session', 'active');
  if (cfg.embeddedBackend) {
    const res = await backend.startEmbedded(cfg, {
      appPath: app.getAppPath(),
      isPackaged: app.isPackaged,
      onProgress: (_stage, detail) => step('session', 'active', detail),
    });
    if (!res.started && res.reason === 'timeout') {
      step('session', 'error', 'backend не поднялся');
      bootState.bootError = 'backend_timeout';
    }
  }
  let health = await backend.health(bootState.backendUrl, 4000);
  if (!health.ok) {
    step('session', 'error', health.error ?? `status ${health.status ?? '—'}`);
    bootState.bootError = 'backend_unavailable';
    await new Promise((r) => setTimeout(r, 900));
    W.closeSplash();
    await showFatal(`Backend недоступен: ${bootState.backendUrl}`, 'Проверьте backend/.env и запустите `npm run dev:backend`.');
    return;
  }
  step('session', 'done', health.info?.db ? `${health.info.db.driver}/${health.info.db.engine}` : 'ok');

  // 4. Пользователь / 5. Статус
  step('user', 'active');
  let me = await fetchMe();

  if (me.status === 401 || (me.json && me.json.authenticated === false)) {
    // : действующей сессии нет → Auth
    step('user', 'wait', 'требуется вход');
    W.closeSplash();
    const ok = await waitForAuth();
    if (!ok) return;
    step('user', 'active');
    me = await fetchMe();
  }

  if (me.status === 403 && me.json?.blocked) {
    step('status', 'error', 'blocked');
    W.closeSplash();
    const reason = me.json.user?.blockedReason ?? null;
    await showBlocked(reason
      ? `Аккаунт заблокирован.\n\nПричина: ${reason}`
      : 'Аккаунт заблокирован. Использование Epic AI запрещено.');
    return;
  }
  if (!me.json?.authenticated) {
    step('user', 'error', 'не удалось получить пользователя');
    W.closeSplash();
    await showFatal('Не удалось получить пользователя', 'Попробуйте войти заново из трея.');
    return;
  }
  step('user', 'done', me.json.user?.username ?? '');

  step('status', 'active');
  step('status', 'done', me.json.user?.status ?? 'active');

  // 6. Роль
  step('role', 'active');
  const role = me.json.user?.primaryRole;
  step('role', 'done', role?.name ?? 'Игрок');

  // 7. Permissions
  step('permissions', 'active');
  bootState.user = me.json.user;
  bootState.permissions = Array.isArray(me.json.permissions) ? me.json.permissions : [];
  bootState.isDeveloper = Boolean(me.json.isDeveloper);
  bootState.maxRoleLevel = Number(me.json.maxRoleLevel ?? 0);
  step('permissions', 'done', `${bootState.permissions.length} прав`);

  // 8. Интерфейс
  step('ui', 'active');
  await applyRuntimeSettings();
  step('ui', 'done');

  // 9. Основное окно
  step('main', 'active');
  createOverlay();
  step('main', 'done');

  await new Promise((r) => setTimeout(r, 220));
  W.closeSplash();
  tray.refreshTray(trayCallbacks());
}

/** Ждём завершения авторизации в окне Auth. */
function waitForAuth() {
  return new Promise((resolve) => {
    const cfgUrl = bootState.backendUrl;
    const win = W.createAuthWindow(cfgUrl);
    ensureHotkey();   // страховка: клавиша обязана работать на окне входа
    let settled = false;
    const done = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      win.removeListener('closed', onClosed);
      resolve(result);
    };
    const onClosed = () => {
      // окно закрыли вручную — даём шанс повторить из трея
      done(false);
    };
    const check = async () => {
      const me = await fetchMe().catch(() => null);
      if (me?.json?.authenticated && me.json.blocked !== true) {
        done(true);
        return;
      }
      timer = setTimeout(check, 2000);   // реже: окно входа может висеть долго
    };
    let timer = setTimeout(check, 1500);
    // Окно входа закрыли вручную: сначала проверяем сессию вдруг claim успел,
    // потом даём шанс повторить из трея.
    const onClosedCheck = async () => {
      const me = await fetchMe().catch(() => null);
      if (me?.json?.authenticated && me.json.blocked !== true) done(true);
      else onClosed();
    };
    win.on('closed', onClosedCheck);
  });
}

async function showBlocked(message) {
  W.createBlockedWindow(message);
  tray.createTray(trayCallbacks());
  tray.setTrayHint('аккаунт заблокирован');
}

async function showFatal(title, detail) {
  W.createBlockedWindow(`${title}\n${detail}`);
  tray.createTray(trayCallbacks());
  tray.setTrayHint('ошибка запуска');
}

/* ------------------------------------------------------------------ */
/*  Overlay                                                             */
/* ------------------------------------------------------------------ */

function createOverlay() {
  const win = W.createMainPanel();

  // Крестик/закрытие основного окна → прячем в трей, процесс не завершается 
  win.on('close', (e) => {
    if (!quitting) {
      e.preventDefault();
      W.hideOverlay();
      notifyOverlay(false);
    }
  });
  win.webContents.on('did-finish-load', () => {
    win.webContents.send('main:init', {
      user: bootState.user,
      permissions: bootState.permissions,
      isDeveloper: bootState.isDeveloper,
      maxRoleLevel: bootState.maxRoleLevel,
      backendUrl: bootState.backendUrl,
      settings: loadSettings(),
    });
  });

  // Клик вне окна → скрытие 
  win.on('blur', () => {
    const s = loadSettings();
    if (!s.hideOnOutsideClick) return;
    // ЗАКРЕПЛЁННОЕ окно (звёздочка / alwaysOnTop) НЕ прячется при клике вне:
    // требование пользователя — закреплённая панель остаётся поверх игры.
    if (s.alwaysOnTop) return;
    setTimeout(() => {
      const focused = BrowserWindow.getFocusedWindow();
      if (focused && W.ownWindows().includes(focused)) return;   // клик по нашему же окну (источники, БЗ, админ…)
      if (!W.isOverlayVisible()) return;
      W.hideOverlay();
      notifyOverlay(false);
    }, 120);
  });

}

/** Настройки, влияющие на рантайм окон. */
async function applyRuntimeSettings() {
  const s = loadSettings();
  tray.applyAutostart(Boolean(s.autostart));
  registerHotkey(normalizeAccelerator(s.hotkey), hotkeyToggle);
  // Ctrl+H / Ctrl+O / Ctrl+P — ГЛОБАЛЬНЫЕ сочетания (работают даже когда
  // фокус в игре); перерегистрируются при смене значений в «Клавиши».
  ipc.registerComboShortcuts();
}

/* ------------------------------------------------------------------ */
/*  Жизненный цикл приложения                                           */
/* ------------------------------------------------------------------ */

app.on('second-instance', () => {
  W.showOverlay();
  notifyOverlay(true);
});

// П.1 раунда 34: консоли Windows по умолчанию в cp866 — UTF-8-логи выглядят
// кракозябрами. Переключаем кодовую страницу общей консоли на 65001 до первых
// строк лога (chcp в дочернем процессе меняет код-страницу той же консоли).
if (process.platform === 'win32') {
  try { require('node:child_process').execSync('chcp 65001', { stdio: 'ignore' }); } catch { /* ignore */ }
}

app.whenReady().then(async () => {
  // Голосовой ввод: renderer пишет микрофон через getUserMedia — разрешаем
  // media-права окнам нашей партиции (без этого Chromium молча отказывает).
  try {
    session.fromPartition(W.SESSION_PARTITION).setPermissionRequestHandler((_wc, permission, callback) => {
      callback(['media', 'audioCapture', 'mediaKeySystem', 'notifications'].includes(permission));
    });
  } catch (e) { console.warn('[epic-ai] permission handler:', e.message); }

  // П.4 раунда 25/26: хоткей активен уже во время входа — до появления
  // основного окна он показывает/скрывает окно входа (hotkeyToggle).
  ensureHotkey();

  ipc.register(hotkeyToggle);
  ipc.setHooks({
    onOverlayChanged: notifyOverlay,
    onSettingsChanged: (s, patch) => {
      broadcastSettings();
      tray.refreshTray(trayCallbacks());
      // Автозапуск вместе с Windows применяется сразу 
      if (patch && 'autostart' in patch) tray.applyAutostart(Boolean(s.autostart));
      // Реагируем только на ТЕ ключи, которые реально менялись (patch),
      // а не на полный слепок настроек: иначе каждое сохранение настроек
      // считалось изменением поведения скрытия. Сейчас дополнительных
      // действий не нужно: скрытие по клику работает через blur-обработчик,
      // который читает настройку при каждом событии.
      void patch;
    },
    onHotkeyChanged: (res) => tray.refreshTray(trayCallbacks()),
    ensureAdminAllowed: () => {
      const allowed = bootState.permissions.some((p) => ['users.view', 'ai.reports.view', 'knowledge.view', 'system.logs', 'roles.view'].includes(p));
      if (!allowed) throw Object.assign(new Error('Недостаточно прав для администрирования'), { statusCode: 403 });
    },
    onAccountLogout: () => accountLogout(),
    onAccountRecheck: () => accountRecheck(),
    onQuit: () => { quitting = true; },
  });

  W.createSplash();
  tray.createTray(trayCallbacks());

  await bootSequence();

  // База знаний обновляется ПРИ ЗАПУСКЕ приложения (требование пользователя):
  // клиент просит backend синхронизироваться своей сессией; embedded-backend
  // к этому моменту уже поднялся и сам запланировал startup-sync.
  setTimeout(() => { void triggerKbSyncOnStart(); }, 5000);
});

/**
 * Запрос синхронизации БЗ при старте клиента своей сессией (cookie партиции).
 * Нет прав / crawler выключен / backend не в сети — молча пропускаем:
 * обновление не должно мешать запуску приложения.
 */
async function triggerKbSyncOnStart() {
  // Раунд 29: при выключенном crawler'е синхронизация запрещена (403) —
  // не дёргаем её при старте, чтобы не шуметь «startup KB sync: skipped».
  try {
    const st = await fetch(`${bootState.backendUrl}/api/kb/status`).then((r) => r.json()).catch(() => null);
    if (st && st.crawlerEnabled === false) return;
  } catch { /* backend недоступен — sync и так пропустится */ }
  try {
    const ses = session.fromPartition(W.SESSION_PARTITION);
    const cookies = await ses.cookies.get({ url: bootState.backendUrl });
    const cookieHeader = cookies.map((c) => `${c.name}=${c.value}`).join('; ');
    const res = await fetch(`${bootState.backendUrl}/api/kb/sync`, {
      method: 'POST',
      headers: {
        'X-Epic-Client': 'desktop',
        'Content-Type': 'application/json',
       ...(cookieHeader ? { Cookie: cookieHeader } : {}),
      },
      body: JSON.stringify({ full: false }),
      redirect: 'manual',
      signal: AbortSignal.timeout(15_000),
    });
    if (res.ok) console.log('[epic-ai] startup KB sync: requested');
    else if (res.status === 409) console.log('[epic-ai] startup KB sync: already running');
    else console.log(`[epic-ai] startup KB sync: skipped (HTTP ${res.status})`);
  } catch (e) {
    console.log(`[epic-ai] startup KB sync: unavailable (${e?.message ?? e})`);
  }
}

app.on('window-all-closed', (e) => {
  // Приложение живёт в трее: не выходим, пока пользователь явно не выбрал «Выход» 
  if (quitting) { app.quit(); return; }
  if (!W.state.main && !W.state.auth && !W.state.blocked && !W.state.admin) {
    // окон нет вообще — остаёмся в трее
  }
});

// Выход не должен падать ни при каких обстоятельствах: любая ошибка в
// обработчике ранее приводила к uncaughtException и «висящему» процессу.
app.on('before-quit', () => {
  quitting = true;
  try {
    unregisterAll();
  } catch (e) { console.warn('[epic-ai] unregisterAll:', e.message); }
  try {
    backend.stopEmbedded();
  } catch (e) { console.warn('[epic-ai] stopEmbedded:', e.message); }
  for (const win of [W.state.sources, W.state.admin, W.state.auth, W.state.blocked, W.state.main, W.state.splash, W.state.history, W.state.confirm]) {
    if (win && !win.isDestroyed()) { try { win.destroy(); } catch { /* ignore */ } }
  }
  try { tray.destroyTray(); } catch { /* ignore */ }
});

// В dev-режиме удобно открывать DevTools по F12
ipcMain.handle('epic:devtools', async (e) => {
  const win = BrowserWindow.fromWebContents(e.sender);
  if (win) win.webContents.toggleDevTools();
  return true;
});

process.on('uncaughtException', (e) => {
  console.error('[epic-ai] uncaughtException:', e);
  // Во время выхода любая необработанная ошибка не должна оставлять процесс живым
  if (quitting) {
    try { backend.stopEmbedded(); } catch { /* ignore */ }
    process.exit(1);
  }
});
process.on('unhandledRejection', (e) => {
  console.error('[epic-ai] unhandledRejection:', e);
});

module.exports = { bootState };
