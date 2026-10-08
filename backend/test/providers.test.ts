/**
 * EPIC AI — unit-тесты цепочки запасных моделей OpenAI-совместимого провайдера.
 *
 * Сценарий: free-модель OpenRouter снята с пула (404 model_not_found) или
 * упёрлась в лимит (429) — провайдер переходит к следующей модели из
 * AI_MODEL_FALLBACK. Неретраемые ошибки (401) не дёргают цепочку.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.AI_PROVIDER = 'openai_compatible';
process.env.AI_BASE_URL = 'https://openrouter.ai/api/v1';
process.env.AI_API_KEY = 'sk-or-unit-test';
process.env.AI_MODEL = 'primary:free';
process.env.AI_MODEL_FALLBACK = 'second:free,openrouter/free';

const { OpenAICompatibleProvider, GigaChatProvider } = await import('../src/ai/providers/index.js');

const DEFAULTS = { temperature: 0.1, maxTokens: 1200, timeoutMs: 5000 };
const MSGS = [{ role: 'user', content: 'привет' } as const];

function makeProvider() {
  return new OpenAICompatibleProvider(
    'openai_compatible',
    'https://openrouter.ai/api/v1',
    'sk-or-unit-test',
    'primary:free',
    DEFAULTS,
    ['second:free', 'openrouter/free'],
  );
}

function stubFetch(responses: Array<{ status: number; json?: unknown; text?: string }>) {
  const calls: Array<{ url: string; headers: Record<string, string>; body: any }> = [];
  const orig = globalThis.fetch;
  globalThis.fetch = (async (url: any, init: any) => {
    const rawBody = typeof init.body === 'string' ? init.body : String(init.body ?? '');
    let parsedBody: any = rawBody;
    try { parsedBody = JSON.parse(rawBody); } catch { /* form-urlencoded и т. п. */ }
    calls.push({ url: String(url), headers: init.headers, body: parsedBody });
    const r = responses[Math.min(calls.length - 1, responses.length - 1)];
    return {
      ok: r.status >= 200 && r.status < 300,
      status: r.status,
      json: async () => r.json ?? {},
      text: async () => r.text ?? JSON.stringify(r.json ?? {}),
    } as Response;
  }) as typeof fetch;
  return { calls, restore: () => { globalThis.fetch = orig; } };
}

test('404 model_not_found переключает на запасную модель', async () => {
  const { calls, restore } = stubFetch([
    { status: 404, json: { error: { code: 'model_not_found', message: 'model not found' } } },
    { status: 200, json: { choices: [{ message: { content: 'ответ' } }], model: 'second:free' } },
  ]);
  try {
    const res = await makeProvider().chat(MSGS as any);
    assert.equal(res.content, 'ответ');
    assert.equal(res.model, 'second:free');
    assert.equal(calls.length, 2);
    assert.equal(calls[0].body.model, 'primary:free');
    assert.equal(calls[1].body.model, 'second:free');
  } finally { restore(); }
});

test('429 rate_limit тоже переключает, цепочка доходит до openrouter/free', async () => {
  const { calls, restore } = stubFetch([
    { status: 429, json: { error: { code: 'rate_limit' } } },
    { status: 429, json: { error: { code: 'rate_limit' } } },
    { status: 200, json: { choices: [{ message: { content: 'ок' } }], model: 'openrouter/free' } },
  ]);
  try {
    const res = await makeProvider().chat(MSGS as any);
    assert.equal(res.model, 'openrouter/free');
    assert.equal(calls.length, 3);
  } finally { restore(); }
});

test('401 не ретраится: цепочка не дёргается', async () => {
  const { calls, restore } = stubFetch([
    { status: 401, json: { error: { message: 'invalid key' } } },
  ]);
  try {
    await assert.rejects(() => makeProvider().chat(MSGS as any), /401/);
    assert.equal(calls.length, 1);
  } finally { restore(); }
});

test('OpenRouter получает заголовки атрибуции X-Title/HTTP-Referer', async () => {
  const { calls, restore } = stubFetch([
    { status: 200, json: { choices: [{ message: { content: 'x' } }] } },
  ]);
  try {
    await makeProvider().chat(MSGS as any);
    assert.equal(calls[0].headers['X-Title'], 'Epic AI');
    assert.match(calls[0].url, /openrouter\.ai\/api\/v1\/chat\/completions$/);
  } finally { restore(); }
});

test('400 response_format → ретрай того же запроса без флага (SiliconFlow)', async () => {
  const { calls, restore } = stubFetch([
    { status: 400, json: { error: { message: 'response_format is not supported for this model' } } },
    { status: 200, json: { choices: [{ message: { content: 'без json-флага' } }], model: 'primary:free' } },
  ]);
  try {
    const res = await makeProvider().chat(MSGS as any, { json: true });
    assert.equal(res.content, 'без json-флага');
    assert.equal(calls.length, 2);
    assert.ok(calls[0].body.response_format, 'первый запрос шёл с response_format');
    assert.equal(calls[1].body.response_format, undefined, 'ретрай — без response_format');
    assert.equal(calls[1].body.model, 'primary:free', 'модель при ретрае не меняется');
  } finally { restore(); }
});

test('Yandex: модель заворачивается в gpt://<folder>/<model>/latest', async () => {
  const { calls, restore } = stubFetch([
    { status: 200, json: { choices: [{ message: { content: 'ок' } }], model: 'gpt://b1gtest/yandexgpt-lite/latest' } },
  ]);
  const prov = new OpenAICompatibleProvider(
    'openai_compatible',
    'https://ai.api.cloud.yandex.net/v1',
    'test-key',
    'yandexgpt-lite',
    DEFAULTS,
    ['yandexgpt-pro'],
    'b1gtest',
  );
  try {
    await prov.chat(MSGS as any);
    assert.equal(calls[0].body.model, 'gpt://b1gtest/yandexgpt-lite/latest');
  } finally { restore(); }
});

test('Yandex: готовый gpt:// URI не пере-заворачивается', async () => {
  const { calls, restore } = stubFetch([
    { status: 200, json: { choices: [{ message: { content: 'ок' } }] } },
  ]);
  const prov = new OpenAICompatibleProvider(
    'openai_compatible',
    'https://ai.api.cloud.yandex.net/v1',
    'test-key',
    'gpt://b1gtest/yandexgpt-pro/latest',
    DEFAULTS,
    [],
    'b1gtest',
  );
  try {
    await prov.chat(MSGS as any);
    assert.equal(calls[0].body.model, 'gpt://b1gtest/yandexgpt-pro/latest');
  } finally { restore(); }
});

test('GigaChat: Bearer из AI_API_KEY, endpoint Сбера, без response_format', async () => {
  const { calls, restore } = stubFetch([
    { status: 200, json: { choices: [{ message: { content: 'привет' } }], model: 'GigaChat-Pro' } },
  ]);
  const prov = new GigaChatProvider('GigaChat-Pro', DEFAULTS, ['GigaChat-Lite']);
  try {
    const res = await prov.chat(MSGS as any, { json: true });
    assert.equal(res.content, 'привет');
    assert.equal(res.provider, 'gigachat');
    assert.match(calls[0].url, /gigachat\.devices\.sberbank\.ru\/api\/v1\/chat\/completions$/);
    assert.equal(calls[0].headers.Authorization, 'Bearer sk-or-unit-test');
    assert.equal(calls[0].body.response_format, undefined, 'GigaChat не получает response_format');
  } finally { restore(); }
});

test('GigaChat: фолбэк модели при 404', async () => {
  const { calls, restore } = stubFetch([
    { status: 404, json: { error: { message: 'model not found' } } },
    { status: 200, json: { choices: [{ message: { content: 'ок' } }], model: 'GigaChat-Lite' } },
  ]);
  const prov = new GigaChatProvider('GigaChat-Pro', DEFAULTS, ['GigaChat-Lite']);
  try {
    const res = await prov.chat(MSGS as any);
    assert.equal(res.model, 'GigaChat-Lite');
    assert.equal(calls.length, 2);
  } finally { restore(); }
});

test('бандл НУЦ Минцифры на месте и парсится (Root + Sub CA)', async () => {
  const { readFileSync } = await import('node:fs');
  const { X509Certificate } = await import('node:crypto');
  const { resolve } = await import('node:path');
  const pem = readFileSync(resolve(process.cwd(), 'certs/russian_trusted_root_ca.pem'), 'utf8');
  const blocks = pem.match(/-----BEGIN CERTIFICATE-----[\s\S]*?-----END CERTIFICATE-----/g) ?? [];
  assert.equal(blocks.length, 2, 'в бандле два сертификата');
  const subjects = blocks.map((b) => new X509Certificate(b).subject);
  assert.ok(subjects.some((x) => x.includes('Russian Trusted Root CA')), subjects.join(' ; '));
  assert.ok(subjects.some((x) => x.includes('Russian Trusted Sub CA')), subjects.join(' ; '));
});

test('GigaChat: 401 на Bearer → автообмен ключа через OAuth и повтор', async () => {
  const { calls, restore } = stubFetch([
    { status: 401, json: { status: 401, message: 'Unauthorized' } },
    { status: 200, json: { access_token: 'oauth-token-1', expires_at: Date.now() + 1800_000 } },
    { status: 200, json: { choices: [{ message: { content: 'после oauth' } }], model: 'GigaChat-Pro' } },
  ]);
  const prov = new GigaChatProvider('GigaChat-Pro', DEFAULTS, []);
  try {
    const res = await prov.chat(MSGS as any);
    assert.equal(res.content, 'после oauth');
    assert.equal(calls.length, 3);
    assert.match(calls[1].url, /\/oauth$/);
    assert.match(calls[1].headers.Authorization, /^Basic /);
    assert.match(calls[2].headers.Authorization, /^Bearer oauth-token-1$/);
  } finally { restore(); }
});

test('исчерпанная цепочка отдаёт последнюю ошибку', async () => {
  const { calls, restore } = stubFetch([
    { status: 404, json: { error: { code: 'model_not_found' } } },
    { status: 404, json: { error: { code: 'model_not_found' } } },
    { status: 404, json: { error: { code: 'model_not_found' } } },
  ]);
  try {
    await assert.rejects(() => makeProvider().chat(MSGS as any), /404/);
    assert.equal(calls.length, 3);
  } finally { restore(); }
});
