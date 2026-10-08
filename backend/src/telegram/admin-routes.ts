/**
 * EPIC AI — административные маршруты Telegram-бота (раунд 28).
 *
 * Раздел админки «Telegram bot»: статус бота, подписчики, тумблер
 * автоуведомлений об обновлениях базы, рассылка по подписчикам, журнал
 * последних рассылок. Всё под permission telegram.manage.
 */
import type { FastifyInstance } from 'fastify';
import config from '../config/index.js';
import { getDb, type Row } from '../db/index.js';
import { requirePermission, BadRequestError } from '../http/guards.js';
import { audit } from '../audit/index.js';
import { getSetting, setSetting } from '../knowledge/service.js';
import { sendText, isTelegramPolling } from '../auth/telegram.js';

const recent: Array<{ at: string; author: string; text: string; sent: number; failed: number }> = [];

function escapeHtml(s: string): string {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

export async function registerTelegramAdminRoutes(app: FastifyInstance): Promise<void> {
  /** Статус бота и журнал рассылок. */
  app.get('/api/telegram/status', { preHandler: [requirePermission('telegram.manage')] }, async (_req, reply) => {
    const db = await getDb();
    const subs = await db.all<Row>("SELECT DISTINCT provider_user_id FROM identities WHERE provider = 'telegram'");
    return reply.send({
      enabled: config.telegram.enabled && Boolean(config.telegram.botToken),
      username: config.telegram.botUsername || null,
      polling: isTelegramPolling(),
      subscribers: subs.length,
      notifyKbUpdates: String(await getSetting('telegram.notify_kb_updates', 'false')) === 'true',
      recent,
    });
  });

  /** Тумблер автоуведомлений об обновлениях базы знаний. */
  app.put('/api/telegram/settings', { preHandler: [requirePermission('telegram.manage')] }, async (req, reply) => {
    const body = (req.body ?? {}) as { notifyKbUpdates?: unknown };
    if (typeof body.notifyKbUpdates !== 'boolean') throw new BadRequestError('notifyKbUpdates: true|false');
    await setSetting('telegram.notify_kb_updates', body.notifyKbUpdates ? 'true' : 'false', req.auth!.user.id);
    await audit({
      actorId: req.auth!.user.id, actorName: req.auth!.user.username,
      action: 'telegram.settings', entityType: 'telegram', entityId: 'notify_kb_updates',
      meta: { notifyKbUpdates: body.notifyKbUpdates }, ip: req.ip,
    });
    return reply.send({ ok: true, notifyKbUpdates: body.notifyKbUpdates });
  });

  /** Рассылка по всем подписчикам Telegram. */
  app.post('/api/telegram/broadcast', { preHandler: [requirePermission('telegram.manage')] }, async (req, reply) => {
    const text = String((req.body as { text?: string })?.text ?? '').trim();
    if (!text) throw new BadRequestError('Текст рассылки пуст');
    if (text.length > 4000) throw new BadRequestError('Сообщение длиннее 4000 символов');
    if (!(config.telegram.enabled && config.telegram.botToken)) {
      return reply.code(409).send({ error: 'telegram_disabled', message: 'Telegram-бот не настроен на сервере' });
    }
    const db = await getDb();
    const subs = await db.all<Row>("SELECT DISTINCT provider_user_id FROM identities WHERE provider = 'telegram'");
    let sent = 0; let failed = 0;
    const bodyText = `\u{1F4E3} <b>Объявление Epic AI</b>\n\n${escapeHtml(text)}`;
    for (const r of subs) {
      // последовательно: уважаем rate-limit бота (~30 сообщений/сек)
      if (await sendText(String(r.provider_user_id), bodyText)) sent += 1; else failed += 1;
    }
    recent.unshift({ at: new Date().toISOString(), author: String(req.auth!.user.username), text: text.slice(0, 200), sent, failed });
    if (recent.length > 10) recent.length = 10;
    await audit({
      actorId: req.auth!.user.id, actorName: req.auth!.user.username,
      action: 'telegram.broadcast', entityType: 'telegram', entityId: String(sent),
      meta: { sent, failed, text: text.slice(0, 500) }, ip: req.ip,
    });
    return reply.send({ ok: true, sent, failed, subscribers: subs.length });
  });
}
