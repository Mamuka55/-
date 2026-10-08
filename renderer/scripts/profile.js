/**
 * EPIC AI — окно профиля (открывается из меню пользователя).
 *
 * Референс пользователя: аватар, роль, «@ник · вход через Telegram»,
 * карточка «Ответы ИИ сегодня» — крупный остаток дневного лимита
 * («X из Y осталось»), прогресс-бар и подпись, когда появятся новые
 * ответы; карточка «Выйти из аккаунта» с кнопкой «Выйти».
 *
 * Вкладка «Профиль» из настроек убрана — весь профиль живёт здесь.
 * Прозрачность и стрим-режим применяются как в остальных окнах.
 */
import { el, clear, $, toast, initials, avatarNode, streamerAvatarNode, fmtDateTime } from './util.js';
import { Auth, Ai, setBackendUrl, initAuth } from './api.js';
import { applyVisualSettings } from './settings.js';

const st = {
  user: null,
  permissions: [],
  settings: {},
};

/** Есть ли доступ к админ-панели (роль «игрок» — никогда). */
function canAdmin() {
  const code = String(st.user?.primaryRole?.code ?? '').toLowerCase();
  if (code === 'player' || !st.user) return false;
  return (st.permissions ?? []).some((p) => ['users.view', 'ai.reports.view', 'knowledge.view', 'system.logs'].includes(p));
}

/** «вход через Telegram» / «вход через Discord» — по привязанным identity. */
function providerLabel(u) {
  const ids = u?.identities ?? [];
  if (ids.some((i) => i.provider === 'telegram')) return 'вход через Telegram';
  if (ids.some((i) => i.provider === 'discord')) return 'вход через Discord';
  return 'внешний провайдер';
}

function displayName(u) {
  if (st.settings.streamerMode) return st.settings.streamerNick || 'Стример';
  return u?.displayName || u?.username || '—';
}

/* ------------------------------------------------------------------ */

function headCard(u) {
  const ava = st.settings.streamerMode
    ? streamerAvatarNode('prof-ava')
    : avatarNode(u.avatarUrl, u.displayName || u.username, 'prof-ava');
  return el('div', { class: 'prof-head' }, [
    ava,
    el('div', { class: 'prof-id' }, [
      el('div', { class: 'prof-name' }, displayName(u)),
      u.primaryRole
        ? el('span', { class: 'role-pill', style: { color: u.primaryRole.color } }, [el('span', { class: 'dot' }), u.primaryRole.name])
        : null,
      el('div', { class: 'prof-login' }, st.settings.streamerMode ? '@•••••• · стрим-режим' : `@${u.username ?? '—'} · ${providerLabel(u)}`),
    ]),
  ]);
}

/** Карточка «Ответы ИИ сегодня»: крупный остаток + прогресс-бар + подпись. */
function quotaCard() {
  const big = el('div', { class: 'prof-quota__big' }, '…');
  const bar = el('span', { style: { width: '100%' } });
  const caption = el('div', { class: 'prof-caption' }, 'Загружаем лимит…');
  const card = el('div', { class: 'prof-card' }, [
    el('div', { class: 'prof-card__title' }, 'Ответы ИИ сегодня'),
    big,
    el('div', { class: 'prof-bar' }, bar),
    caption,
  ]);
  void Ai.quota().then((q) => {
    const left = Number(q?.left ?? 0);
    const limit = Number(q?.limit ?? 0);
    clear(big);
    big.classList.toggle('is-empty', left <= 0);
    big.append(
      el('b', {}, `${left} из ${limit}`),
      el('span', {}, 'осталось'),
    );
    bar.style.width = limit > 0 ? `${Math.round((left / limit) * 100)}%` : '0%';
    const reset = q?.resetAt ? fmtDateTime(q.resetAt) : '00:00 по Москве';
    caption.textContent = `Новые ответы появятся в ${reset} — лимит сбрасывается ежедневно${q?.personal ? ' (персональный лимит выдан администратором)' : ''}.`;
  }).catch(() => {
    clear(big);
    big.appendChild(el('b', {}, '—'));
    caption.textContent = 'Лимит недоступен: backend не отвечает.';
    bar.style.width = '0%';
  });
  return card;
}

/** Карточка «Выйти из аккаунта» + (для администрации) «Админ панель». */
function logoutCard() {
  return el('div', { class: 'prof-card' }, [
    el('div', { class: 'prof-card__title' }, 'Выйти из аккаунта'),
    el('div', { class: 'prof-logout__row' }, [
      el('div', { class: 'prof-logout__text' }, 'Сессия будет отозвана, а Epic AI вернётся к окну входа. Настройки аккаунта сохранятся на сервере.'),
      el('button', {
        class: 'btn btn--danger', type: 'button',
        onClick: () => window.epicAI?.invoke('epic:account:logout').catch((e) => toast(e?.message ?? 'Не удалось выйти')),
      }, 'Выйти'),
    ]),
    canAdmin()
      ? el('div', { class: 'prof-logout__row' }, [
          el('div', { class: 'prof-logout__text' }, 'Управление пользователями, ошибками ИИ и базой знаний.'),
          el('button', {
            class: 'btn', type: 'button',
            onClick: () => window.epicAI?.invoke('epic:admin:open').catch((e) => toast(e?.message ?? 'Нет доступа')),
          }, 'Админ панель'),
        ])
      : null,
  ]);
}

/** Короткая сводка аккаунта (даты, провайдеры) — внизу окна. */
function detailsCard(u) {
  const line = (name, value) => el('div', { class: 'prof-detail__row' }, [
    el('span', {}, name),
    el('b', { class: 'mono' }, value),
  ]);
  return el('div', { class: 'prof-card prof-details' }, [
    el('div', { class: 'prof-card__title' }, 'Аккаунт'),
    line('ID', `#${u.id ?? '—'}`),
    line('Статус', u.status === 'active' ? 'active' : String(u.status ?? '—')),
    line('Аккаунт создан', fmtDateTime(u.createdAt)),
    line('Последний вход', fmtDateTime(u.lastLoginAt)),
  ]);
}

function render() {
  const root = $('#prof-root');
  clear(root);
  const u = st.user;
  if (!u) {
    root.appendChild(el('div', { class: 'empty' }, 'Нет данных пользователя — требуется вход.'));
    return;
  }
  root.append(headCard(u), quotaCard(), logoutCard(), detailsCard(u));
}

async function boot() {
  await initAuth();
  const runtime = await window.epicAI?.invoke('epic:runtime').catch(() => null);
  if (runtime?.backendUrl) setBackendUrl(runtime.backendUrl);
  if (runtime?.settings) st.settings = runtime.settings;
  applyVisualSettings(st.settings);

  window.epicAI?.on('settings:changed', (s) => {
    st.settings = {...st.settings, ...s };
    applyVisualSettings(st.settings);
    if (st.user) render();   // стрим-режим меняет имя и аватар
  });
  window.epicAI?.on('profile:refresh', () => void load());

  $('#prof-close').addEventListener('click', () => window.close());
  window.addEventListener('keydown', (e) => { if (e.key === 'Escape') window.close(); });

  await load();
}

async function load() {
  try {
    const me = await Auth.me();
    if (!me?.authenticated) throw new Error('нет сессии');
    st.user = me.user;
    st.permissions = me.permissions ?? [];
  } catch (e) {
    st.user = null;
    toast(e?.message ?? 'Не удалось загрузить профиль');
  }
  render();
}

let __booted = false;
function __start() {
  if (__booted) return;
  __booted = true;
  void boot();
}
if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', __start);
else __start();
