/**
 * EPIC AI — маршруты AI: запрос, ответ, источники, feedback, история.
 */
import type { FastifyInstance } from 'fastify';
import config from '../config/index.js';
import { getDb, parseJson, formatDateTime, type Row } from '../db/index.js';
import { requireAuth, requirePermission, BadRequestError, NotFoundError } from '../http/guards.js';
import { ask, NO_DATA_ANSWER } from './rag/pipeline.js';
import { retrieve, getKbVersion } from './rag/retrieval.js';
import { serializeSources } from './serializer.js';
import { checkQuota, getQuota } from './quota.js';

const MODES = new Set(['rules', 'laws']);

export async function registerAiRoutes(app: FastifyInstance): Promise<void> {
  /**
   * POST /api/ai/ask
   * { mode: 'rules'|'laws', question: string, includeArchive?: boolean }
   *
   * Ответ — то, что рисует клиент: verdict/explanation/basis + массив источников
   * для отдельного окна справа.
   */
  app.post('/api/ai/ask', { preHandler: [requirePermission('ai.use')] }, async (req, reply) => {
    const auth = req.auth!;
    const body = (req.body ?? {}) as { mode?: string; question?: string; includeArchive?: boolean };
    const mode = String(body.mode ?? 'rules').toLowerCase();
    const question = String(body.question ?? '').trim();

    if (!MODES.has(mode)) throw new BadRequestError('Режим должен быть "rules" или "laws"');
    if (question.length < 3) throw new BadRequestError('Слишком короткий запрос');
    if (question.length > 1200) throw new BadRequestError('Слишком длинный запрос (максимум 1200 символов)');

    const modePerm = mode === 'laws' ? 'ai.laws' : 'ai.rules';
    if (!auth.permissions.codes.has(modePerm)) {
      return reply.code(403).send({ error: 'forbidden', message: `Недостаточно прав для режима: ${modePerm}` });
    }

    // Дневной лимит запросов: 50 по умолчанию, персонально выдаётся админом.
    const over = await checkQuota(auth.user.id);
    if (over) {
      return reply.code(429).send({
        error: 'quota_exceeded',
        message: `Исчерпан дневной лимит запросов (${over.used} из ${over.limit}). Лимит обновится завтра, персональный лимит может выдать администратор.`,
        quota: over,
      });
    }

    const answer = await ask({
      userId: auth.user.id,
      mode: mode as 'rules' | 'laws',
      question,
      includeArchive: Boolean(body.includeArchive),
    });

    return reply.send({
      requestId: answer.requestId,
      mode,
      question,
      verdict: answer.verdict,
      verdictLabel: answer.verdictLabel,
      explanation: answer.explanation,
      basis: answer.basis,
      status: answer.status,
      confidence: answer.confidence,
      model: answer.model,
      provider: answer.provider,
      latencyMs: answer.latencyMs,
      kbVersion: answer.kbVersion,
      noData: answer.status === 'no_data',
      noDataMessage: answer.status === 'no_data' ? NO_DATA_ANSWER : null,
      sources: serializeSources(answer.sources),
      relatedDocuments: answer.relatedDocuments,
      quota: await getQuota(auth.user.id),
      feedback: { allowed: auth.permissions.codes.has('ai.feedback'), vote: null },
    });
  });

  /**
   * GET /api/ai/quota — остаток дневного лимита запросов.
   * Показан в окне подтверждения «Спросить ИИ?» и в профиле настроек.
   */
  app.get('/api/ai/quota', { preHandler: [requirePermission('ai.use')] }, async (req, reply) => {
    return reply.send(await getQuota(req.auth!.user.id));
  });

  /**
   * POST /api/ai/transcribe — голосовой ввод (речь → текст).
   *
   * Клиент пишет микрофон в MediaRecorder (audio/webm) и шлёт запись сырым
   * телом запроса. Распознаёт ТОЛЬКО backend (Groq Whisper — бесплатный API):
   * ключ API не уходит в клиент. В Electron Web Speech API Chromium
   * не работает (нет сервисов Google), поэтому запись → сервер единственный
   * надёжный путь.
   */
  app.post('/api/ai/transcribe', { preHandler: [requirePermission('ai.use')] }, async (req, reply) => {
    const buf = req.body as unknown as Buffer;
    if (!Buffer.isBuffer(buf) || buf.length < 512) throw new BadRequestError('Пустая аудиозапись');
    if (buf.length > 3 * 1024 * 1024) throw new BadRequestError('Запись слишком длинная (лимит ~60 секунд)');

    // mock-режим: разработка и тесты без ключей
    if (config.ai.provider === 'mock') {
      return reply.send({ text: 'Можно ли красить транспорт в любой цвет?', provider: 'mock' });
    }
    // Раунд 32: голосовой ввод работает и на SiliconFlow (FunAudioLLM/SenseVoiceSmall
    // через OpenAI-совместимый /audio/transcriptions), и на Groq (whisper).
    const sttBase = config.ai.baseUrl.replace(/\/$/, '');
    const sttOk = (config.ai.provider as string) !== 'mock' && Boolean(config.ai.apiKey)
      && /siliconflow|groq/i.test(sttBase + (config.ai.provider === 'groq' ? 'groq' : ''));
    if (!sttOk) {
      return reply.code(503).send({
        error: 'stt_unavailable',
        message: 'Голосовой ввод не настроен на сервере (нужен SiliconFlow или Groq в AI_BASE_URL)',
      });
    }

    const ctype = String(req.headers['content-type'] ?? 'audio/webm').split(';')[0].trim() || 'audio/webm';
    const form = new FormData();
    form.append('file', new Blob([new Uint8Array(buf)], { type: ctype }), 'voice.webm');
    const defaultSttModel = /siliconflow/i.test(sttBase) ? 'FunAudioLLM/SenseVoiceSmall' : 'whisper-large-v3-turbo';
    form.append('model', process.env.STT_MODEL || defaultSttModel);
    form.append('language', 'ru');

    let res: Response;
    try {
      res = await fetch(`${sttBase}/audio/transcriptions`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${config.ai.apiKey}` },
        body: form,
        signal: AbortSignal.timeout(60_000),
      });
    } catch (e: any) {
      return reply.code(502).send({ error: 'stt_network', message: `Сервис распознавания недоступен: ${e?.message ?? e}` });
    }
    const json = (await res.json().catch(() => null)) as { text?: string; error?: { message?: string } } | null;
    if (!res.ok || typeof json?.text !== 'string') {
      return reply.code(502).send({ error: 'stt_error', message: json?.error?.message ?? `Ошибка распознавания (HTTP ${res.status})` });
    }
    const text = json.text.trim();
    if (!text) return reply.code(422).send({ error: 'stt_empty', message: 'Речь не распознана — повторите запрос' });
    return reply.send({ text, provider: /siliconflow/i.test(sttBase) ? 'siliconflow-sensevoice' : 'groq-whisper' });
  });

  /**
   * GET /api/ai/sources?requestId=
   * Содержимое окна источников. Отдельный эндпоинт, чтобы Sources
   * Window мог обновиться независимо от основной панели.
   */
  app.get('/api/ai/sources', { preHandler: [requirePermission('ai.sources')] }, async (req, reply) => {
    const q = (req.query ?? {}) as { requestId?: string };
    const requestId = Number(q.requestId ?? 0);
    if (!requestId) throw new BadRequestError('Требуется requestId');
    const db = await getDb();
    const row = await db.get<Row>(
      'SELECT id, user_id, mode, question, sources_json, kb_version, created_at FROM ai_requests WHERE id = ?',
      [requestId],
    );
    if (!row) throw new NotFoundError('Запрос не найден');
    // Чужую историю смотреть нельзя (кроме администраторов с ai.reports.view)
    if (Number(row.user_id) !== req.auth!.user.id && !req.auth!.permissions.codes.has('ai.reports.view')) {
      return reply.code(403).send({ error: 'forbidden', message: 'Нет доступа к этому запросу' });
    }
    return reply.send({
      requestId: Number(row.id),
      mode: String(row.mode),
      question: String(row.question),
      kbVersion: row.kb_version,
      createdAt: row.created_at,
      sources: parseJson(row.sources_json, []),
    });
  });

  /**
   * GET /api/ai/search?mode=&q= — «чистый» поиск по базе без AI.
   * Полезно для отладки RAG и для режима «только источники».
   */
  app.get('/api/ai/search', { preHandler: [requirePermission('ai.use')] }, async (req, reply) => {
    const q = (req.query ?? {}) as { mode?: string; q?: string; archive?: string };
    const mode = String(q.mode ?? 'rules') === 'laws' ? 'laws' : 'rules';
    const query = String(q.q ?? '').trim();
    if (!query) throw new BadRequestError('Пустой запрос');
    const result = await retrieve({ query, mode, includeArchive: q.archive === '1' });
    return reply.send({
      mode, query, kbVersion: result.kbVersion, searchMs: result.searchMs,
      sources: serializeSources(result.sources),
      relatedDocuments: result.relatedDocuments,
    });
  });

  /** GET /api/ai/history — своя история запросов (ai.history). */
  app.get('/api/ai/history', { preHandler: [requirePermission('ai.history')] }, async (req, reply) => {
    const q = (req.query ?? {}) as { limit?: string; offset?: string; mode?: string };
    const db = await getDb();
    const limit = Math.min(Math.max(parseInt(q.limit ?? '30', 10) || 30, 1), 200);
    const offset = Math.max(parseInt(q.offset ?? '0', 10) || 0, 0);
    const where = q.mode && MODES.has(q.mode) ? 'AND mode = ?' : '';
    const params: unknown[] = q.mode && MODES.has(q.mode) ? [req.auth!.user.id, q.mode, limit, offset] : [req.auth!.user.id, limit, offset];
    const rows = await db.all<Row>(
      `SELECT id, mode, question, verdict, explanation, status, created_at, kb_version
         FROM ai_requests WHERE user_id = ? ${where} ORDER BY id DESC LIMIT ? OFFSET ?`,
      params,
    );
    return reply.send({
      items: rows.map((r) => ({
        requestId: Number(r.id), mode: String(r.mode), question: String(r.question),
        verdict: r.verdict, explanation: r.explanation, status: String(r.status),
        createdAt: r.created_at, createdAtLabel: formatDateTime(r.created_at), kbVersion: r.kb_version,
      })),
    });
  });

  /** GET /api/ai/request/:id — полный контекст запроса (для формы дизлайка и админки). */
  app.get('/api/ai/request/:id', { preHandler: [requirePermission('ai.use')] }, async (req, reply) => {
    const p = req.params as { id: string };
    const db = await getDb();
    const row = await db.get<Row>('SELECT * FROM ai_requests WHERE id = ?', [Number(p.id)]);
    if (!row) throw new NotFoundError('Запрос не найден');
    const isOwner = Number(row.user_id) === req.auth!.user.id;
    if (!isOwner && !req.auth!.permissions.codes.has('ai.reports.view')) {
      return reply.code(403).send({ error: 'forbidden', message: 'Нет доступа' });
    }
    const fb = await db.get<Row>('SELECT vote FROM ai_feedback WHERE request_id = ?', [Number(row.id)]);
    return reply.send({
      requestId: Number(row.id),
      userId: row.user_id == null ? null : Number(row.user_id),
      mode: String(row.mode),
      question: String(row.question),
      verdict: row.verdict,
      explanation: row.explanation,
      basis: row.basis,
      answerText: row.answer_text,
      status: String(row.status),
      model: row.model, provider: row.provider,
      latencyMs: row.latency_ms, kbVersion: row.kb_version,
      createdAt: row.created_at, createdAtLabel: formatDateTime(row.created_at),
      sources: parseJson(row.sources_json, []),
      vote: fb ? Number(fb.vote) : null,
    });
  });

  /** GET /api/ai/meta — версия базы и статус провайдера (для настроек/отладки). */
  app.get('/api/ai/meta', { preHandler: [requireAuth] }, async (_req, reply) => {
    const { getProvider } = await import('./providers/index.js');
    const p = getProvider();
    const check = p.isConfigured();
    return reply.send({
      kbVersion: await getKbVersion(),
      provider: p.name,
      model: p.model,
      configured: check.ok,
      configReason: check.reason ?? null,
    });
  });
}
