/**
 * EPIC AI — уведомления Telegram-бота (раунд 28).
 *
 * Тумблер «Уведомлять об обновлениях базы знаний» в админке: после NEW/UPDATED
 * документа бот рассылает подписчикам (identity telegram) короткую сводку.
 * Ошибки уведомлений не должны влиять на ingest — всё глотается.
 */
import config from '../config/index.js';
import { getDb, type Row } from '../db/index.js';
import { sendText } from '../auth/telegram.js';
import { getSetting } from '../knowledge/service.js';

function escapeHtml(s: string): string {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

export async function notifyKbUpdate(info: {
  title: string;
  category?: string | null;
  outcome: 'NEW' | 'UPDATED';
  added?: number;
  removed?: number;
  url?: string | null;
}): Promise<void> {
  try {
    const on = String(await getSetting('telegram.notify_kb_updates', 'false')) === 'true';
    if (!on || !config.telegram.enabled || !config.telegram.botToken) return;
    const db = await getDb();
    const subs = await db.all<Row>("SELECT DISTINCT provider_user_id FROM identities WHERE provider = 'telegram'");
    if (!subs.length) return;
    const words = info.added || info.removed
      ? `\n+${info.added ?? 0} / −${info.removed ?? 0} слов`
      : '';
    const text = [
      `\u{1F4DC} <b>${info.outcome === 'NEW' ? 'Новый документ базы знаний' : 'Обновление базы знаний'}</b>`,
      `${escapeHtml(info.title)}${info.category ? ` · ${escapeHtml(info.category)}` : ''}`,
      words,
      info.url ? escapeHtml(info.url) : '',
    ].filter(Boolean).join('\n');
    for (const r of subs) await sendText(String(r.provider_user_id), text);
  } catch { /* уведомления не должны ронять ingest */ }
}
