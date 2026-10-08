/**
 * EPIC AI — окно истории ответов.
 *
 * По требованию пользователя «Ответы ИИ» убраны из настроек: история
 * открывается ОТДЕЛЬНЫМ окном в том же стиле и месте, что и окно
 * найденных источников (справа от панели). Клик по записи — основной
 * панель открывается этот ответ вместе с окном источников.
 */
import { el, clear, $, fmtDateTime, toast } from './util.js';
import { Ai, setBackendUrl, initAuth } from './api.js';
import { applyVisualSettings } from './settings.js';

const COLORS = { allowed: 'var(--accent)', forbidden: 'var(--danger)', depends: '#F1C40F', unknown: 'var(--text-subtle)' };
const LABELS = { allowed: 'разрешено', forbidden: 'запрещено', depends: 'зависит', unknown: 'нет данных' };

async function load() {
  const root = $('#hist-root');
  clear(root);
  root.appendChild(el('div', { class: 'empty' }, [el('span', { class: 'spinner' })]));
  let items = [];
  try { items = (await Ai.history(60)).items ?? []; }
  catch (e) {
    clear(root);
    root.appendChild(el('div', { class: 'empty' }, e?.message ?? 'История недоступна'));
    return;
  }
  clear(root);
  if (!items.length) {
    root.appendChild(el('div', { class: 'empty' }, [
      el('div', {}, 'Истории пока нет'),
      el('div', { class: 'subtle', style: { fontSize: '10.5px' } }, 'Задайте первый вопрос в панели — ответ появится здесь.'),
    ]));
    return;
  }
  for (const it of items) {
    root.appendChild(el('button', {
      class: 'hist-item', type: 'button',
      title: 'Открыть ответ в панели',
      onClick: () => {
        window.epicAI?.invoke('epic:history:pick', it.requestId)
         .catch((e) => toast(e?.message ?? 'Не удалось открыть ответ'));
      },
    }, [
      el('span', { class: 'verdict-dot', style: { background: COLORS[it.verdict] ?? COLORS.unknown }, title: LABELS[it.verdict] ?? '' }),
      el('span', { class: 'hist-item__q' }, it.question),
      el('span', { class: 'hist-item__meta' }, [
        el('span', { class: 'badge', style: { textTransform: 'none' } }, it.mode === 'laws' ? 'законы' : 'правила'),
        el('span', {}, fmtDateTime(it.createdAt)),
      ]),
    ]));
  }
}

async function boot() {
  await initAuth();
  const runtime = await window.epicAI?.invoke('epic:runtime').catch(() => null);
  if (runtime?.backendUrl) setBackendUrl(runtime.backendUrl);
  // Прозрачность и прочие визуальные настройки применяются и в окне истории
  // (раньше оно их игнорировало), и обновляются на лету через settings:changed.
  if (runtime?.settings) applyVisualSettings(runtime.settings);
  window.epicAI?.on('settings:changed', applyVisualSettings);
  $('#hist-close').addEventListener('click', () => window.close());
  $('#hist-refresh').addEventListener('click', () => void load());
  window.epicAI?.on('history:refresh', () => void load());
  void load();
}

let __booted = false;
function __start() {
  if (__booted) return;
  __booted = true;
  void boot();
}
if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', __start);
else __start();
