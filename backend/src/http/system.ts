/**
 * EPIC AI — служебные маршруты: health, version, обзор админки.
 */
import type { FastifyInstance } from 'fastify';
import { getDb, formatDateTime, type Row } from '../db/index.js';
import config from '../config/index.js';
import { optionalAuth, requirePermission } from './guards.js';
import { getKbStatus } from '../knowledge/service.js';
import { getProvider } from '../ai/providers/index.js';
import { isSyncRunning } from '../knowledge/sync.js';

export async function registerSystemRoutes(app: FastifyInstance): Promise<void> {
  /** GET /api/health — для splash-экрана и мониторинга. Без авторизации. */
  app.get('/api/health', async (_req, reply) => {
    let db = 'unknown';
    let engine = 'unknown';
    try {
      const d = await getDb();
      await d.get('SELECT 1 AS ok');
      db = 'ok';
      engine = d.engine;
    } catch { db = 'error'; }
    return reply.send({
      ok: db === 'ok',
      service: 'epic-ai-backend',
      version: '1.0.0',
      env: config.env,
      db: { status: db, driver: config.db.driver, engine },
      ai: { provider: config.ai.provider, model: config.ai.model },
      crawler: { enabled: config.crawler.enabled, respectRobots: config.crawler.respectRobots, running: isSyncRunning() },
      time: new Date().toISOString(),
    });
  });

  /** GET /api/bootstrap/status — нужен ли первичный setup Developer. */
  app.get('/api/bootstrap/status', async (_req, reply) => {
    const db = await getDb();
    const devs = Number((await db.get<Row>(
      `SELECT COUNT(*) AS c FROM user_roles ur JOIN roles r ON r.id = ur.role_id WHERE r.code = 'developer'`,
    ))?.c ?? 0);
    const users = Number((await db.get<Row>('SELECT COUNT(*) AS c FROM users'))?.c ?? 0);
    return reply.send({
      needsBootstrap: devs === 0,
      developers: devs,
      users,
      bootstrapTokenConfigured: Boolean(config.bootstrap.token),
    });
  });

  /**
   * POST /api/bootstrap/developer — защищённый одноразовый bootstrap.
   * Работает только если BOOTSTRAP_TOKEN задан и совпадает, и только пока
   * в системе нет ни одного Developer. Через обычную админ-панель недоступно.
   */
  app.post('/api/bootstrap/developer', async (req, reply) => {
    const body = (req.body ?? {}) as { token?: string; discordId?: string; telegramId?: string };
    const db = await getDb();
    const devs = Number((await db.get<Row>(
      `SELECT COUNT(*) AS c FROM user_roles ur JOIN roles r ON r.id = ur.role_id WHERE r.code = 'developer'`,
    ))?.c ?? 0);
    // : bootstrap одноразовый. Если Developer уже есть — endpoint закрыт навсегда.
    if (devs > 0) return reply.code(409).send({ error: 'already_bootstrapped', message: 'Developer уже создан. Bootstrap недоступен.' });
    if (!config.bootstrap.token) return reply.code(403).send({ error: 'bootstrap_disabled', message: 'BOOTSTRAP_TOKEN не задан' });
    if (String(body.token ?? '') !== config.bootstrap.token) {
      return reply.code(403).send({ error: 'invalid_token', message: 'Неверный bootstrap-токен' });
    }

    const discordId = String(body.discordId ?? config.bootstrap.discordId ?? '').trim();
    const telegramId = String(body.telegramId ?? config.bootstrap.telegramId ?? '').trim();
    if (!discordId && !telegramId) {
      return reply.code(400).send({ error: 'identity_required', message: 'Укажите discordId или telegramId' });
    }

    const { findOrCreateUserByIdentity, setUserRole } = await import('../users/service.js');
    const { audit, AUDIT_ACTIONS } = await import('../audit/index.js');

    let userId: number | null = null;
    if (discordId) {
      const r = await findOrCreateUserByIdentity({ provider: 'discord', providerUserId: discordId, username: 'developer', displayName: 'Developer' });
      userId = Number(r.user.id);
    }
    if (telegramId) {
      const r = await findOrCreateUserByIdentity({ provider: 'telegram', providerUserId: telegramId, username: 'developer', displayName: 'Developer' });
      if (userId == null) userId = Number(r.user.id);
    }
    if (userId == null) return reply.code(500).send({ error: 'bootstrap_failed' });

    await setUserRole(userId, 'developer', null);
    await audit({ actorId: userId, actorName: 'bootstrap', action: AUDIT_ACTIONS.BOOTSTRAP_DEVELOPER, entityType: 'user', entityId: userId, meta: { discordId, telegramId }, ip: req.ip });

    return reply.send({ ok: true, userId, message: 'Developer создан. Обнулите BOOTSTRAP_TOKEN в.env' });
  });

  /**
   * GET /api/admin/overview — раздел «Обзор» админ-панели.
   */
  app.get('/api/admin/overview', { preHandler: [requirePermission('users.view')] }, async (req, reply) => {
    const db = await getDb();
    const users = await db.get<Row>(
      `SELECT COUNT(*) AS total,
              SUM(CASE WHEN status = 'blocked' THEN 1 ELSE 0 END) AS blocked,
              SUM(CASE WHEN last_login_at >= ? THEN 1 ELSE 0 END) AS active7d
         FROM users`,
      [new Date(Date.now() - 7 * 86400_000).toISOString()],
    );
    const reports = await db.get<Row>(
      `SELECT COUNT(*) AS total,
              SUM(CASE WHEN status = 'new' THEN 1 ELSE 0 END) AS new_c,
              SUM(CASE WHEN status = 'in_progress' THEN 1 ELSE 0 END) AS prog_c,
              SUM(CASE WHEN status = 'resolved' THEN 1 ELSE 0 END) AS res_c
         FROM ai_reports`,
    );
    const feedback = await db.get<Row>(
      `SELECT SUM(CASE WHEN vote = 1 THEN 1 ELSE 0 END) AS likes, SUM(CASE WHEN vote = -1 THEN 1 ELSE 0 END) AS dislikes FROM ai_feedback`,
    );
    const requests = await db.get<Row>(
      `SELECT COUNT(*) AS total, SUM(CASE WHEN status = 'no_data' THEN 1 ELSE 0 END) AS no_data FROM ai_requests`,
    );
    const roles = await db.all<Row>(
      `SELECT r.code, r.name, r.color, COUNT(ur.user_id) AS c
         FROM roles r LEFT JOIN user_roles ur ON ur.role_id = r.id
        GROUP BY r.id, r.code, r.name, r.color ORDER BY r.code`,
    );
    const kb = await getKbStatus();
    const recentAudit = await db.all<Row>('SELECT id, actor_name, action, entity_type, entity_id, created_at FROM audit_logs ORDER BY id DESC LIMIT 12');
    const provider = getProvider();
    const providerCheck = provider.isConfigured();

    return reply.send({
      users: { total: Number(users?.total ?? 0), blocked: Number(users?.blocked ?? 0), active7d: Number(users?.active7d ?? 0) },
      aiReports: { total: Number(reports?.total ?? 0), new: Number(reports?.new_c ?? 0), inProgress: Number(reports?.prog_c ?? 0), resolved: Number(reports?.res_c ?? 0) },
      feedback: { likes: Number(feedback?.likes ?? 0), dislikes: Number(feedback?.dislikes ?? 0) },
      requests: { total: Number(requests?.total ?? 0), noData: Number(requests?.no_data ?? 0) },
      roles: roles.map((r) => ({ code: String(r.code), name: String(r.name), color: String(r.color), count: Number(r.c ?? 0) })),
      kb: {
        state: kb.state, stateLabel: kb.stateLabel, stateColor: kb.stateColor,
        lastSyncLabel: kb.lastSyncLabel, documents: kb.documents, versions: kb.versions,
        chunks: kb.chunks, today: kb.today, kbVersion: kb.kbVersion, intervalMinutes: kb.intervalMinutes,
      },
      system: {
        env: config.env, db: config.db.driver, aiProvider: provider.name, aiModel: provider.model,
        aiConfigured: providerCheck.ok, aiConfigReason: providerCheck.reason ?? null,
        crawlerEnabled: config.crawler.enabled, syncRunning: isSyncRunning(),
        telegramEnabled: config.telegram.enabled,
        serverTime: formatDateTime(new Date().toISOString()),
      },
      recentAudit: recentAudit.map((a) => ({
        id: Number(a.id), actorName: a.actor_name, action: String(a.action),
        entityType: a.entity_type, entityId: a.entity_id, createdAtLabel: formatDateTime(a.created_at),
      })),
      permissions: [...req.auth!.permissions.codes].sort(),
    });
  });

  /** GET /api/admin/nav — дерево разделов админки с учётом permissions. */
  app.get('/api/admin/nav', { preHandler: [optionalAuth] }, async (req, reply) => {
    const codes = req.auth?.permissions.codes ?? new Set<string>();
    const nav = [
      { id: 'overview', label: 'Обзор', permission: 'users.view' },
      { id: 'users', label: 'Пользователи', permission: 'users.view' },
      { id: 'roles', label: 'Роли', permission: 'roles.view' },
      { id: 'permissions', label: 'Permissions', permission: 'permissions.view' },
      { id: 'blocks', label: 'Блокировки', permission: 'users.view' },
      { id: 'ai', label: 'AI', permission: 'ai.reports.view', children: [
        { id: 'ai-reports', label: 'Ошибки AI', permission: 'ai.reports.view' },
      ] },
      { id: 'kb', label: 'Knowledge Base', permission: 'knowledge.view', children: [
        { id: 'kb-documents', label: 'Документы', permission: 'knowledge.view' },
        { id: 'kb-versions', label: 'Версии', permission: 'knowledge.history' },
        { id: 'kb-changes', label: 'Изменения', permission: 'knowledge.view' },
        { id: 'kb-sync', label: 'Синхронизация', permission: 'knowledge.sync' },
      ] },
      { id: 'telegram', label: 'Telegram bot', permission: 'telegram.manage' },
      { id: 'audit', label: 'Audit Log', permission: 'system.logs' },
      { id: 'system', label: 'System', permission: 'system.settings' },
    ];
    const filter = (items: any[]): any[] => items
     .filter((i) => codes.has(i.permission))
     .map((i) => ({...i, children: i.children ? filter(i.children) : undefined }));
    return reply.send({ items: filter(nav), authenticated: Boolean(req.auth) });
  });
}
