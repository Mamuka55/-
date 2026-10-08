/**
 * EPIC AI — точка входа backend.
 *
 * Локальная разработка :  Electron + Backend + SQLite + Crawler на одной машине.
 * Production :           тот же код за reverse proxy на VPS, DB_DRIVER=postgres.
 */
import config from './config/index.js';
import { acquireInstanceLock } from './config/lock.js';
import { startServer } from './http/server.js';
import { startScheduler, stopScheduler } from './http/scheduler.js';
import { migrate, seed } from './db/migrate.js';
import { closeDb, flushDb, getDb } from './db/index.js';
import { stopTelegramPolling } from './auth/telegram.js';
import { syncPermissionCatalog } from './permissions/catalog.js';

async function main(): Promise<void> {
  console.log('[epic-ai] backend starting…');
  acquireInstanceLock();

  // Миграции и сиды применяем автоматически: приложение должно подниматься
  // одной командой и на машине разработчика, и на VPS.
  const mig = await migrate();
  if (mig.applied.length) console.log(`[epic-ai] migrations applied: ${mig.applied.join(', ')}`);
  const seeded = await seed();
  if (seeded.length) console.log(`[epic-ai] seeds applied: ${seeded.join(', ')}`);
  await syncPermissionCatalog(await getDb());

  const app = await startServer();

  // Автоматическая синхронизация форума  + обновление базы ПРИ ЗАПУСКЕ
  // приложения: планировщик делает первый tick через ~12 секунд после старта
  // (embedded-backend поднимается вместе с Electron-клиентом), далее — по
  // расписанию. Клиент дополнительно дёргает POST /api/kb/sync при своём
  // запуске (electron/main/main.js#triggerKbSyncOnStart) — это покрывает
  // режим VPS, где backend живёт постоянно.
  if (config.crawler.enabled) {
    await startScheduler({ initialDelayMs: 12_000 });
    const minutes = Number(process.env.CRAWLER_INTERVAL_MINUTES ?? config.crawler.intervalMinutes);
    app.log.info(`[epic-ai] scheduler started: sync at startup + every ${minutes} min`);
  } else {
    app.log.warn('[epic-ai] CRAWLER_ENABLED=false — автообновление базы при запуске и по расписанию отключено (robots.txt форума, см. docs/LEGAL.md)');
  }

  if (!config.telegram.enabled) {
    app.log.warn('[epic-ai] Telegram не настроен: используйте `npm run bootstrap:developer` для локального входа');
  }
  if (config.ai.provider === 'mock') {
    app.log.warn('[epic-ai] AI_PROVIDER=mock — ответы генерируются заглушкой. Настройте AI_PROVIDER/AI_API_KEY.');
  }
  if (config.session.secret === 'change-me') {
    app.log.warn('[epic-ai] SESSION_SECRET не изменён — смените его перед любым публичным развёртыванием');
  }

  const shutdown = async (signal: string) => {
    app.log.info(`[epic-ai] ${signal} — останавливаюсь…`);
    stopTelegramPolling();
    stopScheduler();
    try { await app.close(); } catch { /* ignore */ }
    try { await flushDb(); await closeDb(); } catch { /* ignore */ }
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('beforeExit', () => { void flushDb(); });
  process.on('unhandledRejection', (reason) => { app.log.error({ err: reason }, 'unhandledRejection'); });
}

main().catch((e) => {
  console.error('[epic-ai] fatal:', e);
  process.exit(1);
});
