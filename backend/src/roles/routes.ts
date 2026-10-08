/**
 * EPIC AI — маршруты ролей.
 */
import type { FastifyInstance } from 'fastify';
import { getDb, toBool, type Row, type DbClient } from '../db/index.js';
import { requirePermission, BadRequestError, NotFoundError, ForbiddenError } from '../http/guards.js';
import { ROLES } from '../shared.js';
import { audit } from '../audit/index.js';

export async function registerRoleRoutes(app: FastifyInstance): Promise<void> {
  /** GET /api/roles — список ролей с их permissions. */
  app.get('/api/roles', { preHandler: [requirePermission('roles.view')] }, async (req, reply) => {
    const db = await getDb();
    const roles = await db.all<Row>('SELECT * FROM roles ORDER BY level ASC');
    const maxLevel = req.auth!.permissions.maxLevel;
    const isDev = req.auth!.permissions.isDeveloper;

    const items = await Promise.all(roles.map(async (r) => {
      const perms = await db.all<Row>(
        `SELECT p.code FROM role_permissions rp JOIN permissions p ON p.id = rp.permission_id WHERE rp.role_id = ? ORDER BY p.code`,
        [Number(r.id)],
      );
      const users = await db.get<Row>('SELECT COUNT(*) AS c FROM user_roles WHERE role_id = ?', [Number(r.id)]);
      const level = Number(r.level);
      return {
        id: Number(r.id),
        code: String(r.code),
        name: String(r.name),
        color: String(r.color),
        level,
        isSystem: toBool(r.is_system),
        permissions: perms.map((p) => String(p.code)),
        userCount: Number(users?.c ?? 0),
        // Developer не доступен для назначения в обычной панели 
        assignable: !toBool(r.is_system) && (isDev ? level <= maxLevel : level < maxLevel),
        visible: isDev || level <= maxLevel,
      };
    }));

    return reply.send({
      items,
      // Справочник из — для проверки, что БД не разъехалась с дизайном
      spec: ROLES,
      actor: { maxLevel, isDeveloper: isDev },
    });
  });

  /** GET /api/roles/assignable — роли, которые текущий администратор может выдать. */
  app.get('/api/roles/assignable', { preHandler: [requirePermission('roles.assign')] }, async (req, reply) => {
    const db = await getDb();
    const roles = await db.all<Row>('SELECT * FROM roles ORDER BY level ASC');
    const items = roles
     .filter((r) => canAssignNow(req.auth!.permissions, Number(r.level), toBool(r.is_system)))
     .map((r) => ({ code: String(r.code), name: String(r.name), color: String(r.color), level: Number(r.level) }));
    return reply.send({ items });
  });

  /**
   * POST /api/roles — создание роли (roles.manage).
   * Роль уровня выше своего создать нельзя.
   */
  app.post('/api/roles', { preHandler: [requirePermission('roles.manage')] }, async (req, reply) => {
    const body = (req.body ?? {}) as { code?: string; name?: string; color?: string; level?: number; permissions?: string[] };
    const code = String(body.code ?? '').trim().toLowerCase();
    const name = String(body.name ?? '').trim();
    if (!/^[a-z_][a-z0-9_]{1,46}$/.test(code)) throw new BadRequestError('code: 2–47 символов, латиница/цифры/_');
    if (!name) throw new BadRequestError('Укажите название роли');
    const level = Number(body.level ?? 2);
    if (!Number.isFinite(level) || level < 1) throw new BadRequestError('Некорректный level');
    if (!req.auth!.permissions.isDeveloper && level >= req.auth!.permissions.maxLevel) {
      throw new ForbiddenError('Нельзя создать роль уровня не ниже своего');
    }
    const db = await getDb();
    if (await db.get<Row>('SELECT id FROM roles WHERE code = ?', [code])) throw new BadRequestError('Роль с таким code уже существует');

    await db.run('INSERT INTO roles (code, name, color, level, is_system, created_at) VALUES (?, ?, ?, ?, 0, ?)',
      [code, name, String(body.color ?? '#888888'), level, new Date().toISOString()]);
    const role = await db.get<Row>('SELECT * FROM roles WHERE code = ?', [code]);
    if (Array.isArray(body.permissions)) await setRolePermissions(db, Number(role!.id), body.permissions);

    await audit({ actorId: req.auth!.user.id, actorName: req.auth!.user.username, action: 'role.create', entityType: 'role', entityId: code, meta: body, ip: req.ip });
    return reply.code(201).send({ ok: true, id: Number(role!.id), code, name, level });
  });

  /** PATCH /api/roles/:code — изменить название/цвет/permissions. */
  app.patch('/api/roles/:code', { preHandler: [requirePermission('roles.manage')] }, async (req, reply) => {
    const p = req.params as { code: string };
    const body = (req.body ?? {}) as { name?: string; color?: string; permissions?: string[] };
    const db = await getDb();
    const role = await db.get<Row>('SELECT * FROM roles WHERE code = ?', [p.code]);
    if (!role) throw new NotFoundError('Роль не найдена');
    if (toBool(role.is_system) && !req.auth!.permissions.isDeveloper) {
      throw new ForbiddenError('Системную роль (Developer) можно изменить только разработчику');
    }
    if (!req.auth!.permissions.isDeveloper && Number(role.level) >= req.auth!.permissions.maxLevel) {
      throw new ForbiddenError('Нельзя изменить роль уровня не ниже своего');
    }
    const sets: string[] = [];
    const params: unknown[] = [];
    if (body.name !== undefined) { sets.push('name = ?'); params.push(String(body.name)); }
    if (body.color !== undefined) { sets.push('color = ?'); params.push(String(body.color)); }
    if (sets.length) await db.run(`UPDATE roles SET ${sets.join(', ')} WHERE id = ?`, [...params, Number(role.id)]);
    if (Array.isArray(body.permissions)) await setRolePermissions(db, Number(role.id), body.permissions);

    await audit({ actorId: req.auth!.user.id, actorName: req.auth!.user.username, action: 'role.update', entityType: 'role', entityId: p.code, meta: body, ip: req.ip });
    return reply.send({ ok: true });
  });

  /** DELETE /api/roles/:code — удалить роль (нельзя системные и нельзя роли ≥ своего уровня). */
  app.delete('/api/roles/:code', { preHandler: [requirePermission('roles.manage')] }, async (req, reply) => {
    const p = req.params as { code: string };
    const db = await getDb();
    const role = await db.get<Row>('SELECT * FROM roles WHERE code = ?', [p.code]);
    if (!role) throw new NotFoundError('Роль не найдена');
    if (toBool(role.is_system)) throw new ForbiddenError('Системную роль удалить нельзя');
    if (['player', 'helper', 'admin', 'chief_admin'].includes(String(role.code))) {
      throw new ForbiddenError('Базовые роли из удалить нельзя');
    }
    const users = Number((await db.get<Row>('SELECT COUNT(*) AS c FROM user_roles WHERE role_id = ?', [Number(role.id)]))?.c ?? 0);
    if (users > 0) throw new BadRequestError(`Роль назначена ${users} пользователям — сначала снимите её`);

    await db.run('DELETE FROM role_permissions WHERE role_id = ?', [Number(role.id)]);
    await db.run('DELETE FROM roles WHERE id = ?', [Number(role.id)]);
    await audit({ actorId: req.auth!.user.id, actorName: req.auth!.user.username, action: 'role.delete', entityType: 'role', entityId: p.code, ip: req.ip });
    return reply.send({ ok: true });
  });
}

function canAssignNow(perms: { codes: Set<string>; maxLevel: number; isDeveloper: boolean }, targetLevel: number, targetIsSystem: boolean): boolean {
  if (!perms.codes.has('roles.assign')) return false;
  if (targetIsSystem) return false;
  return perms.isDeveloper ? targetLevel <= perms.maxLevel : targetLevel < perms.maxLevel;
}

async function setRolePermissions(db: DbClient, roleId: number, codes: string[]): Promise<void> {
  const unique = [...new Set(codes.map((c) => String(c).trim()).filter(Boolean))];
  await db.run('DELETE FROM role_permissions WHERE role_id = ?', [roleId]);
  if (!unique.length) return;
  const rows = await db.all<Row>(`SELECT id FROM permissions WHERE code IN (${unique.map(() => '?').join(',')})`, unique);
  for (const r of rows) {
    await db.run('INSERT INTO role_permissions (role_id, permission_id, created_at) VALUES (?, ?, ?) ON CONFLICT DO NOTHING',
      [roleId, Number(r.id), new Date().toISOString()]);
  }
}
