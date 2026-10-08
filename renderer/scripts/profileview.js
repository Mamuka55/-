/**
 * EPIC AI — профиль как РАЗДЕЛ НАСТРОЕК (п.4, п.5 требований пользователя).
 *
 * Раньше профиль жил в отдельном BrowserWindow и открывался из dropdown-меню
 * пилюли пользователя. Теперь окно удалено: содержимое профиля рисуется
 * вкладкой «Профиль» внутри выпадающей области настроек основной панели.
 *
 * Состав (референс пользователя): шапка (аватар, имя, роль, «@ник · вход
 * через Telegram»), карточка «Ответы ИИ сегодня» с остатком дневного лимита
 * и прогресс-баром, карточка выхода из аккаунта (+ вход в админ-панель для
 * администрации), сводка аккаунта.
 */
import { el, fmtDateTime, avatarNode, streamerAvatarNode } from './util.js';
import { Ai } from './api.js';

/** «вход через Telegram» / «вход через Discord» — по привязанным identity. */
function providerLabel(u) {
  const ids = u?.identities ?? [];
  if (ids.some((i) => i.provider === 'telegram')) return 'вход через Telegram';
  if (ids.some((i) => i.provider === 'discord')) return 'вход через Discord';
  return 'внешний провайдер';
}

function displayName(ctx, u) {
  if (ctx.settings?.streamerMode) return ctx.settings.streamerNick || 'Стример';
  return u?.displayName || u?.username || '—';
}

function headCard(ctx, u) {
  const ava = ctx.settings?.streamerMode
    ? streamerAvatarNode('prof-ava', u.avatarUrl, u.displayName || u.username)
    : avatarNode(u.avatarUrl, u.displayName || u.username, 'prof-ava');
  return el('div', { class: 'prof-head' }, [
    ava,
    el('div', { class: 'prof-id' }, [
      el('div', { class: 'prof-name' }, displayName(ctx, u)),
      u.primaryRole
        ? el('span', { class: 'role-pill', style: { color: u.primaryRole.color } }, [el('span', { class: 'dot' }), u.primaryRole.name])
        : null,
      el('div', { class: 'prof-login' }, ctx.settings?.streamerMode ? '@•••••• · стрим-режим' : `@${u.username ?? '—'} · ${providerLabel(u)}`),
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
    big.textContent = '';
    big.classList.toggle('is-empty', left <= 0);
    big.append(
      el('b', {}, `${left} из ${limit}`),
      el('span', {}, 'осталось'),
    );
    bar.style.width = limit > 0 ? `${Math.round((left / limit) * 100)}%` : '0%';
    const reset = q?.resetAt ? fmtDateTime(q.resetAt) : '00:00 по Москве';
    caption.textContent = `Новые ответы появятся в ${reset} — лимит сбрасывается ежедневно${q?.personal ? ' (персональный лимит выдан администратором)' : ''}.`;
  }).catch(() => {
    big.textContent = '';
    big.appendChild(el('b', {}, '—'));
    caption.textContent = 'Лимит недоступен: backend не отвечает.';
    bar.style.width = '0%';
  });
  return card;
}

/** Карточка «Выйти из аккаунта» + (для администрации) «Админ панель». */
function logoutCard(ctx) {
  return el('div', { class: 'prof-card' }, [
    el('div', { class: 'prof-card__title' }, 'Выйти из аккаунта'),
    el('div', { class: 'prof-logout__row' }, [
      el('div', { class: 'prof-logout__text' }, 'Сессия будет отозвана, а Epic AI вернётся к окну входа. Настройки аккаунта сохранятся на сервере.'),
      el('button', {
        class: 'btn btn--danger', type: 'button',
        onClick: () => { ctx.onLogout?.(); },
      }, 'Выйти'),
    ]),
    ctx.canAdmin
      ? el('div', { class: 'prof-logout__row' }, [
          el('div', { class: 'prof-logout__text' }, 'Управление пользователями, ошибками ИИ и базой знаний.'),
          el('button', {
            class: 'btn', type: 'button',
            onClick: () => { ctx.onOpenAdmin?.(); },
          }, 'Админ панель'),
        ])
      : null,
  ]);
}

/** Короткая сводка аккаунта (даты, провайдеры) — внизу раздела. */
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

/**
 * Раздел «Профиль» настроек. Контекст — тот же, что передаёт main.js
 * в initSettings(): user, permissions, settings, canAdmin, onLogout, onOpenAdmin.
 */
export function buildProfileSection(ctx) {
  const host = el('div', { class: 'set-page' });
  const u = ctx.user;
  if (!u) {
    host.appendChild(el('div', { class: 'empty' }, 'Нет данных пользователя — требуется вход.'));
    return host;
  }
  host.append(
    el('div', { style: { display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '6px' } }, [
      el('button', {
        class: 'btn btn--ghost btn--sm', type: 'button',
        onClick: () => ctx.onNavigate?.('main'),
      }, '← к настройкам'),
      el('span', { class: 'section-title', style: { margin: '0' } }, 'Профиль и аккаунт'),
    ]),
    headCard(ctx, u),
    quotaCard(),
    logoutCard(ctx),
    detailsCard(u),
  );
  return host;
}

export { providerLabel };
