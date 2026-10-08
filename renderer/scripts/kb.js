/**
 * EPIC AI — окно базы знаний (открывается кнопками «Посмотреть» и
 * «История изменений» из настроек, ТЗ §23–§26: ВНЕ панели настроек).
 *
 * Вкладки: «Обновления» (правки за день + diff) и «История изменений» (дни).
 */
import { clear, $ } from './util.js';
import { setBackendUrl, initAuth } from './api.js';
import { buildUpdatesView, buildHistoryView } from './kbview.js';

const state = { tab: 'updates', day: null };

function render() {
  const root = $('#kb-root');
  clear(root);
  const isUpd = state.tab === 'updates';
  $('#tab-updates').classList.toggle('is-active', isUpd);
  $('#tab-updates').setAttribute('aria-selected', String(isUpd));
  $('#tab-history').classList.toggle('is-active', !isUpd);
  $('#tab-history').setAttribute('aria-selected', String(!isUpd));

  root.appendChild(isUpd
    ? buildUpdatesView(state.day, { onDay: (day) => { state.day = day; render(); } })
    : buildHistoryView({ onOpenDay: (day) => { state.day = day; state.tab = 'updates'; render(); } }));
}

async function boot() {
  await initAuth();
  const runtime = await window.epicAI?.invoke('epic:runtime').catch(() => null);
  if (runtime?.backendUrl) setBackendUrl(runtime.backendUrl);

  $('#tab-updates').addEventListener('click', () => { state.tab = 'updates'; render(); });
  $('#tab-history').addEventListener('click', () => { state.tab = 'history'; render(); });
  $('#kb-close').addEventListener('click', () => {
    // frameless-окно закрываем через IPC-независимый window.close()
    window.close();
  });

  window.epicAI?.on('kb:tab', (payload) => {
    if (!payload) return;
    state.tab = payload.tab === 'history' ? 'history' : 'updates';
    state.day = typeof payload.day === 'string' ? payload.day : null;
    render();
  });

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
