/**
 * EPIC AI — пользователи и единая учётная запись.
 *
 * Discord и Telegram — внешние identity provider'ы. Они НЕ определяют роль:
 * роль хранится внутри системы Epic AI. Новый пользователь автоматически
 * получает роль «Игрок».
 */
import { getDb, insertReturningId, toBool, parseJson, type Row, type DbClient } from '../db/index.js';
import { syncPermissionCatalog } from '../permissions/catalog.js';

// 'discord' оставлен для legacy-identity в старых базах; новый dev-вход — 'local'
export type Provider = 'discord' | 'telegram' | 'local';

export interface IdentityInput {
  /** IP входа: используется для связывания identity в один аккаунт (раунд 30). */
  ip?: string | null;
  provider: Provider;
  providerUserId: string;
  username?: string | null;
  firstName?: string | null;
  lastName?: string | null;
  displayName?: string | null;
  avatarUrl?: string | null;
  raw?: Record<string, unknown> | null;
}

export interface UserProfile {
  id: number;
  username: string;
  displayName: string | null;
  avatarUrl: string | null;
  status: 'active' | 'blocked';
  blockedReason: string | null;
  createdAt: string | null;
  lastLoginAt: string | null;
  roles: { id: number; code: string; name: string; color: string; level: number; isSystem: boolean }[];
  primaryRole: { code: string; name: string; color: string; level: number } | null;
  identities: {
    provider: Provider;
    providerUserId: string;
    username: string | null;
    displayName: string | null;
    avatarUrl: string | null;
    linkedAt: string | null;
  }[];
}

const USERNAME_RE = /^[a-zA-Z0-9_а-яА-ЯёЁ.\-]{3,32}$/;

export function slugUsername(input: string | null | undefined, fallback = 'user'): string {
  let s = String(input ?? '').trim().replace(/\s+/g, '_');
  s = s.replace(/[^\wа-яА-ЯёЁ.\-]/g, '');
  if (s.length < 3) s = `${fallback}_${s || 'x'}`.slice(0, 32);
  if (!USERNAME_RE.test(s)) s = s.slice(0, 32) || fallback;
  return s;
}

async function uniqueUsername(db: DbClient, base: string): Promise<string> {
  let candidate = base;
  let i = 1;
  for (;;) {
    const exists = await db.get<Row>('SELECT id FROM users WHERE username = ?', [candidate]);
    if (!exists) return candidate;
    i += 1;
    candidate = `${base.slice(0, 28)}${i}`;
    if (i > 500) return `${base.slice(0, 20)}_${Date.now().toString(36)}`;
  }
}

async function ensurePlayerRole(db: DbClient): Promise<number> {
  let role = await db.get<Row>('SELECT id FROM roles WHERE code = ?', ['player']);
  if (!role) {
    // На случай запуска до сидов
    await syncPermissionCatalog(db);
    const id = await insertReturningId(db, 'roles', {
      code: 'player', name: 'Игрок', color: '#888888', level: 1, is_system: 0,
      created_at: new Date().toISOString(),
    });
    const perms = await db.all<Row>(
      `SELECT id FROM permissions WHERE code IN ('ai.use','ai.rules','ai.laws','ai.sources','ai.history','ai.feedback','settings.view')`,
    );
    for (const p of perms) {
      await db.run('INSERT INTO role_permissions (role_id, permission_id, created_at) VALUES (?, ?, ?) ON CONFLICT DO NOTHING',
        [id, Number(p.id), new Date().toISOString()]);
    }
    return id;
  }
  return Number(role.id);
}

/**
 * Поиск или создание Epic AI Account по внешней идентичности.
 * Один Discord/Telegram identity принадлежит только одному аккаунту.
 */
export async function findOrCreateUserByIdentity(input: IdentityInput): Promise<{ user: Row; created: boolean; linked?: boolean }> {
  const db = await getDb();
  const existing = await db.get<Row>(
    'SELECT * FROM identities WHERE provider = ? AND provider_user_id = ?',
    [input.provider, String(input.providerUserId)],
  );

  if (existing) {
    const user = await db.get<Row>('SELECT * FROM users WHERE id = ?', [Number(existing.user_id)]);
    if (!user) throw new Error(`Identity ${input.provider}:${input.providerUserId} указывает на несуществующего пользователя`);
    // Актуализируем профиль из провайдера (аватар/ник могли измениться) — 
    await db.run(
      `UPDATE identities SET username = COALESCE(?, username), first_name = COALESCE(?, first_name),
              last_name = COALESCE(?, last_name), display_name = COALESCE(?, display_name),
              avatar_url = COALESCE(?, avatar_url), raw = COALESCE(?, raw), last_used_at = ?
       WHERE id = ?`,
      [
        input.username ?? null, input.firstName ?? null, input.lastName ?? null,
        input.displayName ?? null, input.avatarUrl ?? null,
        input.raw ? JSON.stringify(input.raw) : null,
        new Date().toISOString(), Number(existing.id),
      ],
    );
    const newUsername = input.username ? slugUsername(input.username, 'user') : null;
    const newAvatar = input.avatarUrl ?? null;
    // ВАЖНО: display_name тоже актуализируем из провайдера. Раньше обновлялись
    // только username и avatar, из-за чего в пилюле панели оставалось имя,
    // заданное при создании аккаунта (например «Developer» после bootstrap),
    // а не реальный ник из Discord/Telegram.
    await db.run(
      'UPDATE users SET username = COALESCE(?, username), display_name = COALESCE(?, display_name), avatar_url = COALESCE(?, avatar_url), updated_at = ?, last_login_at = ? WHERE id = ?',
      [newUsername, input.displayName ?? null, newAvatar, new Date().toISOString(), new Date().toISOString(), Number(user.id)],
    );
    return { user: {...(await db.get<Row>('SELECT * FROM users WHERE id = ?', [Number(user.id)])) }, created: false };
  }

  // П.3 раунда 30: Discord и Telegram одного человека — ОДИН аккаунт.
  // Связывание по IP: ищем активный аккаунт с самой свежей сессией с того же
  // адреса, с которого пришёл вход, и привязываем новую identity к нему.
  // (Раунд 29 связывал по нику — заменено по требованию пользователя.)
  if (input.ip) {
    const match = await db.get<Row>(
      `SELECT u.* FROM sessions s JOIN users u ON u.id = s.user_id
        WHERE s.ip = ? AND u.status = 'active'
        ORDER BY s.last_seen_at DESC LIMIT 1`,
      [String(input.ip)],
    );
    if (match) {
      await insertReturningId(db, 'identities', {
        user_id: Number(match.id),
        provider: input.provider,
        provider_user_id: String(input.providerUserId),
        username: input.username ?? null,
        first_name: input.firstName ?? null,
        last_name: input.lastName ?? null,
        display_name: input.displayName ?? null,
        avatar_url: input.avatarUrl ?? null,
        raw: input.raw ? JSON.stringify(input.raw) : null,
        created_at: new Date().toISOString(),
        last_used_at: new Date().toISOString(),
      });
      return { user: { ...match }, created: false, linked: true };
    }
  }

  // --- Создаём новый Epic AI Account ---
  const baseName = slugUsername(input.username ?? input.displayName ?? input.firstName ?? `${input.provider}_user`, input.provider);
  const username = await uniqueUsername(db, baseName);
  const full = [input.firstName, input.lastName].filter(Boolean).join(' ');
  const displayName = input.displayName ?? (full || username);

  const userId = await insertReturningId(db, 'users', {
    username,
    display_name: displayName,
    avatar_url: input.avatarUrl ?? null,
    status: 'active',
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    last_login_at: new Date().toISOString(),
  });

  await insertReturningId(db, 'identities', {
    user_id: userId,
    provider: input.provider,
    provider_user_id: String(input.providerUserId),
    username: input.username ?? null,
    first_name: input.firstName ?? null,
    last_name: input.lastName ?? null,
    display_name: input.displayName ?? null,
    avatar_url: input.avatarUrl ?? null,
    raw: input.raw ? JSON.stringify(input.raw) : null,
    created_at: new Date().toISOString(),
    last_used_at: new Date().toISOString(),
  });

  // Новый пользователь получает роль «Игрок» (критерий готовности v1)
  const playerRoleId = await ensurePlayerRole(db);
  await db.run('INSERT INTO user_roles (user_id, role_id, assigned_at) VALUES (?, ?, ?) ON CONFLICT DO NOTHING',
    [userId, playerRoleId, new Date().toISOString()]);

  const user = await db.get<Row>('SELECT * FROM users WHERE id = ?', [userId]);
  return { user: user!, created: true };
}

/** Привязать дополнительную идентичность к существующему аккаунту. */
export async function linkIdentity(userId: number, input: IdentityInput): Promise<void> {
  const db = await getDb();
  const taken = await db.get<Row>(
    'SELECT user_id FROM identities WHERE provider = ? AND provider_user_id = ?',
    [input.provider, String(input.providerUserId)],
  );
  if (taken && Number(taken.user_id) !== userId) {
    const err: any = new Error('Этот аккаунт Discord/Telegram уже привязан к другому Epic AI Account');
    err.statusCode = 409;
    err.code = 'identity_taken';
    throw err;
  }
  if (taken) return;
  await insertReturningId(db, 'identities', {
    user_id: userId,
    provider: input.provider,
    provider_user_id: String(input.providerUserId),
    username: input.username ?? null,
    first_name: input.firstName ?? null,
    last_name: input.lastName ?? null,
    display_name: input.displayName ?? null,
    avatar_url: input.avatarUrl ?? null,
    raw: input.raw ? JSON.stringify(input.raw) : null,
    created_at: new Date().toISOString(),
    last_used_at: new Date().toISOString(),
  });
}

export async function getUserProfile(userId: number): Promise<UserProfile | null> {
  const db = await getDb();
  const u = await db.get<Row>('SELECT * FROM users WHERE id = ?', [userId]);
  if (!u) return null;

  const roles = await db.all<Row>(
    `SELECT r.id, r.code, r.name, r.color, r.level, r.is_system
       FROM user_roles ur JOIN roles r ON r.id = ur.role_id
      WHERE ur.user_id = ? ORDER BY r.level DESC`,
    [userId],
  );
  const ids = await db.all<Row>('SELECT * FROM identities WHERE user_id = ? ORDER BY created_at', [userId]);

  const mappedRoles = roles.map((r) => ({
    id: Number(r.id), code: String(r.code), name: String(r.name),
    color: String(r.color), level: Number(r.level), isSystem: toBool(r.is_system),
  }));
  const primary = mappedRoles[0] ?? null;

  return {
    id: Number(u.id),
    username: String(u.username),
    displayName: u.display_name == null ? null : String(u.display_name),
    avatarUrl: u.avatar_url == null ? null : String(u.avatar_url),
    status: String(u.status) === 'blocked' ? 'blocked' : 'active',
    blockedReason: u.blocked_reason == null ? null : String(u.blocked_reason),
    createdAt: u.created_at == null ? null : String(u.created_at),
    lastLoginAt: u.last_login_at == null ? null : String(u.last_login_at),
    roles: mappedRoles,
    primaryRole: primary ? { code: primary.code, name: primary.name, color: primary.color, level: primary.level } : null,
    identities: ids.map((i) => ({
      provider: String(i.provider) as Provider,
      providerUserId: String(i.provider_user_id),
      username: i.username == null ? null : String(i.username),
      displayName: i.display_name == null ? null : String(i.display_name),
      avatarUrl: i.avatar_url == null ? null : String(i.avatar_url),
      linkedAt: i.created_at == null ? null : String(i.created_at),
    })),
  };
}

export async function listUsers(opts: {
  search?: string; role?: string; status?: string; limit?: number; offset?: number;
} = {}): Promise<{ total: number; items: UserProfile[] }> {
  const db = await getDb();
  const where: string[] = [];
  const params: unknown[] = [];

  if (opts.search) {
    where.push(`(u.username LIKE ? OR u.display_name LIKE ? OR CAST(u.id AS TEXT) = ?
                 OR EXISTS (SELECT 1 FROM identities i WHERE i.user_id = u.id AND (i.provider_user_id = ? OR i.username LIKE ? OR i.display_name LIKE ?)))`);
    const s = `%${opts.search}%`;
    const idNum = /^\d+$/.test(opts.search) ? Number(opts.search) : -1;
    params.push(s, s, idNum, opts.search, s, s);
  }
  if (opts.role) {
    where.push('EXISTS (SELECT 1 FROM user_roles ur JOIN roles r ON r.id = ur.role_id WHERE ur.user_id = u.id AND r.code = ?)');
    params.push(opts.role);
  }
  if (opts.status) { where.push('u.status = ?'); params.push(opts.status); }

  const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const limit = Math.min(Math.max(opts.limit ?? 50, 1), 200);
  const offset = Math.max(opts.offset ?? 0, 0);

  const total = Number((await db.get<Row>(`SELECT COUNT(*) AS c FROM users u ${whereSql}`, params))?.c ?? 0);
  const rows = await db.all<Row>(
    `SELECT u.id FROM users u ${whereSql} ORDER BY u.id DESC LIMIT ? OFFSET ?`,
    [...params, limit, offset],
  );

  const items: UserProfile[] = [];
  for (const r of rows) {
    const p = await getUserProfile(Number(r.id));
    if (p) items.push(p);
  }
  return { total, items };
}

/** Блокировка / разблокировка. */
export async function setUserBlocked(userId: number, blocked: boolean, reason: string | null, actorId: number | null): Promise<void> {
  const db = await getDb();
  if (blocked) {
    await db.run(
      `UPDATE users SET status = 'blocked', blocked_reason = ?, blocked_by = ?, blocked_at = ?, updated_at = ? WHERE id = ?`,
      [reason, actorId, new Date().toISOString(), new Date().toISOString(), userId],
    );
    // Существующие сессии инвалидируются 
    await db.run(
      'UPDATE sessions SET revoked_at = ?, revoke_reason = ? WHERE user_id = ? AND revoked_at IS NULL',
      [new Date().toISOString(), 'blocked', userId],
    );
  } else {
    await db.run(
      `UPDATE users SET status = 'active', blocked_reason = NULL, blocked_by = NULL, blocked_at = NULL, updated_at = ? WHERE id = ?`,
      [new Date().toISOString(), userId],
    );
  }
}

export async function setUserRole(userId: number, roleCode: string, actorId: number | null): Promise<void> {
  const db = await getDb();
  const role = await db.get<Row>('SELECT * FROM roles WHERE code = ?', [roleCode]);
  if (!role) {
    const e: any = new Error(`Роль не найдена: ${roleCode}`); e.statusCode = 404; throw e;
  }
  await db.transaction(async (tx) => {
    await tx.run('DELETE FROM user_roles WHERE user_id = ?', [userId]);
    await tx.run('INSERT INTO user_roles (user_id, role_id, assigned_by, assigned_at) VALUES (?, ?, ?, ?)',
      [userId, Number(role.id), actorId, new Date().toISOString()]);
  });
}

export async function getUserOverrides(userId: number): Promise<{ allow: string[]; deny: string[] }> {
  const db = await getDb();
  const rows = await db.all<Row>(
    `SELECT p.code, uo.effect FROM user_permission_overrides uo JOIN permissions p ON p.id = uo.permission_id WHERE uo.user_id = ?`,
    [userId],
  );
  return {
    allow: rows.filter((r) => r.effect === 'allow').map((r) => String(r.code)),
    deny: rows.filter((r) => r.effect === 'deny').map((r) => String(r.code)),
  };
}

export async function setUserOverride(userId: number, permissionCode: string, effect: 'allow' | 'deny' | null, opts: { reason?: string; grantedBy?: number | null } = {}): Promise<void> {
  const db = await getDb();
  const perm = await db.get<Row>('SELECT id FROM permissions WHERE code = ?', [permissionCode]);
  if (!perm) { const e: any = new Error(`Permission не найден: ${permissionCode}`); e.statusCode = 404; throw e; }

  if (effect === null) {
    await db.run('DELETE FROM user_permission_overrides WHERE user_id = ? AND permission_id = ?', [userId, Number(perm.id)]);
    return;
  }
  const existing = await db.get<Row>('SELECT id FROM user_permission_overrides WHERE user_id = ? AND permission_id = ?', [userId, Number(perm.id)]);
  if (existing) {
    await db.run('UPDATE user_permission_overrides SET effect = ?, reason = ?, granted_by = ? WHERE id = ?',
      [effect, opts.reason ?? null, opts.grantedBy ?? null, Number(existing.id)]);
  } else {
    await insertReturningId(db, 'user_permission_overrides', {
      user_id: userId, permission_id: Number(perm.id), effect,
      reason: opts.reason ?? null, granted_by: opts.grantedBy ?? null,
      created_at: new Date().toISOString(),
    });
  }
}

export function serializeUserProfile(p: UserProfile) {
  return {
    id: p.id,
    username: p.username,
    displayName: p.displayName,
    avatarUrl: p.avatarUrl,
    status: p.status,
    blockedReason: p.blockedReason,
    createdAt: p.createdAt,
    lastLoginAt: p.lastLoginAt,
    roles: p.roles,
    primaryRole: p.primaryRole,
    identities: p.identities,
  };
}

export { parseJson };
