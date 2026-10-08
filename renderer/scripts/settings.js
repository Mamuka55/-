/**
 * EPIC AI — настройки панели (референс-стиль: сайдбар + строки-карточки).
 *
 * Разделы (по требованиям пользователя):
 *   Основное · Правила · Клавиши · Производительность · Частые вопросы
 *
 * Вкладки «Интерфейс» НЕТ: прозрачность перенесена в «Основное».
 * Вкладки «Профиль» НЕТ: профиль открывается отдельным окном (profile.html)
 * по клику на шапку меню пользователя или пункт «Профиль и аккаунт».
 *
 * Настройки НЕ открывают отдельное окно: панель разворачивается вниз.
 */
import { el, clear, toast, avatarNode, streamerAvatarNode, streamerName } from './util.js';
import { Kb } from './api.js';
import { buildProfileSection } from './profileview.js';



/* ------------------------------------------------------------------ */
/*  Применение визуальных настроек к DOM                               */
/* ------------------------------------------------------------------ */

export function applyVisualSettings(s) {
  const root = document.documentElement;
  const op = clamp(s.opacity ?? 0.82, 0.35, 1);
  root.style.setProperty('--panel-alpha', op.toFixed(3));
  root.style.setProperty('--surface-alpha', clamp(Math.min(1, op + 0.02), 0.3, 1).toFixed(3));
  root.style.setProperty('--muted-alpha', clamp(op - 0.05, 0.25, 1).toFixed(3));
  root.style.setProperty('--base-alpha', clamp(Math.min(1, op + 0.08), 0.3, 1).toFixed(3));
  root.style.setProperty('--drop-alpha', clamp(Math.min(1, op + 0.14), 0.3, 1).toFixed(3));
  root.dataset.lowperf = s.lowPerformanceMode ? 'true' : 'false';
  // Режим стримера: аватары размываются CSS-ом, ники подменяются в main.js
  root.dataset.streamer = s.streamerMode ? 'true' : 'false';
}

function clamp(v, min, max) { const n = Number(v); return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : min; }

/* ------------------------------------------------------------------ */
/*  Иконки разделов                                                     */
/* ------------------------------------------------------------------ */

const I = {
  main: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M4 8h10M18 8h2M4 16h4M12 16h8"/><circle cx="16" cy="8" r="2.2"/><circle cx="10" cy="16" r="2.2"/></svg>',
  perf: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"><path d="M13 2.5L5 13.5h5.5L10 21.5l8-11h-5.5z"/></svg>',
  rules: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"><path d="M6 3h9l4 4v14H6z"/><path d="M15 3v4h4M9.5 12h6M9.5 16h6"/></svg>',
  keys: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9"><rect x="2.5" y="6.5" width="19" height="11" rx="2.5"/><path d="M6 10h.01M9.5 10h.01M13 10h.01M16.5 10h.01M6 13.5h.01M18 13.5h.01M9 13.5h6" stroke-linecap="round"/></svg>',
  faq: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="12" cy="12" r="9"/><path d="M9.6 9.4a2.5 2.5 0 1 1 3.4 2.3c-.8.35-1.9-1 1.8"/><path d="M12 16.8v.2"/></svg>',
};

/**
 * Разделы настроек (требования пользователя):
 *  — вкладка «Интерфейс» УБРАНА: прозрачность переехала в «Основное»;
 *  — вкладка «Профиль» ВЕРНУТА в настройки (п.4, п.5): отдельное окно профиля
 *    удалено, пилюля пользователя открывает настройки сразу на ней.
 */
const SECTIONS = [
  { id: 'main', label: 'Основное', icon: I.main },
  { id: 'rules', label: 'Правила', icon: I.rules },
  { id: 'keys', label: 'Клавиши', icon: I.keys },
  { id: 'perf', label: 'Производительность', icon: I.perf },
  { id: 'faq', label: 'Частые вопросы', icon: I.faq },
];

/**
 * Скрытые разделы: «Профиль» НЕ показывается в навигации настроек
 * (п.2 раунда 19) — в него попадает только клик по пилюле пользователя
 * (п.3), внутри есть кнопка возврата к настройкам.
 */
const HIDDEN_SECTIONS = ['profile'];

export function isKnownSection(id) {
  return Boolean(id) && (SECTIONS.some((s) => s.id === id) || HIDDEN_SECTIONS.includes(id));
}

/* ------------------------------------------------------------------ */
/*  Контекст                                                            */
/* ------------------------------------------------------------------ */

let ctx = null;
let activeSection = null;

export function initSettings(context) { ctx = context; }

export function renderSettings(container, section) {
  if (!ctx) return;
  activeSection = isKnownSection(section) ? section : 'main';

  const side = container.querySelector('#settings-side');
  const pages = container.querySelector('#settings-pages');
  if (!side || !pages) return;

  /* --- сайдбар: карточка пользователя, навигация, версия --- */
  clear(side);
  const u = ctx.user ?? {};
  side.append(
    el('div', { class: 'side-user' }, [
      // Режим стримера: настоящее фото, сильно размытое (п.2)
      ctx.settings?.streamerMode
        ? streamerAvatarNode('side-user__ava', u.avatarUrl, u.displayName || u.username)
        : avatarNode(u.avatarUrl, u.displayName || u.username, 'side-user__ava'),
      el('div', { style: { minWidth: '0' } }, [
        el('div', { class: 'side-user__name' }, ctx.settings?.streamerMode ? (ctx.settings.streamerNick || u.displayName || '—') : (u.displayName || u.username || '—')),
        el('div', { class: 'side-user__nick' }, ctx.settings?.streamerMode ? '@••••••' : `@${u.username ?? '—'}`),
      ]),
    ]),
    el('nav', { class: 'set-nav' }, SECTIONS.map((s) => el('button', {
      class: `settings__nav-item${s.id === activeSection ? ' is-active' : ''}`,
      type: 'button',
      onClick: () => ctx.onNavigate?.(s.id),
    }, [el('span', { html: s.icon, style: { display: 'inline-flex', width: '15px', height: '15px' } }), s.label]))),
    el('div', { class: 'side-foot' }, [
      el('span', { class: 'dot', id: 'side-status-dot' }),
      el('span', { id: 'side-version' }, `v${ctx.appVersion ?? '1.0.0'}`),
      el('span', { class: 'grow' }),
      el('span', { id: 'side-kb' }, 'база: …'),
    ]),
  );
  void refreshSideStatus();

  /* --- страница --- */
  // П.8: клик по элементу ВНУТРИ раздела не должен отматывать список наверх.
  // Скролл сбрасывается только при СМЕНЕ раздела, а перерисовка того же
  // раздела (переключатель, сохранение настройки) сохраняет позицию.
  const sameSection = pages.dataset.section === activeSection;
  const keepScroll = sameSection ? pages.scrollTop : 0;
  clear(pages);
  pages.appendChild(buildSection(activeSection));
  pages.dataset.section = activeSection;
  pages.scrollTop = keepScroll;
  ctx.onResize?.(measureHeight(activeSection));
}

async function refreshSideStatus() {
  const dot = document.getElementById('side-status-dot');
  const kb = document.getElementById('side-kb');
  if (!dot || !kb) return;
  try {
    const st = await Kb.status();
    kb.textContent = `база: ${st.documents.active} док. · ${st.stateLabel.toLowerCase()}`;
    dot.className = `dot${st.state === 'error' ? ' err' : ''}`;
    dot.style.background = st.stateColor;
    dot.style.boxShadow = `0 0 8px ${st.stateColor}`;
  } catch {
    kb.textContent = 'база недоступна';
    dot.className = 'dot err';
  }
}

/**
 * Высота области настроек ФИКСИРОВАННАЯ и не зависит от вкладки: окно не
 * «прыгает» при переключении разделов, содержимое скроллится внутри
 * .set-main.scroll.
 */
export function measureHeight(_section) {
  return 520;
}

/* ------------------------------------------------------------------ */
/*  Конструкторы строк                                                  */
/* ------------------------------------------------------------------ */

function page(title, sub,...nodes) {
  return el('div', {}, [
    el('div', { class: 'set-title' }, title),
    sub ? el('div', { class: 'set-sub' }, sub) : el('div', { style: { height: '12px' } }),
   ...nodes,
  ]);
}

function card(...rows) {
  return el('div', { class: 'opt-card' }, rows.filter(Boolean));
}

function row(name, desc, control) {
  return el('div', { class: 'opt-row' }, [
    el('div', { class: 'opt-row__label' }, [
      el('div', { class: 'opt-row__name' }, name),
      desc ? el('div', { class: 'opt-row__desc' }, desc) : null,
    ]),
    el('div', { class: 'opt-row__control' }, [].concat(control)),
  ]);
}

function toggle(key, current, onChange) {
  const input = el('input', { type: 'checkbox' });
  input.checked = Boolean(current);
  input.addEventListener('change', () => onChange(key, input.checked));
  return el('label', { class: 'switch' }, [input, el('span', { class: 'track' }), el('span', { class: 'thumb' })]);
}

function select(key, current, options, onChange) {
  const sel = el('select', { class: 'sel' }, options.map((o) => el('option', { value: o.value,...(String(o.value) === String(current) ? { selected: true } : {}) }, o.label)));
  sel.value = String(current);
  sel.addEventListener('change', () => onChange(key, sel.value));
  return sel;
}

function range(key, current, { min, max, step, format }, onChange) {
  const value = el('span', { class: 'range-value' }, format(current));
  const input = el('input', { class: 'range', type: 'range', min: String(min), max: String(max), step: String(step) });
  input.value = String(current);
  input.addEventListener('input', () => { value.textContent = format(Number(input.value)); });
  input.addEventListener('change', () => onChange(key, Number(input.value)));
  return [input, value];
}

/** Кейкапы: 'Ctrl+Shift+P' → [Ctrl][Shift][P]. */
function kbdRow(combo, { editable = false, onEdit } = {}) {
  const parts = String(combo ?? '').split('+').filter(Boolean);
  const wrap = el('span', { class: `kbd-row${editable ? ' is-editable' : ''}` }, parts.map((p) => el('span', { class: p.length > 2 ? 'kbd kbd--wide' : 'kbd' }, p)));
  if (editable && onEdit) wrap.addEventListener('click', () => onEdit(wrap));
  return wrap;
}

/* ------------------------------------------------------------------ */
/*  Разделы                                                             */
/* ------------------------------------------------------------------ */

function buildSection(id) {
  const s = ctx.settings;
  switch (id) {
    case 'profile': return buildProfileSection(ctx);
    case 'main': return pageMain(s);
    case 'perf': return pagePerf(s);
    case 'rules': return pageRules();
    case 'keys': return pageKeys(s);
    case 'faq': return pageFaq();
    default: return pageMain(s);
  }
}

/* ---------- Основное  ---------- */

function pageMain(s) {
  const change = ctx.onChange;
  return page('Основное', 'Горячая клавиша, окно, прозрачность, микрофон и режим стримера — всё, что нужно каждый день.',
    card(
      row('Горячая клавиша', 'Показать или скрыть окно поверх игры', kbdRow(s.hotkey, {
        editable: true,
        onEdit: (wrap) => captureHotkey(wrap, s.hotkey, async (acc) => {
          const res = await window.epicAI?.invoke('epic:hotkey:set', acc).catch(() => null);
          if (res?.ok) { change('hotkey', res.requested); toast(`Горячая клавиша: ${res.requested}`); }
          else toast('Сочетание занято системой — оставлено прежнее');
        }),
      })),
      row('Поверх всех окон', 'Держать оверлей поверх игры (уровень screen-saver). Закреплённое окно НЕ прячется при клике по игре', toggle('alwaysOnTop', s.alwaysOnTop, change)),
      row('Запускать вместе с Windows', 'Автозапуск в свёрнутом виде', toggle('autostart', s.autostart, change)),
      // Прозрачность переехала сюда из убранной вкладки «Интерфейс»
      row('Прозрачность', 'Общая полупрозрачность панели и выпадающих областей', range('opacity', s.opacity, { min: 0.4, max: 1, step: 0.02, format: (v) => `${Math.round(v * 100)}%` }, change)),
      // Выбор устройства микрофона для голосового ввода (п.13)
      row('Микрофон', 'Устройство записи для голосовых запросов', micDeviceSelect(s.micDeviceId, change)),
    ),
    card(
      row('Скрывать при клике вне окна', 'Клик по игре прячет панель и источники; приложение остаётся в трее. Не работает, пока окно закреплено звёздочкой', toggle('hideOnOutsideClick', s.hideOnOutsideClick, change)),
      row('Очищать предыдущий ответ', 'Новый вопрос заменяет старый ответ', toggle('clearPreviousAnswer', s.clearPreviousAnswer, change)),
      row('Сохранять выбранный режим', 'Запоминать «Правила» / «Законы» между запусками', toggle('rememberMode', s.rememberMode, change)),
      row('Режим по умолчанию', 'Если сохранение выключено', select('defaultMode', s.defaultMode, [
        { value: 'rules', label: 'Правила' }, { value: 'laws', label: 'Законы' },
      ], change)),
      row('Подтверждать вопрос', 'Перед отправкой показывать отдельное окно «Спросить ИИ?» с остатком запросов на сегодня', toggle('confirmAiAsk', s.confirmAiAsk !== false, change)),
    ),
    card(
      row('Режим стримера', 'Скрывает настоящее имя и лицо: случайный ник вместо вашего, вместо аватара — нейтральная заглушка', toggle('streamerMode', s.streamerMode, async (k, v) => {
        // Ник генерируется ЗАНОВО при каждом включении режима (требование
        // пользователя) — и дополнительно при каждом запуске приложения.
        if (v) await ctx.onChange('streamerNick', streamerName());
        await ctx.onChange(k, v);
      })),
      s.streamerMode && s.streamerNick
        ? row('Ник в стриме', 'Меняется при каждом запуске приложения и включении режима', el('span', { class: 'mono', style: { fontSize: '11px' } }, s.streamerNick))
        : null,
    ),
    el('div', { class: 'kb-note' }, 'Панель можно перетащить за любое свободное место — она останется там, где вы её оставили. Живой фон (съёмка экрана под окном) убран полностью: он нагружал систему и мешал игре.'),
  );
}

/**
 * Селект устройства микрофона (п.13): список audioinput из
 * navigator.mediaDevices.enumerateDevices(). Названия устройств браузер
 * отдаёт только после разрешения на микрофон — до этого показываем
 * «Микрофон N». Значение сохраняется в настройке micDeviceId.
 */
function micDeviceSelect(current, onChange) {
  const sel = el('select', { class: 'sel', style: { maxWidth: '190px' } });
  sel.appendChild(el('option', { value: '' }, 'По умолчанию'));
  sel.value = String(current ?? '');
  sel.addEventListener('change', () => onChange('micDeviceId', sel.value || null));
  const fill = async () => {
    try {
      if (!navigator.mediaDevices?.enumerateDevices) throw new Error('нет mediaDevices');
      const devices = (await navigator.mediaDevices.enumerateDevices()).filter((d) => d.kind === 'audioinput');
      if (!devices.length) throw new Error('нет устройств');
      devices.forEach((d, i) => {
        sel.appendChild(el('option', { value: d.deviceId }, d.label || `Микрофон ${i + 1}`));
      });
      sel.value = String(current ?? '');
      if (sel.selectedIndex < 0) sel.value = '';
    } catch {
      // Нет доступа к списку устройств (или окружение без mediaDevices) —
      // оставляем только «По умолчанию».
      sel.title = 'Список устройств недоступен — используется устройство по умолчанию';
    }
  };
  void fill();
  return sel;
}

/** Перехват сочетания клавиш для горячей клавиши. */
function captureHotkey(wrap, fallback, onDone) {
  let listening = false;
  const caps = () => [...wrap.querySelectorAll('.kbd')];
  const onKey = (e) => {
    if (!listening) return;
    e.preventDefault(); e.stopPropagation();
    if (e.key === 'Escape') { stop(); return; }
    if (['Control', 'Shift', 'Alt', 'Meta'].includes(e.key)) return;
    const parts = [];
    if (e.ctrlKey || e.metaKey) parts.push('Ctrl');
    if (e.altKey) parts.push('Alt');
    if (e.shiftKey) parts.push('Shift');
    let key = e.key;
    if (key === ' ') key = 'Space';
    else if (key.length === 1) key = key.toUpperCase();
    parts.push(key);
    stop();
    void onDone(parts.join('+'));
  };
  const start = () => { listening = true; wrap.classList.add('is-listening'); clear(wrap); wrap.appendChild(el('span', { class: 'kbd kbd--wide' }, 'Нажмите сочетание…')); window.addEventListener('keydown', onKey, true); };
  const stop = () => { listening = false; wrap.classList.remove('is-listening'); window.removeEventListener('keydown', onKey, true); clear(wrap); String(fallback).split('+').forEach((p) => wrap.appendChild(el('span', { class: p.length > 2 ? 'kbd kbd--wide' : 'kbd' }, p))); };
  start();
}

/* ---------- Производительность  ---------- */

function pagePerf(s) {
  const change = ctx.onChange;
  return page('Производительность', 'Если игра проседает по FPS — начните с «Режима снижения нагрузки».',
    card(
      row('Аппаратное ускорение (Vulkan)', 'Рендер интерфейса через GPU: Chromium использует Vulkan (ANGLE). Применяется после перезапуска', toggle('hardwareAcceleration', s.hardwareAcceleration, async (k, v) => {
        await change(k, v);
        if (confirm('Изменение вступит в силу после перезапуска Epic AI. Перезапустить сейчас?')) {
          await window.epicAI?.invoke('epic:app:relaunch').catch(() => {});
        }
      })),
      row('Режим снижения нагрузки', 'Выключает анимации интерфейса одним переключателем', toggle('lowPerformanceMode', s.lowPerformanceMode, change)),
    ),
    el('div', { class: 'kb-note' }, 'Оверлей оптимизирован: живой фон и съёмка экрана убраны полностью, перетаскивание и раскрытие окна не шлют лишние вызовы — интерфейс не лагает даже на слабых ПК.'),
  );
}

/* ---------- Правила: состояние базы (референс: карточки обновлений) ---------- */

function pageRules() {
  const wrap = page('Правила', 'База знаний EpicRP: сегодняшние обновления документов и последние изменения.');
  const host = el('div', {}, [el('div', { class: 'empty' }, [el('span', { class: 'spinner' })])]);
  wrap.appendChild(host);
  void loadRulesPage(host);
  return wrap;
}

/** Локальная дата YYYY-MM-DD — ключ дня для списка изменений базы. */
function todayKey() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

function rulesChip(label, n) {
  return el('span', { class: 'role-pill', style: { color: 'var(--text-muted)' } }, [
    el('span', { class: 'dot' }), `${label} ${n}`,
  ]);
}

async function loadRulesPage(host) {
  let st;
  try { st = await Kb.status(); }
  catch (e) { clear(host); host.appendChild(el('div', { class: 'notice' }, [el('div', {}, [el('b', {}, 'База недоступна. '), e.message])])); return; }

  const t = st.today ?? {};
  const chips = [];
  if (t.newCount) chips.push(rulesChip('новых', t.newCount));
  if (t.updatedCount) chips.push(rulesChip('изменены', t.updatedCount));
  if (t.archivedCount) chips.push(rulesChip('в архиве', t.archivedCount));

  clear(host);
  host.append(
    // Карточка-статус: база обновлена сегодня
    el('div', { class: 'opt-card rules-status' }, [
      el('div', { class: 'rules-status__title' }, 'Обновлены сегодня'),
      el('div', { class: 'rules-status__meta' }, `база v${st.kbVersion} · синхронизация ${st.lastSyncLabel}`),
    ]),
    el('div', { class: 'rules-caption' }, 'Последние изменения'),
    // Карточка изменений: чипы «изменены N» + кнопка «Посмотреть»
    el('div', { class: 'opt-card' }, [
      el('div', { class: 'rules-changes__head' }, [
        el('div', { class: 'rules-changes__title' }, 'Обновление сегодня'),
        el('button', { class: 'btn', type: 'button', onClick: () => ctx.onOpenKb?.('updates', todayKey()) }, 'Посмотреть'),
      ]),
      el('div', { class: 'rules-chips' }, chips.length ? chips : [
        el('span', { class: 'subtle', style: { fontSize: '11px' } }, 'Сегодня изменений нет'),
      ]),
    ]),
    // Кнопка «История изменений» из вкладки «Правила» УБРАНА (требование
    // пользователя): история изменений доступна в самой области базы знаний
    // (переключатель «Посмотреть / История изменений» при открытии БЗ).
    st.lastError ? el('div', { class: 'notice' }, [el('div', {}, [el('b', {}, 'Ошибка синхронизации: '), st.lastError])]) : null,
    el('div', { class: 'kb-note' }, 'База обновляется автоматически при запуске приложения и по расписанию — кнопка ручного обновления не нужна.'),
  );
}

/* ---------- Клавиши (референс) ---------- */

function pageKeys(s) {
  const editLocal = (key, fallback) => ({
    editable: true,
    onEdit: (wrap) => captureHotkey(wrap, fallback, (acc) => {
      ctx.onChange(key, acc);
      toast(`Сочетание назначено: ${acc}`);
    }),
  });
  const rows = [
    { main: true, label: 'Показать или скрыть окно', combo: s.hotkey, editable: true },
    { label: 'История ответов ИИ', combo: s.comboHistory ?? 'Ctrl+H', edit: editLocal('comboHistory', s.comboHistory ?? 'Ctrl+H') },
    { label: 'Открыть источники ответа', combo: s.comboSources ?? 'Ctrl+O', edit: editLocal('comboSources', s.comboSources ?? 'Ctrl+O') },
    { label: 'Закрепить окно поверх игры', combo: s.comboPin ?? 'Ctrl+P', edit: editLocal('comboPin', s.comboPin ?? 'Ctrl+P') },
    { label: 'Отправить запрос', combo: 'Enter' },
    { label: 'Сказать запрос голосом', note: 'кнопка-микрофон в строке ввода' },
    { label: 'Свернуть ответ или настройки', combo: 'Esc' },
    { label: 'Скрыть окно, когда всё свёрнуто', combo: 'Esc' },
    { label: 'Перетащить панель', note: 'удерживайте любое свободное место панели; положение запомнится' },
  ];
  return page('Клавиши', 'Основное делается с клавиатуры — мышь не нужна.',
    card(...rows.map((r) => el('div', { class: `key-row${r.main ? ' key-row--main' : ''}` }, [
      el('span', { class: 'key-row__label' }, r.label),
      r.combo
        ? kbdRow(r.combo, r.editable ? {
            editable: true,
            onEdit: (wrap) => captureHotkey(wrap, s.hotkey, async (acc) => {
              const res = await window.epicAI?.invoke('epic:hotkey:set', acc).catch(() => null);
              if (res?.ok) { ctx.onChange('hotkey', res.requested); toast(`Горячая клавиша: ${res.requested}`); }
              else toast('Сочетание занято системой — оставлено прежнее');
            }),
          } : (r.edit ?? {}))
        : el('span', { class: 'subtle', style: { fontSize: '10.5px' } }, r.note ?? ''),
    ]))),
    el('div', { class: 'kb-note' }, 'Клик по кейкапам — перехват нового сочетания. Все сочетания регистрируются В СИСТЕМЕ и работают глобально — даже когда фокус в игре, а не на панели. Escape отменяет перехват.'),
  );
}

/* ---------- Частые вопросы (референс-аккордеон) ---------- */

const FAQ = [
  {
    cat: 'Игра и окно',
    items: [
      {
        q: 'Игра сворачивается, когда открываю окно',
        a: 'Так Windows поступает с полноэкранными играми: любое окно поверх сворачивает игру. Переключите игру в оконный режим без рамки — выглядит так же, как полный экран.',
        crumbs: ['В игре', 'Настройки', 'Графика', 'Тип экрана', 'Оконный без рамки'],
      },
      { q: 'Пропадает звук игры, пока открыто окно', a: 'Часть игр глушит звук при потере фокуса. Включите в настройках игры фоновый звук («Audio → Mute when unfocused» или похожее) либо играйте в оконном режиме без рамки.' },
      { q: 'Окно не открывается по горячей клавише', a: 'Откройте «Клавиши» и кликните по кейкапам первой строки, чтобы назначить новое сочетание: старое могло быть перехвачено оверлеем драйвера мыши, Discord или другой программой.' },
      { q: 'Окно прячется, когда кликаю по игре', a: 'Так работает автоскрытие: клик вне Epic AI прячет оверлей, а приложение продолжает работать в трее. Закреплённое звёздочкой окно НЕ прячется — открепите его или выключите «Основное» → «Скрывать при клике вне окна».' },
      { q: 'Как закрепить окно поверх игры', a: 'Кнопка-звёздочка в баре, тумблер «Поверх всех окон» в разделе «Основное» или сочетание Ctrl+P (работает глобально, даже в игре). Оверлей использует уровень screen-saver, поэтому виден и поверх оконной игры; пока окно закреплено, клик по игре его не прячет.' },
    ],
  },
  {
    cat: 'База знаний и ответы',
    items: [
      { q: 'Пишет «не найдено подтверждённой информации»', a: 'Это не сбой, а принцип Epic AI: ответы даются только по официальной базе. Проверьте, что выбран верный режим (Правила / Законы), и при необходимости обновите базу в разделе «Правила».' },
      { q: 'Как обновить базу правил', a: 'Ничего нажимать не нужно: база обновляется сама при запуске приложения и по расписанию. Посмотреть новые и изменённые документы можно в «Правила» → «Посмотреть»: слева список изменений за день, справа сравнение «было / стало» с цветным diff; старые редакции не удаляются.' },
      { q: 'Ответ ссылается на устаревшую редакцию', a: 'Поставьте 👎 и выберите «Устаревшая информация»: создастся отчёт, администратор сверит версию документа с форумом и исправит базу или промпт.' },
      { q: 'Чем «Правила» отличаются от «Законов»', a: 'Это две независимые базы: правила проекта, сервера и организаций — против Конституции, Penal Code и судебных документов. Поиск в одном режиме не примешивает документы другого.' },
    ],
  },
  {
    cat: 'Программа',
    items: [
      { q: 'Аппаратное ускорение: включать или нет', a: 'На обычном ПК — включать: интерфейс рендерится GPU через Vulkan (ANGLE), это быстрее обычного рендера. На слабом ноутбуке или при просадках FPS отключите его либо включите «Режим снижения нагрузки» в разделе «Производительность». Живой фон со съёмкой экрана убран полностью, поэтому оверлей больше не нагружает игру.' },
      { q: 'Куда девается окно при закрытии крестиком', a: 'В системный трей: приложение продолжает работать и синхронизировать базу. Полный выход — иконка трея → «Выход».' },
      { q: 'Где хранятся мои настройки и сессия', a: 'Настройки привязаны к аккаунту Epic AI и общие между машинами. Сессия хранится в защищённом хранилище Electron на этом компьютере и не передаётся наружу.' },
    ],
  },
];

function pageFaq() {
  const wrap = page('Частые вопросы', 'Короткие ответы на то, что спрашивают чаще всего.');
  for (const group of FAQ) {
    wrap.appendChild(el('div', { class: 'faq-cat' }, group.cat));
    for (const item of group.items) {
      const body = el('div', { class: 'faq-item__body' }, [el('div', {}, item.a)]);
      if (item.crumbs?.length) {
        body.appendChild(el('div', { class: 'crumbs' }, item.crumbs.flatMap((c, i) => [
          i > 0 ? el('span', { class: 'crumb-sep' }, '›') : null,
          el('span', { class: i === 0 ? 'crumb crumb--muted' : 'crumb' }, c),
        ]).filter(Boolean)));
      }
      const head = el('button', { class: 'faq-item__head', type: 'button' }, [
        el('span', {}, item.q),
        el('span', { class: 'faq-item__chev', html: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"><path d="M6 9l6 6 6-6"/></svg>' }),
      ]);
      const box = el('div', { class: 'faq-item' }, [head, body]);
      head.addEventListener('click', () => box.classList.toggle('is-open'));
      wrap.appendChild(box);
    }
  }
  return wrap;
}

/* ---------- Профиль ----------
   Вкладка «Профиль» из настроек УБРАНА (требование пользователя): профиль
   и аккаунт открываются ОТДЕЛЬНЫМ окном (renderer/profile.html) — клик по
   шапке меню пользователя или пункт «Профиль и аккаунт». В окне профиля:
   аватар, роль, «@ник · вход через Telegram», карточка «Ответы ИИ сегодня»
   с остатком дневного лимита и прогресс-баром, «Выйти из аккаунта». */

export { SECTIONS };
