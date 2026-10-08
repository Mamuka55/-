/**
 * EPIC AI — единая цветовая система (ТЗ §4) и дизайн-токены.
 *
 * Файл намеренно написан на чистом JS (ESM) без типов, чтобы его могли
 * импортировать одновременно:
 *   - backend (TypeScript)
 *   - Electron main (CommonJS через dynamic import / JSON-копия)
 *   - renderer (ESM в браузере)
 *
 * Никаких дубликатов цветов в CSS: все значения берутся отсюда через
 * сгенерированные CSS custom properties (см. renderer/styles/tokens.css).
 */

export const COLORS = {
  // Accent
  accent: '#ACE72E',          // активные элементы, выбранные состояния, CTA, успех, подсветка найденного
  accentBright: '#E2FF3F',    // hover, focus, яркая подсветка
  accentMid: '#72CE1C',       // иконки, вторичные акценты, маркеры

  // Backgrounds
  bgBase: '#0C0C0C',          // самый тёмный фон
  bgDark: '#121416',          // основная панель, карточки, шапки
  bgSurface: '#1A1A1A',       // поля ввода, поверхности
  bgMuted: '#2A2A2A',         // вторичные поверхности

  // Text
  textPrimary: '#EEF9F4',
  textMuted: '#888888',
  textSubtle: '#666666',

  // States
  danger: '#E74C3C',          // ошибки и удалённый текст (diff)
  warning: '#F87171',         // предупреждения / «есть обновления»
  info: '#3498DB',
};

/**
 * Полупрозрачные варианты основных фонов (ТЗ §5).
 * Главная панель: rgba(18,20,22,0.82); поверхности: rgba(26,26,26,0.78).
 */
export const GLASS = {
  panel: 'rgba(18, 20, 22, 0.82)',
  surface: 'rgba(26, 26, 26, 0.78)',
  muted: 'rgba(42, 42, 42, 0.72)',
  base: 'rgba(12, 12, 12, 0.90)',
  stroke: 'rgba(238, 249, 244, 0.08)',
  strokeStrong: 'rgba(238, 249, 244, 0.14)',
};

/** Роли и их цвета (ТЗ §39). level используется для иерархии выдачи ролей (ТЗ §46). */
export const ROLES = [
  { code: 'player',        name: 'Игрок',                              color: '#888888', level: 1 },
  { code: 'helper',        name: 'Хелпер',                             color: '#72CE1C', level: 2 },
  { code: 'admin',         name: 'Администратор',                      color: '#3498DB', level: 3 },
  { code: 'senior_admin',  name: 'Старший администратор',              color: '#9B59B6', level: 4 },
  { code: 'deputy_chief',  name: 'Заместитель главного администратора', color: '#E67E22', level: 5 },
  { code: 'chief_admin',   name: 'Главный администратор',              color: '#E74C3C', level: 6 },
  { code: 'project_lead',  name: 'Руководство проекта',                color: '#F1C40F', level: 7 },
  { code: 'developer',     name: 'Разработчик',                        color: '#E2FF3F', level: 8, system: true },
];

export const ROLE_BY_CODE = Object.fromEntries(ROLES.map((r) => [r.code, r]));

/** Статусы аккаунта (ТЗ §40). Статус — НЕ роль. */
export const ACCOUNT_STATUS = ['active', 'blocked'];

/** Статусы AI Report (ТЗ §16). */
export const REPORT_STATUS = {
  NEW: 'new',
  IN_PROGRESS: 'in_progress',
  RESOLVED: 'resolved',
};

export const REPORT_STATUS_LABEL = {
  new: 'Новая',
  in_progress: 'На проверке',
  resolved: 'Решена',
};

/** Категории ошибки в форме дизлайка (ТЗ §15). Порядок важен — он же в UI. */
export const FEEDBACK_CATEGORIES = [
  { id: 'misinterpreted',  label: 'Неверно истолковано правило' },
  { id: 'wrong_article',   label: 'Неправильная статья' },
  { id: 'outdated',        label: 'Устаревшая информация' },
  { id: 'wrong_source',    label: 'Неверный источник' },
  { id: 'technical',       label: 'Техническая ошибка' },
  { id: 'other',           label: 'Другое' },
];

/** Автоматическая классификация источника проблемы (ТЗ §18). */
export const REPORT_ANALYSIS = [
  { id: 'kb_outdated',    label: 'Устарела база' },
  { id: 'search_miss',    label: 'Ошибка поиска' },
  { id: 'ai_error',       label: 'Ошибка AI' },
  { id: 'technical',      label: 'Техническая ошибка' },
];

/** Типы документов (ТЗ §59) — жёсткое разделение баз. */
export const DOC_TYPES = { RULE: 'RULE', LAW: 'LAW' };

/** Режимы поиска в UI (ТЗ §8). */
export const MODES = {
  rules: { id: 'rules', label: 'ПРАВИЛА', docType: 'RULE' },
  laws:  { id: 'laws',  label: 'ЗАКОНЫ',  docType: 'LAW' },
};

/** Статусы синхронизации (ТЗ §22). */
export const SYNC_STATE = {
  OK:       { id: 'ok',       label: 'База актуальна',   color: '#ACE72E' },
  UPDATES:  { id: 'updates',  label: 'Есть обновления',  color: '#F87171' },
  ERROR:    { id: 'error',    label: 'Ошибка',           color: '#E74C3C' },
  RUNNING:  { id: 'running',  label: 'Обновление',       color: '#72CE1C' },
};

/** Результаты синхронизации (ТЗ §54, §55). */
export const SYNC_RESULT = { NEW: 'NEW', UPDATED: 'UPDATED', UNCHANGED: 'UNCHANGED', ARCHIVED: 'ARCHIVED' };

/** Этапы splash screen (ТЗ §32). Порядок = порядок отображения. */
export const SPLASH_STEPS = [
  { id: 'config',      label: 'Конфигурация' },
  { id: 'local_data',  label: 'Локальные данные' },
  { id: 'session',     label: 'Сессия' },
  { id: 'user',        label: 'Пользователь' },
  { id: 'status',      label: 'Статус' },
  { id: 'role',        label: 'Роль' },
  { id: 'permissions', label: 'Разрешения' },
  { id: 'ui',          label: 'Интерфейс' },
  { id: 'main',        label: 'Основное окно' },
];

/** Значения по умолчанию (ТЗ §6, §19, §20, §30, §56, §61). */
export const DEFAULTS = {
  main: { width: 660, height: 56, minWidth: 460, maxWidth: 900, minHeight: 48, maxHeight: 72 },
  sources: { width: 420, height: 560, gap: 12, offsetY: 0 },
  splash: { width: 360, height: 220 },
  hotkey: 'F10',
  syncIntervalMinutes: 30,
  settings: {
    language: 'ru',
    theme: 'dark',
    autostart: false,
    opacity: 0.82,
    blur: true,
    blurRadius: 18,
    animations: true,
    animationSpeed: 1,
    alwaysOnTop: true,
    hideOnOutsideClick: true,
    clearPreviousAnswer: true,
    rememberMode: true,
    hardwareAcceleration: true,
    lowPerformanceMode: false,
    panelPosition: 'bottom-center',
  },
};

/** Формат даты, используемый везде в UI (ТЗ §21: 05.10.2026 20:14). */
export const DATE_FORMAT = { date: 'DD.MM.YYYY', dateTime: 'DD.MM.YYYY HH:mm' };

export default { COLORS, GLASS, ROLES, ROLE_BY_CODE, ACCOUNT_STATUS, REPORT_STATUS, REPORT_STATUS_LABEL, FEEDBACK_CATEGORIES, REPORT_ANALYSIS, DOC_TYPES, MODES, SYNC_STATE, SYNC_RESULT, SPLASH_STEPS, DEFAULTS, DATE_FORMAT };
