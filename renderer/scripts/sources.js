/**
 * EPIC AI — окно источников.
 *
 * Отдельный BrowserWindow справа от основной панели. Показывает:
 * найденные статьи, пункты, подпункты, название документа, категорию,
 * дату редакции и ссылку на оригинал («Открыть источник ↗»).
 *
 * Все эти данные приходят с backend'а из базы источников — AI их не формирует.
 */
import { el, clear, $, fmtDateTime, highlight, openExternal } from './util.js';
import { Ai, setBackendUrl, initAuth } from './api.js';
import { applyVisualSettings } from './settings.js';

let payload = null;

async function boot() {
  // Токен сессии — до первых запросов к API (file:// не отправляет cookie)
  await initAuth();
  const runtime = await window.epicAI?.invoke('epic:runtime').catch(() => null);
  if (runtime?.backendUrl) setBackendUrl(runtime.backendUrl);
  if (runtime?.settings) applyVisualSettings(runtime.settings);

  window.epicAI?.on('settings:changed', applyVisualSettings);
  window.epicAI?.on('sources:data', (data) => { payload = data; render(data); });

  $('#src-close').addEventListener('click', () => window.epicAI?.invoke('epic:sources:close').catch(() => window.close()));
  $('#src-refresh').addEventListener('click', async () => {
    if (!payload?.requestId) return;
    try {
      const fresh = await Ai.sources(payload.requestId);
      payload = {...payload, sources: fresh.sources ?? payload.sources };
      render(payload);
    } catch (e) { /* offline */ }
  });

  // Данные могут прийти до подписки — запросим сами
  const q = new URLSearchParams(location.search);
  const requestId = q.get('requestId');
  if (!requestId && window.__DEMO_SOURCES_PAYLOAD__) {
    payload = window.__DEMO_SOURCES_PAYLOAD__;
    render(payload);
    return;
  }
  if (requestId) {
    try {
      const data = await Ai.sources(requestId);
      payload = {...data, modeLabel: data.mode === 'laws' ? 'ЗАКОНЫ' : 'ПРАВИЛА' };
      render(payload);
    } catch { /* ждём sources:data */ }
  }
}

function render(data) {
  const list = $('#src-list');
  clear(list);

  $('#src-mode').textContent = data.modeLabel ?? (data.mode === 'laws' ? 'ЗАКОНЫ' : 'ПРАВИЛА');
  $('#src-count').textContent = String(data.sources?.length ?? 0);
  clear($('#src-question'));
  $('#src-question').append(
    el('b', {}, 'Запрос: '),
    document.createTextNode(data.question ?? '—'),
  );
  $('#src-meta').textContent = [
    data.kbVersion ? `база v${data.kbVersion}` : null,
    data.generatedAt ? `сформировано ${fmtDateTime(data.generatedAt)}` : null,
  ].filter(Boolean).join(' · ');

  if (data.noData || !data.sources?.length) {
    list.appendChild(el('div', { class: 'src-nodata' }, [
      el('b', {}, 'В официальной базе EpicRP не найдено подтверждённой информации для однозначного ответа.'),
      el('div', { style: { marginTop: '6px' } }, 'Система не придумывает правила и статьи: если официального источника нет, ответа нет. Попробуйте переформулировать запрос или проверить другой режим (ПРАВИЛА / ЗАКОНЫ).'),
    ]));
  }

  const terms = collectTerms(data.question);
  for (const s of data.sources ?? []) list.appendChild(sourceCard(s, terms));

  if (data.relatedDocuments?.length) {
    list.appendChild(el('div', { class: 'src-related' }, [
      el('div', { class: 'src-related__title' }, 'Возможно, относится к запросу'),
     ...data.relatedDocuments.map((d) => el('div', { class: 'src-related__item' }, [
        el('span', { style: { color: 'var(--accent-mid)' } }, '•'),
        el('span', {}, d.title),
      ])),
    ]));
  }
}

function sourceCard(s, terms) {
  const kindLabel = s.docType === 'LAW' ? 'Закон' : 'Правило';
  const kindClass = s.docType === 'LAW' ? 'badge' : 'badge badge--mid';

  return el('article', { class: 'src-card' }, [
    el('div', { class: 'src-card__head' }, [
      el('span', { class: 'src-card__num' }, String(s.index + 1)),
      el('div', { class: 'src-card__titles' }, [
        el('div', { class: 'src-card__doc' }, s.title),
        s.heading ? el('div', { class: 'src-card__item' }, s.heading) : null,
      ]),
      el('span', { class: `${kindClass} src-card__kind` }, kindLabel),
    ]),

    el('div', { class: 'src-card__meta' }, [
      s.category ? el('span', {}, [el('b', {}, 'Категория: '), s.category]) : null,
      s.section ? el('span', { class: 'ellipsis', style: { maxWidth: '100%' } }, [el('b', {}, 'Раздел: '), s.section]) : null,
      el('span', {}, [el('b', {}, 'Дата редакции: '), el('span', { class: 'mono' }, s.revisionLabel || '—')]),
      el('span', {}, [el('b', {}, 'Версия: '), el('span', { class: 'mono' }, `v${s.version}`)]),
      el('span', {}, [el('b', {}, 'Тема: '), el('span', { class: 'mono' }, `#${s.threadId}`)]),
    ]),

    el('div', { class: 'src-card__text selectable' }, highlight(s.content, terms)),

    el('div', { class: 'src-card__foot' }, [
      el('a', {
        class: 'src-open', href: s.url, title: s.url,
        onClick: (e) => { e.preventDefault(); void openExternal(s.url); },
      }, [
        document.createTextNode('Открыть источник'),
        el('span', { html: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M7 17L17 7M9 7h8v8"/></svg>', style: { display: 'inline-flex', width: '11px', height: '11px' } }),
      ]),
      el('span', { class: 'grow' }),
      el('span', { class: 'subtle', style: { fontSize: '9.5px' } }, `forum.epic-gta.com`),
    ]),
  ]);
}

/** Слова запроса — для подсветки найденного. */
function collectTerms(question) {
  return [...new Set(
    String(question ?? '').toLowerCase().match(/[a-zа-яё0-9]{3,}/gi) ?? [],
  )].slice(0, 24);
}

let __booted = false;
function __start() {
  if (__booted) return;   // защита от повторного запуска (double DOMContentLoaded)
  __booted = true;
  void boot();
}
if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', __start);
else __start();
