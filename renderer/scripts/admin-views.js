/**
 * EPIC AI — административная панель.
 *
 * Разделы:
 *   Обзор · Пользователи · Роли · Permissions · Блокировки
 *   AI → Ошибки AI
 *   Knowledge Base → Документы · Версии · Изменения · Синхронизация
 *   Audit Log · System
 *
 * Видимость разделов зависит от permissions.
 */
import { el, clear, fmtDateTime, fmtDate, relativeTime, plural, toast, openExternal, avatarNode, debounce } from './util.js';
import { api, Ai, Kb } from './api.js';
import { renderDiff } from './kbview.js';

/* ------------------------------------------------------------------ */
/*  Общие хелперы                                                       */
/* ------------------------------------------------------------------ */

function pageHead(title, sub, actions = []) {
  return el('div', { class: 'page-head' }, [
    el('div', { style: { minWidth: '0' } }, [
      el('div', { class: 'page-title' }, title),
      sub ? el('div', { class: 'page-sub' }, sub) : null,
    ]),
    actions.length ? el('div', { class: 'page-actions' }, actions) : null,
  ]);
}

function card(title,...children) {
  return el('div', { class: 'card' }, [title ? el('div', { class: 'card__title' }, title) : null,...children]);
}

function stat(value, label, hint, color) {
  return el('div', { class: 'card stat' }, [
    el('div', { class: 'stat__value', style: color ? { color } : null }, String(value ?? 0)),
    el('div', { class: 'stat__label' }, label),
    hint ? el('div', { class: 'stat__hint' }, hint) : null,
  ]);
}

function table(columns, rows, renderRow, opts = {}) {
  const thead = el('thead', {}, el('tr', {}, columns.map((c) => el('th', { style: c.style ?? null }, c.label))));
  const tbody = el('tbody', {}, rows.map((r) => renderRow(r)));
  const t = el('table', { class: 'data' }, [thead, tbody]);
  const wrap = el('div', { class: 'table-wrap' }, t);
  if (!rows.length) {
    return el('div', { class: 'empty-state' }, [
      el('div', { html: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><rect x="3" y="4" width="18" height="16" rx="2"/><path d="M3 9h18M8 14h8" stroke-linecap="round"/></svg>' }),
      el('div', {}, opts.emptyText ?? 'Ничего не найдено'),
    ]);
  }
  return wrap;
}

function pager(total, limit, offset, onGo) {
  const from = total ? offset + 1 : 0;
  const to = Math.min(total, offset + limit);
  return el('div', { class: 'pager' }, [
    el('button', { class: 'btn btn--sm', disabled: offset <= 0, onClick: () => onGo(Math.max(0, offset - limit)) }, '← Назад'),
    el('span', {}, `${from}–${to} из ${total}`),
    el('button', { class: 'btn btn--sm', disabled: to >= total, onClick: () => onGo(offset + limit) }, 'Вперёд →'),
  ]);
}

function rolePill(role) {
  if (!role) return el('span', { class: 'badge' }, '—');
  return el('span', { class: 'role-pill', style: { color: role.color } }, [el('span', { class: 'dot' }), role.name]);
}

function statusBadge(status) {
  return status === 'blocked'
    ? el('span', { class: 'badge badge--danger' }, 'blocked')
    : el('span', { class: 'badge badge--accent' }, 'active');
}

function openModal(ctx, { title, body, footer, width }) {
  const modal = ctx.dom.modal;
  const backdrop = ctx.dom.backdrop;
  clear(modal);
  if (width) modal.style.width = `min(${width}px, 100%)`; else modal.style.width = '';
  modal.append(
    el('div', { class: 'modal__head' }, [
      el('div', { class: 'section-title', style: { fontSize: '11px' } }, title),
      el('span', { class: 'grow' }),
      el('button', { class: 'icon-btn', onClick: closeModal, 'aria-label': 'Закрыть', html: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><path d="M6 6l12 12M18 6L6 18"/></svg>' }),
    ]),
    el('div', { class: 'modal__body' }, body),
    footer ? el('div', { class: 'modal__foot' }, footer) : null,
  );
  backdrop.hidden = false;
  backdrop.onclick = (e) => { if (e.target === backdrop) closeModal(); };
  function closeModal() { backdrop.hidden = true; backdrop.onclick = null; clear(modal); }
  return closeModal;
}

/* ------------------------------------------------------------------ */
/*  ОБЗОР                                                               */
/* ------------------------------------------------------------------ */

export async function viewOverview(ctx) {
  const host = el('div', {}, [el('div', { class: 'center', style: { padding: '40px' } }, el('span', { class: 'spinner' }))]);
  const d = await api.get('/api/admin/overview');
  clear(host);

  const sat = d.feedback.likes + d.feedback.dislikes;
  host.append(
    pageHead('Обзор', 'Сводка по пользователям, качеству ответов AI и состоянию базы знаний EpicRP.', [
      el('button', { class: 'btn', onClick: () => ctx.go('kb-sync') }, 'Синхронизация'),
      el('button', { class: 'btn', onClick: () => ctx.go('ai-reports') }, `Ошибки AI${d.aiReports.new ? ` (${d.aiReports.new})` : ''}`),
    ]),

    el('div', { class: 'grid grid--4' }, [
      stat(d.users.total, 'Пользователей', `${d.users.active7d} активных за 7 дней`),
      stat(d.requests.total, 'Запросов к AI', `${d.requests.noData} без подтверждённых данных`, 'var(--accent-mid)'),
      stat(sat ? `${Math.round((d.feedback.likes / sat) * 100)}%` : '—', 'Одобрение ответов', `👍 ${d.feedback.likes} · 👎 ${d.feedback.dislikes}`, sat && d.feedback.likes / sat >= 0.7 ? 'var(--accent)' : 'var(--warning)'),
      stat(d.aiReports.new, 'Новых ошибок AI', `${d.aiReports.inProgress} в работе · ${d.aiReports.resolved} решено`, d.aiReports.new ? 'var(--danger)' : 'var(--accent)'),
    ]),

    el('div', { class: 'grid grid--2', style: { marginTop: '12px' } }, [
      card('База знаний',
        el('div', { style: { display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '10px' } }, [
          el('span', { style: { width: '9px', height: '9px', borderRadius: '50%', background: d.kb.stateColor, boxShadow: `0 0 10px ${d.kb.stateColor}` } }),
          el('b', { style: { color: d.kb.stateColor, fontSize: '13px' } }, d.kb.stateLabel),
          el('span', { class: 'grow' }),
          el('span', { class: 'badge' }, `v${d.kb.kbVersion}`),
        ]),
        el('dl', { class: 'kv' }, [
          el('dt', {}, 'Обновлено'), el('dd', { class: 'mono' }, d.kb.lastSyncLabel),
          el('dt', {}, 'Документов'), el('dd', { class: 'mono' }, `${d.kb.documents.active} (${d.kb.documents.rules} правил · ${d.kb.documents.laws} законов)`),
          el('dt', {}, 'В архиве'), el('dd', { class: 'mono' }, String(d.kb.documents.archive)),
          el('dt', {}, 'Версий'), el('dd', { class: 'mono' }, String(d.kb.versions)),
          el('dt', {}, 'Фрагментов'), el('dd', { class: 'mono' }, String(d.kb.chunks)),
          el('dt', {}, 'Сегодня'), el('dd', { class: 'mono' }, `${d.kb.today.newCount} новых · ${d.kb.today.updatedCount} изменено`),
          el('dt', {}, 'Интервал'), el('dd', { class: 'mono' }, `${d.kb.intervalMinutes} мин`),
        ]),
      ),
      card('Система',
        el('dl', { class: 'kv' }, [
          el('dt', {}, 'Окружение'), el('dd', { class: 'mono' }, d.system.env),
          el('dt', {}, 'База данных'), el('dd', { class: 'mono' }, d.system.db),
          el('dt', {}, 'AI-провайдер'), el('dd', { class: 'mono' }, `${d.system.aiProvider} · ${d.system.aiModel}`),
          el('dt', {}, 'AI настроен'), el('dd', {}, d.system.aiConfigured
            ? el('span', { style: { color: 'var(--accent)' } }, 'да')
            : el('span', { style: { color: 'var(--warning)' } }, d.system.aiConfigReason ?? 'нет')),
          el('dt', {}, 'Crawler'), el('dd', {}, d.system.crawlerEnabled
            ? el('span', { style: { color: 'var(--accent)' } }, 'включён')
            : el('span', { style: { color: 'var(--warning)' } }, 'отключён (см. docs/LEGAL.md)')),
          el('dt', {}, 'Discord / Telegram'), el('dd', { class: 'mono' }, `${d.system.discordEnabled ? '✓' : '✕'} / ${d.system.telegramEnabled ? '✓' : '✕'}`),
          el('dt', {}, 'Время сервера'), el('dd', { class: 'mono' }, d.system.serverTime),
        ]),
      ),
    ]),

    el('div', { class: 'grid grid--2', style: { marginTop: '12px' } }, [
      card('Роли',
        table([{ label: 'Роль' }, { label: 'Уровень', style: 'width:80px' }, { label: 'Пользователей', style: 'width:130px' }], d.roles, (r) => el('tr', {}, [
          el('td', {}, rolePill({ name: r.name, color: r.color })),
          el('td', { class: 'num' }, r.code),
          el('td', { class: 'num' }, String(r.count)),
        ]), { emptyText: 'Роли не настроены' }),
      ),
      card('Последние события (Audit Log)',
        el('div', { class: 'timeline' }, d.recentAudit.map((a) => el('div', { class: 'tl-item' }, [
          el('div', { class: 'tl-item__time' }, fmtDateTime(a.createdAt)),
          el('div', { class: 'tl-item__action' }, a.action),
          el('div', { class: 'tl-item__meta' }, `${a.actorName ?? 'система'}${a.entityType ? ` · ${a.entityType} #${a.entityId ?? ''}` : ''}`),
        ]))),
      ),
    ]),
  );
  return host;
}

/* ------------------------------------------------------------------ */
/*  ПОЛЬЗОВАТЕЛИ                                           */
/* ------------------------------------------------------------------ */

export async function viewUsers(ctx, params = {}) {
  const state = { search: params.search ?? '', role: '', status: '', limit: 50, offset: 0 };
  const host = el('div', {});
  const listHost = el('div', {});

  const search = el('input', { class: 'field', type: 'text', placeholder: 'Никнейм, ID, Discord или Telegram…', value: state.search });
  const roleSel = el('select', { class: 'field', style: { width: '190px' } }, [el('option', { value: '' }, 'Все роли')]);
  const statusSel = el('select', { class: 'field', style: { width: '140px' } }, [
    el('option', { value: '' }, 'Все статусы'), el('option', { value: 'active' }, 'active'), el('option', { value: 'blocked' }, 'blocked'),
  ]);

  try {
    const roles = await api.get('/api/roles');
    for (const r of roles.items) roleSel.appendChild(el('option', { value: r.code }, `${r.name} (ур. ${r.level})`));
  } catch { /* нет roles.view */ }

  const reload = debounce(async () => {
    clear(listHost);
    listHost.appendChild(el('div', { class: 'center', style: { padding: '30px' } }, el('span', { class: 'spinner' })));
    const q = new URLSearchParams({ limit: String(state.limit), offset: String(state.offset) });
    if (state.search) q.set('search', state.search);
    if (state.role) q.set('role', state.role);
    if (state.status) q.set('status', state.status);
    let data;
    try { data = await api.get(`/api/users?${q.toString()}`); }
    catch (e) { clear(listHost); listHost.appendChild(el('div', { class: 'empty-state' }, e.message)); return; }

    clear(listHost);
    listHost.appendChild(table(
      [{ label: 'Пользователь' }, { label: 'Роль', style: 'width:180px' }, { label: 'Статус', style: 'width:100px' },
       { label: 'Discord', style: 'width:150px' }, { label: 'Telegram', style: 'width:150px' },
       { label: 'Последний вход', style: 'width:150px' }, { label: '', style: 'width:120px' }],
      data.items,
      (u) => el('tr', { class: 'is-clickable', onClick: () => openUserCard(ctx, u.id, reload) }, [
        el('td', {}, el('div', { class: 'cell-user' }, [
          avatarNode(u.avatarUrl, u.displayName || u.username, 'avatar'),
          el('div', { style: { minWidth: '0' } }, [
            el('div', { class: 'name ellipsis' }, u.displayName || u.username),
            el('div', { class: 'sub' }, `#${u.id} · @${u.username}`),
          ]),
        ])),
        el('td', {}, rolePill(u.primaryRole)),
        el('td', {}, statusBadge(u.status)),
        el('td', { class: 'num' }, u.discord ? (u.discord.username ? `@${u.discord.username}` : u.discord.providerUserId) : '—'),
        el('td', { class: 'num' }, u.telegram ? (u.telegram.username ? `@${u.telegram.username}` : u.telegram.providerUserId) : '—'),
        el('td', { class: 'num' }, u.lastLoginLabel ?? '—'),
        el('td', { class: 'actions' }, el('button', { class: 'btn btn--sm', onClick: (e) => { e.stopPropagation(); openUserCard(ctx, u.id, reload); } }, 'Открыть')),
      ]),
      { emptyText: 'Пользователи не найдены' },
    ));
    listHost.appendChild(pager(data.total, state.limit, state.offset, (o) => { state.offset = o; void reload(); }));
  }, 280);

  search.addEventListener('input', () => { state.search = search.value.trim(); state.offset = 0; void reload(); });
  roleSel.addEventListener('change', () => { state.role = roleSel.value; state.offset = 0; void reload(); });
  statusSel.addEventListener('change', () => { state.status = statusSel.value; state.offset = 0; void reload(); });

  host.append(
    pageHead('Пользователи', 'Поиск по никнейму, ID, Discord и Telegram. Карточка пользователя показывает роль, статус, identity, permissions и историю действий.', [
      ctx.can('users.block') ? el('button', { class: 'btn', onClick: () => ctx.go('blocks') }, 'Блокировки') : null,
    ]),
    el('div', { class: 'toolbar' }, [search, roleSel, statusSel, el('span', { class: 'spacer' }),
      el('button', { class: 'btn btn--ghost btn--sm', onClick: () => { search.value = ''; roleSel.value = ''; statusSel.value = ''; state.search = ''; state.role = ''; state.status = ''; state.offset = 0; void reload(); } }, 'Сбросить')]),
    listHost,
  );
  void reload();
  return host;
}

async function openUserCard(ctx, userId, reload) {
  let u;
  try { u = await api.get(`/api/users/${userId}`); } catch (e) { return toast(e.message); }
  const roles = ctx.cache.roles ?? (ctx.cache.roles = (await api.get('/api/roles').catch(() => ({ items: [] }))).items);
  const allPerms = ctx.cache.perms ?? (ctx.cache.perms = (await api.get('/api/permissions').catch(() => ({ items: [] }))).items);

  const roleSelect = el('select', { class: 'field', style: { width: '240px' } }, roles
   .filter((r) => r.assignable || r.code === u.primaryRole?.code)
   .map((r) => el('option', { value: r.code,...(r.code === u.primaryRole?.code ? { selected: true } : {}) }, `${r.name} · уровень ${r.level}${r.isSystem ? ' (системная)' : ''}`)));

  const body = el('div', { style: { display: 'flex', flexDirection: 'column', gap: '14px' } }, [
    el('div', { style: { display: 'flex', gap: '12px', alignItems: 'center' } }, [
      avatarNode(u.avatarUrl, u.displayName || u.username, 'avatar'),
      el('div', {}, [
        el('div', { style: { fontSize: '15px', fontWeight: '700' } }, u.displayName || u.username),
        el('div', { class: 'row gap-6', style: { marginTop: '4px' } }, [rolePill(u.primaryRole), statusBadge(u.status), el('span', { class: 'subtle mono', style: { fontSize: '10px' } }, `#${u.id}`)]),
      ]),
    ]),

    el('dl', { class: 'kv' }, [
      el('dt', {}, 'Аккаунт создан'), el('dd', { class: 'mono' }, u.createdAtLabel ?? '—'),
      el('dt', {}, 'Последний вход'), el('dd', { class: 'mono' }, u.lastLoginLabel ?? '—'),
      el('dt', {}, 'Discord'), el('dd', {}, u.discord ? `${u.discord.displayName ?? ''} ${u.discord.username ? '@' + u.discord.username : ''} (id ${u.discord.providerUserId})` : el('span', { class: 'subtle' }, 'не привязан')),
      el('dt', {}, 'Telegram'), el('dd', {}, u.telegram ? `${u.telegram.displayName ?? ''} ${u.telegram.username ? '@' + u.telegram.username : ''} (id ${u.telegram.providerUserId})` : el('span', { class: 'subtle' }, 'не привязан')),
     ...(u.status === 'blocked' && u.blockedReason ? [el('dt', {}, 'Причина блокировки'), el('dd', { style: { color: 'var(--danger)' } }, u.blockedReason)] : []),
    ]),

    ctx.can('roles.assign') ? card('Роль',
      el('div', { class: 'row gap-8', style: { flexWrap: 'wrap' } }, [
        roleSelect,
        el('button', { class: 'btn btn--accent', onClick: async () => {
          try { await api.patch(`/api/users/${u.id}/role`, { role: roleSelect.value }); toast('Роль обновлена'); close(); void reload?.(); }
          catch (e) { toast(e.message); }
        } }, 'Сохранить роль'),
      ]),
      el('div', { class: 'kb-note', style: { marginTop: '8px' } }, 'Администратор не может назначить роль выше своего разрешённого уровня. Developer в списке для назначения недоступен.'),
    ) : null,

    /* Персональный дневной лимит запросов к ИИ: выдаёт администратор.
       Общий лимит — 50 в сутки; отсутствие персональной строки = общий. */
    card('Лимит запросов к ИИ',
      (() => {
        const q = u.quota ?? null;
        const info = el('div', { class: 'subtle', style: { fontSize: '11.5px' } },
          q ? `Осталось сегодня: ${q.left} из ${q.limit} (использовано ${q.used}) · ${q.personal ? 'персональный лимит' : 'общий лимит по умолчанию'}`
            : 'Данные о лимите недоступны');
        if (!ctx.can('users.edit')) return info;
        const input = el('input', {
          class: 'field', type: 'number', min: '0', max: '100000', step: '1',
          placeholder: String(q?.limit ?? 50), style: { width: '150px' },
        });
        const apply = async (value) => {
          try {
            const r = await api.put(`/api/users/${u.id}/quota`, { dailyLimit: value });
            toast(value == null ? 'Возвращён общий лимит по умолчанию' : `Персональный лимит установлен: ${value}`);
            info.textContent = `Осталось сегодня: ${r.quota.left} из ${r.quota.limit} (использовано ${r.quota.used}) · ${r.quota.personal ? 'персональный лимит' : 'общий лимит по умолчанию'}`;
            input.value = '';
          } catch (e) { toast(e.message); }
        };
        return el('div', {}, [
          info,
          el('div', { class: 'row gap-8', style: { marginTop: '8px', flexWrap: 'wrap' } }, [
            input,
            el('button', { class: 'btn btn--accent', onClick: () => apply(input.value.trim() === '' ? null : Number(input.value)) }, 'Сохранить лимит'),
            el('button', { class: 'btn btn--ghost', onClick: () => apply(null) }, 'Сбросить на общий (50)'),
          ]),
          el('div', { class: 'kb-note', style: { marginTop: '8px' } }, 'Общий лимит — 50 запросов в сутки на пользователя. Персональный лимит перекрывает общий; сброс возвращает общий. Изменение пишется в аудит.'),
        ]);
      })(),
    ),

    ctx.can('permissions.manage') ? card('Дополнительные разрешения и запреты',
      el('div', { class: 'row gap-8', style: { flexWrap: 'wrap', marginBottom: '10px' } }, [
        (() => {
          const sel = el('select', { class: 'field', style: { width: '300px' } }, allPerms.map((p) => el('option', { value: p.code }, `${p.code} — ${p.description ?? ''}`)));
          const eff = el('select', { class: 'field', style: { width: '150px' } }, [
            el('option', { value: 'allow' }, 'разрешить (+)'), el('option', { value: 'deny' }, 'запретить (−)'), el('option', { value: '' }, 'убрать override'),
          ]);
          const btn = el('button', { class: 'btn', onClick: async () => {
            try {
              await api.put(`/api/users/${u.id}/permissions`, { permission: sel.value, effect: eff.value || null });
              toast('Permissions обновлены'); close(); void reload?.();
            } catch (e) { toast(e.message); }
          } }, 'Применить');
          sel._eff = eff;
          return el('div', { class: 'row gap-8', style: { flexWrap: 'wrap' } }, [sel, eff, btn]);
        })(),
      ]),
      el('div', { class: 'report-field' }, [
        el('div', { class: 'report-field__label' }, 'Выдано дополнительно'),
        el('div', { class: 'perm-list' }, u.permissionsDetail.extra.length
          ? u.permissionsDetail.extra.map((p) => el('span', { class: 'perm perm--allow' }, p))
          : el('span', { class: 'subtle', style: { fontSize: '11px' } }, 'нет')),
      ]),
      el('div', { class: 'report-field', style: { marginTop: '8px' } }, [
        el('div', { class: 'report-field__label' }, 'Запрещено индивидуально (приоритет над ролью)'),
        el('div', { class: 'perm-list' }, u.permissionsDetail.denied.length
          ? u.permissionsDetail.denied.map((p) => el('span', { class: 'perm perm--deny' }, p))
          : el('span', { class: 'subtle', style: { fontSize: '11px' } }, 'нет')),
      ]),
      el('div', { class: 'report-field', style: { marginTop: '8px' } }, [
        el('div', { class: 'report-field__label' }, `Эффективные permissions (${u.permissions.length})`),
        el('div', { class: 'perm-list' }, u.permissions.map((p) => el('span', { class: 'perm' }, p))),
      ]),
    ) : null,

    card('История действий',
      u.history.length
        ? el('div', { class: 'timeline', style: { maxHeight: '220px', overflowY: 'auto' } }, u.history.map((h) => el('div', { class: 'tl-item' }, [
            el('div', { class: 'tl-item__time' }, h.createdAtLabel),
            el('div', { class: 'tl-item__action' }, h.action),
            el('div', { class: 'tl-item__meta' }, h.entityType ? `${h.entityType} #${h.entityId ?? ''}` : ''),
          ])))
        : el('div', { class: 'subtle', style: { fontSize: '11.5px' } }, 'Записей нет'),
    ),
  ]);

  const footer = [
    ctx.can('users.edit') ? el('button', { class: 'btn', onClick: async () => {
      try { const r = await api.post(`/api/users/${u.id}/sessions/revoke`, {}); toast(`Сессий завершено: ${r.revoked}`); } catch (e) { toast(e.message); }
    } } , 'Завершить сессии') : null,
    ctx.can('users.block') && u.id !== ctx.user.id ? el('button', {
      class: u.status === 'blocked' ? 'btn btn--accent' : 'btn btn--danger',
      onClick: () => {
        // П.4 раунда 29: window.prompt() в Electron не работает (возвращает
        // null) — причина блокировки спрашивается собственной модалкой.
        if (u.status === 'blocked') { void toggleBlock(ctx, u, null); return; }
        askBlockReason(ctx, u);
      },
    }, u.status === 'blocked' ? 'Разблокировать' : 'Заблокировать') : null,
    ctx.can('users.edit') && u.id !== ctx.user.id ? el('button', {
      class: 'btn btn--danger',
      onClick: () => confirmDeleteUser(ctx, u),
    }, 'Удалить аккаунт') : null,
    el('button', { class: 'btn btn--ghost', onClick: () => close() }, 'Закрыть'),
  ];

  const close = openModal(ctx, { title: `Пользователь #${u.id}`, body, footer, width: 780 });
}

/* ------------------------------------------------------------------ */
/*  РОЛИ                                                   */
/* ------------------------------------------------------------------ */

export async function viewRoles(ctx) {
  const data = await api.get('/api/roles');
  const canManage = ctx.can('roles.manage');
  const host = el('div', {});
  host.append(pageHead('Роли', 'Иерархия ролей зафиксирована в Developer — системная роль: она не создаётся и не выдаётся обычной административной панелью.',
    canManage ? [el('button', { class: 'btn btn--accent', onClick: () => roleEditor(ctx, null) }, 'Создать роль')] : []));

  host.appendChild(table(
    [{ label: 'Роль' }, { label: 'Код', style: 'width:150px' }, { label: 'Уровень', style: 'width:90px' },
     { label: 'Пользователей', style: 'width:130px' }, { label: 'Permissions', style: 'width:120px' }, { label: 'Управление', style: 'width:230px' }],
    data.items,
    (r) => el('tr', {}, [
      el('td', {}, rolePill({ name: r.name, color: r.color })),
      el('td', { class: 'num' }, r.code),
      el('td', { class: 'num' }, String(r.level)),
      el('td', { class: 'num' }, String(r.userCount)),
      el('td', { class: 'num' }, String(r.permissions.length)),
      el('td', {}, el('div', { style: { display: 'flex', gap: '6px', flexWrap: 'wrap' } }, [
        canManage && (!r.isSystem || data.actor.isDeveloper)
          ? el('button', { class: 'btn btn--sm', onClick: () => roleEditor(ctx, r) }, 'Изменить')
          : !canManage && r.assignable
            ? el('button', { class: 'btn btn--sm', onClick: () => roleEditor(ctx, r) }, 'Права')
            : null,
        canManage && !r.isSystem && r.userCount === 0 && !BASE_ROLES.includes(r.code)
          ? el('button', { class: 'btn btn--sm btn--danger', onClick: () => deleteRole(ctx, r) }, 'Удалить')
          : null,
        r.isSystem
          ? el('span', { class: 'badge badge--danger' }, 'системная')
          : !canManage && !r.assignable
            ? el('span', { class: 'badge' }, 'выше вашего уровня')
            : r.userCount > 0
              ? el('span', { class: 'badge', title: 'Сначала снимите роль с пользователей' }, 'назначена')
              : null,
      ])),
    ]),
  ));

  host.appendChild(el('div', { class: 'card', style: { marginTop: '12px' } }, [
    el('div', { class: 'card__title' }, 'Ваш уровень доступа'),
    el('div', { style: { fontSize: '12px', color: 'var(--text-muted)', lineHeight: '1.7' } },
      `Максимальный уровень роли: ${data.actor.maxLevel}. Вы можете назначать роли строго ниже своего уровня${data.actor.isDeveloper ? ' (режим разработчика: доступны все несистемные роли)' : ''}.`),
  ]));
  return host;
}

/** Модалка причины блокировки (вместо нерабочего window.prompt в Electron). */
function askBlockReason(ctx, u) {
  const input = el('input', { class: 'field', placeholder: 'Причина блокировки (видна пользователю)' });
  const close = openModal(ctx, {
    title: `Блокировка ${u.username}`,
    width: 460,
    body: el('div', {}, [
      el('div', { style: { fontSize: '12px', color: 'var(--text-muted)', marginBottom: '10px', lineHeight: '1.6' } },
        'Сессии пользователя будут инвалидированы, окно блокировки покажет причину.'),
      input,
    ]),
    footer: [
      el('button', {
        class: 'btn btn--danger',
        onClick: () => {
          const reason = input.value.trim() || 'без указания причины';
          close();
          void toggleBlock(ctx, u, reason);
        },
      }, 'Заблокировать'),
      el('button', { class: 'btn btn--ghost', onClick: () => close() }, 'Отмена'),
    ],
  });
}

async function toggleBlock(ctx, u, reason) {
  try {
    await api.patch(`/api/users/${u.id}/status`, { blocked: u.status !== 'blocked', reason });
    toast(u.status === 'blocked' ? 'Пользователь разблокирован' : 'Пользователь заблокирован, сессии инвалидированы');
    ctx.reload();
  } catch (e) { toast(e?.message ?? 'Не удалось изменить статус'); }
}

/** Удаление аккаунта с подтверждением (п.5 раунда 29). */
function confirmDeleteUser(ctx, u) {
  const close = openModal(ctx, {
    title: `Удаление аккаунта ${u.username}`,
    width: 480,
    body: el('div', { style: { fontSize: '12.5px', lineHeight: '1.7' } }, [
      'Будут удалены: профиль, identity (Discord/Telegram), роли, сессии, настройки и лимиты.',
      el('br'),
      'История в Audit Log сохранится. Действие необратимо.',
    ]),
    footer: [
      el('button', {
        class: 'btn btn--danger',
        onClick: async () => {
          try {
            await api.del(`/api/users/${u.id}`);
            toast(`Аккаунт ${u.username} удалён`);
            close();
            ctx.reload();
          } catch (e) { toast(e?.message ?? 'Не удалось удалить аккаунт'); }
        },
      }, 'Удалить навсегда'),
      el('button', { class: 'btn btn--ghost', onClick: () => close() }, 'Отмена'),
    ],
  });
}

/** Базовые роли проекта: удалить нельзя (защищено и на backend). */
const BASE_ROLES = ['player', 'helper', 'admin', 'chief_admin'];

function isHexColor(v) { return /^#[0-9a-f]{6}$/i.test(String(v ?? '').trim()); }

/** Чек-лист permissions, сгруппированный по категориям каталога. */
function permChecklist(groups, selected) {
  const boxes = [];
  const node = el('div', {}, groups.map((g) => el('div', { style: { marginBottom: '10px' } }, [
    el('div', { class: 'section-title', style: { marginBottom: '6px' } }, g.category),
    el('div', { class: 'perm-list' }, g.items.map((p) => {
      const input = el('input', { type: 'checkbox', checked: selected.has(p.code) });
      boxes.push({ input, code: p.code });
      return el('label', { class: 'perm perm--allow', style: { cursor: 'pointer', display: 'inline-flex', alignItems: 'center', gap: '6px' }, title: p.description ?? '' }, [input, p.code]);
    })),
  ])));
  return { node, get: () => boxes.filter((b) => b.input.checked).map((b) => b.code) };
}

/**
 * Редактор роли (п.10): создание, название, ЦВЕТ, permissions.
 * role === null → создание; иначе PATCH /api/roles/:code.
 */
async function roleEditor(ctx, role) {
  const isCreate = !role;
  let groups = [];
  try { groups = (await api.get('/api/permissions')).groups ?? []; } catch { /* каталог недоступен */ }
  const selected = new Set(role?.permissions ?? []);

  const codeInput = el('input', { class: 'field', placeholder: 'watcher', value: role?.code ?? '', disabled: !isCreate });
  const nameInput = el('input', { class: 'field', placeholder: 'Наблюдатель', value: role?.name ?? '' });
  const colorInput = el('input', { type: 'color', value: isHexColor(role?.color) ? role.color : '#888888', style: { width: '46px', height: '30px', padding: '2px', background: 'none', border: '1px solid var(--stroke)', borderRadius: '6px' } });
  const colorText = el('input', { class: 'field mono', style: { width: '110px' }, value: role?.color ?? '#888888' });
  colorInput.addEventListener('input', () => { colorText.value = colorInput.value; });
  colorText.addEventListener('input', () => { if (isHexColor(colorText.value)) colorInput.value = colorText.value; });
  const levelInput = el('input', { class: 'field', type: 'number', min: '1', max: '99', value: String(role?.level ?? 2), disabled: !isCreate, style: { width: '90px' } });
  const perms = permChecklist(groups, selected);
  const error = el('div', { class: 'form-error' });

  const body = el('div', {}, [
    el('div', { class: 'kb-note', style: { marginBottom: '10px' } }, isCreate
      ? 'Новая роль создаётся несистемной. Уровень и код после создания не меняются: иерархия (ТЗ §39) защищает от самоповышения.'
      : `Код и уровень роли «${role.code}» неизменяемы; название, цвет и permissions — редактируются.`),
    el('div', { class: 'report-form__title', style: { marginTop: '8px' } }, 'Роль'),
    el('div', { style: { display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '8px' } }, [
      el('label', {}, [el('div', { class: 'answer__label' }, 'Код (латиница, _)'), codeInput]),
      el('label', {}, [el('div', { class: 'answer__label' }, 'Уровень'), levelInput]),
    ]),
    el('label', { style: { display: 'block', marginTop: '8px' } }, [el('div', { class: 'answer__label' }, 'Название'), nameInput]),
    el('div', { style: { display: 'flex', gap: '8px', alignItems: 'flex-end', marginTop: '8px' } }, [
      el('label', {}, [el('div', { class: 'answer__label' }, 'Цвет роли'), colorInput]),
      el('label', { style: { flex: '1' } }, [el('div', { class: 'answer__label' }, 'HEX'), colorText]),
    ]),
    el('div', { class: 'report-form__title', style: { marginTop: '12px' } }, `Permissions (${groups.length ? 'каталог' : 'каталог недоступен'})`),
    perms.node,
    error,
  ]);

  const close = openModal(ctx, {
    title: isCreate ? 'Новая роль' : `Роль ${role.name}`,
    width: 760,
    body,
    footer: [
      el('button', {
        class: 'btn btn--accent',
        onClick: async () => {
          const payload = {
            name: nameInput.value.trim(),
            color: colorText.value.trim(),
            permissions: perms.get(),
          };
          if (isCreate) {
            payload.code = codeInput.value.trim();
            payload.level = Number(levelInput.value || 2);
          }
          if (!payload.name) { error.textContent = 'Укажите название роли'; return; }
          if (!isHexColor(payload.color)) { error.textContent = 'Цвет: HEX вида #RRGGBB'; return; }
          try {
            if (isCreate) await api.post('/api/roles', payload);
            else await api.patch(`/api/roles/${encodeURIComponent(role.code)}`, payload);
            toast(isCreate ? `Роль «${payload.name}» создана` : 'Роль сохранена');
            close();
            ctx.reload();
          } catch (e) { error.textContent = e?.message ?? 'Не удалось сохранить роль'; }
        },
      }, isCreate ? 'Создать' : 'Сохранить'),
      el('button', { class: 'btn btn--ghost', onClick: () => close() }, 'Отмена'),
    ],
  });
}

/** Удаление роли с подтверждением (backend дополнительно проверит права). */
function deleteRole(ctx, role) {
  const body = el('div', {}, [
    el('div', { style: { fontSize: '12.5px', lineHeight: '1.7' } }, [
      'Удалить роль ', el('b', { style: { color: role.color } }, role.name), ` (${role.code})? `,
      'Назначенных пользователей нет; действие попадёт в Audit Log.',
    ]),
  ]);
  const close = openModal(ctx, {
    title: 'Удаление роли',
    width: 460,
    body,
    footer: [
      el('button', {
        class: 'btn btn--danger',
        onClick: async () => {
          try {
            await api.del(`/api/roles/${encodeURIComponent(role.code)}`);
            toast(`Роль «${role.name}» удалена`);
            close();
            ctx.reload();
          } catch (e) { toast(e?.message ?? 'Не удалось удалить роль'); }
        },
      }, 'Удалить'),
      el('button', { class: 'btn btn--ghost', onClick: () => close() }, 'Отмена'),
    ],
  });
}

/* ------------------------------------------------------------------ */
/*  TELEGRAM BOT (раунд 28)                                          */
/* ------------------------------------------------------------------ */

export async function viewTelegram(ctx) {
  const st = await api.get('/api/telegram/status');
  const host = el('div', {});
  host.append(pageHead('Telegram bot', 'Рассылки подписчикам и автоуведомления об обновлениях базы знаний.', [
    el('span', { class: `badge ${st.enabled ? 'badge--accent' : 'badge--danger'}` }, st.enabled ? 'бот активен' : 'бот выключен'),
  ]));

  host.appendChild(card('Статус',
    el('div', { class: 'kv' }, [
      el('dt', {}, 'Бот'), el('dd', { class: 'mono' }, st.username ? `@${st.username}` : '—'),
      el('dt', {}, 'Long-polling'), el('dd', {}, st.polling ? 'активен' : 'остановлен'),
      el('dt', {}, 'Подписчиков'), el('dd', { class: 'num' }, String(st.subscribers ?? 0)),
    ]),
    el('div', { class: 'kb-note', style: { marginTop: '10px' } },
      'Подписчики — пользователи Epic AI с привязанным identity telegram. Рассылка идёт только им.'),
  ));

  const toggle = el('input', { type: 'checkbox', checked: Boolean(st.notifyKbUpdates) });
  toggle.addEventListener('change', async () => {
    try {
      await api.put('/api/telegram/settings', { notifyKbUpdates: toggle.checked });
      toast(toggle.checked ? 'Уведомления об обновлениях включены' : 'Уведомления выключены');
      ctx.reload();
    } catch (e) { toast(e?.message ?? 'Не удалось сохранить'); toggle.checked = !toggle.checked; }
  });
  host.appendChild(card('Автоуведомления',
    el('label', { style: { display: 'flex', gap: '10px', alignItems: 'center', fontSize: '12.5px' } }, [
      toggle,
      el('span', {}, 'Уведомлять подписчиков о новых и изменённых документах базы знаний (после синхронизации и ручного импорта).'),
    ]),
  ));

  const text = el('textarea', { class: 'field selectable', rows: '4', placeholder: 'Текст объявления… например: «Обновление правил сервера, раздел 4.3»' });
  const result = el('div', { class: 'kb-note', style: { marginTop: '8px' } });
  host.appendChild(card('Рассылка',
    text,
    el('div', { style: { display: 'flex', gap: '8px', marginTop: '10px' } }, [
      el('button', {
        class: 'btn btn--accent',
        onClick: async () => {
          const value = text.value.trim();
          if (!value) { toast('Введите текст рассылки'); return; }
          try {
            const r = await api.post('/api/telegram/broadcast', { text: value });
            result.textContent = `Отправлено: ${r.sent}, ошибок: ${r.failed} (подписчиков: ${r.subscribers})`;
            text.value = '';
            ctx.reload();
          } catch (e) { result.textContent = e?.message ?? 'Ошибка рассылки'; }
        },
      }, 'Отправить рассылку'),
    ]),
    result,
  ));

  if ((st.recent ?? []).length) {
    host.appendChild(card('Последние рассылки',
      table(
        [{ label: 'Когда', style: 'width:170px' }, { label: 'Автор', style: 'width:140px' }, { label: 'Текст' }, { label: 'Доставлено', style: 'width:110px' }],
        st.recent,
        (r) => el('tr', {}, [
          el('td', { class: 'num' }, fmtDateTime(r.at)),
          el('td', {}, r.author),
          el('td', {}, r.text),
          el('td', { class: 'num' }, `${r.sent}/${r.sent + r.failed}`),
        ]),
      ),
    ));
  }
  return host;
}

/* ------------------------------------------------------------------ */
/*  PERMISSIONS                                             */
/* ------------------------------------------------------------------ */

export async function viewPermissions(ctx) {
  const m = await api.get('/api/permissions/matrix');
  const perms = await api.get('/api/permissions');
  const host = el('div', {});
  host.append(pageHead('Permissions', 'Матрица «роль × разрешение». Индивидуальные разрешения и запреты назначаются в карточке пользователя.', [
    ctx.can('permissions.manage') ? el('button', { class: 'btn', onClick: async () => {
      try { const r = await api.post('/api/permissions/sync', {}); toast(`Каталог синхронизирован: ${r.total}`); ctx.reload(); } catch (e) { toast(e.message); }
    } }, 'Синхронизировать каталог') : null,
  ]));

  const set = new Set(m.matrix.map((x) => x));
  const matrix = el('div', { class: 'matrix' }, el('table', { class: 'matrix-t' }, [
    el('thead', {}, el('tr', {}, [el('th', { class: 'row-head' }, 'permission'),...m.roles.map((r) => el('th', { style: { color: r.color } }, r.name.split(' ')[0]))])),
    el('tbody', {}, m.permissions.map((p) => el('tr', {}, [
      el('td', { class: 'row-head' }, p.code),
     ...m.roles.map((r) => el('td', {}, set.has(`${r.id}:${p.id}`) ? el('span', { class: 'yes' }, '✓') : el('span', { class: 'no' }, '·'))),
    ]))),
  ]));
  host.appendChild(matrix);

  host.appendChild(el('div', { class: 'card', style: { marginTop: '14px' } }, [
    el('div', { class: 'card__title' }, `Каталог (${perms.items.length})`),
   ...perms.groups.map((g) => el('div', { style: { marginBottom: '10px' } }, [
      el('div', { class: 'section-title', style: { marginBottom: '6px' } }, g.category),
      el('div', { class: 'perm-list' }, g.items.map((p) => el('span', { class: 'perm', title: p.description ?? '' }, p.code))),
    ])),
  ]));
  return host;
}

/* ------------------------------------------------------------------ */
/*  БЛОКИРОВКИ                                              */
/* ------------------------------------------------------------------ */

export async function viewBlocks(ctx) {
  const data = await api.get('/api/users/blocked');
  const host = el('div', {});
  host.append(pageHead('Блокировки', 'Заблокированный пользователь не получает доступ к интерфейсу, не может отправлять запросы, а его сессии инвалидируются. Проверка выполняется на backend.'));
  host.appendChild(table(
    [{ label: 'Пользователь' }, { label: 'Причина' }, { label: 'Когда', style: 'width:160px' }, { label: 'Кем', style: 'width:160px' }, { label: '', style: 'width:150px' }],
    data.items,
    (b) => el('tr', {}, [
      el('td', {}, el('div', { class: 'cell-user' }, [
        avatarNode(b.avatarUrl, b.username, 'avatar'),
        el('div', {}, [el('div', { class: 'name' }, b.username), el('div', { class: 'sub' }, `#${b.id}`)]),
      ])),
      el('td', {}, b.reason ?? el('span', { class: 'subtle' }, 'не указана')),
      el('td', { class: 'num' }, b.blockedAtLabel ?? '—'),
      el('td', {}, b.blockedBy ? `${b.blockedBy.username} (#${b.blockedBy.id})` : '—'),
      el('td', { class: 'actions' }, ctx.can('users.block') ? el('button', { class: 'btn btn--sm btn--accent', onClick: async () => {
        try { await api.patch(`/api/users/${b.id}/status`, { blocked: false }); toast('Разблокирован'); ctx.reload(); } catch (e) { toast(e.message); }
      } }, 'Разблокировать') : null),
    ]),
    { emptyText: 'Заблокированных пользователей нет' },
  ));
  return host;
}

/* ------------------------------------------------------------------ */
/*  AI → ОШИБКИ AI                                           */
/* ------------------------------------------------------------------ */

export async function viewReports(ctx, params = {}) {
  const state = { status: params.status ?? '', limit: 50, offset: 0 };
  const host = el('div', {});
  const listHost = el('div', {});
  const chips = el('div', { class: 'chips' });

  const reload = async () => {
    clear(listHost);
    listHost.appendChild(el('div', { class: 'center', style: { padding: '30px' } }, el('span', { class: 'spinner' })));
    const q = new URLSearchParams({ limit: String(state.limit), offset: String(state.offset) });
    if (state.status) q.set('status', state.status);
    let data;
    try { data = await api.get(`/api/ai/reports?${q.toString()}`); }
    catch (e) { clear(listHost); listHost.appendChild(el('div', { class: 'empty-state' }, e.message)); return; }

    clear(chips);
    chips.append(
      chip('', 'Все', data.counts.all, state.status),
      chip('new', 'Новые', data.counts.new, state.status),
      chip('in_progress', 'На проверке', data.counts.inProgress, state.status),
      chip('resolved', 'Решены', data.counts.resolved, state.status),
    );

    clear(listHost);
    listHost.appendChild(table(
      [{ label: '#' , style: 'width:64px' }, { label: 'Пользователь', style: 'width:190px' }, { label: 'Вопрос' },
       { label: 'Режим', style: 'width:90px' }, { label: 'Причина', style: 'width:210px' },
       { label: 'Статус', style: 'width:130px' }, { label: 'Создан', style: 'width:140px' }],
      data.items,
      (r) => el('tr', { class: 'is-clickable', onClick: () => openReport(ctx, r.id, reload) }, [
        el('td', { class: 'num' }, `#${r.id}`),
        el('td', {}, el('div', { class: 'cell-user' }, [
          avatarNode(r.user?.avatarUrl, r.user?.username, 'avatar'),
          el('div', {}, [el('div', { class: 'name' }, r.user?.username ?? '—'), el('div', { class: 'sub' }, r.user?.role ?? '')]),
        ])),
        el('td', { class: 'ellipsis', style: { maxWidth: '360px' } }, r.question ?? '—'),
        el('td', {}, el('span', { class: 'tag' }, r.mode === 'laws' ? 'ЗАКОНЫ' : 'ПРАВИЛА')),
        el('td', {}, r.categoryLabel),
        el('td', {}, statusPill(r.status)),
        el('td', { class: 'num' }, r.createdAtLabel),
      ]),
      { emptyText: 'Ошибок AI нет — это хорошая новость' },
    ));
    listHost.appendChild(pager(data.total, state.limit, state.offset, (o) => { state.offset = o; void reload(); }));
  };

  function chip(value, label, count, current) {
    return el('button', { class: `chip${current === value ? ' is-active' : ''}`, onClick: () => { state.status = value; state.offset = 0; void reload(); } }, [label, el('b', {}, String(count ?? 0))]);
  }

  host.append(
    pageHead('Ошибки AI', 'Отчёты создаются автоматически после 👎. Карточка показывает полный контекст: пользователя, роль, вопрос, ответ AI, найденные источники, причину и комментарий.', [
      el('button', { class: 'btn', onClick: () => reload() }, 'Обновить'),
    ]),
    el('div', { class: 'toolbar' }, [chips]),
    listHost,
  );
  void reload();
  return host;
}

function statusPill(status) {
  const map = { new: ['badge--danger', 'Новая'], in_progress: ['badge--warning', 'На проверке'], resolved: ['badge--accent', 'Решена'] };
  const [cls, label] = map[status] ?? ['badge', status];
  return el('span', { class: `badge ${cls}` }, label);
}

async function openReport(ctx, id, reload) {
  let r;
  try { r = await api.get(`/api/ai/reports/${id}`); } catch (e) { return toast(e.message); }

  const analysisSel = el('select', { class: 'field', style: { width: '230px' } }, [
    el('option', { value: '' }, '— не определено —'),
    el('option', { value: 'kb_outdated' }, 'Устарела база'),
    el('option', { value: 'search_miss' }, 'Ошибка поиска'),
    el('option', { value: 'ai_error' }, 'Ошибка AI'),
    el('option', { value: 'technical' }, 'Техническая ошибка'),
  ]);
  analysisSel.value = r.analysis ?? '';
  const resolutionInput = el('textarea', { class: 'field selectable', rows: '2', placeholder: 'Что сделано / какое решение принято' }, r.resolution ?? '');
  resolutionInput.value = r.resolution ?? '';

  const body = el('div', { class: 'report-card' }, [
    el('div', { class: 'report-card__head' }, [
      el('span', { class: 'report-id' }, `ОШИБКА AI #${r.id}`),
      statusPill(r.status),
      el('span', { class: 'tag' }, r.modeLabel),
      el('span', { class: 'grow' }),
      el('span', { class: 'subtle mono', style: { fontSize: '10px' } }, `база v${r.kbVersion ?? '—'}`),
    ]),

    el('div', { class: 'grid grid--2' }, [
      el('div', { class: 'report-field' }, [
        el('div', { class: 'report-field__label' }, 'Пользователь'),
        el('div', { class: 'row gap-8' }, r.user
          ? [avatarNode(r.user.avatarUrl, r.user.username, 'avatar'), el('div', {}, [el('div', { style: { fontWeight: '600' } }, r.user.username), el('div', { class: 'subtle', style: { fontSize: '10.5px' } }, `роль: ${r.user.role ?? '—'} · #${r.user.id}`)])]
          : ['—']),
      ]),
      el('div', { class: 'report-field' }, [
        el('div', { class: 'report-field__label' }, 'Дата и время'),
        el('div', { class: 'report-field__value report-field__value--muted mono', style: { fontSize: '11.5px' } }, r.createdAtLabel),
      ]),
    ]),

    field('Вопрос', r.question),
    field('Ответ AI', [
      el('div', { style: { marginBottom: '6px' } }, el('b', { style: { color: verdictColor(r.aiAnswer?.verdict) } }, verdictLabel(r.aiAnswer?.verdict))),
      el('div', {}, r.aiAnswer?.explanation ?? '—'),
      r.aiAnswer?.basis ? el('div', { style: { marginTop: '6px', color: 'var(--text-muted)' } }, [el('b', {}, 'Основание: '), r.aiAnswer.basis]) : null,
      el('div', { class: 'subtle', style: { marginTop: '6px', fontSize: '10px' } }, `модель: ${r.aiAnswer?.provider ?? '—'} / ${r.aiAnswer?.model ?? '—'}`),
    ]),

    el('div', { class: 'report-field' }, [
      el('div', { class: 'report-field__label' }, `Найденные источники (${r.sources?.length ?? 0})`),
      r.sources?.length
        ? el('div', { class: 'report-sources' }, r.sources.map((s, i) => el('div', { class: 'report-source' }, [
            el('div', { class: 'report-source__title' }, `[${i + 1}] ${s.title}`),
            s.heading ? el('div', { class: 'report-source__item' }, s.heading) : null,
            el('div', { class: 'report-source__meta' }, `${s.docType === 'LAW' ? 'закон' : 'правило'} · v${s.version} · редакция ${s.revisionLabel}`),
            el('div', { class: 'report-source__text selectable' }, s.content),
            el('div', { style: { marginTop: '6px' } }, el('button', { class: 'btn btn--sm', onClick: () => openExternal(s.url) }, 'Открыть источник ↗')),
          ])))
        : el('div', { class: 'report-field__value report-field__value--muted' }, 'Источники не найдены — вероятная причина: ошибка поиска или устаревшая база.'),
    ]),

    el('div', { class: 'grid grid--2' }, [
      field('Причина', r.categoryLabel),
      field('Комментарий пользователя', r.comment ?? el('span', { class: 'subtle' }, 'не заполнен')),
    ]),

    ctx.can('ai.reports.manage') ? el('div', { class: 'card' }, [
      el('div', { class: 'card__title' }, 'Обработка '),
      el('div', { class: 'row gap-8', style: { flexWrap: 'wrap' } }, [
        el('span', { class: 'subtle', style: { fontSize: '11px' } }, 'Источник проблемы:'),
        analysisSel,
        el('span', { class: 'subtle', style: { fontSize: '11px' } }, `подсказка системы: ${r.analysisLabel ?? '—'}`),
      ]),
      el('div', { style: { marginTop: '8px' } }, resolutionInput),
      el('div', { class: 'report-actions' }, [
        el('button', { class: 'btn', onClick: () => save('in_progress') }, 'В работу'),
        el('button', { class: 'btn btn--accent', onClick: () => save('resolved') }, 'Решено'),
        el('span', { class: 'grow' }),
        r.handledBy ? el('span', { class: 'subtle', style: { fontSize: '10.5px' } }, `обработал ${r.handledBy.username} · ${fmtDateTime(r.handledAt)}`) : null,
      ]),
    ]) : null,
  ]);

  async function save(status) {
    try {
      await api.patch(`/api/ai/reports/${r.id}`, { status, analysis: analysisSel.value || null, resolution: resolutionInput.value.trim() || null });
      toast('Отчёт обновлён');
      close();
      void reload?.();
    } catch (e) { toast(e.message); }
  }

  const footer = [
    r.sources?.[0]?.url ? el('button', { class: 'btn', onClick: () => openExternal(r.sources[0].url) }, 'Открыть источник') : null,
    ctx.can('ai.reports.manage') ? el('button', { class: 'btn', onClick: () => save('in_progress') }, 'В работу') : null,
    ctx.can('ai.reports.manage') ? el('button', { class: 'btn btn--accent', onClick: () => save('resolved') }, 'Решено') : null,
    el('button', { class: 'btn btn--ghost', onClick: () => close() }, 'Закрыть'),
  ];
  const close = openModal(ctx, { title: `ОШИБКА AI #${r.id}`, body, footer, width: 900 });

  function field(label, value) {
    return el('div', { class: 'report-field' }, [
      el('div', { class: 'report-field__label' }, label),
      el('div', { class: 'report-field__value selectable' }, value),
    ]);
  }
}

function verdictLabel(v) { return { allowed: 'Разрешено', forbidden: 'Запрещено', depends: 'Зависит от обстоятельств', unknown: 'Нет подтверждённых данных' }[v] ?? '—'; }
function verdictColor(v) { return { allowed: 'var(--accent)', forbidden: 'var(--danger)', depends: '#F1C40F', unknown: 'var(--text-muted)' }[v] ?? 'var(--text-muted)'; }

/* ------------------------------------------------------------------ */
/*  KNOWLEDGE BASE                                      */
/* ------------------------------------------------------------------ */

export async function viewKbDocuments(ctx, params = {}) {
  const state = { type: params.type ?? '', search: '', limit: 50, offset: 0 };
  const host = el('div', {});
  const listHost = el('div', {});
  const search = el('input', { class: 'field', type: 'text', placeholder: 'Поиск по названию документа…' });

  const reload = debounce(async () => {
    clear(listHost);
    listHost.appendChild(el('div', { class: 'center', style: { padding: '30px' } }, el('span', { class: 'spinner' })));
    const q = new URLSearchParams({ limit: String(state.limit), offset: String(state.offset) });
    if (state.type) q.set('type', state.type);
    if (state.search) q.set('search', state.search);
    let data;
    try { data = await api.get(`/api/kb/documents?${q.toString()}`); }
    catch (e) { clear(listHost); listHost.appendChild(el('div', { class: 'empty-state' }, e.message)); return; }

    clear(listHost);
    listHost.appendChild(table(
      [{ label: 'Документ' }, { label: 'Тип', style: 'width:90px' }, { label: 'Раздел', style: 'width:220px' },
       { label: 'Версия', style: 'width:90px' }, { label: 'Статус', style: 'width:100px' },
       { label: 'Редакция', style: 'width:150px' }, { label: '', style: 'width:180px' }],
      data.items,
      (d) => el('tr', { class: 'is-clickable', onClick: () => openDocument(ctx, d.id) }, [
        el('td', {}, el('div', {}, [el('div', { style: { fontWeight: '600' } }, d.title), el('div', { class: 'sub', style: { fontSize: '10px', color: 'var(--text-subtle)' } }, `thread #${d.threadId}`)])),
        el('td', {}, el('span', { class: 'tag' }, d.docType === 'LAW' ? 'LAW' : 'RULE')),
        el('td', { class: 'ellipsis', style: { maxWidth: '240px' } }, d.section ?? '—'),
        el('td', { class: 'num' }, `v${d.currentVersion ?? '?'} (${d.versions})`),
        el('td', {}, d.status === 'active' ? el('span', { class: 'badge badge--accent' }, 'active') : el('span', { class: 'badge' }, d.status)),
        el('td', { class: 'num' }, fmtDateTime(d.sourceModifiedAt)),
        el('td', { class: 'actions' }, [
          el('button', { class: 'btn btn--sm', onClick: (e) => { e.stopPropagation(); ctx.go('kb-versions', { documentId: d.id }); } }, 'Версии'),
          el('button', { class: 'btn btn--sm', onClick: (e) => { e.stopPropagation(); void openExternal(d.url); } }, 'Источник ↗'),
        ]),
      ]),
      { emptyText: 'Документов нет. Запустите синхронизацию или добавьте документ вручную.' },
    ));
    listHost.appendChild(pager(data.total, state.limit, state.offset, (o) => { state.offset = o; void reload(); }));
  }, 280);

  search.addEventListener('input', () => { state.search = search.value.trim(); state.offset = 0; void reload(); });

  host.append(
    pageHead('Документы', 'Каждый документ имеет тип RULE или LAW. Архивные документы сохраняются для истории и расследования ошибок, но не участвуют в обычном поиске.', [
      el('button', { class: 'btn', onClick: () => ctx.go('kb-sync') }, 'Синхронизация'),
    ]),
    el('div', { class: 'toolbar' }, [
      search,
      el('div', { class: 'chips' }, [
        chipBtn('', 'Все'), chipBtn('RULE', 'Правила'), chipBtn('LAW', 'Законы'),
      ]),
    ]),
    listHost,
  );

  function chipBtn(value, label) {
    const b = el('button', { class: `chip${state.type === value ? ' is-active' : ''}`, onClick: () => {
      state.type = value; state.offset = 0;
      for (const c of b.parentElement.children) c.classList.remove('is-active');
      b.classList.add('is-active');
      void reload();
    } }, label);
    return b;
  }
  void reload();
  return host;
}

async function openDocument(ctx, id) {
  let d;
  try { d = await api.get(`/api/kb/documents/${id}`); } catch (e) { return toast(e.message); }
  const body = el('div', { style: { display: 'flex', flexDirection: 'column', gap: '12px' } }, [
    el('div', { class: 'row gap-8', style: { flexWrap: 'wrap' } }, [
      el('span', { class: 'tag' }, d.docType === 'LAW' ? 'Закон' : 'Правило'),
      el('span', { class: 'badge' }, `v${d.version ?? '?'}`),
      d.status === 'archive' ? el('span', { class: 'badge badge--warning' }, 'архив') : el('span', { class: 'badge badge--accent' }, 'active'),
      el('span', { class: 'grow' }),
      el('button', { class: 'btn btn--sm', onClick: () => openExternal(d.url) }, 'Открыть источник ↗'),
    ]),
    el('div', { style: { fontSize: '15px', fontWeight: '700' } }, d.title),
    el('dl', { class: 'kv' }, [
      el('dt', {}, 'Раздел'), el('dd', {}, d.section ?? '—'),
      el('dt', {}, 'Категория'), el('dd', {}, d.category ?? '—'),
      el('dt', {}, 'Дата редакции'), el('dd', { class: 'mono' }, fmtDateTime(d.sourceModifiedAt)),
      el('dt', {}, 'Слов'), el('dd', { class: 'mono' }, String(d.wordCount ?? '—')),
      el('dt', {}, 'Версий'), el('dd', { class: 'mono' }, String(d.versions?.length ?? 0)),
    ]),
    el('div', { class: 'report-field' }, [
      el('div', { class: 'report-field__label' }, 'Содержимое актуальной версии'),
      el('div', { class: 'report-field__value selectable', style: { maxHeight: '300px', overflowY: 'auto', fontSize: '12px' } }, d.content ?? '—'),
    ]),
  ]);
  openModal(ctx, { title: `Документ #${d.id}`, body, width: 860, footer: [el('button', { class: 'btn btn--ghost', onClick: () => { document.getElementById('modal-backdrop').hidden = true; } }, 'Закрыть')] });
}

export async function viewKbVersions(ctx, params = {}) {
  const host = el('div', {});
  const docs = await api.get('/api/kb/documents?limit=200');
  const docSel = el('select', { class: 'field', style: { width: '420px' } }, docs.items.map((d) => el('option', { value: String(d.id) }, `${d.title} (v${d.currentVersion ?? '?'} · ${d.versions} версий)`)));
  const out = el('div', { style: { marginTop: '12px' } });

  const load = async () => {
    clear(out);
    out.appendChild(el('div', { class: 'center', style: { padding: '24px' } }, el('span', { class: 'spinner' })));
    const id = Number(docSel.value);
    const versions = (await api.get(`/api/kb/documents/${id}/versions`)).items;
    clear(out);
    out.appendChild(card(`История версий (${versions.length}) — старые версии не удаляются `,
      table([{ label: 'Версия', style: 'width:90px' }, { label: 'Изменение', style: 'width:120px' }, { label: 'Слов', style: 'width:80px' },
             { label: 'Редакция источника', style: 'width:170px' }, { label: 'Загружено', style: 'width:170px' }, { label: '', style: 'width:200px' }],
        versions,
        (v) => el('tr', {}, [
          el('td', { class: 'num' }, `v${v.version}`),
          el('td', {}, v.changeKind === 'NEW' ? el('span', { class: 'badge badge--accent' }, 'NEW') : v.changeKind === 'UPDATED' ? el('span', { class: 'badge badge--warning' }, 'UPDATED') : el('span', { class: 'badge' }, v.changeKind)),
          el('td', { class: 'num' }, String(v.wordCount)),
          el('td', { class: 'num' }, fmtDateTime(v.sourceModifiedAt)),
          el('td', { class: 'num' }, fmtDateTime(v.fetchedAt)),
          el('td', { class: 'actions' }, v.version < versions[0].version ? el('button', { class: 'btn btn--sm', onClick: async () => {
            const res = await api.get(`/api/kb/documents/${id}/diff?from=${v.version}&to=${v.version + 1}`);
            openModal(ctx, { title: `v${v.version} → v${v.version + 1}`, width: 900, body: el('div', {}, [renderDiff(res.diff), legend()]), footer: [el('button', { class: 'btn btn--ghost', onClick: () => { document.getElementById('modal-backdrop').hidden = true; } }, 'Закрыть')] });
          } }, `Сравнить с v${v.version + 1}`) : el('span', { class: 'subtle', style: { fontSize: '10.5px' } }, 'актуальная')),
        ]),
      ),
    ));
  };

  docSel.addEventListener('change', () => void load());
  host.append(pageHead('Версии документов', 'Каждая редакция документа сохраняется как отдельная версия. Сравнение выполняется на уровне слов.'),
    el('div', { class: 'toolbar' }, [docSel]));
  if (params.documentId) docSel.value = String(params.documentId);
  if (docs.items.length) void load();
  return host;
}

function legend() {
  return el('div', { class: 'diff-legend' }, [
    el('span', {}, [el('i', { style: { background: 'var(--danger)' } }), 'удалённый текст']),
    el('span', {}, [el('i', { style: { background: 'var(--accent)' } }), 'добавленный текст']),
  ]);
}

export async function viewKbChanges(ctx, params = {}) {
  const host = el('div', {});
  const history = await api.get('/api/kb/changes/history?limit=90');
  const days = el('div', { class: 'chips' });
  const detailHost = el('div', { style: { marginTop: '12px' } });

  const loadDay = async (day) => {
    for (const c of days.children) c.classList.toggle('is-active', c.dataset.day === day);
    clear(detailHost);
    detailHost.appendChild(el('div', { class: 'center', style: { padding: '30px' } }, el('span', { class: 'spinner' })));
    const data = await Kb.changes(day);
    clear(detailHost);
    if (!data.items.length) { detailHost.appendChild(el('div', { class: 'empty-state' }, `За ${fmtDate(`${day}T12:00:00Z`)} изменений нет`)); return; }

    const list = el('div', { class: 'split__list' });
    const detail = el('div', {});
    const groups = [
      { title: 'Изменения', items: data.items.filter((i) => i.changeKind === 'UPDATED') },
      { title: 'Новые документы', items: data.items.filter((i) => i.changeKind === 'NEW') },
      { title: 'Отправлено в архив', items: data.items.filter((i) => i.changeKind === 'ARCHIVED') },
    ];
    const btns = [];
    for (const g of groups) {
      if (!g.items.length) continue;
      list.appendChild(el('div', { class: 'split__list-group' }, g.title));
      for (const it of g.items) {
        const b = el('button', { class: 'split__list-item', onClick: () => { btns.forEach((x) => x.classList.remove('is-active')); b.classList.add('is-active'); void loadChange(it.id, detail); } }, [
          el('div', {}, it.title),
          el('div', { class: 'meta' }, [
            el('span', { class: 'tag' }, it.docType === 'LAW' ? 'закон' : 'правило'),
            it.changeKind === 'UPDATED' ? el('span', { class: 'tag', style: { color: 'var(--accent)' } }, `±${it.changedWords} ${plural(it.changedWords, 'слово', 'слова', 'слов')}`) : null,
          ]),
        ]);
        btns.push(b);
        list.appendChild(b);
      }
    }
    detailHost.appendChild(el('div', { class: 'split' }, [list, detail]));
    if (btns[0]) btns[0].click();
  };

  for (const d of history.items) {
    days.appendChild(el('button', { class: 'chip', dataset: { day: d.day }, onClick: () => void loadDay(d.day) }, [
      fmtDate(`${d.day}T12:00:00Z`), el('b', {}, d.summary),
    ]));
  }

  host.append(pageHead('Изменения базы знаний', 'Слева — документы, изменившиеся за выбранный день. Справа — «Было / Стало» с цветным diff на уровне слов.'), days, detailHost);

  const initial = params.day ?? history.items[0]?.day;
  if (initial) void loadDay(initial);
  else detailHost.appendChild(el('div', { class: 'empty-state' }, 'Изменений пока нет — база ещё не синхронизировалась.'));
  return host;
}

async function loadChange(changeId, host) {
  clear(host);
  host.appendChild(el('div', { class: 'center', style: { padding: '24px' } }, el('span', { class: 'spinner' })));
  let d;
  try { d = await Kb.change(changeId); } catch (e) { clear(host); host.appendChild(el('div', { class: 'empty-state' }, e.message)); return; }
  clear(host);
  host.appendChild(el('div', { style: { display: 'flex', flexDirection: 'column', gap: '10px' } }, [
    el('div', { class: 'row gap-8', style: { flexWrap: 'wrap' } }, [
      d.isNew ? el('span', { class: 'badge badge--accent' }, '🟢 НОВОЕ') : el('span', { class: 'badge badge--warning' }, `ИЗМЕНЕНО v${d.before?.version ?? '?'} → v${d.after.version}`),
      el('span', { class: 'tag' }, d.document.docType === 'LAW' ? 'Законодательная база' : 'Правила'),
      el('span', { class: 'grow' }),
      el('button', { class: 'btn btn--sm', onClick: () => openExternal(d.document.url) }, 'Открыть источник ↗'),
    ]),
    el('div', { style: { fontSize: '14px', fontWeight: '700' } }, d.document.title),
    el('dl', { class: 'kv' }, [
      el('dt', {}, 'Раздел'), el('dd', {}, d.document.section ?? '—'),
      el('dt', {}, 'Дата редакции'), el('dd', { class: 'mono' }, fmtDateTime(d.document.sourceModifiedAt)),
      el('dt', {}, 'Изменено слов'), el('dd', { class: 'mono' }, String(d.change.changedWords)),
    ]),
    d.isNew
      ? el('div', { class: 'report-field' }, [el('div', { class: 'report-field__label' }, 'Полный текст нового документа'), el('div', { class: 'diff-view selectable', style: { color: 'var(--accent)' } }, d.after.text)])
      : el('div', { class: 'report-field' }, [el('div', { class: 'report-field__label' }, 'Было / Стало'), renderDiff(d.diff), legend()]),
  ]));
}

export async function viewKbSync(ctx) {
  const host = el('div', {});
  const [status, logsRes] = await Promise.all([Kb.status(), api.get('/api/kb/sync/logs?limit=30')]);
  const logs = logsRes.items;

  host.append(
    pageHead('Синхронизация', `Автоматическая синхронизация forum.epic-gta.com каждые ${status.intervalMinutes} минут. Crawler работает на backend, соблюдает robots.txt и не обходит технические ограничения сайта.`, [
      ctx.can('knowledge.sync') ? el('button', { class: 'btn btn--accent', onClick: async (e) => {
        const b = e.currentTarget; b.disabled = true; b.textContent = 'Запуск…';
        try { await Kb.sync(false); toast('Синхронизация запущена'); setTimeout(() => ctx.reload(), 2500); }
        catch (err) { toast(err.message); b.disabled = false; b.textContent = 'Обновить базу'; }
      } }, 'Обновить базу') : null,
    ]),

    el('div', { class: 'grid grid--4' }, [
      stat(status.documents.active, 'Документов', `${status.documents.rules} правил · ${status.documents.laws} законов`, 'var(--accent)'),
      stat(status.versions, 'Версий', 'старые версии сохраняются'),
      stat(status.chunks, 'Фрагментов', 'участвуют в поиске'),
      stat(`${status.today.newCount + status.today.updatedCount}`, 'Изменений сегодня', `${status.today.newCount} новых · ${status.today.updatedCount} изменено`),
    ]),

    el('div', { class: 'card', style: { marginTop: '12px' } }, [
      el('div', { class: 'card__title' }, 'Состояние'),
      el('div', { class: 'row gap-8', style: { marginBottom: '10px' } }, [
        el('span', { style: { width: '10px', height: '10px', borderRadius: '50%', background: status.stateColor, boxShadow: `0 0 12px ${status.stateColor}` } }),
        el('b', { style: { color: status.stateColor } }, status.stateLabel),
        el('span', { class: 'subtle' }, `· обновлено ${status.lastSyncLabel}`),
        status.nextSyncAt ? el('span', { class: 'subtle' }, `· следующая ${fmtDateTime(status.nextSyncAt)}`) : null,
      ]),
      status.lastError ? el('div', { class: 'notice notice--warn' }, [el('div', {}, [el('b', {}, 'Ошибка: '), status.lastError])]) : null,
      status.crawlerEnabled === false ? el('div', { class: 'notice', style: { marginTop: '8px' } }, [el('div', {}, [
        el('b', {}, 'Crawler отключён. '),
        document.createTextNode('Автоматический обход forum.epic-gta.com выключен: robots.txt форума запрещает доступ AI-краулерам. Порядок согласования и альтернативы (официальный XenForo REST API, ручной импорт) описаны в docs/LEGAL.md. Ручной импорт документов доступен через POST /api/kb/ingest.'),
      ])]) : null,
    ]),

    el('div', { class: 'card', style: { marginTop: '12px' } }, [
      el('div', { class: 'card__title' }, 'Журнал синхронизаций'),
      table([{ label: 'Начало', style: 'width:160px' }, { label: 'Триггер', style: 'width:90px' }, { label: 'Статус', style: 'width:100px' },
             { label: 'Новых', style: 'width:80px' }, { label: 'Изменено', style: 'width:100px' }, { label: 'В архив', style: 'width:90px' },
             { label: 'Страниц', style: 'width:90px' }, { label: 'Ошибка' }],
        logs,
        (l) => el('tr', {}, [
          el('td', { class: 'num' }, fmtDateTime(l.startedAt)),
          el('td', {}, el('span', { class: 'tag' }, l.triggerType)),
          el('td', {}, l.status === 'success' ? el('span', { class: 'badge badge--accent' }, 'success') : l.status === 'error' ? el('span', { class: 'badge badge--danger' }, 'error') : el('span', { class: 'badge badge--mid' }, 'running')),
          el('td', { class: 'num' }, String(l.docsNew)),
          el('td', { class: 'num' }, String(l.docsUpdated)),
          el('td', { class: 'num' }, String(l.docsArchived)),
          el('td', { class: 'num' }, String(l.pagesFetched)),
          el('td', { class: 'ellipsis', style: { maxWidth: '300px', color: 'var(--danger)' } }, l.error ?? ''),
        ]),
        { emptyText: 'Синхронизаций ещё не было' }),
    ]),
  );
  return host;
}

/* ------------------------------------------------------------------ */
/*  AUDIT LOG                                                   */
/* ------------------------------------------------------------------ */

export async function viewAudit(ctx, params = {}) {
  const state = { search: params.search ?? '', action: '', limit: 100, offset: 0 };
  const host = el('div', {});
  const listHost = el('div', {});
  const search = el('input', { class: 'field', type: 'text', placeholder: 'Поиск по действию, пользователю или данным…', value: state.search });

  let actions = [];
  try { actions = (await api.get('/api/audit-logs/actions')).items; } catch { /* ignore */ }
  const actionSel = el('select', { class: 'field', style: { width: '260px' } }, [el('option', { value: '' }, 'Все действия'),...actions.map((a) => el('option', { value: a.action }, `${a.action} (${a.count})`))]);

  const reload = debounce(async () => {
    clear(listHost);
    listHost.appendChild(el('div', { class: 'center', style: { padding: '30px' } }, el('span', { class: 'spinner' })));
    const q = new URLSearchParams({ limit: String(state.limit), offset: String(state.offset) });
    if (state.search) q.set('search', state.search);
    if (state.action) q.set('action', state.action);
    let data;
    try { data = await api.get(`/api/audit-logs?${q.toString()}`); }
    catch (e) { clear(listHost); listHost.appendChild(el('div', { class: 'empty-state' }, e.message)); return; }
    clear(listHost);
    listHost.appendChild(table(
      [{ label: 'Время', style: 'width:160px' }, { label: 'Действие', style: 'width:210px' }, { label: 'Кто', style: 'width:170px' },
       { label: 'Объект', style: 'width:170px' }, { label: 'Данные' }],
      data.items,
      (a) => el('tr', {}, [
        el('td', { class: 'num' }, fmtDateTime(a.createdAt)),
        el('td', {}, el('span', { class: 'perm' }, a.action)),
        el('td', {}, a.actorName ?? el('span', { class: 'subtle' }, 'система')),
        el('td', {}, a.entityType ? `${a.entityType} #${a.entityId ?? ''}` : '—'),
        el('td', { class: 'num ellipsis', style: { maxWidth: '380px' } }, a.meta ? JSON.stringify(a.meta) : ''),
      ]),
      { emptyText: 'Записей нет' },
    ));
    listHost.appendChild(pager(data.total, state.limit, state.offset, (o) => { state.offset = o; void reload(); }));
  }, 280);

  search.addEventListener('input', () => { state.search = search.value.trim(); state.offset = 0; void reload(); });
  actionSel.addEventListener('change', () => { state.action = actionSel.value; state.offset = 0; void reload(); });

  host.append(
    pageHead('Audit Log', 'Журнал критических действий: вход, выход, блокировка, смена роли, выдача и снятие permissions, изменение системных настроек, ручная синхронизация, изменения базы, обработка AI Report. Журнал доступен только для чтения — изменить его через интерфейс нельзя.'),
    el('div', { class: 'toolbar' }, [search, actionSel]),
    listHost,
  );
  void reload();
  return host;
}

/* ------------------------------------------------------------------ */
/*  SYSTEM                                                              */
/* ------------------------------------------------------------------ */

export async function viewSystem(ctx) {
  const host = el('div', {});
  const settings = (await api.get('/api/settings/system')).items;
  const health = await fetch(`${ctx.backendUrl}/api/health`).then((r) => r.json()).catch(() => null);

  const intervalInput = el('input', { class: 'field', type: 'number', min: '5', max: '1440', style: { width: '110px' } });
  const current = settings.find((s) => s.key === 'sync.interval_minutes');
  intervalInput.value = String(current?.value ?? 30);

  host.append(
    pageHead('System', 'Серверные настройки и диагностика. Эти параметры применяются ко всем клиентам Epic AI.', [
      el('button', { class: 'btn', onClick: async () => {
        try {
          await api.put('/api/settings/system', { key: 'sync.interval_minutes', value: Number(intervalInput.value) });
          toast('Интервал синхронизации сохранён'); ctx.reload();
        } catch (e) { toast(e.message); }
      } }, 'Сохранить интервал'),
    ]),

    el('div', { class: 'grid grid--2' }, [
      card('Синхронизация',
        el('div', { class: 'opt' }, [
          el('div', { class: 'opt__label' }, [el('div', { class: 'opt__name' }, 'Интервал автоматической синхронизации'), el('div', { class: 'opt__desc' }, 'Минут. По умолчанию 30 ')]),
          el('div', { class: 'opt__control' }, [intervalInput, el('span', { class: 'subtle' }, 'мин')]),
        ]),
        el('div', { class: 'table-wrap', style: { marginTop: '10px' } }, el('table', { class: 'data' }, [
          el('thead', {}, el('tr', {}, [el('th', {}, 'Ключ'), el('th', {}, 'Значение'), el('th', {}, 'Обновлено')])),
          el('tbody', {}, settings.map((s) => el('tr', {}, [
            el('td', { class: 'num' }, s.key),
            el('td', {}, String(s.value)),
            el('td', { class: 'num' }, fmtDateTime(s.updatedAt)),
          ]))),
        ])),
      ),
      card('Диагностика',
        el('dl', { class: 'kv' }, [
          el('dt', {}, 'Сервис'), el('dd', { class: 'mono' }, health ? `${health.service} v${health.version}` : 'недоступен'),
          el('dt', {}, 'Окружение'), el('dd', { class: 'mono' }, health?.env ?? '—'),
          el('dt', {}, 'БД'), el('dd', { class: 'mono' }, health ? `${health.db.driver} / ${health.db.engine} — ${health.db.status}` : '—'),
          el('dt', {}, 'AI'), el('dd', { class: 'mono' }, health ? `${health.ai.provider} · ${health.ai.model}` : '—'),
          el('dt', {}, 'Crawler'), el('dd', { class: 'mono' }, health ? `${health.crawler.enabled ? 'включён' : 'выключен'} · robots: ${health.crawler.respectRobots ? 'соблюдается' : 'игнорируется'}` : '—'),
          el('dt', {}, 'Время'), el('dd', { class: 'mono' }, health?.time ?? '—'),
        ]),
        el('div', { class: 'notice notice--info', style: { marginTop: '10px' } }, [el('div', {}, [
          el('b', {}, 'Безопасность. '),
          document.createTextNode('Ключи AI, OAuth-секреты Discord и Telegram, а также доступы к БД хранятся только на backend. Electron-клиент получает лишь адрес API.'),
        ])]),
      ),
    ]),

    ctx.can('system.manage') ? card('Логи встроенного backend') : null,
    ctx.can('system.manage') ? el('pre', { class: 'diff-view selectable', id: 'backend-logs', style: { marginTop: '8px', fontSize: '10.5px', maxHeight: '220px' } }, 'загрузка…') : null,
  );

  if (ctx.can('system.manage')) {
    const logs = await window.epicAI?.invoke('epic:backend:logs').catch(() => null);
    const pre = host.querySelector('#backend-logs');
    if (pre) pre.textContent = Array.isArray(logs) && logs.length ? logs.join('\n') : 'Логи отсутствуют (backend запущен отдельно от Electron).';
  }
  return host;
}
