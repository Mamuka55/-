/**
 * EPIC AI — защищённый bootstrap первого Developer.
 *
 * Developer не создаётся и не выдаётся обычной административной панелью.
 * Первый разработчик создаётся только этим скриптом (или POST /api/bootstrap/developer
 * с BOOTSTRAP_TOKEN), после чего токен необходимо обнулить.
 *
 * Запуск:
 *   npm run bootstrap:developer -- --discord 123456789012345678
 *   npm run bootstrap:developer -- --telegram 987654321
 *   npm run bootstrap:developer -- --local dev          # локальный тестовый вход (только development)
 *
 *   --name "ВашНик" — сразу задать отображаемый ник (иначе «Developer»,
 *                     пока ник не приедет из Discord/Telegram при OAuth-входе).
 */
import { getDb, closeDb, type Row } from '../db/index.js';
import { migrate, seed } from '../db/migrate.js';
import { syncPermissionCatalog } from '../permissions/catalog.js';
import { findOrCreateUserByIdentity, setUserRole, getUserProfile } from '../users/service.js';
import { audit, AUDIT_ACTIONS } from '../audit/index.js';
import config from '../config/index.js';

interface Args { discord?: string; telegram?: string; local?: string; force?: boolean; name?: string }

function parseArgs(argv: string[]): Args {
  const out: Args = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === '--discord') out.discord = argv[++i];
    else if (a === '--telegram') out.telegram = argv[++i];
    else if (a === '--local') out.local = argv[++i] ?? 'dev';
    else if (a === '--force') out.force = true;
    else if (a === '--name') out.name = argv[++i];
  }
  return out;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  await migrate();
  await seed();
  const db = await getDb();
  await syncPermissionCatalog(db);

  const devs = await db.all<Row>(
    `SELECT u.id, u.username FROM user_roles ur JOIN roles r ON r.id = ur.role_id JOIN users u ON u.id = ur.user_id WHERE r.code = 'developer'`,
  );
  if (devs.length && !args.force) {
    console.log('[epic-ai] Developer уже существует:');
    for (const d of devs) console.log(`  • #${d.id} ${d.username}`);
    console.log('[epic-ai] Повторный bootstrap запрещён. Используйте --force только если точно понимаете зачем.');
    await closeDb();
    return;
  }

  let userId: number | null = null;
  let label = '';

  if (args.local) {
    if (config.isProd) throw new Error('--local запрещён в production');
    const r = await findOrCreateUserByIdentity({
      provider: 'discord',
      providerUserId: `local-${args.local}`,
      username: args.local,
      displayName: args.local,
      avatarUrl: null,
      raw: { bootstrap: 'local' },
    });
    userId = Number(r.user.id);
    label = `local:${args.local}`;
  } else if (args.discord) {
    const r = await findOrCreateUserByIdentity({ provider: 'discord', providerUserId: args.discord, username: args.name ?? 'developer', displayName: args.name ?? 'Developer' });
    userId = Number(r.user.id);
    label = `discord:${args.discord}`;
  } else if (args.telegram) {
    const r = await findOrCreateUserByIdentity({ provider: 'telegram', providerUserId: args.telegram, username: args.name ?? 'developer', displayName: args.name ?? 'Developer' });
    userId = Number(r.user.id);
    label = `telegram:${args.telegram}`;
  } else {
    console.error('Укажите --discord <id>, --telegram <id> или --local <name>');
    process.exitCode = 1;
    await closeDb();
    return;
  }

  await setUserRole(userId!, 'developer', null);
  await audit({ actorId: userId, actorName: 'bootstrap', action: AUDIT_ACTIONS.BOOTSTRAP_DEVELOPER, entityType: 'user', entityId: userId!, meta: { label }, ip: null });

  const profile = await getUserProfile(userId!);
  console.log('[epic-ai] Developer создан:');
  console.log(`  • id:        ${userId}`);
  console.log(`  • username:  ${profile?.username}`);
  console.log(`  • identity:  ${label}`);
  console.log(`  • роль:      ${profile?.primaryRole?.name} (${profile?.primaryRole?.code})`);
  if (args.local) {
    console.log('');
    console.log('  Локальный вход (только development):');
    console.log(`    curl -X POST ${config.publicUrl}/api/auth/dev-login \\`);
    console.log(`      -H "Content-Type: application/json" -H "X-Epic-Client: cli" \\`);
    console.log(`      -d '{"token":"${config.session.secret}","userId":${userId}}'`);
  }
  if (config.bootstrap.token) console.log('\n[epic-ai] Не забудьте обнулить BOOTSTRAP_TOKEN в backend/.env');
  await closeDb();
}

main().catch(async (e) => { console.error(e); await closeDb(); process.exit(1); });
