/**
 * EPIC AI — Telegram Login Widget.
 *
 * Проверка подписи по официальному алгоритму Telegram:
 *   secret_key = SHA256(bot_token)
 *   data_check_string = отсортированные по ключу пары "k=v" (без hash), через \n
 *   hmac = HMAC_SHA256(data_check_string, secret_key)  ==  hash
 *
 * TELEGRAM_BOT_TOKEN хранится только на backend.
 */
import { createHmac, createHash, timingSafeEqual, randomBytes } from 'node:crypto';
import config from '../config/index.js';
import { getUserProfile, type IdentityInput } from '../users/service.js';
import { getQuota } from '../ai/quota.js';

export interface TelegramAuthData {
  id: string | number;
  first_name?: string;
  last_name?: string;
  username?: string;
  photo_url?: string;
  auth_date: string | number;
  hash: string;
  [key: string]: unknown;
}

export class TelegramAuthError extends Error {
  constructor(message: string, public code = 'telegram_auth_failed') { super(message); }
}

export function verifyTelegramHash(data: TelegramAuthData): { ok: boolean; reason?: string } {
  if (!config.telegram.enabled) return { ok: false, reason: 'Telegram-авторизация отключена на сервере' };
  if (!config.telegram.botToken) return { ok: false, reason: 'TELEGRAM_BOT_TOKEN не задан' };
  if (!data?.hash) return { ok: false, reason: 'Отсутствует hash' };
  if (!data?.id) return { ok: false, reason: 'Отсутствует id' };

  const authDate = Number(data.auth_date ?? 0);
  if (!authDate) return { ok: false, reason: 'Отсутствует auth_date' };
  const ageSec = Math.floor(Date.now() / 1000) - authDate;
  if (ageSec > config.telegram.hashMaxAge) return { ok: false, reason: 'auth_hash устарел' };
  if (ageSec < -60) return { ok: false, reason: 'auth_date в будущем' };

  const checkString = Object.keys(data)
   .filter((k) => k !== 'hash')
   .sort()
   .map((k) => `${k}=${String(data[k])}`)
   .join('\n');

  const secret = createHash('sha256').update(config.telegram.botToken, 'utf8').digest();
  const hmac = createHmac('sha256', secret).update(checkString, 'utf8').digest();
  const provided = Buffer.from(String(data.hash), 'hex');

  if (provided.length !== hmac.length || !timingSafeEqual(provided, hmac)) {
    return { ok: false, reason: 'Недействительная подпись' };
  }
  return { ok: true };
}

/**
 * Данные, автоматически записываемые в Epic AI :
 * Telegram User ID, username, имя, фамилия, avatar.
 */
export function toIdentity(data: TelegramAuthData): IdentityInput {
  const firstName = data.first_name ? String(data.first_name) : null;
  const lastName = data.last_name ? String(data.last_name) : null;
  const displayName = [firstName, lastName].filter(Boolean).join(' ') || data.username || `tg_${data.id}`;
  return {
    provider: 'telegram',
    providerUserId: String(data.id),
    username: data.username ? String(data.username) : null,
    firstName,
    lastName,
    displayName,
    avatarUrl: data.photo_url ? String(data.photo_url) : null,
    raw: { id: String(data.id), username: data.username ?? null, first_name: firstName, last_name: lastName, auth_date: data.auth_date },
  };
}


/* ------------------------------------------------------------------ */
/*  Вход БЕЗ виджета: deep-link на бота + подтверждение кнопками       */
/*                                                                      */
/*  Виджет Telegram удалён (раунд 23): вход идёт через внешний браузер */
/*  и чат бота. Код одноразовый (TTL 5 мин); подтверждение — inline-   */
/*  клавиши «Войти» / «Это не я» в карточке бота (референс пользователя */
/*  : код для сверки, устройство и ОС, время по Москве, адрес).        */
/*  Домен и HTTPS не нужны вовсе.                                      */
/* ------------------------------------------------------------------ */

const BOT_API = 'https://api.telegram.org';
const CODE_TTL_MS = 5 * 60_000;
const START_RE = /^\/start(?:@[a-z0-9_]+)?\s+([a-f0-9]{8,32})$/i;
const CB_RE = /^tglogin:(ok|no):([a-f0-9]{8,32})$/i;
const APP_TITLE = 'Epic AI';

export interface TelegramFrom {
  id: string | number;
  first_name?: string | null;
  last_name?: string | null;
  username?: string | null;
  /** data-URL аватара, снятый с getUserProfilePhotos (п.1 раунда 27). */
  photoDataUrl?: string | null;
}

export type TelegramLoginState = 'pending' | 'ready' | 'denied' | 'expired';

interface PendingLogin {
  createdAt: number;
  from: TelegramFrom | null;
  state: 'pending' | 'ready' | 'denied';
  device?: string;
  os?: string;
  ip?: string;
  msg?: { chatId: string | number; messageId: number };
  /** Тикет desktop-входа: подтверждение кнопкой помечает тикет ready. */
  ticket?: string | null;
}
const pendingLogins = new Map<string, PendingLogin>();

/** Колбэк для routes: подтверждение/отклонение входа помечает desktop-тикет. */
let onLoginConfirmed: ((ticket: string, state: 'ready' | 'denied', from: TelegramFrom | null) => void) | null = null;
export function setOnLoginConfirmed(fn: typeof onLoginConfirmed): void { onLoginConfirmed = fn; }

let lastTickAt = 0;
let updateOffset = 0;
let tokenWarned = false;

/** 4-цифренный код для сверки глазами: страница входа и сообщение бота. */
function displayCodeOf(secret: string): string {
  let h = 0;
  for (let i = 0; i < secret.length; i++) h = (h * 31 + secret.charCodeAt(i)) >>> 0;
  return String(h % 10000).padStart(4, '0');
}

function moscowTime(d = new Date()): string {
  try {
    return new Intl.DateTimeFormat('ru-RU', { timeZone: 'Europe/Moscow', hour: '2-digit', minute: '2-digit' }).format(d);
  } catch {
    return d.toTimeString().slice(0, 5);
  }
}

function escapeHtml(s: string): string {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

let netWarnedAt = 0;
let lastBotError: string | null = null;

/** Здоровье бота для страницы входа: polling активен и последняя ошибка. */
export function getBotHealth(): { polling: boolean; error: string | null } {
  return { polling, error: lastBotError };
}
function netWarn(message: string): void {
  const now = Date.now();
  if (now - netWarnedAt < 5 * 60_000) return;   // не спамим при каждом обрыве
  netWarnedAt = now;
  console.warn(`[epic-ai] Telegram API: ${message} (повторяю не чаще раза в 5 минут)`);
}

async function botApiOnce(method: string, payload: Record<string, unknown>, timeoutMs: number): Promise<any | null> {
  const res = await fetch(`${BOT_API}/bot${config.telegram.botToken}/${method}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) {
    if ((res.status === 401 || res.status === 404) && !tokenWarned) {
      tokenWarned = true;
      console.warn('[epic-ai] Telegram API: токен отклонён (401/404) — проверьте TELEGRAM_BOT_TOKEN (повторно не повторяю)');
    }
    return null;
  }
  const data = (await res.json()) as { ok?: boolean; result?: any };
  return data.result ?? null;
}

/**
 * Вызов Bot API с одним ретраем на сетевых сбоях (п.2 раунда 26):
 * «fetch failed» у long-poll обычно означает краткий обрыв сети/DNS,
 * повтор через 600 мс проходит; предупреждения троттлятся до 1 раза в 5 мин.
 */
async function botApi(method: string, payload: Record<string, unknown>, timeoutMs = 8000): Promise<any | null> {
  if (!config.telegram.botToken) return null;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      return await botApiOnce(method, payload, timeoutMs);
    } catch (e: any) {
      if (attempt === 0) {
        await new Promise((r) => setTimeout(r, 600));
        continue;
      }
      lastBotError = `сеть: ${String(e?.message ?? e).slice(0, 120)}`;
      netWarn(`${method}: ${e?.message ?? e}`);
      return null;
    }
  }
  return null;
}

/** Карточка подтверждения в чате бота — референс пользователя. */
async function sendConfirmCard(code: string, p: PendingLogin): Promise<void> {
  if (!p.from) return;
  const ip = p.ip && p.ip !== '127.0.0.1' ? p.ip : 'локального адреса';
  const text = [
    `\u{1F510} <b>Вход в ${APP_TITLE}</b>`,
    '',
    `Код: <code>${displayCodeOf(code)}</code>`,
    `\u{1F4BB} ${escapeHtml(p.device || 'Неизвестное устройство')} · ${escapeHtml(p.os || 'Неизвестная ОС')}`,
    `\u{1F550} Начат в ${moscowTime()} по Москве с адреса ${escapeHtml(ip)}.`,
    '',
    '⚠️ Нажимайте «Войти», только если сами только что нажали «Войти через Telegram»',
    'в программе. Если ссылку прислал кто-то другой, это попытка войти',
    'в ваш аккаунт: нажмите «Это не я».',
  ].join('\n');
  const msg = await botApi('sendMessage', {
    chat_id: p.from.id,
    text,
    parse_mode: 'HTML',
    disable_web_page_preview: true,
    reply_markup: {
      inline_keyboard: [[
        { text: '✅ Войти', callback_data: `tglogin:ok:${code}` },
        { text: '❌ Это не я', callback_data: `tglogin:no:${code}` },
      ]],
    },
  });
  if (msg?.message_id) p.msg = { chatId: msg.chat?.id ?? p.from.id, messageId: Number(msg.message_id) };
  else lastBotError = 'sendMessage не вернул message_id (бот не смог отправить карточку)';
}

/** Отправить текст в чат; true — Telegram принял сообщение. */
export async function sendText(chatId: string | number, text: string, parseMode: 'HTML' | null = 'HTML'): Promise<boolean> {
  const payload: Record<string, unknown> = { chat_id: chatId, text, disable_web_page_preview: true };
  if (parseMode) payload.parse_mode = parseMode;
  return Boolean(await botApi('sendMessage', payload, 12_000));
}

/** Фото профиля Telegram как data-URL (<=512 КБ), либо null. */
export async function fetchTelegramPhotoDataUrl(userId: string | number): Promise<string | null> {
  try {
    const photos = await botApi('getUserProfilePhotos', { user_id: Number(userId), limit: 1 }, 12_000);
    const sizes = photos?.photos?.[0];
    if (!Array.isArray(sizes) || !sizes.length) return null;
    const best = sizes[sizes.length - 1];
    if (Number(best.file_size ?? 0) > 512 * 1024) return null;
    const file = await botApi('getFile', { file_id: String(best.file_id) }, 12_000);
    if (!file?.file_path) return null;
    const res = await fetch(`${BOT_API}/file/bot${config.telegram.botToken}/${file.file_path}`, { signal: AbortSignal.timeout(15_000) });
    if (!res.ok) return null;
    const buf = Buffer.from(await res.arrayBuffer());
    if (!buf.length || buf.length > 512 * 1024) return null;
    const ctype = String(res.headers.get('content-type') ?? 'image/jpeg').split(';')[0];
    return `data:${ctype};base64,${buf.toString('base64')}`;
  } catch {
    return null;
  }
}

/** Текст статуса аккаунта для команды /status. */
export function buildBotStatusText(profile: { username?: string | null; displayName?: string | null; status?: string | null; primaryRole?: { name?: string | null } | null }, quota: { left?: number; limit?: number } | null): string {
  const role = profile.primaryRole?.name ?? 'Игрок';
  const quotaLine = quota ? `\u{1F3AF} Ответов ИИ сегодня: <b>${quota.left} из ${quota.limit}</b> осталось.` : '';
  return [
    `\u{1F464} <b>${escapeHtml(profile.displayName || profile.username || '—')}</b> (@${escapeHtml(profile.username || '—')})`,
    `\u{1F396} Роль: ${escapeHtml(role)} · статус: ${escapeHtml(profile.status ?? 'active')}`,
    quotaLine,
  ].filter(Boolean).join('\n');
}

const BOT_MENU_KEYBOARD = {
  inline_keyboard: [[
    { text: '📊 Статус', callback_data: 'bot:status' },
    { text: '🎯 Лимит', callback_data: 'bot:limit' },
  ], [
    { text: '❓ Помощь', callback_data: 'bot:help' },
  ]],
};

const BOT_HELP_TEXT = [
  `<b>Команды ${APP_TITLE}:</b>`,
  '/start — меню бота (или вход в приложение, если прийти по ссылке с кодом)',
  '/status — ваш аккаунт: ник, роль, статус',
  '/limit — остаток ответов ИИ на сегодня',
  '/help — эта справка',
  '',
  'Вход в приложение: нажмите «Войти через Telegram» в Epic AI и подтвердите здесь кнопкой «Войти».',
].join('\n');

/** Обработать команду/кнопку меню бота. */
async function handleBotCommand(tgUserId: string, cmd: string, chatId?: string | number): Promise<void> {
  const target = chatId ?? tgUserId;
  try {
    const db = await (await import('../db/index.js')).getDb();
    const link = await db.get<{ user_id: number }>(
      'SELECT user_id FROM identities WHERE provider = ? AND provider_user_id = ?',
      ['telegram', tgUserId],
    );
    if (!link) {
      await sendText(target, 'Аккаунт Epic AI не привязан к этому Telegram.\nНажмите «Войти через Telegram» в приложении и подтвердите вход здесь — привязка создастся автоматически.');
      return;
    }
    if (cmd === 'help') { await sendText(target, BOT_HELP_TEXT); return; }
    const profile = await getUserProfile(Number(link.user_id));
    if (!profile) { await sendText(target, 'Аккаунт не найден.'); return; }
    if (cmd === 'start') {
      await sendText(target, `Здравствуйте, <b>${escapeHtml(profile.displayName || profile.username || '')}</b>!\n\n${BOT_HELP_TEXT}`, );
      await botApi('sendMessage', { chat_id: target, text: 'Меню:', reply_markup: BOT_MENU_KEYBOARD });
      return;
    }
    const quota = cmd === 'limit' || cmd === 'status' ? await getQuota(Number(link.user_id)).catch(() => null) : null;
    if (cmd === 'limit') {
      await sendText(target, quota ? `\u{1F3AF} Ответов ИИ сегодня осталось: <b>${quota.left} из ${quota.limit}</b>.` : 'Лимит недоступен.');
      return;
    }
    await sendText(target, buildBotStatusText(profile, quota));
  } catch (e: any) {
    console.warn(`[epic-ai] bot command ${cmd}: ${e?.message ?? e}`);
  }
}

/** Выдать код входа и ссылку на бота. */
export function createTelegramLoginCode(opts: { device?: string; os?: string; ip?: string; ticket?: string | null } = {}): { code: string; displayCode: string; url: string } {
  if (!config.telegram.enabled || !config.telegram.botToken) {
    throw new TelegramAuthError('Telegram-авторизация отключена или токен не задан', 'telegram_disabled');
  }
  const code = randomBytes(8).toString('hex');
  pendingLogins.set(code, {
    createdAt: Date.now(),
    from: null,
    state: 'pending',
    device: opts.device,
    os: opts.os,
    ip: opts.ip,
    ticket: opts.ticket ?? null,
  });
  return { code, displayCode: displayCodeOf(code), url: `https://t.me/${config.telegram.botUsername}?start=${code}` };
}

export function telegramLoginStatus(code: string): TelegramLoginState {
  const p = pendingLogins.get(String(code ?? ''));
  if (!p) return 'expired';
  if (Date.now() - p.createdAt > CODE_TTL_MS) { pendingLogins.delete(String(code)); return 'expired'; }
  return p.state;
}

/** Забрать telegram-пользователя после подтверждения кнопкой (одноразово). */
export function takeTelegramLogin(code: string): TelegramFrom | null {
  const key = String(code ?? '');
  const p = pendingLogins.get(key);
  if (!p || p.state !== 'ready' || !p.from) return null;
  pendingLogins.delete(key);
  return p.from;
}

/**
 * Один такт getUpdates по требованию (троттлинг 800 мс): обрабатывает
 * /start <код> (шлёт карточку), код сообщением и callback_query кнопок.
 */
/** Обработать один update Telegram: /start<код>, код сообщением, callback кнопок. */
async function processUpdate(u: Record<string, any>): Promise<void> {
  updateOffset = Math.max(updateOffset, Number(u.update_id ?? 0));

  const cb = u?.callback_query;
  if (cb) {
    const menuCmd = /^bot:(status|limit|help)$/i.exec(String(cb.data ?? ''));
    if (menuCmd && cb?.from?.id) {
      void botApi('answerCallbackQuery', { callback_query_id: cb.id }, 12_000);
      await handleBotCommand(String(cb.from.id), menuCmd[1].toLowerCase(), cb.message?.chat?.id);
      return;
    }
    const m = CB_RE.exec(String(cb.data ?? ''));
    const p = m ? pendingLogins.get(m![2]) : undefined;
    if (m && p && p.state === 'pending') {
      p.state = m[1] === 'ok' ? 'ready' : 'denied';
      if (p.ticket) onLoginConfirmed?.(p.ticket, p.state, p.from);
      void botApi('answerCallbackQuery', {
        callback_query_id: cb.id,
        text: p.state === 'ready' ? 'Вход выполнен' : 'Вход отклонён',
      });
      if (p.msg) {
        void botApi('editMessageText', {
          chat_id: p.msg.chatId,
          message_id: p.msg.messageId,
          text: p.state === 'ready'
            ? `✅ <b>Вход в ${APP_TITLE} подтверждён</b> (код ${displayCodeOf(m[2])}). Сообщение можно удалить.`
            : `❌ <b>Вход в ${APP_TITLE} отклонён</b> (код ${displayCodeOf(m[2])}). Если это были не вы — смените сеансы в Telegram.`,
          parse_mode: 'HTML',
        });
      }
    } else if (cb?.id) {
      void botApi('answerCallbackQuery', { callback_query_id: cb.id, text: 'Код устарел' });
    }
    return;
  }

  const msgText = String(u?.message?.text ?? '').trim();
  // Команды бота: /start без кода — меню, /status, /limit, /help (п.3 раунда 31)
  const cmd = /^\/(start|status|limit|help)(@[a-z0-9_]+)?$/i.exec(msgText)?.[1]?.toLowerCase();
  if (cmd && u?.message?.from?.id) {
    await handleBotCommand(String(u.message.from.id), cmd, u.message.chat?.id);
    return;
  }
  let code = START_RE.exec(msgText)?.[1];
  // Код можно прислать просто сообщением («5614» или hex) с ЛЮБОГО
  // устройства: веб-страница t.me открывает приложение только если
  // Telegram установлен на этом же компьютере.
  if (!code && /^[0-9]{4}$|^[a-f0-9]{16}$/i.test(msgText)) {
    for (const [secret, entry] of pendingLogins) {
      if (entry.state === 'pending' && !entry.from
        && (secret.toLowerCase() === msgText.toLowerCase() || displayCodeOf(secret) === msgText)) {
        code = secret;
        break;
      }
    }
  }
  if (!code) return;
  const p = pendingLogins.get(code);
  if (!p || p.from || p.state !== 'pending') return;
  const from = u.message?.from;
  if (!from?.id) return;
  p.from = {
    id: String(from.id),
    first_name: from.first_name ?? null,
    last_name: from.last_name ?? null,
    username: from.username ?? null,
  };
  void sendConfirmCard(code, p);
}

/**
 * Фоновый поллинг Bot API: стартует вместе с backend (п.1 раунда 24) и
 * держит подтверждения кнопок без задержек. Останавливается на shutdown.
 */
let pollTimer: NodeJS.Timeout | null = null;
let polling = false;

export function isTelegramPolling(): boolean { return polling; }

export function startTelegramPolling(): void {
  if (!config.telegram.enabled || !config.telegram.botToken || polling) return;
  polling = true;
  console.log('[epic-ai] Telegram-бот запущен вместе с backend (long-polling getUpdates)');
  const loop = async (): Promise<void> => {
    while (polling) {
      const result = await botApi('getUpdates', {
        timeout: 25,
        limit: 50,
        offset: updateOffset + 1,
        allowed_updates: ['message', 'callback_query'],
      }, 35_000);
      if (!polling) return;
      for (const u of Array.isArray(result) ? result : []) {
        await processUpdate(u);
      }
      // чистим устаревшие коды, чтобы карта не росла
      const now = Date.now();
      for (const [k, p] of pendingLogins) if (now - p.createdAt > CODE_TTL_MS) pendingLogins.delete(k);
      if (!Array.isArray(result)) await new Promise((r) => setTimeout(r, 3000)); // ошибка сети — пауза
    }
  };
  void loop();
}

export function stopTelegramPolling(): void {
  polling = false;
  if (pollTimer) { clearTimeout(pollTimer); pollTimer = null; }
}

/**
 * Такт getUpdates по требованию (троттлинг 800 мс) — fallback, когда фоновый
 * поллинг не запущен (тесты, отключённый бот): статус-эндпоинт дёргает его.
 */
export async function tickTelegramUpdates(): Promise<void> {
  if (polling) return;
  if (!config.telegram.botToken) return;
  if (!pendingLogins.size) return;
  const now = Date.now();
  if (now - lastTickAt < 800) return;
  lastTickAt = now;
  const result = await botApi('getUpdates', {
    timeout: 1,
    limit: 20,
    offset: updateOffset + 1,
    allowed_updates: ['message', 'callback_query'],
  }, 10_000);
  for (const u of Array.isArray(result) ? result : []) await processUpdate(u);
}
