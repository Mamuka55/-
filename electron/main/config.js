/**
 * EPIC AI — конфигурация клиента (main process).
 *
 * Хранится в userData/config.json, при первом запуске создаётся из
 * assets/client-config.default.json. Позволяет сменить адрес backend
 * без пересборки клиента — это и есть механизм переноса local → VPS.
 *
 * ВАЖНО: client-config.default.json — строгий JSON, комментарии в нём
 * недопустимы (JSON.parse на них падает). Все пояснения живут здесь.
 *
 * Поля конфига:
 *   backendUrl       адрес backend; на VPS меняется на https://api.…
 *   embeddedBackend  true = Electron сам поднимает backend рядом с собой
 *   backendCommand   чем запускать backend (по умолчанию: npx в dev, node в сборке)
 *   backendArgs      аргументы запуска
 *   backendCwd       рабочий каталог backend (относительно app.getAppPath())
 *
 * В режиме разработки (app.isPackaged === false) значения backendCommand/Args/Cwd
 * подставляются автоматически — см. DEV_DEFAULTS ниже, поэтому в файле их нет.
 */
'use strict';

const { app } = require('electron');
const fs = require('node:fs');
const path = require('node:path');

const DEFAULTS = Object.freeze({
  backendUrl: 'http://127.0.0.1:8787',
  embeddedBackend: true,
  backendCommand: null,
  backendArgs: null,
  backendCwd: null,
});

/**
 * Как запускать backend в режиме разработки из исходников.
 * app.getAppPath() = <проект>/electron, поэтому backend лежит в../backend.
 */
const DEV_DEFAULTS = Object.freeze({
  backendCommand: 'npx',
  backendArgs: ['tsx', 'src/index.ts'],
  backendCwd: '../backend',
});

/** Production-сборка: backend обычно на VPS, но если он рядом — запускаем dist. */
const PROD_DEFAULTS = Object.freeze({
  backendCommand: 'node',
  backendArgs: ['dist/index.js'],
  backendCwd: '../backend',
});

/** Настройки интерфейса по умолчанию. */
const SETTINGS_DEFAULTS = Object.freeze({
  // Общие
  language: 'ru',
  theme: 'dark',
  autostart: false,

  // Интерфейс
  opacity: 0.82,
  // Ширина панели ЗАФИКСИРОВАНА (требование пользователя): всегда 900 px.
  // Ключ хранится только для совместимости старых settings.json — окна
  // используют константу PANEL_WIDTH из windows.js.
  panelWidth: 900,
  panelHeight: 56,
  // Положение свободное: панель остаётся там, куда её перетащили.
  panelX: null,
  panelY: null,
  sourcesGap: 12,

  // Поведение
  alwaysOnTop: true,
  hotkey: 'F10',
  // Локальные сочетания панели (меняются в «Клавиши», перехватом сочетания)
  comboHistory: 'Ctrl+H',
  comboSources: 'Ctrl+O',
  comboPin: 'Ctrl+P',
  hideOnOutsideClick: true,
  clearPreviousAnswer: true,
  rememberMode: true,
  defaultMode: 'rules',
  // Подтверждение вопроса ОТДЕЛЬНЫМ окном «Спросить ИИ?» (отключается)
  confirmAiAsk: true,
  // Режим стримера: случайный ник вместо настоящего, аватар — заглушка.
  // Ник перегенерируется при КАЖДОМ запуске приложения (см. generateStreamerNick).
  streamerMode: false,
  streamerNick: null,
  // Устройство микрофона для голосового ввода (deviceId из enumerateDevices);
  // null = системное устройство по умолчанию.
  micDeviceId: null,

  // Производительность
  hardwareAcceleration: true,
  lowPerformanceMode: false,
});

const SETTINGS_FILE = () => path.join(app.getPath('userData'), 'settings.json');
const CONFIG_FILE = () => path.join(app.getPath('userData'), 'config.json');

function readJson(file) {
  try {
    if (!fs.existsSync(file)) return null;
    const raw = fs.readFileSync(file, 'utf8');
    // JSON не поддерживает комментарии; убираем только BOM, всё остальное — ошибка
    return JSON.parse(raw.replace(/^\uFEFF/, ''));
  } catch (e) {
    console.error(`[epic-ai] не удалось разобрать JSON ${file}: ${e.message}`);
    console.error('[epic-ai] файл должен быть строгим JSON без комментариев (// и /* */ недопустимы).');
    return null;
  }
}

function writeJsonAtomic(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf8');
  fs.renameSync(tmp, file);
}

/** Конфигурация подключения к backend. */
function loadClientConfig() {
  const file = CONFIG_FILE();
  let cfg = readJson(file);

  if (!cfg) {
    // Копируем дефолт из ресурсов приложения
    const candidates = [
      path.join(__dirname, '..', 'assets', 'client-config.default.json'),
      path.join(__dirname, '..', '..', 'electron', 'assets', 'client-config.default.json'),
    ];
    for (const d of candidates) {
      const parsed = readJson(d);
      if (parsed) { cfg = parsed; break; }
    }
    cfg = {...(cfg ?? {}) };
    writeJsonAtomic(file, cfg);
  }

  // Значения по умолчанию для запуска backend подставляются по режиму,
  // если пользователь не задал их в конфиге явно.
  const mode = app.isPackaged ? PROD_DEFAULTS : DEV_DEFAULTS;
  return {
   ...DEFAULTS,
   ...cfg,
    backendCommand: cfg.backendCommand ?? mode.backendCommand,
    backendArgs: cfg.backendArgs ?? mode.backendArgs,
    backendCwd: cfg.backendCwd ?? mode.backendCwd,
  };
}

function saveClientConfig(patch) {
  const cur = loadClientConfig();
  const next = {...cur,...patch };
  writeJsonAtomic(CONFIG_FILE(), next);
  return next;
}

/** Пользовательские настройки интерфейса. */
function loadSettings() {
  return {...SETTINGS_DEFAULTS,...(readJson(SETTINGS_FILE()) ?? {}) };
}

function saveSettings(patch) {
  const next = {...loadSettings(),...patch };
  writeJsonAtomic(SETTINGS_FILE(), next);
  return next;
}

/**
 * Случайный ник для режима стримера.
 *
 * Требование пользователя: ник НЕ должен быть одним и тем же между
 * запусками — он перегенерируется при каждом старте приложения и при
 * каждом включении режима стримера (см. main.js и renderer/settings.js).
 */
function generateStreamerNick() {
  const a = ['Neo', 'Fox', 'Echo', 'Nova', 'Pixel', 'Ghost', 'Turbo', 'Vega', 'Luna', 'Raptor', 'Sigma', 'Zephyr'];
  const b = ['One', 'X', 'Prime', 'Core', 'Wave', 'Byte', 'Fox', 'Nord', 'Spark', 'Drift'];
  const pick = (arr) => arr[Math.floor(Math.random() * arr.length)];
  return `${pick(a)}${pick(b)}_${100 + Math.floor(Math.random() * 900)}`;
}

module.exports = {
  DEFAULTS,
  SETTINGS_DEFAULTS,
  loadClientConfig,
  saveClientConfig,
  loadSettings,
  saveSettings,
  generateStreamerNick,
  paths: { config: CONFIG_FILE, settings: SETTINGS_FILE, userData: () => app.getPath('userData') },
};
