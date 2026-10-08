/**
 * EPIC AI — просмотр базы знаний: обновления за день и история изменений.
 *
 * По требованию пользователя кнопки «Посмотреть» и «История изменений»
 * раскрывают базу знаний ВНУТРИ панели (pane-kb в main.html: список изменений
 * за день слева с фильтрами-чипами, «было / стало» с цветным diff справа),
 * ВНЕ настроек. Админка ре-использует renderDiff для word-level сравнения.
 */
import { el, clear, fmtDateTime, fmtDate, plural, openExternal } from './util.js';
import { Kb } from './api.js';

/* ------------------------------------------------------------------ */
/*  Обновления за день                                     */
/* ------------------------------------------------------------------ */

/**
 * @param {string|null} day ISO-день (YYYY-MM-DD) или null = сегодня
 * @param {{onDay?: (day: string|null) => void}} [opts]
 */
export function buildUpdatesView(day, opts = {}) {
  const wrap = el('div', { style: { display: 'flex', flexDirection: 'column', height: '100%', minHeight: '0' } });
  const shell = el('div', { class: 'upd-shell' });
  const left = el('div', { class: 'upd-left' }, [el('div', { class: 'empty', style: { flex: '1' } }, [el('span', { class: 'spinner' })])]);
  const detail = el('div', { class: 'upd-detail selectable' }, [el('div', { class: 'empty' }, [el('span', { class: 'spinner' })])]);
  shell.append(left, detail);
  wrap.appendChild(shell);
  void loadUpdates(left, detail, day ?? null, opts);
  return wrap;
}

/** Сегодняшний день в ISO (YYYY-MM-DD) — для заголовка «Изменения правил». */
function todayIso() { return new Date().toISOString().slice(0, 10); }

async function loadUpdates(left, detail, day, opts) {
  let data;
  try { data = day ? await Kb.changes(day) : await Kb.today(); }
  catch (e) { clear(left); left.appendChild(el('div', { class: 'empty', style: { flex: '1' } }, e.message ?? 'База недоступна')); return; }

  const counts = data.counts ?? {};
  const total = (counts.new ?? 0) + (counts.updated ?? 0) + (counts.archived ?? 0);
  const filters = [
    { id: 'all', label: 'все', count: total },
    { id: 'UPDATED', label: 'изменены', count: counts.updated ?? 0 },
    { id: 'NEW', label: 'новые', count: counts.new ?? 0 },
    { id: 'ARCHIVED', label: 'архив', count: counts.archived ?? 0 },
  ];
  let filter = 'all';

  const list = el('div', { class: 'upd-list' });
  const chips = el('div', { class: 'upd-chips' });

  clear(left);
  left.append(
    el('div', { class: 'upd-head' }, [
      el('div', { class: 'set-title', style: { margin: '0' } }, 'Изменения правил'),
      el('span', { class: 'upd-head__date' }, fmtDate(`${(day ?? todayIso())}T12:00:00Z`)),
      el('span', { class: 'grow' }),
      day ? el('button', { class: 'btn btn--ghost btn--sm', type: 'button', onClick: () => opts.onDay?.(null) }, 'Сегодня') : null,
    ]),
    chips,
    list,
  );

  if (!data.items?.length) {
    chips.hidden = true;
    list.remove();
    left.appendChild(el('div', { class: 'empty', style: { flex: '1' } }, [
      el('div', {}, 'Изменений за этот день нет'),
      el('div', { class: 'subtle', style: { fontSize: '10.5px' } }, 'База обновляется при запуске приложения и по расписанию; новые редакции появятся здесь.'),
    ]));
    clear(detail);
    detail.appendChild(el('div', { class: 'empty' }, 'Выберите изменение слева'));
    return;
  }

  function drawChips() {
    clear(chips);
    for (const f of filters) {
      if (f.id !== 'all' && !f.count) continue;
      const b = el('button', {
        class: `upd-chip${filter === f.id ? ' is-active' : ''}`, type: 'button',
        onClick: () => { filter = f.id; drawChips(); drawList(); },
      }, [el('i', {}), `${f.label} ${f.count}`]);
      chips.appendChild(b);
    }
  }

  function drawList() {
    clear(list);
    const items = filter === 'all' ? data.items : data.items.filter((i) => i.changeKind === filter);
    if (!items.length) {
      list.appendChild(el('div', { class: 'empty' }, 'Нет событий этого типа'));
      return;
    }
    const groups = [
      { title: 'Изменён пункт', kind: 'UPDATED', items: items.filter((i) => i.changeKind === 'UPDATED') },
      { title: 'Новый пункт', kind: 'NEW', items: items.filter((i) => i.changeKind === 'NEW') },
      { title: 'Отправлено в архив', kind: 'ARCHIVED', items: items.filter((i) => i.changeKind === 'ARCHIVED') },
    ];
    const btns = [];
    for (const g of groups) {
      if (!g.items.length) continue;
      list.appendChild(el('div', { class: 'upd-group' }, [
        el('span', {}, g.title),
        el('span', { class: 'upd-group__count' }, String(g.items.length)),
      ]));
      for (const it of g.items) {
        const b = el('button', {
          class: 'upd-item', type: 'button',
          onClick: () => { btns.forEach((x) => x.classList.remove('is-active')); b.classList.add('is-active'); void loadChangeDetail(detail, it.id); },
        }, [
          el('div', {}, it.title),
          el('div', { class: 'meta' }, [
            it.changeKind === 'UPDATED' ? el('span', { class: 'badge', style: { color: 'var(--accent)', height: '17px' } }, `±${it.changedWords ?? 0} сл.`) : null,
            el('span', { class: 'badge', style: { textTransform: 'none', height: '17px' } }, it.docType === 'LAW' ? 'закон' : 'правило'),
          ]),
        ]);
        btns.push(b);
        list.appendChild(b);
      }
    }
    if (btns[0]) btns[0].click();
  }

  drawChips();
  drawList();
}

async function loadChangeDetail(container, changeId) {
  clear(container);
  container.appendChild(el('div', { class: 'empty' }, [el('span', { class: 'spinner' })]));
  let d;
  try { d = await Kb.change(changeId); } catch (e) { clear(container); container.appendChild(el('div', { class: 'empty' }, e.message ?? 'Не удалось загрузить редакцию')); return; }

  clear(container);
  container.appendChild(el('div', { style: { display: 'flex', flexDirection: 'column', gap: '11px' } }, [
    el('div', { style: { display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' } }, [
      d.isNew ? el('span', { class: 'badge badge--accent' }, '🟢 новое правило') : el('span', { class: 'badge', style: { color: 'var(--warning)' } }, `изменено · v${d.before?.version ?? '?'} → v${d.after.version}`),
      !d.isNew && d.diff ? el('span', { class: 'badge', style: { color: 'var(--accent)', textTransform: 'none' } }, `добавлено ${wc(d.diff.addedText)}`) : null,
      !d.isNew && d.diff ? el('span', { class: 'badge', style: { color: 'var(--danger)', textTransform: 'none' } }, `убрано ${wc(d.diff.removedText)}`) : null,
      el('span', { class: 'badge', style: { textTransform: 'none' } }, d.document.docType === 'LAW' ? 'законодательная база' : 'правила'),
      el('span', { class: 'grow' }),
      el('button', { class: 'btn btn--sm', type: 'button', onClick: () => openExternal(d.document.url) }, 'Открыть источник ↗'),
    ]),
    el('div', { class: 'set-title', style: { margin: '0' } }, d.document.title),
    d.document.section ? el('div', { class: 'set-sub', style: { margin: '-6px 0 0' } }, d.document.section) : null,
    el('div', { class: 'kv' }, [
      el('dt', {}, 'Дата редакции'), el('dd', { class: 'mono' }, fmtDateTime(d.document.sourceModifiedAt)),
      el('dt', {}, 'Дата создания'), el('dd', { class: 'mono' }, fmtDateTime(d.document.sourceCreatedAt)),
      el('dt', {}, 'Изменено слов'), el('dd', { class: 'mono' }, String(d.change.changedWords)),
    ]),
    d.isNew
      ? el('div', {}, [
          el('div', { class: 'answer__label', style: { marginBottom: '6px' } }, 'Полный текст'),
          el('div', { class: 'diff-view selectable', style: { color: 'var(--accent)' } }, d.after.text),
        ])
      : el('div', {}, [
          el('div', { class: 'answer__label', style: { marginBottom: '6px' } }, 'Было / стало'),
          renderDiff(d.diff),
          el('div', { class: 'diff-legend' }, [
            el('span', {}, [el('i', { style: { background: 'var(--danger)' } }), 'удалённый текст']),
            el('span', {}, [el('i', { style: { background: 'var(--accent)' } }), 'добавленный текст']),
          ]),
        ]),
  ]));
}

/** Количество слов в тексте diff-фрагмента. */
function wc(text) {
  const m = String(text ?? '').trim().match(/[\p{L}\p{N}]+/gu);
  return m ? m.length : 0;
}

/** Цветной word-level diff : 🔴 #E74C3C, 🟢 #ACE72E. */
export function renderDiff(diff) {
  const box = el('div', { class: 'diff-view selectable' });
  if (!diff?.ops?.length) { box.appendChild(el('div', { class: 'subtle' }, 'Изменений нет')); return box; }
  for (const op of diff.ops) {
    if (op.kind === 'equal') box.appendChild(document.createTextNode(op.text));
    else if (op.kind === 'del') box.appendChild(el('span', { style: { color: '#fff', background: 'rgba(231,76,60,.28)', textDecoration: 'line-through', textDecorationColor: 'rgba(231,76,60,.85)', borderRadius: '3px', padding: '0 1px' } }, op.text));
    else box.appendChild(el('span', { style: { color: '#000', background: 'var(--accent)', borderRadius: '3px', padding: '0 2px', fontWeight: '600' } }, op.text));   // 'ins'
  }
  return box;
}

/* ------------------------------------------------------------------ */
/*  История изменений по дням                                  */
/* ------------------------------------------------------------------ */

/** @param {{onOpenDay?: (day: string) => void}} [opts] */
export function buildHistoryView(opts = {}) {
  const wrap = el('div', { style: { display: 'flex', flexDirection: 'column', height: '100%', minHeight: '0' } });
  wrap.appendChild(el('div', { style: { display: 'flex', alignItems: 'center', gap: '10px', marginBottom: '12px' } }, [
    el('div', { class: 'set-title', style: { margin: '0' } }, 'История изменений'),
    el('span', { class: 'grow' }),
    el('span', { class: 'subtle', style: { fontSize: '10.5px' } }, 'Выберите день, чтобы посмотреть редакции'),
  ]));
  const list = el('div', { class: 'kb-hist' }, [el('div', { class: 'empty' }, [el('span', { class: 'spinner' })])]);
  wrap.appendChild(list);
  void (async () => {
    let data;
    try { data = await Kb.history(90); } catch (e) { clear(list); list.appendChild(el('div', { class: 'empty' }, e.message ?? 'База недоступна')); return; }
    clear(list);
    if (!data.items?.length) {
      list.appendChild(el('div', { class: 'empty' }, [
        el('div', {}, 'История пуста'),
        el('div', { class: 'subtle', style: { fontSize: '10.5px' } }, 'После первой синхронизации здесь появятся дни с изменениями документов.'),
      ]));
      return;
    }
    for (const d of data.items) {
      list.appendChild(el('div', { class: 'kb-hist__row' }, [
        el('div', { class: 'kb-hist__date' }, fmtDate(`${d.day}T12:00:00Z`)),
        el('div', { class: 'kb-hist__sum' }, d.summary),
        el('button', { class: 'btn btn--sm', type: 'button', onClick: () => opts.onOpenDay?.(d.day) }, 'Открыть'),
      ]));
    }
  })();
  return wrap;
}
