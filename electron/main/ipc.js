/**
 * EPIC AI — IPC-обработчики main process.
 *
 * Renderer общается с системой только через эти каналы (см. preload/index.js).
 * Все оконные операции, настройки и внешние ссылки проходят валидацию здесь.
 */
'use strict';

const { ipcMain, shell, app } = require('electron');
const W = require('./windows.js');
const { loadSettings, saveSettings, SETTINGS_DEFAULTS, loadClientConfig, saveClientConfig } = require('./config.js');
const { registerHotkey, normalizeAccelerator, registerCombos } = require('./hotkey.js');
const backend = require('./backend.js');

/** Колбэки, которые main.js подставляет для tray/overlay. */
let hooks = {};

/**
 * Последний payload окна источников: глобальное сочетание Ctrl+O должно
 * снова показывать источники даже когда окно закрыли (данные берём отсюда).
 */
let lastSourcesPayload = null;

/**
 * Ожидание ответа отдельного окна «Спросить ИИ?» (п.1: модалка больше не
 * рисуется внутри панели). Panel вызывает 'epic:ask:confirm' и ждёт promise;
 * окно подтверждения шлёт 'epic:ask:confirm:result' (или закрывается — тогда
 * вопрос считается отменённым).
 */
let askConfirmResolve = null;

/** Рассылка настроек ВСЕМ окнам, которые их применяют (прозрачность и пр.). */
function broadcastToWindows(s) {
  for (const win of [W.state.main, W.state.sources, W.state.admin, W.state.history, W.state.confirm, W.state.blocked]) {
    if (win && !win.isDestroyed()) win.webContents.send('settings:changed', s);
  }
}

/** Debounce-сохранение свободного положения панели (panelX/panelY). */
let panelPosTimer = null;
let panelPosLast = null;
function rememberPanelPosition(x, y) {
  panelPosLast = { x, y };
  if (panelPosTimer) clearTimeout(panelPosTimer);
  panelPosTimer = setTimeout(flushPanelPosition, 250);
}
function flushPanelPosition() {
  if (panelPosTimer) { clearTimeout(panelPosTimer); panelPosTimer = null; }
  if (panelPosLast) saveSettings({ panelX: panelPosLast.x, panelY: panelPosLast.y });
  panelPosLast = null;
}

/** Кэш имени cookie-сессии (читается из /api/auth/providers). */
const sessionCookieName = { cache: null, at: 0 };

function setHooks(h) { hooks = {...hooks,...h }; }

/* ------------------------------------------------------------------ */
/*  Глобальные сочетания Ctrl+H / Ctrl+O / Ctrl+P                       */
/* ------------------------------------------------------------------ */

/**
 * Сочетания из раздела «Клавиши» регистрируются В MAIN PROCESS через
 * globalShortcut (как F10): раньше их слушал только renderer панели, и без
 * фокуса на панели они не срабатывали. Перерегистрируются при каждом
 * изменении настроек (см. 'epic:settings:set').
 */
function comboHistory() {
  const h = W.state.history;
  if (h && !h.isDestroyed() && h.isVisible()) { h.hide(); return; }
  W.createHistoryWindow();
}

function comboSources() {
  const src = W.state.sources;
  if (src && !src.isDestroyed()) {
    if (src.isVisible()) { src.focus(); return; }
    src.show();
    W.positionSourcesWindow();
    W.applyAlwaysOnTop(src);
    return;
  }
  if (lastSourcesPayload) W.createSourcesWindow(lastSourcesPayload);
}

function comboPin() {
  const s = loadSettings();
  const next = !s.alwaysOnTop;
  const ns = saveSettings({ alwaysOnTop: next });
  for (const win of [W.state.main, W.state.sources, W.state.history]) {
    if (win && !win.isDestroyed()) W.applyAlwaysOnTop(win);
  }
  broadcastToWindows(ns);
  hooks.onSettingsChanged?.(ns, { alwaysOnTop: next });
}

function registerComboShortcuts() {
  const s = loadSettings();
  return registerCombos({
    history: { accelerator: s.comboHistory ?? 'Ctrl+H', callback: comboHistory },
    sources: { accelerator: s.comboSources ?? 'Ctrl+O', callback: comboSources },
    pin: { accelerator: s.comboPin ?? 'Ctrl+P', callback: comboPin },
  });
}

function register(hotkeyToggle) {
  app.on('will-quit', flushPanelPosition);

  /* ---------- runtime / info ---------- */

  ipcMain.handle('epic:runtime', async () => {
    const cfg = loadClientConfig();
    const s = loadSettings();
    return {
      backendUrl: cfg.backendUrl.replace(/\/$/, ''),
      version: app.getVersion(),
      electron: process.versions.electron,
      chrome: process.versions.chrome,
      node: process.versions.node,
      platform: process.platform,
      device: require('node:os').hostname(),
      osLabel: prettyOsLabel(),
      arch: process.arch,
      packaged: app.isPackaged,
      settings: s,
    };
  });

  ipcMain.handle('epic:app:info', async () => ({
    version: app.getVersion(),
    electron: process.versions.electron,
    chrome: process.versions.chrome,
    node: process.versions.node,
    platform: process.platform,
    arch: process.arch,
    userData: app.getPath('userData'),
    packaged: app.isPackaged,
    backendUrl: loadClientConfig().backendUrl,
    backendEmbedded: backend.isEmbeddedRunning(),
  }));

  ipcMain.handle('epic:backend:logs', async () => backend.getLogs());

  /**
   * Токен сессии для renderer'а.
   *
   * Зачем: окна renderer'а грузятся с file://, а Chromium не прикладывает
   * cookie к fetch-запросам с непрозрачного origin. Поэтому renderer получает
   * токен через IPC и шлёт его заголовком Authorization: Bearer — backend
   * этот заголовок понимает наравне с cookie (auth/session.ts#readSessionToken).
   * Сам токен хранится в cookie партиции Electron и наружу не уходит.
   */
  ipcMain.handle('epic:session:token', async () => {
    try {
      const cfg = loadClientConfig();
      const url = cfg.backendUrl.replace(/\/$/, '');
      const now = Date.now();
      if (!sessionCookieName.cache || now - sessionCookieName.at > 60_000) {
        const res = await fetch(`${url}/api/auth/providers`, { signal: AbortSignal.timeout(4000) });
        const json = res.ok ? await res.json() : null;
        sessionCookieName.cache = json?.sessionCookie ?? 'epic_ai_session';
        sessionCookieName.at = now;
      }
      const { session } = require('electron');
      const cookies = await session.fromPartition(W.SESSION_PARTITION)
       .cookies.get({ url });
      const found = cookies.find((c) => c.name === sessionCookieName.cache);
      return found ? found.value : null;
    } catch {
      return null;
    }
  });

  /* ---------- настройки ---------- */

  ipcMain.handle('epic:settings:get', async () => ({ settings: loadSettings(), defaults: SETTINGS_DEFAULTS }));

  ipcMain.handle('epic:settings:set', async (_e, patch) => {
    const s = saveSettings(patch ?? {});
    // Реакция на изменения, влияющие на окна
    if ('alwaysOnTop' in (patch ?? {})) {
      W.applyAlwaysOnTop(W.state.main);
      if (W.state.sources) W.applyAlwaysOnTop(W.state.sources);
      if (W.state.history) W.applyAlwaysOnTop(W.state.history);
    }
    if ('panelWidth' in (patch ?? {}) || 'panelPosition' in (patch ?? {}) || 'panelX' in (patch ?? {}) || 'panelY' in (patch ?? {})) {
      try {
        W.applyPanelGeometry();
      } catch (e) {
        console.error('[epic-ai] не удалось применить геометрию панели:', e.message);
      }
    }
    if ('sourcesGap' in (patch ?? {})) {
      W.repositionSatellites();
    }
    if ('hotkey' in (patch ?? {})) {
      const res = registerHotkey(s.hotkey, hotkeyToggle);
      hooks.onHotkeyChanged?.(res);
    }
    // Локальные сочетания стали глобальными: перерегистрируем в системе
    if ('comboHistory' in (patch ?? {}) || 'comboSources' in (patch ?? {}) || 'comboPin' in (patch ?? {})) {
      registerComboShortcuts();
    }
    if ('blur' in (patch ?? {}) || 'opacity' in (patch ?? {}) || 'animations' in (patch ?? {}) || 'lowPerformanceMode' in (patch ?? {}) || 'streamerMode' in (patch ?? {}) || 'streamerNick' in (patch ?? {}) || 'confirmAiAsk' in (patch ?? {})) {
      broadcastToWindows(s);
    }
    hooks.onSettingsChanged?.(s, patch);
    return { settings: s };
  });

  ipcMain.handle('epic:settings:reset', async () => {
    const s = saveSettings(SETTINGS_DEFAULTS);
    W.applyPanelGeometry();
    const res = registerHotkey(s.hotkey, hotkeyToggle);
    registerComboShortcuts();
    hooks.onHotkeyChanged?.(res);
    return { settings: s, hotkey: res };
  });

  /* ---------- геометрия панели ---------- */

  ipcMain.handle('epic:panel:resize', async (_e, height, opts) => {
    W.setPanelHeight(Number(height) || 56, opts ?? {});
    const win = W.state.main;
    return win && !win.isDestroyed() ? win.getBounds() : null;
  });

  ipcMain.handle('epic:panel:geometry', async () => {
    const win = W.state.main;
    return win && !win.isDestroyed() ? win.getBounds() : null;
  });

  ipcMain.handle('epic:panel:move', async (_e, x, y) => {
    const win = W.state.main;
    if (!win || win.isDestroyed()) return null;
    if (Number.isFinite(x) && Number.isFinite(y)) {
      win.setPosition(Math.round(x), Math.round(y));
      // Свободное положение: запоминаем координаты (debounce, чтобы не
      // переписывать settings.json на каждое движение мыши).
      rememberPanelPosition(Math.round(x), Math.round(y));
      // Спутники следуют за панелью (источники справа, история слева),
      // если пользователь не передвигал их сам в этом сеансе.
      W.repositionSatellites();
    }
    return win.getBounds();
  });

  /* ---------- overlay ---------- */

  ipcMain.handle('epic:window:toggle', async () => {
    const visible = W.toggleOverlay();
    hooks.onOverlayChanged?.(visible);
    return visible;
  });

  ipcMain.handle('epic:window:hide', async () => {
    W.hideOverlay();
    hooks.onOverlayChanged?.(false);
    return true;
  });

  ipcMain.handle('epic:window:show', async () => {
    W.showOverlay();
    hooks.onOverlayChanged?.(true);
    return true;
  });

  ipcMain.handle('epic:always-on-top', async (_e, enabled) => {
    const s = saveSettings({ alwaysOnTop: Boolean(enabled) });
    W.applyAlwaysOnTop(W.state.main);
    if (W.state.sources) W.applyAlwaysOnTop(W.state.sources);
    hooks.onSettingsChanged?.(s);
    return s.alwaysOnTop;
  });

  /* ---------- база знаний: раскрытие ВНУТРИ панели (как на референсе) ---------- */

  /**
   * «Посмотреть» / «История изменений» рисуются выпадающей областью панели
   * (pane-kb в main.html) — окно не создаётся, оверлей показывается целиком.
   */
  ipcMain.handle('epic:kb:open', async (_e, payload) => {
    const tab = payload?.tab === 'history' ? 'history' : 'updates';
    const day = typeof payload?.day === 'string' && payload.day ? payload.day : null;
    W.showOverlay();
    hooks.onOverlayChanged?.(true);
    const win = W.state.main;
    if (win && !win.isDestroyed()) win.webContents.send('main:open-kb', { tab, day });
    return true;
  });

  /* ---------- история ответов: отдельное окно, как источники ---------- */

  ipcMain.handle('epic:history:open', async () => {
    W.createHistoryWindow();
    return true;
  });

  /** Клик по записи истории → основной панели открыть этот ответ. */
  ipcMain.handle('epic:history:pick', async (_e, requestId) => {
    const id = Number(requestId);
    if (!Number.isFinite(id) || id <= 0) return false;
    W.showOverlay();
    hooks.onOverlayChanged?.(true);
    const win = W.state.main;
    if (win && !win.isDestroyed()) win.webContents.send('main:open-history-item', id);
    return true;
  });

  /* ---------- окно источников ---------- */

  ipcMain.handle('epic:sources:open', async (_e, payload) => {
    // Кэшируем payload: глобальное сочетание Ctrl+O снова покажет источники
    // последнего ответа, даже если окно закрыли.
    if (payload !== undefined) lastSourcesPayload = payload;
    if (!W.state.sources || W.state.sources.isDestroyed()) W.createSourcesWindow(payload);
    else {
      W.sendSourcesData(payload);
      W.state.sources.show();
      W.positionSourcesWindow();
      W.applyAlwaysOnTop(W.state.sources);
    }
    return true;
  });

  ipcMain.handle('epic:sources:close', async () => {
    const win = W.state.sources;
    if (win && !win.isDestroyed()) win.close();
    W.state.sources = null;
    return true;
  });

  /* ---------- настройки внутри панели  ---------- */

  ipcMain.handle('epic:settings:toggle', async (_e, force) => {
    const open = typeof force === 'boolean' ? force : !W.state.settingsOpen;
    if (open) {
      const win = W.state.main;
      if (win && !win.isDestroyed()) win.webContents.send('main:open-settings', true);
    } else {
      W.setPanelHeight(loadSettings().panelHeight, { anchor: 'top' });
      const win = W.state.main;
      if (win && !win.isDestroyed()) win.webContents.send('main:open-settings', false);
    }
    return open;
  });

  /* ---------- подтверждение вопроса: ОТДЕЛЬНОЕ окно «Спросить ИИ?» ---------- */

  /**
   * Панель вызывает этот канал перед отправкой вопроса и ждёт ответ.
   * Окно подтверждения (confirm.html) открывается поверх панели; «Спросить»
   * / «Отмена» (или закрытие окна) возвращают true/false.
   */
  ipcMain.handle('epic:ask:confirm', async () => {
    // Предыдущий незакрытый запрос подтверждения считаем отменённым
    if (askConfirmResolve) { askConfirmResolve(false); askConfirmResolve = null; }
    const win = W.createConfirmWindow();
    return new Promise((resolve) => {
      askConfirmResolve = (ok) => { askConfirmResolve = null; resolve(Boolean(ok)); };
      win.once('closed', () => {
        if (askConfirmResolve) { askConfirmResolve(false); askConfirmResolve = null; }
      });
    });
  });

  /** Ответ окна подтверждения: true — «Спросить», false — «Отмена»/Esc. */
  ipcMain.handle('epic:ask:confirm:result', async (_e, ok) => {
    const resolve = askConfirmResolve;
    askConfirmResolve = null;
    if (resolve) resolve(Boolean(ok));
    const win = W.state.confirm;
    if (win && !win.isDestroyed()) win.close();
    return true;
  });

  /* ---------- вход завершён: локальная страница входа сообщает main ---------- */

  /**
   * Claim desktop-тикета из окна входа: cookie SameSite=lax не может лечь
   * из cross-origin fetch со страницы file://, поэтому main-процесс сам
   * кладёт токен сессии в cookie партиции (п.1 раунда 26).
   */
  ipcMain.handle('epic:auth:claim', async (_e, payload) => {
    const ticket = String(payload?.ticket ?? '');
    if (!ticket) return { ok: false, error: 'no_ticket' };
    const cfg = loadClientConfig();
    const base = String(cfg.backendUrl ?? '').replace(/\/$/, '');
    let j = null;
    try {
      const res = await fetch(`${base}/api/auth/desktop/claim`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Epic-Client': 'desktop' },
        body: JSON.stringify({ ticket }),
      });
      j = await res.json().catch(() => null);
      if (!res.ok || !j?.ok || !j?.token) return { ok: false, error: j?.error ?? `http_${res.status}` };
    } catch (e) {
      return { ok: false, error: e?.message ?? 'network' };
    }
    try {
      const { session } = require('electron');
      await session.fromPartition(W.SESSION_PARTITION).cookies.set({
        url: base,
        name: j.cookie || 'epic_ai_session',
        value: String(j.token),
        path: '/',
        httpOnly: true,
        sameSite: 'lax',
        secure: base.startsWith('https://'),
        expirationDate: Math.floor(Date.now() / 1000) + 30 * 24 * 3600,
      });
    } catch (e) {
      return { ok: false, error: `cookie: ${e?.message ?? e}` };
    }
    return { ok: true, username: j.username ?? null };
  });

  ipcMain.handle('epic:auth:done', async () => {
    const win = W.state.auth;
    if (win && !win.isDestroyed()) win.close();
    return true;
  });

  /* ---------- прочие окна ---------- */

  ipcMain.handle('epic:admin:open', async () => {
    hooks.ensureAdminAllowed?.();
    W.createAdminWindow();
    return true;
  });

  ipcMain.handle('epic:auth:open', async () => {
    const cfg = loadClientConfig();
    W.createAuthWindow(cfg.backendUrl);
    return true;
  });

  /**
   * Выход из заблокированного аккаунта: отзываем сессию на backend,
   * чистим cookie в партиции Electron и заново проходим инициализацию,
   * чтобы пользователь попал на окно входа, а не в тупик.
   */
  ipcMain.handle('epic:account:logout', async () => {
    await hooks.onAccountLogout?.();
    return true;
  });

  /** Повторная проверка статуса — например, после разблокировки через CLI. */
  ipcMain.handle('epic:account:recheck', async () => {
    await hooks.onAccountRecheck?.();
    return true;
  });

  ipcMain.handle('epic:external', async (_e, url) => {
    const u = String(url ?? '');
    if (!/^https?:\/\//i.test(u)) return false;
    await shell.openExternal(u);
    return true;
  });

  ipcMain.handle('epic:hotkey:set', async (_e, accelerator) => {
    const normalized = normalizeAccelerator(accelerator);
    const res = registerHotkey(normalized, hotkeyToggle);
    if (res.ok) saveSettings({ hotkey: normalized });
    hooks.onHotkeyChanged?.(res);
    return res;
  });

  ipcMain.handle('epic:app:relaunch', async () => { app.relaunch(); app.exit(0); });
  ipcMain.handle('epic:app:quit', async () => { hooks.onQuit?.(); app.quit(); });
}

/** Человекочитаемая ОС для сообщения бота («DESKTOP-X · Windows 11»). */
function prettyOsLabel() {
  const os = require('node:os');
  const rel = os.release();
  if (process.platform === 'win32') {
    const build = Number(String(rel).split('.')[2] ?? 0);
    if (build >= 22000) return 'Windows 11';
    if (build >= 10240) return 'Windows 10';
    return `Windows (${rel})`;
  }
  if (process.platform === 'darwin') return `macOS ${rel}`;
  if (process.platform === 'linux') return 'Linux';
  return process.platform;
}

module.exports = { register, setHooks, registerComboShortcuts, broadcastToWindows };
