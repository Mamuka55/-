/**
 * EPIC AI — HTTP-слой (Fastify).
 *
 * Единая точка входа для Electron-клиента и для будущей админки на VPS.
 * Клиент ходит только сюда; никакие секреты наружу не отдаются.
 */
import Fastify, { type FastifyInstance, type FastifyBaseLogger } from 'fastify';
import cookie from '@fastify/cookie';
import cors from '@fastify/cors';
import fastifyStatic from '@fastify/static';
import { existsSync } from 'node:fs';
import config from '../config/index.js';
import { createLogger } from '../config/logger.js';
import { getDb } from '../db/index.js';
import { HttpError } from './guards.js';
import { registerAuthRoutes } from '../auth/routes.js';
import { startTelegramPolling } from '../auth/telegram.js';
import { registerTelegramAdminRoutes } from '../telegram/admin-routes.js';
import { registerUserRoutes } from '../users/routes.js';
import { registerRoleRoutes } from '../roles/routes.js';
import { registerPermissionRoutes } from '../permissions/routes.js';
import { registerAiRoutes } from '../ai/routes.js';
import { registerKnowledgeRoutes } from '../knowledge/routes.js';
import { registerReportRoutes } from '../reports/routes.js';
import { registerAuditRoutes } from '../audit/index.js';
import { registerSettingsRoutes } from '../settings/routes.js';
import { registerSystemRoutes } from './system.js';

export type { AuthContext } from '../auth/session.js';
export { HttpError, requireAuth, requirePermission, requireAnyPermission, optionalAuth } from './guards.js';

export async function buildServer(): Promise<FastifyInstance> {
  const app = Fastify({
    // Собственный логгер вместо pino: в Windows-консоли (cp866/cp1251) pino
    // выдаёт нечитаемую кириллицу, так как пишет UTF-8 байты мимо console.log.
    // См. backend/src/config/logger.ts.
    loggerInstance: createLogger(config.logLevel) as unknown as FastifyBaseLogger,
    bodyLimit: 4 * 1024 * 1024,
    trustProxy: true,
  });

  await app.register(cors, { origin: true, credentials: true, exposedHeaders: ['x-epic-ai-version'] });
  await app.register(cookie);

  // Голосовой ввод: клиент шлёт сырую аудиозапись (audio/webm|ogg|mp4) телом
  // запроса POST /api/ai/transcribe — регистрируем парсер буфера для этих
  // content-type, иначе Fastify отклонит запрос как неподдерживаемый тип.
  app.addContentTypeParser(
    ['audio/webm', 'audio/ogg', 'audio/mp4', 'audio/mpeg', 'audio/wav', 'application/octet-stream'],
    { parseAs: 'buffer' },
    (_req, body, done) => done(null, body),
  );

  // Статика: админ-панель и служебные страницы. Electron грузит renderer
  // напрямую с диска, поэтому статика нужна в основном для веб-доступа к админке.
  if (existsSync(config.paths.rendererDir)) {
    await app.register(fastifyStatic, {
      root: config.paths.rendererDir,
      prefix: '/ui/',
      decorateReply: false,
    });
  }

  app.setErrorHandler((error: unknown, req, reply) => {
    const err = error as { statusCode?: number; status?: number; code?: string; message?: string };
    const status = err?.statusCode ?? err?.status ?? 500;
    if (status >= 500) req.log.error(error);
    reply.code(status).send({
      error: err?.code ?? 'internal_error',
      message: status >= 500 && config.isProd ? 'Внутренняя ошибка сервера' : (err?.message ?? 'Внутренняя ошибка сервера'),
    });
  });

  app.setNotFoundHandler((req, reply) => {
    reply.code(404).send({ error: 'not_found', message: `Маршрут не найден: ${req.method} ${req.url}` });
  });

  app.addHook('onRequest', async (req, reply) => {
    reply.header('x-epic-ai-version', '1.0.0');
    reply.header('x-powered-by', 'EpicAI');

    // Защита от CSRF при cookie-авторизации: любой мутирующий запрос к /api
    // обязан нести заголовок X-Epic-Client, который чужой сайт добавить не может.
    if (req.method !== 'GET' && req.method !== 'HEAD' && req.url.startsWith('/api/')) {
      const v = req.headers['x-epic-client'];
      if (v !== 'desktop' && v !== 'admin-web' && v !== 'cli') {
        return reply.code(400).send({ error: 'missing_client_header', message: 'Требуется заголовок X-Epic-Client: desktop | admin-web | cli' });
      }
    }
  });

  // ---------- Маршруты ----------
  await registerSystemRoutes(app);
  await registerAuthRoutes(app);
  await registerTelegramAdminRoutes(app);
  await registerUserRoutes(app);
  await registerRoleRoutes(app);
  await registerPermissionRoutes(app);
  await registerAiRoutes(app);
  await registerKnowledgeRoutes(app);
  await registerReportRoutes(app);
  await registerAuditRoutes(app);
  await registerSettingsRoutes(app);

  return app;
}

export async function startServer(): Promise<FastifyInstance> {
  await getDb();
  const app = await buildServer();
  await app.listen({ host: config.host, port: config.port });

  // Telegram-бот стартует вместе с backend (п.1 раунда 24): long-polling
  // getUpdates держит подтверждения кнопок «Войти»/«Это не я» без задержек.
  startTelegramPolling();
  app.log.info(`Epic AI backend: ${config.publicUrl} (db: ${config.db.driver}, ai: ${config.ai.provider})`);
  return app;
}
