/**
 * EPIC AI — feedback и AI Reports.
 *
 * 👍 сохраняется как положительная оценка и НЕ создаёт административный отчёт.
 * 👎 открывает форму ошибки; после отправки создаётся AI Report со статусом «Новая».
 */
import type { FastifyInstance } from 'fastify';
import { getDb, insertReturningId, parseJson, formatDateTime, type Row, type DbClient } from '../db/index.js';
import { requirePermission, BadRequestError, NotFoundError } from '../http/guards.js';
import { audit, AUDIT_ACTIONS } from '../audit/index.js';
import { FEEDBACK_CATEGORIES, REPORT_ANALYSIS, REPORT_STATUS } from '../shared.js';

const CATEGORY_IDS = new Set(FEEDBACK_CATEGORIES.map((c) => c.id));
const ANALYSIS_IDS = new Set(REPORT_ANALYSIS.map((a) => a.id));
const STATUS_IDS = new Set(Object.values(REPORT_STATUS));

export async function registerReportRoutes(app: FastifyInstance): Promise<void> {
  /** GET /api/ai/feedback/categories — справочник для формы дизлайка. */
  app.get('/api/ai/feedback/categories', { preHandler: [requirePermission('ai.use')] }, async (_req, reply) => {
    return reply.send({ items: FEEDBACK_CATEGORIES, analysis: REPORT_ANALYSIS });
  });

  /**
   * POST /api/ai/feedback  { requestId, vote: 1 }
   * Лайк: только статистика качества.
   */
  app.post('/api/ai/feedback/like', { preHandler: [requirePermission('ai.feedback')] }, async (req, reply) => {
    const body = (req.body ?? {}) as { requestId?: number };
    const requestId = Number(body.requestId ?? 0);
    const request = await loadRequest(requestId, req.auth!.user.id, req.auth!.permissions.codes.has('ai.reports.view'));
    const db = await getDb();

    await upsertVote(db, requestId, req.auth!.user.id, 1);
    void request;
    return reply.send({ ok: true, requestId, vote: 1, reportCreated: false });
  });

  /**
   * POST /api/ai/reports  { requestId, category, comment? }
   * Дизлайк → AI Report. Категория обязательна, комментарий — нет.
   */
  app.post('/api/ai/reports', { preHandler: [requirePermission('ai.feedback')] }, async (req, reply) => {
    const body = (req.body ?? {}) as { requestId?: number; category?: string; comment?: string };
    const requestId = Number(body.requestId ?? 0);
    const category = String(body.category ?? '').trim();
    const comment = body.comment == null ? null : String(body.comment).trim().slice(0, 4000) || null;

    if (!CATEGORY_IDS.has(category)) {
      throw new BadRequestError('Категория ошибки должна быть выбрана');
    }
    const request = await loadRequest(requestId, req.auth!.user.id, req.auth!.permissions.codes.has('ai.reports.view'));
    const db = await getDb();

    const feedbackId = await upsertVote(db, requestId, req.auth!.user.id, -1);

    const roleSnapshot = req.auth!.permissions.roles[0]?.name ?? 'Игрок';
    const suggested = suggestAnalysis(category, request);

    const reportId = await insertReturningId(db, 'ai_reports', {
      request_id: requestId,
      feedback_id: feedbackId || null,
      user_id: req.auth!.user.id,
      user_role_snapshot: roleSnapshot,
      category,
      comment,
      status: REPORT_STATUS.NEW,
      analysis: suggested,
      created_at: new Date().toISOString(),
    });

    await audit({
      actorId: req.auth!.user.id,
      actorName: req.auth!.user.username,
      action: AUDIT_ACTIONS.REPORT_CREATE,
      entityType: 'ai_report',
      entityId: reportId,
      meta: { requestId, category, suggestedAnalysis: suggested },
      ip: req.ip,
    });

    return reply.code(201).send({ ok: true, reportId, requestId, status: REPORT_STATUS.NEW, suggestedAnalysis: suggested });
  });

  /** GET /api/ai/reports — очередь администратора. */
  app.get('/api/ai/reports', { preHandler: [requirePermission('ai.reports.view')] }, async (req, reply) => {
    const q = (req.query ?? {}) as Record<string, string>;
    const db = await getDb();
    const where: string[] = [];
    const params: unknown[] = [];
    if (q.status) { where.push('r.status = ?'); params.push(q.status); }
    if (q.category) { where.push('r.category = ?'); params.push(q.category); }
    if (q.analysis) { where.push('r.analysis = ?'); params.push(q.analysis); }
    if (q.userId) { where.push('r.user_id = ?'); params.push(Number(q.userId)); }
    if (q.from) { where.push('r.created_at >= ?'); params.push(q.from); }
    const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const limit = Math.min(Math.max(parseInt(q.limit ?? '50', 10) || 50, 1), 200);
    const offset = Math.max(parseInt(q.offset ?? '0', 10) || 0, 0);

    const total = Number((await db.get<Row>(`SELECT COUNT(*) AS c FROM ai_reports r ${whereSql}`, params))?.c ?? 0);
    const rows = await db.all<Row>(
      `SELECT r.id, r.request_id, r.user_id, r.user_role_snapshot, r.category, r.comment, r.status,
              r.analysis, r.resolution, r.handled_by, r.handled_at, r.created_at,
              u.username, u.avatar_url, q.mode, q.question, q.verdict
         FROM ai_reports r
         LEFT JOIN users u ON u.id = r.user_id
         LEFT JOIN ai_requests q ON q.id = r.request_id
         ${whereSql}
        ORDER BY CASE r.status WHEN 'new' THEN 0 WHEN 'in_progress' THEN 1 ELSE 2 END, r.id DESC
        LIMIT ? OFFSET ?`,
      [...params, limit, offset],
    );

    const counts = await db.get<Row>(
      `SELECT SUM(CASE WHEN status = 'new' THEN 1 ELSE 0 END) AS new_c,
              SUM(CASE WHEN status = 'in_progress' THEN 1 ELSE 0 END) AS prog_c,
              SUM(CASE WHEN status = 'resolved' THEN 1 ELSE 0 END) AS res_c,
              COUNT(*) AS all_c
         FROM ai_reports`,
    );

    return reply.send({
      total, limit, offset,
      counts: {
        new: Number(counts?.new_c ?? 0),
        inProgress: Number(counts?.prog_c ?? 0),
        resolved: Number(counts?.res_c ?? 0),
        all: Number(counts?.all_c ?? 0),
      },
      items: rows.map((r) => ({
        id: Number(r.id),
        requestId: r.request_id == null ? null : Number(r.request_id),
        user: r.user_id == null ? null : { id: Number(r.user_id), username: r.username, avatarUrl: r.avatar_url, role: r.user_role_snapshot },
        mode: r.mode, question: r.question, verdict: r.verdict,
        category: String(r.category),
        categoryLabel: FEEDBACK_CATEGORIES.find((c) => c.id === r.category)?.label ?? String(r.category),
        comment: r.comment,
        status: String(r.status),
        analysis: r.analysis,
        analysisLabel: REPORT_ANALYSIS.find((a) => a.id === r.analysis)?.label ?? null,
        resolution: r.resolution,
        handledBy: r.handled_by == null ? null : Number(r.handled_by),
        handledAt: r.handled_at,
        createdAt: r.created_at,
        createdAtLabel: formatDateTime(r.created_at),
      })),
    });
  });

  /** GET /api/ai/reports/:id — полная карточка. */
  app.get('/api/ai/reports/:id', { preHandler: [requirePermission('ai.reports.view')] }, async (req, reply) => {
    const p = req.params as { id: string };
    const db = await getDb();
    const r = await db.get<Row>(
      `SELECT r.*, u.username, u.avatar_url, u.status AS user_status,
              q.mode, q.question, q.answer_text, q.explanation, q.basis, q.verdict,
              q.sources_json, q.kb_version, q.model, q.provider, q.created_at AS request_created_at
         FROM ai_reports r
         LEFT JOIN users u ON u.id = r.user_id
         LEFT JOIN ai_requests q ON q.id = r.request_id
        WHERE r.id = ?`,
      [Number(p.id)],
    );
    if (!r) throw new NotFoundError('Отчёт не найден');

    const handler = r.handled_by
      ? await db.get<Row>('SELECT id, username FROM users WHERE id = ?', [Number(r.handled_by)])
      : null;

    return reply.send({
      id: Number(r.id),
      user: r.user_id == null ? null : {
        id: Number(r.user_id), username: r.username, avatarUrl: r.avatar_url,
        role: r.user_role_snapshot, status: r.user_status,
      },
      question: r.question,
      mode: r.mode,
      modeLabel: r.mode === 'laws' ? 'Законы' : 'Правила',
      aiAnswer: {
        verdict: r.verdict, explanation: r.explanation, basis: r.basis, text: r.answer_text,
        model: r.model, provider: r.provider, createdAt: r.request_created_at,
      },
      sources: parseJson(r.sources_json, []),
      category: String(r.category),
      categoryLabel: FEEDBACK_CATEGORIES.find((c) => c.id === r.category)?.label ?? String(r.category),
      comment: r.comment,
      status: String(r.status),
      statusLabel: { new: 'Новая', in_progress: 'На проверке', resolved: 'Решена' }[String(r.status)] ?? String(r.status),
      analysis: r.analysis,
      analysisLabel: REPORT_ANALYSIS.find((a) => a.id === r.analysis)?.label ?? null,
      resolution: r.resolution,
      handledBy: handler ? { id: Number(handler.id), username: String(handler.username) } : null,
      handledAt: r.handled_at,
      kbVersion: r.kb_version,
      createdAt: r.created_at,
      createdAtLabel: formatDateTime(r.created_at),
    });
  });

  /**
   * PATCH /api/ai/reports/:id  { status?, analysis?, resolution? }
   * Кнопки «В РАБОТУ» / «РЕШЕНО».
   */
  app.patch('/api/ai/reports/:id', { preHandler: [requirePermission('ai.reports.manage')] }, async (req, reply) => {
    const p = req.params as { id: string };
    const body = (req.body ?? {}) as { status?: string; analysis?: string | null; resolution?: string | null };
    const db = await getDb();
    const existing = await db.get<Row>('SELECT * FROM ai_reports WHERE id = ?', [Number(p.id)]);
    if (!existing) throw new NotFoundError('Отчёт не найден');

    const sets: string[] = [];
    const params: unknown[] = [];
    if (body.status !== undefined) {
      if (!STATUS_IDS.has(body.status as any)) throw new BadRequestError('Недопустимый статус');
      sets.push('status = ?'); params.push(body.status);
      sets.push('handled_by = ?'); params.push(req.auth!.user.id);
      sets.push('handled_at = ?'); params.push(new Date().toISOString());
    }
    if (body.analysis !== undefined) {
      if (body.analysis !== null && !ANALYSIS_IDS.has(String(body.analysis))) throw new BadRequestError('Недопустимый тип анализа');
      sets.push('analysis = ?'); params.push(body.analysis);
    }
    if (body.resolution !== undefined) {
      sets.push('resolution = ?'); params.push(body.resolution === null ? null : String(body.resolution).slice(0, 4000));
    }
    if (!sets.length) throw new BadRequestError('Нечего обновлять');

    await db.run(`UPDATE ai_reports SET ${sets.join(', ')} WHERE id = ?`, [...params, Number(p.id)]);

    if (body.status) {
      await audit({
        actorId: req.auth!.user.id, actorName: req.auth!.user.username,
        action: AUDIT_ACTIONS.REPORT_STATUS, entityType: 'ai_report', entityId: Number(p.id),
        meta: { from: String(existing.status), to: body.status }, ip: req.ip,
      });
    }
    if (body.analysis !== undefined && String(body.analysis) !== String(existing.analysis)) {
      await audit({
        actorId: req.auth!.user.id, actorName: req.auth!.user.username,
        action: AUDIT_ACTIONS.REPORT_ANALYSIS, entityType: 'ai_report', entityId: Number(p.id),
        meta: { from: existing.analysis, to: body.analysis }, ip: req.ip,
      });
    }

    const updated = await db.get<Row>('SELECT * FROM ai_reports WHERE id = ?', [Number(p.id)]);
    return reply.send({ ok: true, id: Number(p.id), status: String(updated!.status), analysis: updated!.analysis, resolution: updated!.resolution });
  });

  /** GET /api/ai/stats — статистика качества. */
  app.get('/api/ai/stats', { preHandler: [requirePermission('ai.reports.view')] }, async (_req, reply) => {
    const db = await getDb();
    const votes = await db.get<Row>(
      `SELECT SUM(CASE WHEN vote = 1 THEN 1 ELSE 0 END) AS likes,
              SUM(CASE WHEN vote = -1 THEN 1 ELSE 0 END) AS dislikes,
              COUNT(*) AS total FROM ai_feedback`,
    );
    const requests = await db.get<Row>(
      `SELECT COUNT(*) AS total,
              SUM(CASE WHEN status = 'ok' THEN 1 ELSE 0 END) AS ok,
              SUM(CASE WHEN status = 'no_data' THEN 1 ELSE 0 END) AS no_data,
              SUM(CASE WHEN status = 'error' THEN 1 ELSE 0 END) AS errors,
              AVG(latency_ms) AS avg_latency FROM ai_requests`,
    );
    const byMode = await db.all<Row>('SELECT mode, COUNT(*) AS c FROM ai_requests GROUP BY mode');
    const byCategory = await db.all<Row>('SELECT category, COUNT(*) AS c FROM ai_reports GROUP BY category ORDER BY c DESC');
    const byAnalysis = await db.all<Row>('SELECT analysis, COUNT(*) AS c FROM ai_reports WHERE analysis IS NOT NULL GROUP BY analysis ORDER BY c DESC');
    const likes = Number(votes?.likes ?? 0);
    const dislikes = Number(votes?.dislikes ?? 0);
    return reply.send({
      feedback: {
        likes, dislikes, total: Number(votes?.total ?? 0),
        satisfaction: likes + dislikes ? Number((likes / (likes + dislikes)).toFixed(3)) : null,
      },
      requests: {
        total: Number(requests?.total ?? 0), ok: Number(requests?.ok ?? 0),
        noData: Number(requests?.no_data ?? 0), errors: Number(requests?.errors ?? 0),
        avgLatencyMs: requests?.avg_latency == null ? null : Math.round(Number(requests.avg_latency)),
      },
      byMode: byMode.map((r) => ({ mode: String(r.mode), count: Number(r.c) })),
      byCategory: byCategory.map((r) => ({
        category: String(r.category),
        label: FEEDBACK_CATEGORIES.find((c) => c.id === r.category)?.label ?? String(r.category),
        count: Number(r.c),
      })),
      byAnalysis: byAnalysis.map((r) => ({
        analysis: String(r.analysis),
        label: REPORT_ANALYSIS.find((a) => a.id === r.analysis)?.label ?? String(r.analysis),
        count: Number(r.c),
      })),
    });
  });
}

/* ------------------------------------------------------------------ */

/**
 * Одна оценка на один запрос: повторное нажатие просто меняет знак.
 * Сделано вручную (без ON CONFLICT), чтобы одинаково работать на SQLite и PostgreSQL.
 */
async function upsertVote(db: DbClient, requestId: number, userId: number, vote: 1 | -1): Promise<number> {
  const existing = await db.get<Row>('SELECT id FROM ai_feedback WHERE request_id = ?', [requestId]);
  if (existing) {
    await db.run('UPDATE ai_feedback SET vote = ?, user_id = ?, created_at = ? WHERE id = ?',
      [vote, userId, new Date().toISOString(), Number(existing.id)]);
    return Number(existing.id);
  }
  return insertReturningId(db, 'ai_feedback', {
    request_id: requestId, user_id: userId, vote, created_at: new Date().toISOString(),
  });
}

async function loadRequest(requestId: number, actorId: number, isAdmin: boolean): Promise<Row> {
  if (!requestId) throw new BadRequestError('Требуется requestId');
  const db = await getDb();
  const row = await db.get<Row>('SELECT * FROM ai_requests WHERE id = ?', [requestId]);
  if (!row) throw new NotFoundError('Запрос не найден');
  if (Number(row.user_id) !== actorId && !isAdmin) {
    throw new NotFoundError('Запрос не найден');
  }
  return row;
}

/**
 * Автоматическая предварительная оценка источника проблемы.
 * Это только подсказка администратору — итоговое решение принимает человек.
 */
export function suggestAnalysis(category: string, request: Row): string {
  const status = String(request.status ?? '');
  if (status === 'error') return 'technical';
  if (status === 'no_data') return 'search_miss';
  switch (category) {
    case 'outdated': return 'kb_outdated';
    case 'technical': return 'technical';
    case 'wrong_source': return 'search_miss';
    case 'misinterpreted':
    case 'wrong_article':
      return 'ai_error';
    default:
      return 'ai_error';
  }
}
