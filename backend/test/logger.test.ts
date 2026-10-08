/**
 * Модульные тесты логгера backend.
 *
 * Регрессия: Fastify передаёт в логгер объект запроса, содержащий циклические
 * ссылки (socket → parser → socket). Наивный JSON.stringify падал с
 * «Converting circular structure to JSON» и ронял обработчик запроса.
 *
 *   npx tsx --test test/logger.test.ts
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createLogger } from '../src/config/logger.js';

function capture(fn: () => void): string {
  const origLog = console.log;
  const origErr = console.error;
  const origWarn = console.warn;
  const origDbg = console.debug;
  let out = '';
  const sink = (...a: unknown[]) => { out += a.map(String).join(' ') + '\n'; };
  console.log = sink; console.error = sink; console.warn = sink; console.debug = sink;
  try { fn(); } finally {
    console.log = origLog; console.error = origErr; console.warn = origWarn; console.debug = origDbg;
  }
  return out;
}

test('циклический объект не роняет логгер', () => {
  const log = createLogger('info');
  const a: any = { name: 'payload' };
  a.self = a;
  a.deep = { parent: a, list: [a, a] };
  const out = capture(() => log.info(a));
  assert.match(out, /payload/);
  assert.match(out, /Circular/);
});

test('запрос Fastify сворачивается в «METHOD url»', () => {
  const log = createLogger('info');
  const socket: any = {};
  socket.parser = { socket };
  const reqLike = { id: 'req-1', raw: { method: 'GET', url: '/api/health', headers: {}, socket } };
  const out = capture(() => log.info(reqLike));
  assert.match(out, /GET \/api\/health/);
  assert.doesNotMatch(out, /Converting circular/);
});

test('ответ сворачивается в «HTTP <code>»', () => {
  const log = createLogger('info');
  const resLike = { raw: { statusCode: 200, getHeader: () => null } };
  const out = capture(() => log.info(resLike));
  assert.match(out, /HTTP 200/);
});

test('msg + bindings печатаются одной строкой', () => {
  const log = createLogger('info');
  const out = capture(() => log.info({ msg: 'Server listening', address: 'http://127.0.0.1:8787' }));
  assert.match(out, /Server listening/);
  assert.match(out, /address=http:\/\/127\.0\.0\.1:8787/);
});

test('bindings с вложенным запросом не падают', () => {
  const log = createLogger('info');
  const reqLike = { raw: { method: 'POST', url: '/api/ai/ask', headers: {} } };
  const out = capture(() => log.info({ msg: 'обработано', req: reqLike, latency: 12 }));
  assert.match(out, /обработано/);
  assert.match(out, /POST \/api\/ai\/ask/);
});

test('Error печатается со стеком', () => {
  const log = createLogger('error');
  const out = capture(() => log.error(new Error('взрыв')));
  assert.match(out, /взрыв/);
  assert.match(out, /at /);
});

test('уровни фильтруются', () => {
  const log = createLogger('warn');
  const out = capture(() => { log.info('скрыто'); log.debug('тоже скрыто'); log.warn('видно'); });
  assert.doesNotMatch(out, /скрыто/);
  assert.match(out, /видно/);
});

test('silent не печатает ничего', () => {
  const log = createLogger('silent');
  const out = capture(() => { log.fatal('ничего'); log.error('ничего'); });
  assert.equal(out.trim(), '');
});

test('child сохраняет уровень и помечает модуль', () => {
  const log = createLogger('info');
  const child = log.child({ module: 'kb' });
  const out = capture(() => child.info('синхронизация'));
  assert.match(out, /синхронизация/);
  const out2 = capture(() => child.debug('не должно быть'));
  assert.equal(out2.trim(), '');
});
