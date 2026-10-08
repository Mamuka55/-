/**
 * EPIC AI — планировщик автоматической синхронизации.
 *
 * Интервал по умолчанию: 30 минут. Позже частота выносится в серверную
 * настройку app_settings['sync.interval_minutes'] — она уже читается отсюда,
 * так что перенос на VPS ничего не ломает.
 */
import { getDb } from '../db/index.js';
import config from '../config/index.js';
import { runSync, isSyncRunning } from '../knowledge/sync.js';
import { getSetting } from '../knowledge/service.js';
import { audit, AUDIT_ACTIONS } from '../audit/index.js';

let timer: NodeJS.Timeout | null = null;
let stopped = false;

export function isSchedulerRunning(): boolean { return timer !== null; }

export async function getIntervalMinutes(): Promise<number> {
  const fromDb = Number(await getSetting('sync.interval_minutes', config.crawler.intervalMinutes));
  const automatic = await getSetting('sync.automatic', true);
  if (!automatic) return 0;
  return Number.isFinite(fromDb) && fromDb >= 1 ? fromDb : config.crawler.intervalMinutes;
}

export async function startScheduler(opts: { initialDelayMs?: number } = {}): Promise<void> {
  stopped = false;
  const delay = opts.initialDelayMs ?? 20_000;
  setTimeout(() => { void tick(); }, delay);
  scheduleNext();
}

function scheduleNext(): void {
  if (timer) clearTimeout(timer);
  if (stopped) return;
  void getIntervalMinutes().then((minutes) => {
    if (!minutes || minutes <= 0) {
      // Автоматическая синхронизация выключена — проверяем настройку раз в 5 минут
      timer = setTimeout(() => { stopped ? undefined : scheduleNext(); }, 5 * 60_000);
      if (timer.unref) timer.unref();
      return;
    }
    timer = setTimeout(() => { void tick(); scheduleNext(); }, minutes * 60_000);
    if (timer.unref) timer.unref();
  }).catch(() => {
    timer = setTimeout(() => scheduleNext(), 60_000);
    if (timer.unref) timer.unref();
  });
}

async function tick(): Promise<void> {
  if (stopped) return;
  if (!config.crawler.enabled) return; // crawler выключен — ничего не качаем
  if (isSyncRunning()) return;
  try {
    const stats = await runSync({ triggerType: 'auto' });
    await audit({
      actorId: null, actorName: 'system', action: AUDIT_ACTIONS.SYNC_AUTO,
      entityType: 'sync_log', entityId: stats.syncLogId,
      meta: { new: stats.docsNew, updated: stats.docsUpdated, archived: stats.docsArchived, status: stats.status, error: stats.error ?? null },
      ip: null,
    });
  } catch (e: any) {
    // Ошибка синхронизации не должна ронять backend
    console.error('[epic-ai][scheduler] sync failed:', e?.message ?? e);
  }
}

export function stopScheduler(): void {
  stopped = true;
  if (timer) { clearTimeout(timer); timer = null; }
}

export async function touchDb(): Promise<void> { await getDb(); }
