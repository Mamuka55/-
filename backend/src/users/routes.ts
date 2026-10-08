/**
 * EPIC AI — маршруты пользователей.
 */
import type { FastifyInstance } from 'fastify';
import { getDb, formatDateTime, parseJson, type Row } from '../db/index.js';
import { requirePermission, requireAuth, BadRequestError, NotFoundError, ForbiddenError } from '../http/guards.js';
import {
  listUsers, getUserProfile, serializeUserProfile, setUserBlocked, setUserRole,
  getUserOverrides, setUserOverride,
} from './service.js';
import { computeEffectivePermissions, canAssignRole } from '../permissions/catalog.js';
import { revokeSessionsForUser } from '../auth/session.js';
import { audit, AUDIT_ACTIONS } from '../audit/index.js';
import { getQuota, setQuotaLimit } from '../ai/quota.js';

export async function registerUserRoutes(app: FastifyInstance): Promise<void> {
  /** GET /api/users/me — профиль текущего пользователя. */
  app.get('/api/users/me', { preHandler: [requireAuth] }, async (req, reply) => {
    const profile = await getUserProfile(req.auth!.user.id);
    if (!profile) throw new NotFoundError('Пользователь не найден');
    const overrides = await getUserOverrides(profile.id);
    return reply.send({
     ...serializeUserProfile(profile),
      permissions: [...req.auth!.permissions.codes].sort(),
      extraPermissions: overrides.allow,
      deniedPermissions: overrides.deny,
      maxRoleLevel: req.auth!.permissions.maxLevel,
      isDeveloper: req.auth!.permissions.isDeveloper,
      createdAtLabel: formatDateTime(profile.createdAt),
      lastLoginLabel: formatDateTime(profile.lastLoginAt),
    });
  });

  /*
   * PUT /api/users/me НАМЕРЕННО ОТСУТСТВУЕТ.
   *
   * Требование пользователя: никнейм берётся ИЗ Discord/Telegram при входе
   * (users/service.ts синхронизирует users.display_name с identity провайдера),
   * самостоятельное переименование через UI исключено. Для локальных
   * bootstrap-аккаунтов имя задаётся через CLI: `npm run bootstrap:developer --
   * --name "Ник"` либо `npm run users --role/--developer` (audit: via cli).
   */

  /** GET /api/users — список. Поиск по никнейму, ID, Discord, Telegram. */
  app.get('/api/users', { preHandler: [requirePermission('users.view')] }, async (req, reply) => {
    const q = (req.query ?? {}) as Record<string, string>;
    const { total, items } = await listUsers({
      search: q.search || undefined,
      role: q.role || undefined,
      status: q.status || undefined,
      limit: Number(q.limit ?? 50),
      offset: Number(q.offset ?? 0),
    });
    return reply.send({
      total,
      items: items.map((u) => ({
       ...serializeUserProfile(u),
        lastLoginLabel: formatDateTime(u.lastLoginAt),
        createdAtLabel: formatDateTime(u.createdAt),
        discord: u.identities.find((i) => i.provider === 'discord') ?? null,
        telegram: u.identities.find((i) => i.provider === 'telegram') ?? null,
      })),
    });
  });

  /** GET /api/users/:id — карточка пользователя. */
  app.get('/api/users/:id', { preHandler: [requirePermission('users.view')] }, async (req, reply) => {
    const p = req.params as { id: string };
    const id = Number(p.id);
    const profile = await getUserProfile(id);
    if (!profile) throw new NotFoundError('Пользователь не найден');
    const db = await getDb();
    const perms = await computeEffectivePermissions(db, id);
    const overrides = await getUserOverrides(id);
    const history = await db.all<Row>(
      `SELECT id, action, entity_type, entity_id, meta, created_at FROM audit_logs
        WHERE actor_id = ? OR (entity_type = 'user' AND entity_id = ?)
        ORDER BY id DESC LIMIT 50`,
      [id, String(id)],
    );
    const sessions = await db.all<Row>(
      'SELECT id, created_at, last_seen_at, expires_at, revoked_at, ip, user_agent FROM sessions WHERE user_id = ? ORDER BY id DESC LIMIT 20',
      [id],
    );

    return reply.send({
     ...serializeUserProfile(profile),
      createdAtLabel: formatDateTime(profile.createdAt),
      lastLoginLabel: formatDateTime(profile.lastLoginAt),
      quota: await getQuota(id),
      permissions: [...perms.codes].sort(),
      permissionsDetail: { fromRoles: perms.fromRoles, extra: overrides.allow, denied: overrides.deny },
      maxRoleLevel: perms.maxLevel,
      isDeveloper: perms.isDeveloper,
      discord: profile.identities.find((i) => i.provider === 'discord') ?? null,
      telegram: profile.identities.find((i) => i.provider === 'telegram') ?? null,
      sessions: sessions.map((s) => ({
        id: Number(s.id), createdAt: s.created_at, lastSeenAt: s.last_seen_at,
        expiresAt: s.expires_at, revokedAt: s.revoked_at, ip: s.ip, userAgent: s.user_agent,
      })),
      history: history.map((h) => ({
        id: Number(h.id), action: String(h.action), entityType: h.entity_type, entityId: h.entity_id,
        meta: parseJson(h.meta, null), createdAt: h.created_at, createdAtLabel: formatDateTime(h.created_at),
      })),
      // Какие действия доступны текущему администратору 
      availableActions: {
        canEdit: req.auth!.permissions.codes.has('users.edit'),
        canBlock: req.auth!.permissions.codes.has('users.block') && id !== req.auth!.user.id,
        canAssignRole: req.auth!.permissions.codes.has('roles.assign') && id !== req.auth!.user.id,
        canManagePermissions: req.auth!.permissions.codes.has('permissions.manage') && id !== req.auth!.user.id,
        assignableRoles: [],
      },
    });
  });

  /**
   * PATCH /api/users/:id/role — назначение роли.
   * Администратор не может назначить роль выше своего разрешённого уровня.
   * Developer в списке ролей для назначения отсутствует.
   */
  app.patch('/api/users/:id/role', { preHandler: [requirePermission('roles.assign')] }, async (req, reply) => {
    const p = req.params as { id: string };
    const body = (req.body ?? {}) as { role?: string };
    const id = Number(p.id);
    const roleCode = String(body.role ?? '');
    if (!roleCode) throw new BadRequestError('Укажите роль');
    if (id === req.auth!.user.id) throw new BadRequestError('Нельзя изменить собственную роль');

    const db = await getDb();
    const role = await db.get<Row>('SELECT * FROM roles WHERE code = ?', [roleCode]);
    if (!role) throw new NotFoundError('Роль не найдена');
    if (!canAssignRole(req.auth!.permissions, Number(role.level), Boolean(Number(role.is_system)))) {
      throw new ForbiddenError('Вы не можете назначить роль выше своего уровня (Developer не назначается через панель)');
    }

    const before = await getUserProfile(id);
    await setUserRole(id, roleCode, req.auth!.user.id);
    const after = await getUserProfile(id);

    await audit({
      actorId: req.auth!.user.id, actorName: req.auth!.user.username,
      action: AUDIT_ACTIONS.ROLE_CHANGE, entityType: 'user', entityId: id,
      meta: { from: before?.primaryRole?.code ?? null, to: roleCode }, ip: req.ip,
    });
    return reply.send({ ok: true, userId: id, role: after?.primaryRole ?? null });
  });

  /**
   * PUT /api/users/:id/quota — персональный дневной лимит запросов к ИИ.
   * { dailyLimit: number } — выдать лимит; { dailyLimit: null } — вернуть
   * общий лимит по умолчанию (50). Значение видно в карточке пользователя
   * и в профиле настроек самого пользователя.
   */
  app.put('/api/users/:id/quota', { preHandler: [requirePermission('users.edit')] }, async (req, reply) => {
    const p = req.params as { id: string };
    const body = (req.body ?? {}) as { dailyLimit?: number | null };
    const id = Number(p.id);
    if (!Number.isFinite(id) || id <= 0) throw new NotFoundError('Пользователь не найден');
    const profile = await getUserProfile(id);
    if (!profile) throw new NotFoundError('Пользователь не найден');
    const raw = body.dailyLimit;
    const limit = raw == null ? null : Number(raw);
    if (limit != null && (!Number.isFinite(limit) || limit < 0)) {
      throw new BadRequestError('Лимит должен быть неотрицательным числом (или null для общего лимита)');
    }
    const quota = await setQuotaLimit(id, limit, req.auth!.user.id);
    await audit({
      actorId: req.auth!.user.id, actorName: req.auth!.user.username,
      action: AUDIT_ACTIONS.QUOTA_CHANGE, entityType: 'user', entityId: id,
      meta: { dailyLimit: limit }, ip: req.ip,
    });
    return reply.send({ ok: true, userId: id, quota });
  });

  /** PATCH /api/users/:id/status — блокировка / разблокировка. */
  app.patch('/api/users/:id/status', { preHandler: [requirePermission('users.block')] }, async (req, reply) => {
    const p = req.params as { id: string };
    const body = (req.body ?? {}) as { blocked?: boolean; reason?: string };
    const id = Number(p.id);
    if (id === req.auth!.user.id) throw new BadRequestError('Нельзя заблокировать самого себя');
    if (typeof body.blocked !== 'boolean') throw new BadRequestError('Укажите blocked: true|false');

    const db = await getDb();
    const target = await db.get<Row>('SELECT * FROM users WHERE id = ?', [id]);
    if (!target) throw new NotFoundError('Пользователь не найден');

    // Нельзя заблокировать того, кто стоит выше по иерархии
    const targetPerms = await computeEffectivePermissions(db, id);
    if (!req.auth!.permissions.isDeveloper && targetPerms.maxLevel >= req.auth!.permissions.maxLevel) {
      throw new ForbiddenError('Нельзя заблокировать пользователя с ролью не ниже вашей');
    }

    await setUserBlocked(id, body.blocked, body.reason ?? null, req.auth!.user.id);
    if (body.blocked) await revokeSessionsForUser(id, 'blocked');

    await audit({
      actorId: req.auth!.user.id, actorName: req.auth!.user.username,
      action: body.blocked ? AUDIT_ACTIONS.BLOCK : AUDIT_ACTIONS.UNBLOCK,
      entityType: 'user', entityId: id,
      meta: { reason: body.reason ?? null, sessionsRevoked: body.blocked }, ip: req.ip,
    });
    return reply.send({ ok: true, userId: id, status: body.blocked ? 'blocked' : 'active' });
  });

  /**
   * PUT /api/users/:id/permissions/{allow,deny} — индивидуальные разрешения.
   * body: { permission: 'knowledge.sync', effect: 'allow'|'deny'|null, reason? }
   */
  app.put('/api/users/:id/permissions', { preHandler: [requirePermission('permissions.manage')] }, async (req, reply) => {
    const p = req.params as { id: string };
    const body = (req.body ?? {}) as { permission?: string; effect?: 'allow' | 'deny' | null; reason?: string };
    const id = Number(p.id);
    const permission = String(body.permission ?? '');
    const effect = body.effect === undefined ? null : body.effect;
    if (!permission) throw new BadRequestError('Укажите permission');
    if (effect !== null && effect !== 'allow' && effect !== 'deny') throw new BadRequestError('effect: allow | deny | null');

    const db = await getDb();
    const exists = await db.get<Row>('SELECT id FROM users WHERE id = ?', [id]);
    if (!exists) throw new NotFoundError('Пользователь не найден');

    await setUserOverride(id, permission, effect, { reason: body.reason, grantedBy: req.auth!.user.id });
    await audit({
      actorId: req.auth!.user.id, actorName: req.auth!.user.username,
      action: effect === null ? AUDIT_ACTIONS.PERMISSION_REMOVE : AUDIT_ACTIONS.PERMISSION_ADD,
      entityType: 'user', entityId: id,
      meta: { permission, effect, reason: body.reason ?? null }, ip: req.ip,
    });
    const overrides = await getUserOverrides(id);
    return reply.send({ ok: true, userId: id, allow: overrides.allow, deny: overrides.deny });
  });

  /** GET /api/users/:id/permissions */
  app.get('/api/users/:id/permissions', { preHandler: [requirePermission('permissions.view')] }, async (req, reply) => {
    const p = req.params as { id: string };
    const db = await getDb();
    const perms = await computeEffectivePermissions(db, Number(p.id));
    const overrides = await getUserOverrides(Number(p.id));
    return reply.send({
      userId: Number(p.id),
      effective: [...perms.codes].sort(),
      fromRoles: perms.fromRoles.sort(),
      extra: overrides.allow.sort(),
      denied: overrides.deny.sort(),
      roles: perms.roles,
      maxLevel: perms.maxLevel,
      isDeveloper: perms.isDeveloper,
    });
  });

  /** POST /api/users/:id/sessions/revoke — принудительно завершить сессии. */
  /**
   * DELETE /api/users/:id — удаление аккаунта (п.5 раунда 29).
   * Нельзя удалить себя и аккаунт с системной ролью (Developer).
   * Чистятся все связи; Audit Log сохраняется (append-only).
   */
  app.delete('/api/users/:id', { preHandler: [requirePermission('users.edit')] }, async (req, reply) => {
    const id = Number((req.params as { id: string }).id);
    if (!Number.isFinite(id) || id <= 0) throw new BadRequestError('Некорректный id пользователя');
    if (id === req.auth!.user.id) throw new BadRequestError('Нельзя удалить собственный аккаунт');
    const db = await getDb();
    const user = await db.get<Row>('SELECT * FROM users WHERE id = ?', [id]);
    if (!user) throw new NotFoundError('Пользователь не найден');
    const sys = await db.get<Row>(
      'SELECT 1 AS x FROM user_roles ur JOIN roles r ON r.id = ur.role_id WHERE ur.user_id = ? AND r.is_system = 1',
      [id],
    );
    if (sys) throw new ForbiddenError('Аккаунт с системной ролью (Developer) удалить нельзя');
    for (const t of ['sessions', 'identities', 'user_roles', 'user_permission_overrides', 'user_settings', 'ai_quotas', 'ai_feedback', 'ai_reports', 'ai_requests']) {
      await db.run(`DELETE FROM ${t} WHERE user_id = ?`, [id]);
    }
    await db.run('DELETE FROM users WHERE id = ?', [id]);
    await audit({
      actorId: req.auth!.user.id, actorName: req.auth!.user.username,
      action: 'user.delete', entityType: 'user', entityId: String(id),
      meta: { username: String(user.username) }, ip: req.ip,
    });
    return reply.send({ ok: true });
  });

  app.post('/api/users/:id/sessions/revoke', { preHandler: [requirePermission('users.edit')] }, async (req, reply) => {
    const p = req.params as { id: string };
    const n = await revokeSessionsForUser(Number(p.id), 'admin_revoke');
    await audit({ actorId: req.auth!.user.id, actorName: req.auth!.user.username, action: 'user.sessions.revoke', entityType: 'user', entityId: p.id, meta: { revoked: n }, ip: req.ip });
    return reply.send({ ok: true, revoked: n });
  });

  /** GET /api/users/blocked — раздел «Блокировки». */
  app.get('/api/users/blocked', { preHandler: [requirePermission('users.view')] }, async (_req, reply) => {
    const db = await getDb();
    const rows = await db.all<Row>(
      `SELECT u.id, u.username, u.avatar_url, u.blocked_reason, u.blocked_at, u.blocked_by, b.username AS blocked_by_name
         FROM users u LEFT JOIN users b ON b.id = u.blocked_by
        WHERE u.status = 'blocked' ORDER BY u.blocked_at DESC`,
    );
    return reply.send({
      items: rows.map((r) => ({
        id: Number(r.id), username: String(r.username), avatarUrl: r.avatar_url,
        reason: r.blocked_reason, blockedAt: r.blocked_at, blockedAtLabel: formatDateTime(r.blocked_at),
        blockedBy: r.blocked_by == null ? null : { id: Number(r.blocked_by), username: r.blocked_by_name },
      })),
    });
  });
}
