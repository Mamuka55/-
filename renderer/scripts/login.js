/**
 * EPIC AI — окно входа (раунды 23–30).
 *
 * Приложение не показывает сторонние страницы: Discord открывается ТОЛЬКО
 * приложением (discord:// deep-link, п.2 раунда 30), Telegram — чатом бота
 * (t.me / QR / код сообщением). Сессию окно забирает одноразовым тикетом
 * через ipc epic:auth:claim (cookie ставит main-процесс в партицию).
 * Цвета окна — те же токены и альфы, что у основного приложения
 * (applyVisualSettings из runtime-настроек, п.6 раунда 30).
 */
import { $ } from './util.js';
import { applyVisualSettings } from './settings.js';

const state = { backendUrl: '', ticket: null, timer: 0, telegram: null, providers: {}, hasQr: false, runtime: null, waiting: false };

async function boot() {
  const runtime = await window.epicAI?.invoke('epic:runtime').catch(() => null);
  state.runtime = runtime;
  state.backendUrl = String(runtime?.backendUrl ?? 'http://127.0.0.1:8787').replace(/\/$/, '');
  // П.6 раунда 30: прозрачность/альфы как в основном приложении
  if (runtime?.settings) applyVisualSettings(runtime.settings);

  let providers = { telegram: false, botUsername: null };
  try {
    const r = await fetch(`${state.backendUrl}/api/auth/providers`);
    providers = { ...providers, ...(await r.json()) };
  } catch { /* backend ещё поднимается */ }
  state.providers = providers;

  $('#btn-telegram').hidden = !providers.telegram;
  $('#login-none').hidden = Boolean(providers.telegram);

  $('#btn-telegram').addEventListener('click', () => begin('telegram'));
  // Вернулись из браузера/Discord — сразу проверяем тикет (п.4 раунда 30)
  window.addEventListener('focus', () => { if (state.waiting) void checkOnce(); });

  // Telegram: код, QR и опрос тикета готовим сразу — вход с телефона по QR
  // завершится без единого клика на этом компьютере.
  if (providers.telegram) {
    try {
      const j = await start('telegram');
      state.telegram = j;
      state.ticket = j.ticket;
      renderQr(j);
      startPoll();
    } catch { /* покажем по клику */ }
  }
}

async function start(provider) {
  const r = await fetch(`${state.backendUrl}/api/auth/desktop/start`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Epic-Client': 'desktop' },
    body: new TextEncoder().encode(JSON.stringify({ provider, device: state.runtime?.device, os: state.runtime?.osLabel })),
  });
  const j = await r.json();
  if (!j.ok) throw new Error(j.message || j.error || 'start failed');
  return j;
}

function renderQr(j) {
  state.hasQr = Boolean(j.qrDataUrl);
  const box = $('#login-qr');
  box.hidden = !state.hasQr;
  if (!state.hasQr) return;
  $('#qr-img').src = j.qrDataUrl;
  $('#qr-code').textContent = j.displayCode ?? '—';
}

function setCardWaiting(on) {
  state.waiting = on;
  $('#login-wait').hidden = !on;
  $('#btn-telegram').hidden = on || !state.providers.telegram;
  // П.1 раунда 33: QR и код НЕ прячем в ожидании — без них телефонный вход
  // становился тупиком после клика по кнопке.
  $('#login-qr').hidden = !state.hasQr;
}

async function begin(provider) {
  const btns = [$('#btn-telegram')];
  btns.forEach((b) => { b.disabled = true; });
  try {
    const j = provider === 'telegram' && state.telegram ? state.telegram : await start(provider);
    if (provider === 'telegram') state.telegram = j;
    state.ticket = j.ticket;
    setCardWaiting(true);
    $('#wait-text').innerHTML = `Подтвердите вход в Telegram: кнопка «Войти» в сообщении бота<br />или код <b>${j.displayCode}</b> с телефона (QR ниже).`;
    if (j.bot?.error) {
      $('#login-status').textContent = `Внимание: бот недоступен (${j.bot.error}) — вход не завершится, проверьте TELEGRAM_BOT_TOKEN и сеть.`;
    }
    window.open(j.url, '_blank');
    startPoll();
    void checkOnce(false);
  } catch (e) {
    $('#login-status').textContent = `Не удалось начать вход: ${e?.message ?? e}`;
    btns.forEach((b) => { b.disabled = false; });
  }
}

/** Одна проверка тикета; userInitiated — по кнопке/фокусу (показывает ошибки). */
async function checkOnce() {
  if (!state.ticket) return;
  const status = $('#login-status');
  try {
    const s = await (await fetch(`${state.backendUrl}/api/auth/desktop/status?ticket=${encodeURIComponent(state.ticket)}`)).json();
    if (s.status === 'ready') {
      stopPoll();
      status.textContent = 'Вход подтверждён…';
      // Cookie ставит main-процесс: со страницы file:// SameSite=lax не дал
      // бы ей лечь из cross-origin ответа.
      const j = await window.epicAI?.invoke('epic:auth:claim', { ticket: state.ticket });
      if (!j?.ok) throw new Error(j?.error || 'claim failed');
      status.textContent = `Вход выполнен: ${j.username ?? ''}`;
      await window.epicAI?.invoke('epic:auth:done');
      return;
    }
    if (s.status === 'denied') {
      stopPoll();
      state.telegram = null;
      cancelWait();
      status.textContent = 'Вход отклонён в Telegram («Это не я»).';
    }
    if (s.status === 'expired') {
      stopPoll();
      state.telegram = null;
      cancelWait();
      status.textContent = 'Код устарел. Нажмите кнопку ещё раз.';
    }
    if (s.bot?.error) {
      status.textContent = `Бот недоступен: ${s.bot.error}`;
    }
  } catch (e) {
    stopPoll();
    status.textContent = `Не удалось завершить вход: ${e?.message ?? e}. Нажмите кнопку ещё раз.`;
    setCardWaiting(false);
    [$('#btn-telegram')].forEach((b) => { b.disabled = false; });
  }
}

function startPoll() {
  stopPoll();
  const started = Date.now();
  state.timer = setInterval(() => {
    if (Date.now() - started > 10 * 60_000) {
      stopPoll();
      cancelWait();
      $('#login-status').textContent = 'Код устарел. Нажмите кнопку ещё раз.';
      return;
    }
    void checkOnce(false);
  }, 1500);
}

function stopPoll() {
  if (state.timer) { clearInterval(state.timer); state.timer = 0; }
}

function cancelWait() {
  stopPoll();
  state.ticket = state.telegram?.ticket ?? null;
  setCardWaiting(false);
  [$('#btn-discord'), $('#btn-telegram')].forEach((b) => { b.disabled = false; });
  // тихий опрос прежнего telegram-тикета: подтверждение может дойти позже
  if (state.telegram) startPoll();
}

if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
else boot();
