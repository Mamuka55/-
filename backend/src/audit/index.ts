/**
 * EPIC AI — Audit Log.
 *
 * Append-only: API не предоставляет update/delete для этой таблицы.
 */
import type { FastifyInstance } from 'fastify';
import { getDb, insertReturningId, type Row } from '../db/index.js';
import { requirePermission, HttpError } from '../http/guards.js';

export const AUDIT_ACTIONS = {
  LOGIN: 'login',
  LOGOUT: 'logout',
  LOGIN_FAILED: 'login.failed',
  PROFILE_UPDATE: 'user.profile.update',
  BLOCK: 'user.block',
  UNBLOCK: 'user.unblock',
  ROLE_CHANGE: 'user.role.change',
  QUOTA_CHANGE: 'user.quota.change',
  PERMISSION_ADD: 'user.permission.add',
  PERMISSION_REMOVE: 'user.permission.remove',
  SETTINGS_CHANGE: 'system.settings.change',
  SYNC_MANUAL: 'knowledge.sync.manual',
  SYNC_AUTO: 'knowledge.sync.auto',
  KB_CHANGE: 'knowledge.document.change',
  REPORT_CREATE: 'ai.report.create',
  REPORT_STATUS: 'ai.report.status',
  REPORT_ANALYSIS: 'ai.report.analysis',
  BOOTSTRAP_DEVELOPER: 'system.bootstrap.developer',
} as const;

export interface AuditEntry {
  actorId?: number | null;
  actorName?: string | null;
  action: string;
  entityType?: string | null;
  entityId?: string | number | null;
  meta?: Record<string, unknown> | null;
  ip?: string | null;
}

export async function audit(entry: AuditEntry): Promise<number> {
  const db = await getDb();
  return insertReturningId(db, 'audit_logs', {
    actor_id: entry.actorId ?? null,
    actor_name: entry.actorName ?? null,
    action: entry.action,
    entity_type: entry.entityType ?? null,
    entity_id: entry.entityId == null ? null : String(entry.entityId),
    meta: entry.meta ? JSON.stringify(entry.meta) : null,
    ip: entry.ip ?? null,
    created_at: new Date().toISOString(),
  });
}

/** Запись в Audit Log из контекста HTTP-запроса. */
export async function auditFromReq(
  req: any,
  action: string,
  entityType?: string,
  entityId?: string | number,
  meta?: Record<string, unknown>,
): Promise<number> {
  return audit({
    actorId: req?.auth?.user?.id != null ? Number(req.auth.user.id) : null,
    actorName: req?.auth?.user?.username ?? null,
    action,
    entityType,
    entityId,
    meta,
    ip: req?.ip ?? null,
  });
}

export async function registerAuditRoutes(app: FastifyInstance): Promise<void> {
  /**
   * GET /api/audit-logs — журнал критических действий.
   * Фильтры: action, action_prefix, entity_type, entity_id, actor_id, from, to, search, limit, offset.
   */
  app.get('/api/audit-logs', { preHandler: [requirePermission('system.logs')] }, async (req, reply) => {
    const q = (req.query ?? {}) as Record<string, string>;
    const db = await getDb();
    const where: string[] = [];
    const params: unknown[] = [];

    if (q.action) { where.push('action = ?'); params.push(q.action); }
    if (q.action_prefix) { where.push('action LIKE ?'); params.push(`${q.action_prefix}%`); }
    if (q.entity_type) { where.push('entity_type = ?'); params.push(q.entity_type); }
    if (q.entity_id) { where.push('entity_id = ?'); params.push(String(q.entity_id)); }
    if (q.actor_id) { where.push('actor_id = ?'); params.push(Number(q.actor_id)); }
    if (q.from) { where.push('created_at >= ?'); params.push(q.from); }
    if (q.to) { where.push('created_at <= ?'); params.push(q.to); }
    if (q.search) {
      where.push('(action LIKE ? OR actor_name LIKE ? OR meta LIKE ?)');
      params.push(`%${q.search}%`, `%${q.search}%`, `%${q.search}%`);
    }

    const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const limit = Math.min(Math.max(parseInt(q.limit ?? '50', 10) || 50, 1), 500);
    const offset = Math.max(parseInt(q.offset ?? '0', 10) || 0, 0);

    const total = Number((await db.get<Row>(`SELECT COUNT(*) AS c FROM audit_logs ${whereSql}`, params))?.c ?? 0);
    const items = await db.all<Row>(
      `SELECT id, actor_id, actor_name, action, entity_type, entity_id, meta, ip, created_at
         FROM audit_logs ${whereSql}
        ORDER BY id DESC LIMIT ? OFFSET ?`,
      [...params, limit, offset],
    );

    return reply.send({
      total,
      limit,
      offset,
      items: items.map((i) => ({
        id: Number(i.id),
        actorId: i.actor_id == null ? null : Number(i.actor_id),
        actorName: i.actor_name,
        action: i.action,
        entityType: i.entity_type,
        entityId: i.entity_id,
        meta: i.meta ? safeJson(String(i.meta)) : null,
        ip: i.ip,
        createdAt: i.created_at,
      })),
    });
  });

  /** GET /api/audit-logs/actions — справочник действий для фильтра. */
  app.get('/api/audit-logs/actions', { preHandler: [requirePermission('system.logs')] }, async (_req, reply) => {
    const db = await getDb();
    const rows = await db.all<Row>('SELECT action, COUNT(*) AS c FROM audit_logs GROUP BY action ORDER BY c DESC');
    return reply.send({ items: rows.map((r) => ({ action: r.action, count: Number(r.c) })) });
  });

  // Audit Log нельзя изменять обычным способом через интерфейс.
  const readOnly = async () => {
    throw new HttpError(405, 'Audit Log доступен только для чтения ', 'audit_readonly');
  };
  app.post('/api/audit-logs', readOnly);
  app.put('/api/audit-logs', readOnly);
  app.patch('/api/audit-logs', readOnly);
  app.delete('/api/audit-logs', readOnly);
  app.patch('/api/audit-logs/:id', readOnly);
  app.delete('/api/audit-logs/:id', readOnly);
}

function safeJson(s: string): unknown {
  try { return JSON.parse(s); } catch { return s; }
}
