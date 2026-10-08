/**
 * EPIC AI — административная панель: маршрутизация и каркас.
 *
 * Видимость разделов определяется permissions на backend'е:
 * клиент рисует только то, что вернул GET /api/admin/nav.
 */
import { el, clear, $, fmtDateTime, toast, avatarNode } from './util.js';
import { api, Auth, setBackendUrl, ApiError, initAuth } from './api.js';
import {
  viewOverview, viewUsers, viewRoles, viewPermissions, viewBlocks,
  viewReports, viewKbDocuments, viewKbVersions, viewKbChanges, viewKbSync,
  viewAudit, viewSystem, viewTelegram,
} from './admin-views.js';
import { applyVisualSettings } from './settings.js';

const VIEWS = {
  overview: viewOverview,
  users: viewUsers,
  roles: viewRoles,
  permissions: viewPermissions,
  blocks: viewBlocks,
  'ai-reports': viewReports,
  'kb-documents': viewKbDocuments,
  'kb-versions': viewKbVersions,
  'kb-changes': viewKbChanges,
  'kb-sync': viewKbSync,
  telegram: viewTelegram,
  audit: viewAudit,
  system: viewSystem,
};

const GROUP_TITLES = { ai: 'AI', kb: 'Knowledge Base' };

const state = {
  user: null,
  permissions: [],
  nav: [],
  route: null,          // намеренно null: первый navigate('overview') не должен
                        // срабатывать как «уже открыто» и оставлять спиннер
  params: {},
  backendUrl: '',
  cache: {},
};

const ctx = {
  get user() { return state.user; },
  get permissions() { return state.permissions; },
  get backendUrl() { return state.backendUrl; },
  get cache() { return state.cache; },
  get dom() { return { modal: $('#modal'), backdrop: $('#modal-backdrop') }; },
  can: (permission) => state.permissions.includes(permission),
  go: (route, params = {}) => navigate(route, params),
  reload: () => navigate(state.route, state.params, true),
};

async function boot() {
  // Токен сессии — до первых запросов к API (file:// не отправляет cookie)
  await initAuth();
  bindTitlebar();

  const runtime = await window.epicAI?.invoke('epic:runtime').catch(() => null);
  if (runtime?.backendUrl) { state.backendUrl = runtime.backendUrl; setBackendUrl(runtime.backendUrl); }
  if (runtime?.settings) applyVisualSettings(runtime.settings);
  window.epicAI?.on('settings:changed', applyVisualSettings);

  let me;
  try { me = await Auth.me(); }
  catch (e) {
    const status = e instanceof ApiError ? e.status : 0;
    if (status === 401) {
      renderFatal(
        'Нет активной сессии Epic AI.',
        'Административная панель использует ту же сессию, что и основная панель. Откройте overlay (F10 или иконка трея), войдите — и вернитесь сюда.',
        [
          { label: 'Открыть окно входа', onClick: () => window.epicAI?.invoke('epic:auth:open').catch(() => {}) },
          { label: 'Повторить', primary: true, onClick: () => location.reload() },
        ],
      );
    } else if (status === 403) {
      renderFatal('Аккаунт заблокирован.', 'Использование Epic AI запрещено. Обратитесь к руководству проекта.');
    } else {
      renderFatal('Нет связи с backend.', `${e.message ?? e}\n\nУбедитесь, что backend запущен: cd backend && npm run dev`);
    }
    return;
  }
  if (!me?.authenticated) {
    renderFatal(
      'Требуется авторизация.',
      'Откройте overlay (F10 или иконка трея) и войдите через Discord, Telegram или локальный вход.',
      [
        { label: 'Открыть окно входа', onClick: () => window.epicAI?.invoke('epic:auth:open').catch(() => {}) },
        { label: 'Повторить', primary: true, onClick: () => location.reload() },
      ],
    );
    return;
  }
  if (me.blocked) { renderFatal('Аккаунт заблокирован.', 'Использование Epic AI запрещено. Обратитесь к руководству проекта.'); return; }

  state.user = me.user;
  state.permissions = me.permissions ?? [];
  renderUser();

  try { state.nav = (await api.get('/api/admin/nav')).items ?? []; }
  catch (e) { renderFatal(e.message); return; }

  if (!state.nav.length) { renderFatal('У вашей роли нет доступа к административной панели.'); return; }
  renderNav();

  const first = firstLeaf(state.nav);
  await navigate(first ?? 'overview');
  void refreshKbBadge();
  setInterval(() => void refreshKbBadge(), 60_000);
}

function firstLeaf(items) {
  for (const it of items ?? []) {
    if (it.children?.length) { const c = firstLeaf(it.children); if (c) return c; }
    else if (VIEWS[it.id]) return it.id;
  }
  return null;
}

function renderUser() {
  const host = $('#admin-user');
  clear(host);
  const u = state.user;
  host.append(
    avatarNode(u?.avatarUrl, u?.displayName || u?.username, 'avatar'),
    el('div', { style: { minWidth: '0' } }, [
      el('div', { class: 'admin__user-name ellipsis' }, u?.displayName || u?.username || '—'),
      el('div', { style: { marginTop: '3px' } }, u?.primaryRole
        ? el('span', { class: 'role-pill', style: { color: u.primaryRole.color, height: '17px', fontSize: '9px' } }, [el('span', { class: 'dot' }), u.primaryRole.name])
        : null),
    ]),
  );
}

function renderNav() {
  const nav = $('#admin-nav');
  clear(nav);
  for (const item of state.nav) {
    if (item.children?.length) {
      const group = el('div', { class: 'nav-group' }, [el('div', { class: 'nav-group__title' }, GROUP_TITLES[item.id] ?? item.label)]);
      for (const child of item.children) {
        group.appendChild(navItem(child, true));
      }
      nav.appendChild(group);
    } else {
      nav.appendChild(navItem(item, false));
    }
  }
}

function navItem(item, isChild) {
  return el('button', {
    class: `nav-item${isChild ? ' is-child' : ''}${state.route === item.id ? ' is-active' : ''}`,
    dataset: { route: item.id },
    onClick: () => void navigate(item.id),
  }, item.label);
}

async function navigate(route, params = {}, force = false) {
  if (!force && state.route === route && Object.keys(params).length === 0) return;
  const view = VIEWS[route];
  if (!view) { toast(`Раздел «${route}» недоступен`); return; }
  state.route = route;
  state.params = params;

  for (const b of $('#admin-nav').querySelectorAll('.nav-item')) {
    b.classList.toggle('is-active', b.dataset.route === route);
  }

  const host = $('#admin-content');
  clear(host);
  host.appendChild(el('div', { class: 'center', style: { height: '180px' } }, el('span', { class: 'spinner' })));
  host.scrollTop = 0;
  try {
    const node = await view(ctx, params);
    clear(host);
    host.appendChild(node);
  } catch (e) {
    clear(host);
    if (e instanceof ApiError && (e.status === 401 || e.status === 403)) {
      host.appendChild(el('div', { class: 'empty-state' }, [
        el('div', { style: { fontSize: '14px', color: 'var(--warning)' } }, e.status === 403 ? 'Недостаточно прав' : 'Сессия истекла'),
        el('div', {}, e.message),
      ]));
    } else {
      host.appendChild(el('div', { class: 'empty-state' }, [el('div', {}, 'Ошибка загрузки раздела'), el('div', { class: 'mono', style: { fontSize: '11px' } }, e.message ?? String(e))]));
    }
  }
}

async function refreshKbBadge() {
  const badge = $('#admin-kb-badge');
  try {
    const st = await api.get('/api/kb/status');
    badge.textContent = `${st.stateLabel} · ${st.lastSyncLabel}`;
    badge.className = `badge ${st.state === 'ok' ? 'badge--accent' : st.state === 'updates' ? 'badge--warning' : st.state === 'error' ? 'badge--danger' : 'badge--mid'}`;
  } catch { badge.textContent = 'база недоступна'; }
}

function bindTitlebar() {
  $('#admin-close').addEventListener('click', async () => {
    if (window.epicAI) await window.epicAI.invoke('epic:window:hide').catch(() => {});
    window.close();
  });
  $('#admin-min').addEventListener('click', async () => {
    if (window.epicAI) { await window.epicAI.invoke('epic:window:hide').catch(() => {}); window.close(); }
    else window.close();
  });
  $('#admin-overlay').addEventListener('click', async () => {
    if (window.epicAI) await window.epicAI.invoke('epic:window:show').catch(() => {});
    toast('Overlay показан');
  });
}

function renderFatal(message, detail, actions) {
  const host = $('#admin-content');
  clear(host);
  host.appendChild(el('div', { class: 'empty-state', style: { paddingTop: '80px' } }, [
    el('div', { html: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M12 3l9 16H3z" stroke-linejoin="round"/><path d="M12 9v5M12 16.6v.4" stroke-linecap="round"/></svg>' }),
    el('div', { style: { fontSize: '13px', color: 'var(--warning)' } }, message),
    detail ? el('div', { style: { fontSize: '11.5px', color: 'var(--text-muted)', maxWidth: '520px', lineHeight: '1.7', whiteSpace: 'pre-wrap' } }, detail) : null,
    actions?.length ? el('div', { class: 'row gap-8', style: { marginTop: '10px' } },
      actions.map((a) => el('button', { class: `btn${a.primary ? ' btn--accent' : ''}`, onClick: a.onClick }, a.label))) : null,
  ]));
  const nav = $('#admin-nav');
  clear(nav);
}

let __booted = false;
function __start() {
  if (__booted) return;   // защита от повторного запуска (double DOMContentLoaded)
  __booted = true;
  void boot();
}
if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', __start);
else __start();
