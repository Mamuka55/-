/**
 * EPIC AI — splash screen.
 *
 * Этапы:
 *   Конфигурация → Локальные данные → Сессия → Пользователь → Статус →
 *   Роль → Разрешения → Интерфейс → Основное окно
 * После завершения splash автоматически закрывается (это делает main process).
 */
import { el, clear } from './util.js';

const STEPS = [
  { id: 'config', label: 'Конфигурация' },
  { id: 'local_data', label: 'Локальные данные' },
  { id: 'session', label: 'Сессия' },
  { id: 'user', label: 'Пользователь' },
  { id: 'status', label: 'Статус' },
  { id: 'role', label: 'Роль' },
  { id: 'permissions', label: 'Разрешения' },
  { id: 'ui', label: 'Интерфейс' },
  { id: 'main', label: 'Основное окно' },
];

const MARKS = { done: '✓', active: '●', wait: '○', error: '✕' };
const nodes = new Map();
let doneCount = 0;

function render() {
  const list = document.getElementById('splash-steps');
  clear(list);
  for (const s of STEPS) {
    const li = el('li', { 'data-state': 'wait' }, [
      el('span', { class: 'mark' }, MARKS.wait),
      el('span', { class: 'label' }, s.label),
      el('span', { class: 'detail' }, ''),
    ]);
    nodes.set(s.id, li);
    list.appendChild(li);
  }
}

function setState(id, state, detail) {
  const li = nodes.get(id);
  if (!li) return;
  // П.2 раунда 27: крупный заголовок карточки = текущий активный этап
  if (state === 'active') {
    const step = STEPS.find((x) => x.id === id);
    if (step) statusText(`${step.label}…`);
  }
  li.dataset.state = state;
  li.querySelector('.mark').textContent = MARKS[state] ?? MARKS.wait;
  if (detail !== undefined && detail !== null) li.querySelector('.detail').textContent = String(detail).slice(0, 40);
  if (state === 'done') {
    doneCount = Math.max(doneCount, STEPS.findIndex((s) => s.id === id) + 1);
    const fill = document.getElementById('splash-bar-fill');
    if (fill) fill.style.width = `${Math.round((doneCount / STEPS.length) * 100)}%`;
  }
}

function statusText(text) {
  const node = document.getElementById('splash-status');
  if (node) node.textContent = text;
}

/** Все этапы завершены — заголовок «Готово» до закрытия splash. */
export function splashFinished() { statusText('Готово'); }

render();

window.epicAI?.on('splash:step', ({ id, status, detail }) => {
  const state = status === 'done' ? 'done' : status === 'error' ? 'error' : status === 'wait' ? 'wait' : 'active';
  setState(id, state, detail);
  const step = STEPS.find((s) => s.id === id);
  if (step) {
    if (state === 'error') { statusText(`Ошибка: ${step.label.toLowerCase()}`); document.querySelector('.splash').classList.add('is-failed'); }
    else if (state === 'active') statusText(detail ? `${step.label}: ${detail}` : step.label);
    else if (state === 'done') statusText(id === 'main' ? 'Готово' : 'Инициализация приложения');
  }
});

window.epicAI?.on('splash:done', () => {
  document.querySelector('.splash').classList.add('is-done');
  splashFinished();
  statusText('Готово');
});

// Если main process по какой-то причине не присылает события — не зависаем навсегда
setTimeout(() => {
  const active = [...nodes.values()].some((li) => li.dataset.state === 'active');
  if (!active && doneCount === 0) statusText('Ожидание backend…');
}, 3000);
