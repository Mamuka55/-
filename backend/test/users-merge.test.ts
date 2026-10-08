/**
 * EPIC AI — раунд 30, п.3: Discord и Telegram с одного IP — один аккаунт.
 * Связывание идёт по самой свежей активной сессии с адреса входа.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.DB_DRIVER = 'sqlite';
process.env.DB_SQLITE_ENGINE = 'sql.js';
process.env.DB_SQLITE_PATH = join(mkdtempSync(join(tmpdir(), 'epicai-merge-')), 'merge.sqlite');

const { migrate } = await import('../src/db/migrate.js');
const { findOrCreateUserByIdentity } = await import('../src/users/service.js');
const { getDb } = await import('../src/db/index.js');

await migrate();

async function addSession(userId: number, ip: string): Promise<void> {
  const db = await getDb();
  await db.run(
    'INSERT INTO sessions (user_id, token_hash, created_at, expires_at, last_seen_at, ip, user_agent) VALUES (?, ?, ?, ?, ?, ?, ?)',
    [userId, `hash-${userId}-${ip}`, new Date().toISOString(), new Date(Date.now() + 86400_000).toISOString(), new Date().toISOString(), ip, 'test'],
  );
}

test('identity с того же IP связывается в один аккаунт', async () => {
  const first = await findOrCreateUserByIdentity({
    provider: 'discord', providerUserId: 'd-ip-1', username: 'SamePerson',
  } as any);
  assert.equal(first.created, true);
  await addSession(Number(first.user.id), '10.20.30.40');

  const second = await findOrCreateUserByIdentity({
    provider: 'telegram', providerUserId: 't-ip-1', username: 'totally_other_nick', ip: '10.20.30.40',
  } as any);
  assert.equal(second.created, false, 'дубль не создаётся');
  assert.equal(second.linked, true);
  assert.equal(Number(second.user.id), Number(first.user.id));

  const db = await getDb();
  const ids = await db.all('SELECT provider FROM identities WHERE user_id = ? ORDER BY provider', [Number(first.user.id)]);
  assert.deepEqual(ids.map((r: any) => r.provider), ['discord', 'telegram']);
});

test('другой IP создаёт отдельный аккаунт', async () => {
  const other = await findOrCreateUserByIdentity({
    provider: 'telegram', providerUserId: 't-ip-2', username: 'SamePerson', ip: '99.99.99.99',
  } as any);
  assert.equal(other.created, true, 'с другого адреса аккаунт отдельный');
});
