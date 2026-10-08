/**
 * EPIC AI — маршруты авторизации.
 *
 * Поток в Electron:
 *   Splash → нет сессии → окно Auth (загружает GET /login)
 *   → «Войти через Discord» (OAuth) / «Войти через Telegram» (Login Widget)
 *   → backend создаёт сессию (cookie в партиции Electron)
 *   → страница /auth/done → main-процесс закрывает окно и открывает оверлей.
 */
import type { FastifyInstance } from 'fastify';
import config from '../config/index.js';
import { getDb, type Row } from '../db/index.js';
import { attachSession, clearSessionCookie, revokeSession, authenticate, assertClientHeader } from './session.js';
import { findOrCreateUserByIdentity, linkIdentity, getUserProfile, serializeUserProfile } from '../users/service.js';
import { computeEffectivePermissions } from '../permissions/catalog.js';
import { audit, AUDIT_ACTIONS } from '../audit/index.js';
import * as telegram from './telegram.js';
import { randomBytes } from 'node:crypto';
import QRCode from 'qrcode';
import { BadRequestError } from '../http/guards.js';

import { renderDonePage, renderErrorPage } from './pages.js';

/** Публичный IP best-effort (кэш 5 мин): для карточки подтверждения входа. */
let pubIpCache: { at: number; ip: string | null } = { at: 0, ip: null };
async function publicIp(req: any): Promise<string> {
  const now = Date.now();
  if (pubIpCache.ip && now - pubIpCache.at < 5 * 60_000) return pubIpCache.ip;
  try {
    const r = await fetch('https://api.ipify.org?format=json', { signal: AbortSignal.timeout(2500) });
    const j = (await r.json()) as { ip?: string };
    if (j?.ip) { pubIpCache = { at: now, ip: String(j.ip) }; return String(j.ip); }
  } catch { /* офлайн: не критично */ }
  return String(req?.ip ?? '');
}

export async function registerAuthRoutes(app: FastifyInstance): Promise<void> {
  /* ---------------- Страница входа  ---------------- */
  app.get('/auth/done', async (_req, reply) => reply.type('text/html; charset=utf-8').send(renderDonePage('Вход выполнен', true)));

  /* ===== Desktop-вход: тикет + внешний браузер (раунд 23) =====
     Приложение НЕ рисует страницу авторизации: кнопки «Войти через …»
     открывают ВНЕШНИЙ браузер (Discord OAuth / чат бота Telegram), а сессию
     забирают одноразовым тикетом через /api/auth/desktop/claim. */

  interface DesktopTicket {
    key: string;
    provider: 'discord' | 'telegram';
    createdAt: number;
    state: 'pending' | 'ready' | 'denied';
    userId: number | null;
    from: telegram.TelegramFrom | null;
  }
  const desktopTickets = new Map<string, DesktopTicket>();
  const TICKET_TTL_MS = 5 * 60_000;

  telegram.setOnLoginConfirmed((ticket, state, from) => {
    const t = desktopTickets.get(ticket);
    if (!t || t.state !== 'pending') return;
    t.state = state;
    t.from = from;   // from.photoDataUrl придёт асинхронно к моменту claim
    console.log(`[epic-ai] desktop-тикет ${ticket.slice(0, 8)}…: ${state} (telegram ${from?.username ?? from?.id ?? '?'})`);
  });

  function ticketState(key: string): { t?: DesktopTicket; status: 'pending' | 'ready' | 'denied' | 'expired' } {
    const t = desktopTickets.get(key);
    if (!t) return { status: 'expired' };
    if (Date.now() - t.createdAt > TICKET_TTL_MS) { desktopTickets.delete(key); return { status: 'expired' }; }
    return { t, status: t.state };
  }

  /** Начать вход: вернуть тикет и URL для ВНЕШНЕГО браузера. */
  app.post('/api/auth/desktop/start', async (req, reply) => {
    const body = (req.body ?? {}) as { provider?: string; device?: string; os?: string };
    // Раунд 31, п.1: Discord-авторизация удалена полностью — вход только Telegram.
    const provider = body.provider === 'telegram' ? 'telegram' : null;
    if (!provider) throw new BadRequestError('provider: telegram');
    if (provider === 'telegram' && !(config.telegram.enabled && config.telegram.botToken)) {
      return reply.code(404).send({ error: 'provider_disabled', message: 'Вход через Telegram не настроен на сервере' });
    }
    const key = randomBytes(16).toString('hex');
    desktopTickets.set(key, { key, provider, createdAt: Date.now(), state: 'pending', userId: null, from: null });
    let url = '';
    let displayCode: string | null = null;
    let qrDataUrl: string | null = null;
    {
      const ip = await publicIp(req);
      const r = telegram.createTelegramLoginCode({
        device: typeof body.device === 'string' ? body.device.slice(0, 64) : undefined,
        os: typeof body.os === 'string' ? body.os.slice(0, 64) : undefined,
        ip, ticket: key,
      });
      url = r.url;
      displayCode = r.displayCode;
      // QR для входа с телефона (референс пользователя): камера открывает
      // чат бота с тем же кодом подтверждения.
      try {
        const svg = await QRCode.toString(url, { type: 'svg', margin: 1, width: 160 });
        qrDataUrl = `data:image/svg+xml;utf8,${encodeURIComponent(svg)}`;
      } catch { qrDataUrl = null; }
    }
    return reply.send({ ok: true, ticket: key, url, displayCode, qrDataUrl, botUsername: config.telegram.botUsername || null, bot: telegram.getBotHealth() });
  });

  /** Статус тикета (страница/приложение опрашивают до подтверждения). */
  app.get('/api/auth/desktop/status', async (req, reply) => {
    const key = String((req.query as { ticket?: string })?.ticket ?? '');
    let { t, status } = ticketState(key);
    if (status === 'pending' && t?.provider === 'telegram') {
      await telegram.tickTelegramUpdates();
      ({ t, status } = ticketState(key));
    }
    return reply.send({ status, bot: telegram.getBotHealth() });
  });

  /** Одноразовый обмен подтверждённого тикета на cookie-сессию клиента. */
  app.post('/api/auth/desktop/claim', async (req, reply) => {
    const key = String((req.body as { ticket?: string })?.ticket ?? '');
    const { t, status } = ticketState(key);
    if (!t || status !== 'ready') {
      return reply.code(status === 'denied' ? 403 : 404)
        .send({ error: status === 'denied' ? 'login_denied' : 'login_not_ready', message: status === 'denied' ? 'Вход отклонён в Telegram' : 'Вход не подтверждён или код устарел' });
    }
    desktopTickets.delete(key);
    console.log(`[epic-ai] desktop-тикет ${key.slice(0, 8)}…: claim (${t.provider})`);
    let userRow: Row;
    let created = false;
    if (t.provider === 'discord' && t.userId) {
      const db = await getDb();
      userRow = (await db.get<Row>('SELECT * FROM users WHERE id = ?', [t.userId]))!;
    } else if (t.provider === 'telegram' && t.from) {
      const identity = telegram.toIdentity({
        id: t.from.id,
        first_name: t.from.first_name ?? undefined,
        last_name: t.from.last_name ?? undefined,
        username: t.from.username ?? undefined,
        photo_url: t.from.photoDataUrl ?? undefined,
        auth_date: Math.floor(Date.now() / 1000),
        hash: 'deeplink',
      } as telegram.TelegramAuthData);
      identity.ip = req.ip;
      const r = await findOrCreateUserByIdentity(identity);
      userRow = r.user;
      created = r.created;
    } else {
      return reply.code(404).send({ error: 'login_not_ready' });
    }
    const userId = Number(userRow.id);
    if (String(userRow.status) === 'blocked') {
      await audit({ actorId: userId, actorName: String(userRow.username), action: AUDIT_ACTIONS.LOGIN_FAILED, entityType: 'user', entityId: userId, meta: { provider: t.provider, reason: 'blocked', via: 'desktop' }, ip: req.ip });
      return reply.code(403).send({ error: 'blocked', message: 'Аккаунт заблокирован. Использование Epic AI запрещено.' });
    }
    // Токен возвращается и в cookie, и в теле: окно входа живёт на file://,
    // где SameSite=lax не даёт cookie лечь из cross-origin ответа — main
    // процесс ставит cookie в партицию сам (ipc epic:auth:claim).
    const token = await attachSession(reply, userId, { ip: req.ip, userAgent: String(req.headers['user-agent'] ?? '') });
    await audit({ actorId: userId, actorName: String(userRow.username), action: AUDIT_ACTIONS.LOGIN, entityType: 'user', entityId: userId, meta: { provider: t.provider, created, via: 'desktop-browser' }, ip: req.ip });
    return reply.send({ ok: true, userId, username: String(userRow.username), token, cookie: config.session.cookie });
  });

  /* ---------------- API сессии ---------------- */

  /**
   * GET /api/auth/me — текущий пользователь + роль + permissions.
   * Используется splash-экраном.
   */
  app.get('/api/auth/me', async (req, reply) => {
    const auth = await authenticate(req);
    if (!auth) return reply.code(401).send({ authenticated: false });
    if (auth.user.status === 'blocked') {
      const profile = await getUserProfile(auth.user.id);
      return reply.code(403).send({
        authenticated: true,
        blocked: true,
        message: 'Аккаунт заблокирован',
        user: profile ? { id: profile.id, username: profile.username, blockedReason: profile.blockedReason } : null,
      });
    }
    const profile = await getUserProfile(auth.user.id);
    return reply.send({
      authenticated: true,
      blocked: false,
      user: profile ? serializeUserProfile(profile) : auth.user,
      permissions: [...auth.permissions.codes].sort(),
      permissionsDetail: { fromRoles: auth.permissions.fromRoles, extra: auth.permissions.extra, denied: auth.permissions.denied },
      maxRoleLevel: auth.permissions.maxLevel,
      isDeveloper: auth.permissions.isDeveloper,
    });
  });

  /** POST /api/auth/logout */
  app.post('/api/auth/logout', async (req, reply) => {
    assertClientHeader(req);
    const auth = await authenticate(req);
    if (auth) {
      await revokeSession(auth.sessionId, 'logout');
      await audit({ actorId: auth.user.id, actorName: auth.user.username, action: AUDIT_ACTIONS.LOGOUT, entityType: 'user', entityId: auth.user.id, ip: req.ip });
    }
    clearSessionCookie(reply);
    return reply.send({ ok: true });
  });

  /** GET /api/auth/providers — какие способы входа включены (для страницы Auth). */
  app.get('/api/auth/providers', async (_req, reply) => reply.send({
    // Телеграм считаем настроенным только при наличии токена: без него
    // verifyTelegramHash отклонит любой вход, а кнопка виджета уже нарисована.
    telegram: config.telegram.enabled && Boolean(config.telegram.botUsername && config.telegram.botToken),
    botUsername: config.telegram.botUsername || null,
    // Серверное распознавание речи: SiliconFlow (SenseVoice) или Groq (whisper)
    stt: (config.ai.provider as string) !== 'mock' && Boolean(config.ai.apiKey)
      && /siliconflow|groq/i.test(config.ai.baseUrl + (config.ai.provider === 'groq' ? 'groq' : '')),
    devLogin: !config.isProd,
    // Имя cookie нужно Electron'у, чтобы найти токен сессии в своей партиции
    // и отдать его renderer'у через IPC (см. epic:session:token).
    sessionCookie: config.session.cookie,
  }));

  /**
   * POST /api/auth/dev-login — локальный вход БЕЗ OAuth, только для разработки.
   * Работает лишь когда NODE_ENV !== 'production' и передан SESSION_SECRET.
   * Пользователя создаёт `npm run bootstrap:developer -- --local <name>`.
   */
  app.post('/api/auth/dev-login', async (req, reply) => {
    if (config.isProd) return reply.code(404).send({ error: 'not_found' });
    const body = (req.body ?? {}) as { token?: string; userId?: number; username?: string };
    if (!config.session.secret || config.session.secret === 'change-me') {
      return reply.code(403).send({ error: 'dev_login_disabled', message: 'Задайте SESSION_SECRET в backend/.env' });
    }
    if (String(body.token ?? '') !== config.session.secret) {
      return reply.code(403).send({ error: 'invalid_token', message: 'Неверный токен разработчика' });
    }

    const db = await getDb();
    let user: Row | null = null;
    if (body.userId) user = await db.get<Row>('SELECT * FROM users WHERE id = ?', [Number(body.userId)]);
    else if (body.username) {
      // При совпадении имён берём пользователя с наивысшей ролью:
      // это делает dev-login предсказуемым для bootstrap-аккаунта разработчика.
      user = await db.get<Row>(
        `SELECT u.* FROM users u
           LEFT JOIN user_roles ur ON ur.user_id = u.id
           LEFT JOIN roles r ON r.id = ur.role_id
          WHERE u.username = ?
          ORDER BY COALESCE(r.level, 0) DESC, u.id ASC LIMIT 1`,
        [String(body.username)],
      );
      if (!user) {
        // возможно, пользователь уже создан bootstrap'ом с другой идентичностью
        user = await db.get<Row>(
          `SELECT u.* FROM users u JOIN identities i ON i.user_id = u.id
            WHERE i.provider = 'local' AND i.provider_user_id = ?`,
          [`local-${String(body.username)}`],
        );
      }
      if (!user) {
        // возможно, пользователь уже создан bootstrap'ом с другой идентичностью
        user = await db.get<Row>(
          `SELECT u.* FROM users u JOIN identities i ON i.user_id = u.id
            WHERE i.provider = 'discord' AND i.provider_user_id = ?`,
          [`local-${String(body.username)}`],
        );
      }
      if (!user) {
        // создаём локального тестового пользователя с ролью Игрок
        const { findOrCreateUserByIdentity } = await import('../users/service.js');
        const r = await findOrCreateUserByIdentity({
          provider: 'local',
          providerUserId: `local-${String(body.username)}`,
          username: String(body.username),
          displayName: String(body.username),
        });
        user = r.user;
      }
    }
    if (!user) return reply.code(404).send({ error: 'user_not_found', message: 'Создайте пользователя: npm run bootstrap:developer -- --local <name>' });
    if (String(user.status) === 'blocked') return reply.code(403).send({ error: 'blocked', message: 'Аккаунт заблокирован' });

    await attachSession(reply, Number(user.id), { ip: req.ip, userAgent: String(req.headers['user-agent'] ?? 'dev-login') });
    await audit({ actorId: Number(user.id), actorName: String(user.username), action: AUDIT_ACTIONS.LOGIN, entityType: 'user', entityId: Number(user.id), meta: { provider: 'dev-login' }, ip: req.ip });
    return reply.send({ ok: true, userId: Number(user.id), username: String(user.username) });
  });
}

/** Вспомогательный: получить профиль + permissions по userId (используется в admin). */
export async function loadAuthContext(userId: number) {
  const db = await getDb();
  const user = await db.get<Row>('SELECT * FROM users WHERE id = ?', [userId]);
  if (!user) return null;
  const permissions = await computeEffectivePermissions(db, userId);
  return { user, permissions };
}
