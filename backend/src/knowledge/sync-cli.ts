/**
 * CLI синхронизации Knowledge Base.
 *
 *   npm run sync                     — обычный прогон
 *   npm run sync -- --full           — полный обход + RSS
 *   npm run sync -- --offline        — переиндексация из кэша, без сети
 *   npm run sync -- --force          — разрешить, даже если CRAWLER_ENABLED=false
 */
import { runSync } from './sync.js';
import { migrate, seed } from '../db/migrate.js';
import { closeDb, getDb } from '../db/index.js';
import { syncPermissionCatalog } from '../permissions/catalog.js';

const argv = process.argv.slice(2);
const has = (f: string) => argv.includes(f);

async function main() {
  await migrate();
  await seed();
  await syncPermissionCatalog(await getDb());

  if (has('--force')) process.env.CRAWLER_ENABLED = 'true';

  const stats = await runSync({
    triggerType: 'manual',
    full: has('--full'),
    offline: has('--offline'),
    onProgress: (step, detail) => console.log(`  [${step}] ${detail ?? ''}`),
  });

  console.log('\n[epic-ai] ==== результат синхронизации ====');
  console.log(`  статус:        ${stats.status}`);
  console.log(`  новых:         ${stats.docsNew}`);
  console.log(`  изменено:      ${stats.docsUpdated}`);
  console.log(`  в архив:       ${stats.docsArchived}`);
  console.log(`  без изменений: ${stats.docsUnchanged}`);
  console.log(`  страниц:       ${stats.pagesFetched}`);
  console.log(`  версия базы:   ${stats.kbVersion}`);
  console.log(`  время:         ${stats.startedAt} → ${stats.finishedAt}`);
  if (stats.error) console.log(`  ошибка:        ${stats.error}`);
  if (stats.warnings.length) {
    console.log('  предупреждения:');
    for (const w of stats.warnings.slice(0, 20)) console.log(`    ! ${w}`);
  }
  await closeDb();
  process.exitCode = stats.status === 'success' ? 0 : 1;
}

main().catch(async (e) => { console.error(e); await closeDb(); process.exit(1); });
