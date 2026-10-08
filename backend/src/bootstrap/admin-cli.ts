/**
 * EPIC AI — CLI администратора базы.
 *
 * Нужен для ситуаций, когда в приложение войти нельзя: заблокирован аккаунт,
 * потеряна роль Developer, в базе завелись тестовые пользователи.
 * Работает напрямую с БД, минуя HTTP и RBAC, поэтому запускается только
 * на машине с доступом к файлу базы.
 *
 *   npm run users                          список пользователей
 *   npm run users -- --unblock 1           разблокировать
 *   npm run users -- --unblock-all         разблокировать всех
 *   npm run users -- --developer 1         выдать роль Developer
 *   npm run users -- --role 1 player       назначить роль
 *   npm run users -- --revoke-sessions 1   завершить все сессии пользователя
 *   npm run users -- --revoke-all          завершить все сессии (сброс входов)
 *   npm run users -- --delete 3            удалить пользователя вместе с данными
 *   npm run users -- --doctor              диагностика: кто Developer, кто заблокирован,
 *                                          сколько сессий живо, состояние базы
 *
 * ВАЖНО: на драйвере sql.js база держится в памяти процесса, поэтому перед
 * запуском CLI остановите backend. На better-sqlite3/PostgreSQL это не требуется.
 */
import { getDb, closeDb, formatDateTime, type Row, type DbClient } from '../db/index.js';
import { migrate, seed } from '../db/migrate.js';
import { syncPermissionCatalog, computeEffectivePermissions } from '../permissions/catalog.js';
import { setUserRole } from '../users/service.js';
import { audit } from '../audit/index.js';
import config from '../config/index.js';

const argv = process.argv.slice(2);
const flag = (name: string): string | undefined => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? argv[i + 1] : undefined;
};
const has = (name: string): boolean => argv.includes(`--${name}`);

async function listUsers(db: DbClient): Promise<Row[]> {
  return db.all<Row>(
    `SELECT u.id, u.username, u.display_name, u.status, u.blocked_reason, u.blocked_at,
            u.created_at, u.last_login_at,
            (SELECT r.code FROM user_roles ur JOIN roles r ON r.id = ur.role_id
              WHERE ur.user_id = u.id ORDER BY r.level DESC LIMIT 1) AS role_code,
            (SELECT r.name FROM user_roles ur JOIN roles r ON r.id = ur.role_id
              WHERE ur.user_id = u.id ORDER BY r.level DESC LIMIT 1) AS role_name,
            (SELECT r.color FROM user_roles ur JOIN roles r ON r.id = ur.role_id
              WHERE ur.user_id = u.id ORDER BY r.level DESC LIMIT 1) AS role_color,
            (SELECT COUNT(*) FROM sessions s WHERE s.user_id = u.id AND s.revoked_at IS NULL AND s.expires_at > ?) AS live_sessions
       FROM users u ORDER BY u.id`,
    [new Date().toISOString()],
  );
}

async function identitiesOf(db: DbClient, userId: number): Promise<Row[]> {
  return db.all<Row>('SELECT provider, provider_user_id, username, display_name FROM identities WHERE user_id = ? ORDER BY provider', [userId]);
}

async function printUsers(db: DbClient): Promise<void> {
  const users = await listUsers(db);
  if (!users.length) {
    console.log('В базе нет ни одного пользователя.');
    console.log('Создайте первого: npm run bootstrap:developer -- --local developer');
    return;
  }
  console.log(`\nПользователей: ${users.length}\n`);
  console.log('  ID  Статус    Роль                          Ник                     Сессий  Последний вход');
  console.log('  ' + '─'.repeat(104));
  for (const u of users) {
    const status = String(u.status) === 'blocked' ? '\x1b[31mblocked  \x1b[0m' : '\x1b[32mactive   \x1b[0m';
    const role = `${u.role_name ?? '—'} (${u.role_code ?? '—'})`;
    console.log(
      `  ${String(u.id).padStart(2)}  ${status}  ${role.padEnd(28)}  ${String(u.username).padEnd(22)}  ${String(u.live_sessions).padStart(4)}    ${u.last_login_at ? formatDateTime(u.last_login_at) : '—'}`,
    );
    if (String(u.status) === 'blocked' && u.blocked_reason) {
      console.log(`       причина: ${u.blocked_reason} (${formatDateTime(u.blocked_at)})`);
    }
    const ids = await identitiesOf(db, Number(u.id));
    if (ids.length) {
      console.log(`       identity: ${ids.map((i) => `${i.provider}:${i.provider_user_id}${i.username ? ` (@${i.username})` : ''}`).join(', ')}`);
    }
  }
  console.log('');
}

async function doctor(db: DbClient): Promise<void> {
  console.log('\n=== Диагностика Epic AI ===\n');

  const engine = db.engine;
  console.log(`  База:      ${config.db.driver} / ${engine}` + (config.db.driver === 'sqlite' ? ` (${config.db.sqlitePath})` : ''));
  if (engine === 'sql.js') {
    console.log('  \x1b[33m⚠ sql.js: база в памяти процесса. Остановите backend перед CLI-командами.\x1b[0m');
    console.log('    Поставьте нативный драйвер: cd backend && npm install better-sqlite3');
  }

  const counts = await db.get<Row>(
    `SELECT (SELECT COUNT(*) FROM users) AS users,
            (SELECT COUNT(*) FROM users WHERE status = 'blocked') AS blocked,
            (SELECT COUNT(*) FROM identities) AS identities,
            (SELECT COUNT(*) FROM sessions WHERE revoked_at IS NULL AND expires_at > ?) AS live_sessions,
            (SELECT COUNT(*) FROM documents) AS documents,
            (SELECT COUNT(*) FROM documents WHERE status = 'active') AS docs_active,
            (SELECT COUNT(*) FROM document_chunks WHERE is_current = 1) AS chunks,
            (SELECT COUNT(*) FROM ai_requests) AS requests,
            (SELECT COUNT(*) FROM ai_reports) AS reports`,
    [new Date().toISOString()],
  );
  console.log(`  Пользователей: ${counts?.users ?? 0} (заблокировано: ${counts?.blocked ?? 0})`);
  console.log(`  Identity:      ${counts?.identities ?? 0}`);
  console.log(`  Живых сессий:  ${counts?.live_sessions ?? 0}`);
  console.log(`  Документов:    ${counts?.docs_active ?? 0} активных из ${counts?.documents ?? 0}`);
  console.log(`  Фрагментов:    ${counts?.chunks ?? 0}`);
  console.log(`  AI-запросов:   ${counts?.requests ?? 0}, отчётов: ${counts?.reports ?? 0}`);

  const devs = await db.all<Row>(
    `SELECT u.id, u.username, u.status FROM user_roles ur
       JOIN roles r ON r.id = ur.role_id JOIN users u ON u.id = ur.user_id
      WHERE r.code = 'developer'`,
  );
  if (devs.length) {
    console.log(`  Developer:     ${devs.map((d: Row) => `#${d.id} ${d.username}${String(d.status) === 'blocked' ? ' (ЗАБЛОКИРОВАН)' : ''}`).join(', ')}`);
  } else {
    console.log('  \x1b[31mDeveloper: НЕТ — админ-панель недоступна никому\x1b[0m');
    console.log('    Исправление: npm run users -- --developer <id>');
  }

  const blocked = await db.all<Row>("SELECT id, username, blocked_reason FROM users WHERE status = 'blocked'");
  if (blocked.length) {
    console.log(`  \x1b[31mЗаблокированы: ${blocked.map((b: Row) => `#${b.id} ${b.username}`).join(', ')}\x1b[0m`);
    console.log('    Исправление: npm run users -- --unblock <id>   (или --unblock-all)');
  }

  console.log(`\n  AI-провайдер:  ${config.ai.provider} (${config.ai.model})` +
    ((config.ai.provider as string) !== 'mock' && !config.ai.apiKey ? ' \x1b[33m— AI_API_KEY не задан\x1b[0m' : ''));
  // П.4 раунда 34: живая проба ИИ — один тестовый запрос с таймаутом,
  // чтобы «работает ли ИИ» проверялось одной командой doctor.
  if (/ai\.api\.cloud\.yandex\.net/i.test(config.ai.baseUrl)
    && config.ai.yandexFolderId && !/^[a-z0-9]{3,}[a-z0-9-]*$/i.test(config.ai.yandexFolderId)) {
    console.log('  \x1b[33mВнимание: YANDEX_FOLDER_ID похож на плейсхолдер — вставьте id папки из консоли (b1g…)\x1b[0m');
  }
  if ((config.ai.provider as string) !== 'mock') {
    try {
      const { getProvider } = await import('../ai/providers/index.js');
      const prov = getProvider();
      const chk = prov.isConfigured();
      if (!chk.ok) {
        console.log(`  \x1b[33mAI-проба: провайдер не настроен — ${chk.reason}\x1b[0m`);
      } else {
        const t0 = Date.now();
        const res = await prov.chat([{ role: 'user', content: 'Ответь одним словом: готов' }], { maxTokens: 16 });
        console.log(`  AI-проба:      OK — модель ${res.model}, ответ «${res.content.slice(0, 40).trim()}», ${Date.now() - t0} мс`);
      }
    } catch (e: any) {
      const msg = String(e?.message ?? e).slice(0, 600);
      console.log(`  \x1b[31mAI-проба: ОШИБКА — ${msg}\x1b[0m`);
      // Подсказки по типовым кодам площадок (раунд 34)
      if (/GigaChat OAuth не удался|GigaChat вернул 401/i.test(msg)) {
        console.log('    → ключ GigaChat отклонён и через OAuth: пересоздайте ключ');
        console.log('      в кабинете developers.sber.ru и проверьте, что аккаунт подтверждён.');
      } else if (/401|30014|invalid[ _]?token|incorrect api key/i.test(msg)) {
        console.log('    → провайдер не принял AI_API_KEY: скопируйте ключ заново целиком');
        console.log('      (siliconflow.com → Account → API Keys), без кавычек и пробелов,');
        console.log('      и убедитесь, что аккаунт подтверждён (email/телефон).');
      } else if (/does not match|folder/i.test(msg)) {
        console.log('    → YANDEX_FOLDER_ID не совпадает с папкой ключа. Частая причина:');
        console.log('      вставлен id ОБЛАКА или id самого ключа (оба похожи на b1g…/aje…),');
        console.log('      а нужен id ПАПКИ: консоль → облако → список папок → ваша папка,');
        console.log('      либо `yc config get folder-id`. Ключ (AQVN…) должен лежать в этой');
        console.log('      же папке: Сервисные аккаунты → аккаунт → API-ключи.');
      } else if (/organization-manager|resource-manager\.cloud/.test(msg)) {
        console.log('    → отказ на всех уровнях (папка/облако/организация): у сервисного');
        console.log('      аккаунта ключа нет ни одной роли, а облако принадлежит ОРГАНИЗАЦИИ —');
        console.log('      назначить роль может только админ папки/облака:');
        console.log('      yc resource-manager folder add-access-binding <folder> --role');
        console.log('      ai.languageModels.user --subject serviceAccount:<id владельца ключа>.');
        console.log('      Альтернативы без админа: личное облако вне организации,');
        console.log('      GigaChat (личный токен физлица) или Ollama локально.');
      } else if (/PermissionDenied|resource-manager|access.*denied/i.test(msg)) {
        console.log('    → у сервисного аккаунта ключа нет роли в папке. Выдайте её:');
        console.log('      консоль → папка → Service accounts → ваш аккаунт →');
        console.log('      «Назначить роли» → ai.languageModels.user;');
        console.log('      или yc: resource-manager folder add-access-binding <folder>');
        console.log('      --role ai.languageModels.user --subject serviceAccount:<id>.');
      } else if (/404|model_not_found|not available/i.test(msg)) {
        console.log('    → модель недоступна: проверьте AI_MODEL (бесплатны Qwen/Qwen3-8B');
        console.log('      и deepseek-ai/DeepSeek-R1-Distill-Qwen-7B) или смените на фолбэк.');
      } else if (/429|rate/i.test(msg)) {
        console.log('    → исчерпан лимит площадки: подождите или смените модель на фолбэк.');
      } else if (/fetch failed|ECONN|ETIMEDOUT|network/i.test(msg)) {
        console.log('    → сеть до провайдера недоступна с этого компьютера.');
      }
    }
  } else {
    console.log('  AI-проба:      mock — ответы генерируются заглушкой без сети');
  }
  console.log(`  Telegram:      ${config.telegram.enabled ? 'включён' : '\x1b[33mвыключен\x1b[0m'}`);
  console.log(`  Crawler:       ${config.crawler.enabled ? 'включён' : 'выключен (см. docs/LEGAL.md)'}`);

  if (!config.telegram.enabled) {
    console.log('\n  \x1b[33mНи один способ входа не настроен.\x1b[0m');
    console.log('  Для разработки используйте локальный вход:');
    console.log('    npm run bootstrap:developer -- --local developer');
    console.log('  затем POST /api/auth/dev-login с SESSION_SECRET (см. docs/DEVELOPMENT.md).');
  }
  console.log('');
}

async function main(): Promise<void> {
  await migrate();
  await seed();
  const db = await getDb();
  await syncPermissionCatalog(db);

  const unblockId = flag('unblock');
  const developerId = flag('developer');
  const deleteId = flag('delete');
  const revokeId = flag('revoke-sessions');
  const roleId = flag('role');

  if (has('unblock-all')) {
    const r = await db.run(
      "UPDATE users SET status = 'active', blocked_reason = NULL, blocked_by = NULL, blocked_at = NULL, updated_at = ? WHERE status = 'blocked'",
      [new Date().toISOString()],
    );
    await audit({ actorId: null, actorName: 'cli', action: 'user.unblock', entityType: 'user', entityId: 'all', meta: { count: r.changes, via: 'cli' }, ip: null });
    console.log(`\x1b[32mРазблокировано пользователей: ${r.changes}\x1b[0m`);
  } else if (unblockId) {
    const id = Number(unblockId);
    const u = await db.get<Row>('SELECT id, username, status FROM users WHERE id = ?', [id]);
    if (!u) { console.error(`Пользователь #${id} не найден`); process.exitCode = 1; }
    else {
      await db.run(
        "UPDATE users SET status = 'active', blocked_reason = NULL, blocked_by = NULL, blocked_at = NULL, updated_at = ? WHERE id = ?",
        [new Date().toISOString(), id],
      );
      // сессии были инвалидированы при блокировке — их не восстановить, вход будет новым
      await audit({ actorId: null, actorName: 'cli', action: 'user.unblock', entityType: 'user', entityId: id, meta: { via: 'cli', was: String(u.status) }, ip: null });
      console.log(`\x1b[32mПользователь #${id} (${u.username}) разблокирован.\x1b[0m`);
      console.log('Его прежние сессии были инвалидированы при блокировке — войдите заново.');
    }
  } else if (has('revoke-all')) {
    const r = await db.run(
      'UPDATE sessions SET revoked_at = ?, revoke_reason = ? WHERE revoked_at IS NULL',
      [new Date().toISOString(), 'cli_revoke_all'],
    );
    console.log(`\x1b[32mСессий завершено: ${r.changes}\x1b[0m`);
  } else if (revokeId) {
    const id = Number(revokeId);
    const r = await db.run(
      'UPDATE sessions SET revoked_at = ?, revoke_reason = ? WHERE user_id = ? AND revoked_at IS NULL',
      [new Date().toISOString(), 'cli_revoke', id],
    );
    console.log(`\x1b[32mСессий пользователя #${id} завершено: ${r.changes}\x1b[0m`);
  } else if (developerId) {
    const id = Number(developerId);
    const u = await db.get<Row>('SELECT id, username FROM users WHERE id = ?', [id]);
    if (!u) { console.error(`Пользователь #${id} не найден`); process.exitCode = 1; }
    else {
      await setUserRole(id, 'developer', null);
      await db.run("UPDATE users SET status = 'active', blocked_reason = NULL WHERE id = ?", [id]);
      const perms = await computeEffectivePermissions(db, id);
      await audit({ actorId: null, actorName: 'cli', action: 'user.role.change', entityType: 'user', entityId: id, meta: { to: 'developer', via: 'cli' }, ip: null });
      console.log(`\x1b[32mПользователю #${id} (${u.username}) выдана роль Developer\x1b[0m`);
      console.log(`  permissions: ${perms.codes.size}, статус: active`);
    }
  } else if (roleId) {
    const id = Number(roleId);
    const roleCode = argv[argv.indexOf('--role') + 2] ?? '';
    if (!roleCode) { console.error('Укажите роль: npm run users -- --role <id> <role_code>'); process.exitCode = 1; }
    else {
      await setUserRole(id, roleCode, null);
      await audit({ actorId: null, actorName: 'cli', action: 'user.role.change', entityType: 'user', entityId: id, meta: { to: roleCode, via: 'cli' }, ip: null });
      console.log(`\x1b[32mПользователю #${id} назначена роль ${roleCode}\x1b[0m`);
    }
  } else if (deleteId) {
    const id = Number(deleteId);
    const u = await db.get<Row>('SELECT id, username FROM users WHERE id = ?', [id]);
    if (!u) { console.error(`Пользователь #${id} не найден`); process.exitCode = 1; }
    else {
      await db.run('DELETE FROM user_permission_overrides WHERE user_id = ?', [id]);
      await db.run('DELETE FROM user_roles WHERE user_id = ?', [id]);
      await db.run('DELETE FROM sessions WHERE user_id = ?', [id]);
      await db.run('DELETE FROM user_settings WHERE user_id = ?', [id]);
      await db.run('DELETE FROM identities WHERE user_id = ?', [id]);
      await db.run('DELETE FROM users WHERE id = ?', [id]);
      await audit({ actorId: null, actorName: 'cli', action: 'user.delete', entityType: 'user', entityId: id, meta: { username: String(u.username), via: 'cli' }, ip: null });
      console.log(`\x1b[32mПользователь #${id} (${u.username}) удалён вместе с identity, ролями и сессиями\x1b[0m`);
    }
  } else if (has('doctor')) {
    await doctor(db);
  }

  // Список пользователей печатаем всегда — так виден результат любой операции
  await printUsers(db);

  await closeDb();
}

main().catch(async (e) => { console.error(e); await closeDb(); process.exit(1); });
