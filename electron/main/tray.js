/**
 * EPIC AI — системный трей.
 *
 * Приложение не отображается на панели задач Windows и живёт в трее.
 * Контекстное меню:
 *   Открыть Epic AI
 *   Настройки
 *   ────────────
 *   Автозапуск
 *   ────────────
 *   Выход
 */
'use strict';

const { Tray, Menu, nativeImage, app } = require('electron');
const path = require('node:path');
const { loadSettings, saveSettings } = require('./config.js');

let tray = null;

/** Иконка трея: фирменный PNG (раунд 28), fallback — встроенный SVG. */
function buildTrayIcon() {
  try {
    const file = path.join(__dirname, '..', 'assets', 'logo.png');
    const img = nativeImage.createFromPath(file);
    if (!img.isEmpty()) return img.resize({ height: 24 });
  } catch { /* fallback ниже */ }
  const size = 32;
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 32 32">
    <rect width="32" height="32" rx="7" fill="#121416"/>
    <rect x="1" y="1" width="30" height="30" rx="6" fill="none" stroke="#ACE72E" stroke-opacity="0.55" stroke-width="1.5"/>
    <path d="M9 22 L16 8 L23 22 Z" fill="none" stroke="#ACE72E" stroke-width="2.2" stroke-linejoin="round"/>
    <circle cx="16" cy="18.5" r="2.1" fill="#E2FF3F"/>
  </svg>`;
  const img = nativeImage.createFromBuffer(Buffer.from(svg, 'utf8'));
  if (!img.isEmpty() && typeof img.setTemplateImage === 'function') img.setTemplateImage(false);
  return img;
}

function buildMenu(callbacks) {
  const s = loadSettings();
  const ready = callbacks.ready !== false;
  return Menu.buildFromTemplate([
    {
      label: 'Открыть Epic AI',
      enabled: ready,
      click: () => callbacks.onOpen(),
    },
    {
      label: 'Настройки',
      enabled: ready,
      click: () => callbacks.onSettings(),
    },
    // Если оверлея нет (аккаунт заблокирован, нет сессии, ошибка backend),
    // из трея должен быть выход — иначе приложение выглядит зависшим.
    {
      label: 'Проверить аккаунт и переподключиться',
      visible: !ready,
      click: () => callbacks.onRecheck(),
    },
    { type: 'separator' },
    {
      label: 'Автозапуск',
      type: 'checkbox',
      checked: Boolean(s.autostart),
      click: (item) => callbacks.onAutostart(item.checked),
    },
    {
      label: 'Поверх игры',
      type: 'checkbox',
      checked: Boolean(s.alwaysOnTop),
      click: (item) => callbacks.onAlwaysOnTop(item.checked),
    },
    {
      label: `Горячая клавиша: ${s.hotkey}`,
      enabled: false,
    },
    { type: 'separator' },
    {
      label: 'Выход',
      click: () => callbacks.onQuit(),
    },
  ]);
}

function createTray(callbacks) {
  if (tray) return tray;
  const icon = buildTrayIcon();
  tray = new Tray(icon.isEmpty() ? nativeImage.createEmpty() : icon);
  tray.setToolTip('Epic AI — помощник EpicRP');
  tray.setContextMenu(buildMenu(callbacks));
  tray.on('click', () => callbacks.onOpen());
  tray.on('double-click', () => callbacks.onSettings());
  return tray;
}

/** Обновить меню (после смены настроек / получения прав). */
function refreshTray(callbacks) {
  if (!tray) return;
  tray.setContextMenu(buildMenu(callbacks));
}

function setTrayHint(text) {
  if (tray && typeof tray.setToolTip === 'function') tray.setToolTip(text ? `Epic AI — ${text}` : 'Epic AI — помощник EpicRP');
}

function destroyTray() {
  if (tray) { tray.destroy(); tray = null; }
}

/* ------------------------------------------------------------------ */
/*  Автозапуск                          */
/* ------------------------------------------------------------------ */

function applyAutostart(enabled) {
  const args = process.argv.slice(1).filter((a) => !a.startsWith('--'));
  if (enabled) {
    app.setLoginItemSettings({
      openAtLogin: true,
      openAsHidden: true,
      path: process.execPath,
      args: app.isPackaged ? [] : args,
    });
  } else {
    app.setLoginItemSettings({ openAtLogin: false, path: process.execPath });
  }
  saveSettings({ autostart: Boolean(enabled) });
}

function getAutostartState() {
  try { return Boolean(app.getLoginItemSettings().openAtLogin); } catch { return false; }
}

module.exports = { createTray, refreshTray, setTrayHint, destroyTray, applyAutostart, getAutostartState, buildTrayIcon };
