/**
 * EPIC AI — окно подтверждения вопроса «Спросить ИИ?».
 *
 * ОТДЕЛЬНОЕ окно (требование пользователя): раньше модалка рисовалась
 * внутри панели и перекрывала её. Показывает остаток дневного лимита
 * запросов и прогресс-бар; «Спросить» (Enter) / «Отмена» (Esc) возвращают
 * результат в main process каналом 'epic:ask:confirm:result', а тот —
 * основной панели, которая ждёт ответ в epic:ask:confirm.
 *
 * Прозрачность и прочие визуальные настройки применяются так же, как в
 * остальных окнах (applyVisualSettings + settings:changed).
 */
import { $ } from './util.js';
import { Ai, setBackendUrl, initAuth } from './api.js';
import { applyVisualSettings } from './settings.js';

let settled = false;

function done(ok) {
  if (settled) return;
  settled = true;
  window.epicAI?.invoke('epic:ask:confirm:result', ok).catch(() => {});
}

async function loadQuota() {
  try {
    const q = await Ai.quota();
    const left = Number(q?.left ?? 0);
    const limit = Number(q?.limit ?? 0);
    $('#confirm-quota').textContent = `${left} из ${limit}`;
    $('#confirm-bar').style.width = limit > 0 ? `${Math.round((left / limit) * 100)}%` : '0%';
  } catch {
    $('#confirm-quota').textContent = 'лимит недоступен';
    $('#confirm-bar').style.width = '0%';
  }
}

async function boot() {
  // Токен сессии — до запроса лимита (file:// не отправляет cookie)
  await initAuth();
  const runtime = await window.epicAI?.invoke('epic:runtime').catch(() => null);
  if (runtime?.backendUrl) setBackendUrl(runtime.backendUrl);
  if (runtime?.settings) applyVisualSettings(runtime.settings);
  window.epicAI?.on('settings:changed', applyVisualSettings);

  void loadQuota();

  $('#confirm-ok').addEventListener('click', () => done(true));
  $('#confirm-cancel').addEventListener('click', () => done(false));
  window.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); done(true); }
    else if (e.key === 'Escape') { e.preventDefault(); done(false); }
  });
  setTimeout(() => $('#confirm-ok')?.focus(), 30);
}

let __booted = false;
function __start() {
  if (__booted) return;
  __booted = true;
  void boot();
}
if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', __start);
else __start();
