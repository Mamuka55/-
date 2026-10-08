/**
 * EPIC AI — сессии и аутентификация.
 *
 * Токен сессии: 48 случайных байт, в БД хранится ТОЛЬКО SHA-256 хэш.
 * Проверка blocked выполняется на backend при КАЖДОМ запросе.
 */
import { randomBytes, createHash, timingSafeEqual } from 'node:crypto';
import type { FastifyRequest, FastifyReply } from 'fastify';
import config from '../config/index.js';
import { getDb, insertReturningId, toBool, type Row } from '../db/index.js';
import { computeEffectivePermissions, type EffectivePermissions } from '../permissions/catalog.js';

export interface SessionUser {
  id: number;
  username: string;
  displayName: string | null;
  avatarUrl: string | null;
  status: 'active' | 'blocked';
  createdAt: string | null;
  lastLoginAt: string | null;
}

export interface AuthContext {
  user: SessionUser;
  permissions: EffectivePermissions;
  sessionId: number;
}

export const sha256 = (s: string): string => createHash('sha256').update(s).digest('hex');

function newToken(): string { return randomBytes(48).toString('base64url'); }

const COOKIE_OPTS_BASE = {
  path: '/',
  httpOnly: true,
  sameSite: 'lax' as const,
};

/** Создание сессии + установка cookie. */
export async function attachSession(reply: FastifyReply, userId: number, meta: { ip?: string; userAgent?: string } = {}): Promise<string> {
  const db = await getDb();
  const token = newToken();
  const expires = new Date(Date.now() + config.session.ttlDays * 86400_000);
  await insertReturningId(db, 'sessions', {
    user_id: userId,
    token_hash: sha256(token),
    created_at: new Date().toISOString(),
    expires_at: expires.toISOString(),
    last_seen_at: new Date().toISOString(),
    ip: meta.ip ?? null,
    user_agent: meta.userAgent ?? null,
  });
  reply.setCookie(config.session.cookie, token, {
   ...COOKIE_OPTS_BASE,
    secure: config.isProd,
    expires,
  });
  return token;
}

export function readSessionToken(req: FastifyRequest): string | null {
  const fromCookie = req.cookies?.[config.session.cookie];
  if (fromCookie) return String(fromCookie);
  const header = req.headers['authorization'];
  if (typeof header === 'string' && header.startsWith('Bearer ')) return header.slice(7).trim();
  return null;
}

/** Восстановление контекста по cookie/токену. Возвращает null, если сессия недействительна. */
export async function authenticate(req: FastifyRequest): Promise<AuthContext | null> {
  const token = readSessionToken(req);
  if (!token) return null;

  const db = await getDb();
  const hash = sha256(token);
  const s = await db.get<Row>(
    `SELECT s.id, s.user_id, s.expires_at, s.revoked_at, s.revoke_reason,
            u.username, u.display_name, u.avatar_url, u.status, u.created_at, u.last_login_at
       FROM sessions s JOIN users u ON u.id = s.user_id
      WHERE s.token_hash = ?`,
    [hash],
  );
  if (!s) return null;

  // Сессия отозвана из-за блокировки: возвращаем контекст со status='blocked',
  // чтобы клиент получил понятные 403 «Аккаунт заблокирован», а не 401.
  const revokedByBlock = Boolean(s.revoked_at) && String(s.revoke_reason ?? '') === 'blocked';
  if (s.revoked_at && !revokedByBlock) return null;
  if (!revokedByBlock && new Date(String(s.expires_at)).getTime() < Date.now()) return null;

  const user: SessionUser = {
    id: Number(s.user_id),
    username: String(s.username),
    displayName: s.display_name == null ? null : String(s.display_name),
    avatarUrl: s.avatar_url == null ? null : String(s.avatar_url),
    status: String(s.status) === 'blocked' ? 'blocked' : 'active',
    createdAt: s.created_at == null ? null : String(s.created_at),
    lastLoginAt: s.last_login_at == null ? null : String(s.last_login_at),
  };

  const permissions = await computeEffectivePermissions(db, user.id);

  // : заблокированный пользователь не получает доступ,
  // а его существующие сессии инвалидируются.
  if (user.status === 'blocked') {
    if (!s.revoked_at) await revokeSessionsForUser(user.id, 'blocked');
    // Контекст возвращается, чтобы guard мог отдать 403 «blocked», а не 401.
    return { user, permissions, sessionId: Number(s.id) };
  }

  // last_seen обновляем не чаще раза в минуту, чтобы не долбить БД
  await db.run(
    `UPDATE sessions SET last_seen_at = ?
      WHERE id = ? AND (last_seen_at IS NULL OR last_seen_at < ?)`,
    [new Date().toISOString(), Number(s.id), new Date(Date.now() - 60_000).toISOString()],
  );

  return { user, permissions, sessionId: Number(s.id) };
}

/** Инвалидация всех сессий пользователя. */
export async function revokeSessionsForUser(userId: number, reason = 'manual'): Promise<number> {
  const db = await getDb();
  const r = await db.run(
    'UPDATE sessions SET revoked_at = ?, revoke_reason = ? WHERE user_id = ? AND revoked_at IS NULL',
    [new Date().toISOString(), reason, userId],
  );
  return r.changes;
}

export async function revokeSession(sessionId: number, reason = 'logout'): Promise<void> {
  const db = await getDb();
  await db.run('UPDATE sessions SET revoked_at = ?, revoke_reason = ? WHERE id = ?', [
    new Date().toISOString(), reason, sessionId,
  ]);
}

export function clearSessionCookie(reply: FastifyReply): void {
  reply.clearCookie(config.session.cookie, { path: '/' });
}

/**
 * Защита от CSRF для cookie-авторизации.
 * Electron-клиент обязан слать заголовок X-Epic-Client на мутирующие запросы.
 */
export function assertClientHeader(req: FastifyRequest): void {
  const v = req.headers['x-epic-client'];
  const ok = v === 'desktop' || v === 'admin-web' || v === 'cli';
  if (!ok) {
    const err: any = new Error('Требуется заголовок X-Epic-Client');
    err.statusCode = 400;
    err.code = 'missing_client_header';
    throw err;
  }
}

export function safeEqual(a: string, b: string): boolean {
  const ba = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ba.length !== bb.length) return false;
  return timingSafeEqual(ba, bb);
}
