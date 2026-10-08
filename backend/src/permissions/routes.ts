/**
 * EPIC AI — маршруты permissions.
 */
import type { FastifyInstance } from 'fastify';
import { getDb, type Row } from '../db/index.js';
import { requirePermission } from '../http/guards.js';
import { PERMISSION_CATALOG, syncPermissionCatalog } from './catalog.js';
import { audit } from '../audit/index.js';

export async function registerPermissionRoutes(app: FastifyInstance): Promise<void> {
  /** GET /api/permissions — каталог, сгруппированный по категориям. */
  app.get('/api/permissions', { preHandler: [requirePermission('permissions.view')] }, async (_req, reply) => {
    const db = await getDb();
    await syncPermissionCatalog(db);
    const rows = await db.all<Row>('SELECT * FROM permissions ORDER BY category, code');
    const groups = new Map<string, any[]>();
    for (const r of rows) {
      const cat = String(r.category ?? 'general');
      if (!groups.has(cat)) groups.set(cat, []);
      groups.get(cat)!.push({ id: Number(r.id), code: String(r.code), description: r.description });
    }
    return reply.send({
      items: rows.map((r) => ({ id: Number(r.id), code: String(r.code), category: String(r.category), description: r.description })),
      groups: [...groups.entries()].map(([category, items]) => ({ category, items })),
      spec: PERMISSION_CATALOG,
    });
  });

  /** POST /api/permissions/sync — досинхронизировать каталог из кода (permissions.manage). */
  app.post('/api/permissions/sync', { preHandler: [requirePermission('permissions.manage')] }, async (req, reply) => {
    const db = await getDb();
    await syncPermissionCatalog(db);
    const total = Number((await db.get<Row>('SELECT COUNT(*) AS c FROM permissions'))?.c ?? 0);
    await audit({ actorId: req.auth!.user.id, actorName: req.auth!.user.username, action: 'permission.catalog.sync', entityType: 'permission', meta: { total }, ip: req.ip });
    return reply.send({ ok: true, total });
  });

  /** GET /api/permissions/matrix — матрица «роль × permission» для админки. */
  app.get('/api/permissions/matrix', { preHandler: [requirePermission('permissions.view')] }, async (_req, reply) => {
    const db = await getDb();
    const roles = await db.all<Row>('SELECT id, code, name, color, level, is_system FROM roles ORDER BY level');
    const perms = await db.all<Row>('SELECT id, code, category FROM permissions ORDER BY category, code');
    const links = await db.all<Row>('SELECT role_id, permission_id FROM role_permissions');
    const set = new Set(links.map((l) => `${Number(l.role_id)}:${Number(l.permission_id)}`));
    return reply.send({
      roles: roles.map((r) => ({ id: Number(r.id), code: String(r.code), name: String(r.name), color: String(r.color), level: Number(r.level), isSystem: Number(r.is_system) === 1 })),
      permissions: perms.map((p) => ({ id: Number(p.id), code: String(p.code), category: String(p.category) })),
      matrix: [...set],
    });
  });
}
