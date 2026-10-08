/**
 * CLI базы данных:  npm run db:migrate | db:seed | db:reset | db:status
 */
import { migrate, seed, reset, status } from './migrate.js';
import { closeDb, getDb } from './index.js';
import config from '../config/index.js';

const cmd = process.argv[2] ?? 'migrate';

async function main() {
  const db = await getDb();
  console.log(`[epic-ai] driver: ${db.driver} / engine: ${db.engine}` +
    (db.driver === 'sqlite' ? ` (${config.db.sqlitePath})` : ` (${config.db.pg.host}:${config.db.pg.port}/${config.db.pg.database})`));
  switch (cmd) {
    case 'migrate': {
      const r = await migrate();
      console.log(`[epic-ai] applied: ${r.applied.length ? r.applied.join(', ') : '—'} (skipped ${r.skipped.length})`);
      break;
    }
    case 'seed': {
      const r = await seed();
      console.log(`[epic-ai] seeds: ${r.join(', ') || '—'}`);
      break;
    }
    case 'reset': {
      await reset();
      console.log('[epic-ai] database reset complete');
      break;
    }
    case 'status': {
      const s = await status();
      console.log(`[epic-ai] applied: ${s.applied.join(', ') || '—'}`);
      console.log(`[epic-ai] pending: ${s.pending.join(', ') || '—'}`);
      break;
    }
    default:
      console.error(`Unknown command: ${cmd}. Use migrate | seed | reset | status`);
      process.exitCode = 1;
  }
  await closeDb();
}

main().catch(async (e) => { console.error(e); await closeDb(); process.exit(1); });
