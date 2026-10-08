/**
 * EPIC AI — unit-тесты Telegram Login Widget.
 *
 * Проверяется официальный алгоритм проверки подписи:
 *   secret = SHA256(bot_token); hmac = HMAC_SHA256(data_check_string, secret).
 * Переменные окружения задаются ДО импорта модуля: config читает их один раз.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac, createHash } from 'node:crypto';

process.env.TELEGRAM_ENABLED = 'true';
process.env.TELEGRAM_BOT_TOKEN = '123456:UNIT-TEST-TOKEN';
process.env.TELEGRAM_BOT_USERNAME = 'epicai_unit_bot';

const tg = await import('../src/auth/telegram.js');

const TOKEN = '123456:UNIT-TEST-TOKEN';

function sign(data: Record<string, unknown>, token: string = TOKEN): string {
  const checkString = Object.keys(data)
    .sort()
    .map((k) => `${k}=${String(data[k])}`)
    .join('\n');
  const secret = createHash('sha256').update(token, 'utf8').digest();
  return createHmac('sha256', secret).update(checkString, 'utf8').digest('hex');
}

const freshAuth = () => Math.floor(Date.now() / 1000);

test('корректная подпись принимается', () => {
  const data = {
    id: 991204477,
    first_name: 'Ivan',
    last_name: 'Petrov',
    username: 'ivan_rp',
    auth_date: freshAuth(),
  };
  const payload = { ...data, hash: sign(data) };
  const res = tg.verifyTelegramHash(payload as any);
  assert.equal(res.ok, true, res.reason ?? '');
});

test('подпись другим токеном отклоняется', () => {
  const data = { id: 1, username: 'x', auth_date: freshAuth() };
  const payload = { ...data, hash: sign(data, 'OTHER-TOKEN') };
  const res = tg.verifyTelegramHash(payload as any);
  assert.equal(res.ok, false);
  assert.match(res.reason ?? '', /подпись/i);
});

test('устаревший auth_date отклоняется', () => {
  const data = { id: 1, username: 'x', auth_date: freshAuth() - 7200 };
  const payload = { ...data, hash: sign(data) };
  const res = tg.verifyTelegramHash(payload as any);
  assert.equal(res.ok, false);
  assert.match(res.reason ?? '', /устарел/i);
});

test('auth_date в будущем отклоняется', () => {
  const data = { id: 1, username: 'x', auth_date: freshAuth() + 3600 };
  const payload = { ...data, hash: sign(data) };
  const res = tg.verifyTelegramHash(payload as any);
  assert.equal(res.ok, false);
});

test('без hash и без id отклоняется', () => {
  assert.equal(tg.verifyTelegramHash({ id: 1, auth_date: freshAuth() } as any).ok, false);
  assert.equal(tg.verifyTelegramHash({ hash: 'aa', auth_date: freshAuth() } as any).ok, false);
});

test('toIdentity переносит id, username, имя и avatar', () => {
  const identity = tg.toIdentity({
    id: 42,
    username: 'ivan_rp',
    first_name: 'Ivan',
    last_name: 'Petrov',
    photo_url: 'https://t.me/i/userpic/320/abc.jpg',
    auth_date: freshAuth(),
    hash: 'x',
  } as any);
  assert.equal(identity.provider, 'telegram');
  assert.equal(identity.providerUserId, '42');
  assert.equal(identity.username, 'ivan_rp');
  assert.equal(identity.displayName, 'Ivan Petrov');
  assert.equal(identity.avatarUrl, 'https://t.me/i/userpic/320/abc.jpg');
});

test('toIdentity без имени даёт читаемый displayName', () => {
  const identity = tg.toIdentity({ id: 77, auth_date: freshAuth(), hash: 'x' } as any);
  assert.equal(identity.displayName, 'tg_77');
  assert.equal(identity.username, null);
});

test('deep-link: код и ссылка на бота, статус pending', () => {
  const { code, url } = tg.createTelegramLoginCode();
  assert.match(code, /^[a-f0-9]{16}$/);
  assert.equal(url, `https://t.me/epicai_unit_bot?start=${code}`);
  assert.match((tg.createTelegramLoginCode() as any).displayCode, /^\d{4}$/, 'код сверки — 4 цифры');
  assert.equal(tg.telegramLoginStatus(code), 'pending');
  assert.equal(tg.takeTelegramLogin(code), null);
});

test('deep-link: неизвестный код → expired', () => {
  assert.equal(tg.telegramLoginStatus('несуществует'), 'expired');
  assert.equal(tg.takeTelegramLogin('несуществует'), null);
});


test('бот: текст статуса аккаунта содержит ник, роль и лимит', () => {
  const text = tg.buildBotStatusText(
    { username: 'ivan_rp', displayName: 'Ivan Petrov', status: 'active', primaryRole: { name: 'Игрок' } },
    { left: 46, limit: 50 },
  );
  assert.match(text, /Ivan Petrov/);
  assert.match(text, /Игрок/);
  assert.match(text, /46 из 50/);
});
