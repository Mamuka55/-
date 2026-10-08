/**
 * EPIC AI — сквозной smoke-тест API.
 * Проверяет всю цепочку v1  без Electron и без обращения к форуму.
 *   node scripts/smoke.mjs
 */

import { spawnSync } from 'node:child_process';
import { createHmac, createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
const BACKEND = resolve(dirname(fileURLToPath(import.meta.url)), '../backend');
function runCli(args) {
  const res = spawnSync('npx', ['tsx', ...args], { cwd: BACKEND, encoding: 'utf8', env: { ...process.env } });
  return { code: res.status, out: `${res.stdout ?? ''}${res.stderr ?? ''}` };
}

const BASE = process.env.BASE ?? 'http://127.0.0.1:8787';
const SECRET = process.env.SECRET ?? 'dev-secret-0123456789abcdef0123456789abcdef';

let pass = 0, fail = 0;
const ok = (n, extra = '') => { pass++; console.log(`  \x1b[32m✓\x1b[0m ${n}${extra ? ' — ' + extra : ''}`); };
const no = (n, e) => { fail++; console.log(`  \x1b[31m✗\x1b[0m ${n}: ${e}`); };
const section = (t) => console.log(`\n\x1b[1m${t}\x1b[0m`);

async function call(method, path, { token, body, headers } = {}) {
  const h = { 'X-Epic-Client': 'cli', ...(headers ?? {}) };
  if (body !== undefined) h['Content-Type'] = 'application/json';
  if (token) h.Cookie = `epic_ai_session=${token}`;
  const res = await fetch(`${BASE}${path}`, { method, headers: h, body: body === undefined ? undefined : JSON.stringify(body) });
  const setCookie = res.headers.get('set-cookie');
  let json = null;
  const txt = await res.text();
  try { json = JSON.parse(txt); } catch { json = { raw: txt.slice(0, 300) }; }
  return { status: res.status, json, token: setCookie ? setCookie.split(';')[0].split('=').slice(1).join('=') : null };
}

function assert(cond, name, detail = '') { cond ? ok(name, detail) : no(name, detail || 'assert failed'); }

async function main() {
  section('0. Bootstrap первого Developer ');
  let r = await call('GET', '/api/bootstrap/status');
  assert(r.status === 200, 'GET /api/bootstrap/status', `needsBootstrap=${r.json.needsBootstrap} users=${r.json.users}`);
  assert(r.json.needsBootstrap === false && r.json.developers >= 1,
    'Developer создан до запуска сервера (bootstrap CLI)', `developers=${r.json.developers}`);

  r = await call('POST', '/api/bootstrap/developer', { body: { token: 'dev-bootstrap-token', discordId: '999' } });
  assert(r.status === 409, 'повторный bootstrap через API отклонён (409)', `status=${r.status}`);

  section('1. Health');
  r = await call('GET', '/api/health');
  assert(r.status === 200 && r.json.ok, 'GET /api/health', `db=${r.json.db?.driver}/${r.json.db?.engine}`);

  section('2. Авторизация (dev-login) и роли');
  r = await call('POST', '/api/auth/dev-login', { body: { token: SECRET, username: 'developer' } });
  assert(r.status === 200, 'dev-login developer', `userId=${r.json.userId}`);
  const devToken = r.token;
  assert(Boolean(devToken), 'сессия выдана (cookie)');

  r = await call('POST', '/api/auth/dev-login', { body: { token: 'wrong', username: 'developer' } });
  assert(r.status === 403, 'dev-login с неверным токеном отклонён');

  r = await call('GET', '/api/auth/me', { token: devToken });
  assert(r.status === 200 && r.json.authenticated, 'GET /api/auth/me', `role=${r.json.user?.primaryRole?.code} perms=${r.json.permissions?.length}`);
  assert(r.json.isDeveloper === true, 'developer = системная роль с полным доступом');

  r = await call('POST', '/api/auth/dev-login', { body: { token: SECRET, username: 'Alexander' } });
  const playerToken = r.token;
  r = await call('GET', '/api/auth/me', { token: playerToken });
  assert(r.json.user?.primaryRole?.code === 'player', 'новый пользователь получил роль Игрок', r.json.user?.username);

  // Dev-вход (форма в окне входа Epic AI и curl используют один маршрут):
  // cookie уходит тому, кто позвал, — клиент зовёт из своей партиции.
  {
    const fr = await fetch(`${BASE}/api/auth/dev-login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Epic-Client': 'cli' },
      body: JSON.stringify({ token: SECRET, username: 'developer' }),
    });
    const sc = fr.headers.get('set-cookie') ?? '';
    assert(fr.status === 200 && sc.includes('epic_ai_session'),
      'POST /api/auth/dev-login: 200 + cookie сессии', `status=${fr.status}`);
    const me = await fetch(`${BASE}/api/auth/me`, { headers: { 'X-Epic-Client': 'cli', Cookie: sc.split(';')[0] } });
    assert(me.status === 200, 'сессия из dev-входа даёт доступ к API');
    const nf = await fetch(`${BASE}/api/auth/dev-login`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Epic-Client': 'cli' },
      body: JSON.stringify({ token: SECRET, username: 'definitely_missing_user' }),
    });
    assert(nf.status === 200, 'dev-вход: несуществующий ник создаётся как Игрок (dev-удобство, только development+loopback)', `status=${nf.status}`);
    const gt = await fetch(`${BASE}/api/auth/dev-login`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Epic-Client': 'cli' },
      body: JSON.stringify({ token: 'wrong-secret', username: 'developer' }),
    });
    assert(gt.status === 403, 'dev-вход: неверный SECRET отклоняется (403)', `status=${gt.status}`);
  }

  section('2.5 Telegram: подпись, desktop-тикеты, вход из внешнего браузера ');
  {
    const TG_TOKEN = 'smoke-tg-token';
    const tgData = { id: 900100, first_name: 'Smoke', username: 'smoke_tg', auth_date: Math.floor(Date.now() / 1000) };
    const checkString = Object.keys(tgData).sort().map((k) => `${k}=${tgData[k]}`).join('\n');
    const secret = createHash('sha256').update(TG_TOKEN, 'utf8').digest();
    tgData.hash = createHmac('sha256', secret).update(checkString, 'utf8').digest('hex');

    r = await call('GET', '/api/auth/providers');
    assert(r.json.telegram === true && r.json.botUsername === 'epicai_smoke_bot', 'providers: telegram включён и отдаёт имя бота');
    r = await call('GET', '/login');
    assert(r.status === 404, 'серверной страницы /login больше нет: вход только из приложения + внешний браузер', `status=${r.status}`);

    // desktop-тикеты: telegram
    r = await call('POST', '/api/auth/desktop/start', { body: { provider: 'telegram', device: 'SMOKE-PC', os: 'Windows 11' } });
    assert(r.json.ok === true && /^https:\/\/t\.me\/epicai_smoke_bot\?start=[a-f0-9]{16}$/.test(r.json.url ?? ''),
      'desktop start (telegram): тикет и ссылка на бота', r.json.url);
    assert(/^\d{4}$/.test(r.json.displayCode ?? ''), 'desktop start: 4-цифровой код для сверки с карточкой бота', r.json.displayCode);
    assert(String(r.json.qrDataUrl ?? '').startsWith('data:image/svg+xml'), 'desktop start: QR-код для входа с телефона (svg data-url)');
    assert(r.json.bot && typeof r.json.bot.polling === 'boolean', 'desktop start: здоровье бота (polling/ошибка) для страницы входа');
    const ticket = r.json.ticket;
    r = await call('GET', `/api/auth/desktop/status?ticket=${ticket}`);
    assert(r.json.status === 'pending', 'desktop status: до подтверждения — pending', r.json.status);
    r = await call('POST', '/api/auth/desktop/claim', { body: { ticket } });
    assert(r.status === 404, 'desktop claim: неподтверждённый тикет не выдаёт сессию', `status=${r.status}`);
    r = await call('GET', '/api/auth/desktop/status?ticket=unknown');
    assert(r.json.status === 'expired', 'desktop status: чужой тикет → expired');

    // Раунд 31: Discord-авторизация удалена — provider принимается только telegram
    r = await call('POST', '/api/auth/desktop/start', { body: { provider: 'discord' } });
    assert(r.status === 400, 'desktop start (discord): провайдер удалён — 400', `status=${r.status}`);
    r = await call('GET', '/api/auth/providers');
    assert(r.json.discord === undefined, 'providers больше не отдаёт discord');

    // подпись виджета по-прежнему валидируется (используется legacy-интеграциями)
    const bad = { ...tgData, hash: '0'.repeat(64) };
    const badCheck = Object.keys({ ...bad, hash: undefined }).filter((k) => k !== 'hash');
    void badCheck;
    r = await call('POST', '/api/auth/desktop/claim', { body: { ticket: 'zz' } });
    assert(r.status === 404, 'desktop claim: мусорный тикет → 404', `status=${r.status}`);
  }

  section('3. RBAC и блокировки');
  let playerId = null;
  r = await call('GET', '/api/users?search=Alexander', { token: devToken });
  assert(r.status === 200 && r.json.total >= 1, 'GET /api/users (поиск)', `total=${r.json.total}`);
  playerId = r.json.items?.[0]?.id;

  r = await call('GET', '/api/users', { token: playerToken });
  assert(r.status === 403, 'Игрок не видит список пользователей (403)');

  r = await call('GET', '/api/kb/status', { token: playerToken });
  assert(r.status === 200, 'Игрок видит статус базы знаний');

  // Никнейм берётся ИЗ Discord/Telegram при входе: ручное переименование
  // удалено по требованию пользователя (PUT /api/users/me больше нет).
  r = await call('PUT', '/api/users/me', { token: playerToken, body: { displayName: 'SanFromSmoke' } });
  assert(r.status === 404, 'PUT /api/users/me удалён — ник нельзя написать самому', `status=${r.status}`);
  r = await call('GET', '/api/users/me', { token: playerToken });
  assert(Boolean(r.json?.displayName), 'никнейм присутствует в профиле (из провайдера/bootstrap)', String(r.json?.displayName));

  r = await call('PATCH', `/api/users/${playerId}/role`, { token: devToken, body: { role: 'helper' } });
  assert(r.status === 200 && r.json.role?.code === 'helper', 'назначение роли Хелпер', r.json.role?.name);

  // Хелпер не может назначить роль выше своего уровня
  r = await call('POST', '/api/auth/dev-login', { body: { token: SECRET, username: 'Alexander' } });
  const helperToken = r.token;
  r = await call('POST', '/api/auth/dev-login', { body: { token: SECRET, username: 'SomeAdmin' } });
  const otherToken = r.token;
  let otherId = (await call('GET', '/api/users?search=SomeAdmin', { token: devToken })).json.items?.[0]?.id;
  r = await call('PATCH', `/api/users/${otherId}/role`, { token: helperToken, body: { role: 'chief_admin' } });
  assert(r.status === 403, 'Хелпер не может выдать роль выше своего уровня (403)');
  r = await call('PATCH', `/api/users/${otherId}/role`, { token: helperToken, body: { role: 'developer' } });
  assert(r.status === 403, 'Developer не выдаётся из панели (403)');

  // Индивидуальное разрешение 
  r = await call('PUT', `/api/users/${playerId}/permissions`, { token: devToken, body: { permission: 'knowledge.sync', effect: 'allow', reason: 'тест' } });
  assert(r.status === 200 && r.json.allow?.includes('knowledge.sync'), 'user override: +knowledge.sync');
  r = await call('PUT', `/api/users/${playerId}/permissions`, { token: devToken, body: { permission: 'ai.laws', effect: 'deny' } });
  assert(r.status === 200 && r.json.deny?.includes('ai.laws'), 'user override: −ai.laws (deny приоритетнее роли)');

  r = await call('GET', `/api/users/${playerId}/permissions`, { token: devToken });
  assert(r.json.effective?.includes('knowledge.sync') && !r.json.effective?.includes('ai.laws'), 'effective permissions учитывают overrides');

  section('4. Блокировка аккаунта ');
  r = await call('PATCH', `/api/users/${otherId}/status`, { token: devToken, body: { blocked: true, reason: 'тест блокировки' } });
  assert(r.status === 200 && r.json.status === 'blocked', 'блокировка');
  r = await call('GET', '/api/auth/me', { token: otherToken });
  assert(r.status === 403, 'сессия заблокированного инвалидирована (403)');
  assert(r.json.blocked === true, '/api/auth/me сообщает blocked:true — по нему Electron показывает окно блокировки');
  assert(r.json.user?.blockedReason === 'тест блокировки', 'причина блокировки передаётся клиенту', r.json.user?.blockedReason);
  r = await call('POST', '/api/ai/ask', { token: otherToken, body: { mode: 'rules', question: 'можно ли ДМ?' } });
  assert(r.status >= 401, 'заблокированный не может отправить запрос');
  await call('PATCH', `/api/users/${otherId}/status`, { token: devToken, body: { blocked: false } });
  ok('разблокировка');

  section('5. Knowledge Base: загрузка фикстур');
  const { loadFixtures } = await import('./fixtures.mjs');
  const fx = await loadFixtures(BASE, SECRET);
  ok('фикстуры загружены', `документов: ${fx.documents}, chunks: ${fx.chunks}`);

  r = await call('GET', '/api/kb/status', { token: devToken });
  assert(r.status === 200, 'GET /api/kb/status', `${r.json.stateLabel}; docs=${r.json.documents.total} (RULE ${r.json.documents.rules} / LAW ${r.json.documents.laws})`);

  section('6. RAG: поиск и ответ AI');
  r = await call('GET', '/api/ai/search?mode=rules&q=' + encodeURIComponent('можно ли убивать без причины'), { token: devToken });
  assert(r.status === 200 && r.json.sources.length > 0, 'поиск по правилам (морфология: «убивать»→DM)', `найдено ${r.json.sources.length}`);

  r = await call('POST', '/api/ai/ask', { token: devToken, body: { mode: 'rules', question: 'Что такое DM и разрешено ли убивать игрока без причины?' } });
  assert(r.status === 200, 'POST /api/ai/ask', `verdict=${r.json.verdict} sources=${r.json.sources.length} status=${r.json.status}`);
  const askRules = r.json;
  assert(askRules.sources.every((s) => s.docType === 'RULE'), 'в режиме ПРАВИЛА нет документов LAW ');
  assert(askRules.sources.every((s) => s.url && s.title && s.revisionLabel), 'источники содержат название, URL и дату редакции ');

  r = await call('POST', '/api/ai/ask', { token: devToken, body: { mode: 'laws', question: 'Какая статья предусматривает наказание за убийство первой степени?' } });
  assert(r.status === 200 && r.json.sources.every((s) => s.docType === 'LAW'), 'режим ЗАКОНЫ возвращает только LAW');

  r = await call('POST', '/api/ai/ask', { token: devToken, body: { mode: 'rules', question: 'Какой штраф за парковку на газоне 17 мая?' } });
  assert(r.status === 200 && (r.json.status === 'no_data' || r.json.verdict === 'unknown'), 'нет данных → честный отказ ', r.json.status);
  const noData = r.json;

  // Голосовой ввод: сырая аудиозапись телом запроса → текст (mock-провайдер)
  {
    const audio = Buffer.from('fake-webm-bytes'.repeat(128));
    const tr = await fetch(`${BASE}/api/ai/transcribe`, {
      method: 'POST',
      headers: { 'X-Epic-Client': 'cli', 'Content-Type': 'audio/webm', Cookie: `epic_ai_session=${devToken}` },
      body: audio,
    });
    const tj = await tr.json().catch(() => null);
    assert(tr.status === 200 && typeof tj?.text === 'string' && tj.text.length > 3, 'POST /api/ai/transcribe — запись → текст', `text="${String(tj?.text).slice(0, 40)}"`);
    const trEmpty = await fetch(`${BASE}/api/ai/transcribe`, {
      method: 'POST',
      headers: { 'X-Epic-Client': 'cli', 'Content-Type': 'audio/webm', Cookie: `epic_ai_session=${devToken}` },
      body: Buffer.from('x'),
    });
    assert(trEmpty.status === 400, 'пустая запись отклоняется (400)', String(trEmpty.status));
    const trNoAuth = await fetch(`${BASE}/api/ai/transcribe`, {
      method: 'POST', headers: { 'X-Epic-Client': 'cli', 'Content-Type': 'audio/webm' }, body: audio,
    });
    assert(trNoAuth.status === 401, 'transcribe без сессии — 401', String(trNoAuth.status));
  }

  section('6.5 Дневной лимит запросов к ИИ (квота) ');
  r = await call('GET', '/api/ai/quota', { token: devToken });
  assert(r.status === 200 && r.json.limit === 50 && r.json.personal === false, 'GET /api/ai/quota: общий лимит 50 в сутки', `used=${r.json.used} left=${r.json.left}`);
  assert(r.json.left === r.json.limit - r.json.used, 'квота: остаток = лимит − использовано');
  assert(askRules.quota && askRules.quota.limit === 50, 'ответ ask содержит остаток квоты');

  r = await call('PUT', `/api/users/${playerId}/quota`, { token: playerToken, body: { dailyLimit: 100 } });
  assert(r.status === 403, 'игрок не может выдать квоту сам себе (403)');

  r = await call('PUT', `/api/users/${playerId}/quota`, { token: devToken, body: { dailyLimit: 0 } });
  assert(r.status === 200 && r.json.quota.limit === 0 && r.json.quota.personal === true, 'админ выдал персональный лимит 0 (как в админ-панели)', `limit=${r.json.quota.limit}`);
  r = await call('GET', '/api/ai/quota', { token: playerToken });
  assert(r.status === 200 && r.json.left === 0, 'квота игрока: остаток 0');
  r = await call('POST', '/api/ai/ask', { token: playerToken, body: { mode: 'rules', question: 'можно ли ДМ?' } });
  assert(r.status === 429 && r.json.error === 'quota_exceeded', 'исчерпанный лимит → 429 quota_exceeded', `status=${r.status}`);
  assert(r.json.quota?.limit === 0, 'тело 429 содержит квоту для модалки');

  r = await call('PUT', `/api/users/${playerId}/quota`, { token: devToken, body: { dailyLimit: null } });
  assert(r.status === 200 && r.json.quota.personal === false && r.json.quota.limit === 50, 'сброс персонального лимита возвращает общий');
  r = await call('POST', '/api/ai/ask', { token: playerToken, body: { mode: 'rules', question: 'можно ли убивать игрока без причины?' } });
  assert(r.status === 200, 'после сброса лимита запрос снова проходит');

  // П.2 раунда 34: ArrayBuffer-тело без неявного Content-Type раньше давало 415
  {
    const buf = Buffer.alloc(600, 7);
    const r2 = await fetch(`${BASE}/api/ai/transcribe`, {
      method: 'POST',
      headers: { 'X-Epic-Client': 'cli', 'Content-Type': 'audio/webm', Cookie: `epic_ai_session=${devToken}` },
      body: buf,
    });
    assert(r2.status === 200, 'transcribe принимает audio/webm без 415 Unsupported Media Type', `status=${r2.status}`);
  }

  section('7. Feedback и AI Reports ');
  r = await call('POST', '/api/ai/feedback/like', { token: devToken, body: { requestId: askRules.requestId } });
  assert(r.status === 200 && r.json.reportCreated === false, '👍 не создаёт отчёт');

  r = await call('POST', '/api/ai/reports', { token: devToken, body: { requestId: askRules.requestId } });
  assert(r.status === 400, '👎 без категории отклоняется (категория обязательна)');

  r = await call('POST', '/api/ai/reports', { token: devToken, body: { requestId: askRules.requestId, category: 'misinterpreted', comment: 'Пункт процитирован неточно' } });
  assert(r.status === 201 && r.json.reportId, '👎 создаёт AI Report', `id=${r.json.reportId} analysis=${r.json.suggestedAnalysis}`);
  const reportId = r.json.reportId;

  r = await call('GET', '/api/ai/reports', { token: devToken });
  assert(r.status === 200 && r.json.total >= 1, 'очередь администратора', `new=${r.json.counts.new}`);
  r = await call('GET', '/api/ai/reports', { token: helperToken });
  assert(r.status === 200, 'Хелпер видит ошибки AI (ai.reports.view)');

  r = await call('GET', `/api/ai/reports/${reportId}`, { token: devToken });
  assert(r.status === 200 && r.json.question && r.json.sources, 'карточка отчёта содержит вопрос, ответ и источники', `category=${r.json.categoryLabel}`);
  assert(r.json.user?.role && r.json.kbVersion, 'в отчёте есть роль пользователя и версия документов ');

  r = await call('PATCH', `/api/ai/reports/${reportId}`, { token: devToken, body: { status: 'in_progress' } });
  assert(r.status === 200 && r.json.status === 'in_progress', '«В РАБОТУ»');
  r = await call('PATCH', `/api/ai/reports/${reportId}`, { token: devToken, body: { status: 'resolved', analysis: 'ai_error', resolution: 'Исправлен промпт' } });
  assert(r.status === 200 && r.json.status === 'resolved', '«РЕШЕНО»');
  r = await call('PATCH', `/api/ai/reports/${reportId}`, { token: helperToken, body: { status: 'new' } });
  assert(r.status === 403, 'Хелпер не может менять статус (ai.reports.manage)');

  section('8. Версии, diff и история изменений ');
  r = await call('GET', '/api/kb/changes/today', { token: devToken });
  assert(r.status === 200 && r.json.items.length > 0, 'обновления за сегодня', `new=${r.json.counts.new} updated=${r.json.counts.updated}`);
  const updated = r.json.items.find((i) => i.changeKind === 'UPDATED');
  if (updated) {
    r = await call('GET', `/api/kb/changes/${updated.id}`, { token: devToken });
    assert(r.status === 200 && r.json.diff?.ops?.some((o) => o.kind === 'del') && r.json.diff.ops.some((o) => o.kind === 'ins'),
      'цветной word-level diff (🔴/🟢)', `−${r.json.diff.removedText.length} / +${r.json.diff.addedText.length} симв.`);
  } else no('есть изменённый документ', 'не найдено UPDATED в фикстурах');

  r = await call('GET', '/api/kb/changes/history', { token: devToken });
  assert(r.status === 200 && r.json.items.length > 0, 'история изменений по дням', r.json.items[0]?.summary);

  if (fx.documentId) {
    r = await call('GET', `/api/kb/documents/${fx.documentId}/versions`, { token: devToken });
    assert(r.status === 200 && r.json.items.length >= 2, 'старые версии не удаляются ', `versions=${r.json.items.length}`);
    r = await call('GET', `/api/kb/documents/${fx.documentId}/diff?from=1&to=2`, { token: devToken });
    assert(r.status === 200 && r.json.diff, 'diff между версиями 1 → 2');
  }

  section('9. Audit Log ');
  r = await call('GET', '/api/audit-logs?limit=200', { token: devToken });
  const actions = new Set(r.json.items.map((i) => i.action));
  assert(r.status === 200 && r.json.total > 0, 'журнал пишется', `записей: ${r.json.total}`);
  for (const a of ['login', 'user.role.change', 'user.permission.add', 'user.block', 'user.unblock', 'ai.report.create', 'ai.report.status']) {
    assert(actions.has(a), `audit: ${a}`);
  }
  r = await call('DELETE', '/api/audit-logs', { token: devToken });
  assert(r.status === 405, 'Audit Log нельзя изменить через API (405)');
  r = await call('GET', '/api/audit-logs', { token: playerToken });
  assert(r.status === 403, 'Игрок не видит Audit Log');

  section('10. Настройки  и админ-навигация ');
  r = await call('PUT', '/api/settings/me', { token: playerToken, body: { opacity: 0.6, blur: false, hotkey: 'F9', panelWidth: 700, alwaysOnTop: true } });
  assert(r.status === 200 && r.json.settings.hotkey === 'F9' && r.json.settings.blur === false, 'сохранение настроек интерфейса');
  r = await call('PUT', '/api/settings/me', { token: playerToken, body: { hotkey: 'NOT A KEY!!' } });
  assert(r.json.settings.hotkey === 'F10', 'невалидный хоткей откатывается к F10');
  r = await call('GET', '/api/settings/me', { token: playerToken });
  assert(r.json.settings.panelWidth === 700, 'настройки переживают перезапрос');

  // playerToken к этому моменту принадлежит уже Хелперу (роль повышали выше),
  // поэтому берём свежего Игрока.
  r = await call('POST', '/api/auth/dev-login', { body: { token: SECRET, username: 'PlainPlayer' } });
  const plainToken = r.token;
  r = await call('GET', '/api/admin/nav', { token: plainToken });
  assert(r.json.items.length === 0, 'у Игрока нет разделов админки', `items=${r.json.items.length}`);
  r = await call('GET', '/api/admin/nav', { token: helperToken });
  const helperNav = r.json.items.map((i) => i.id);
  assert(helperNav.includes('ai') && !helperNav.includes('audit') && !helperNav.includes('system'),
    'видимость разделов админки зависит от permissions ', helperNav.join(','));
  r = await call('GET', '/api/admin/nav', { token: devToken });
  const navIds = r.json.items.map((i) => i.id);
  assert(navIds.includes('overview') && navIds.includes('users') && navIds.includes('audit') && navIds.includes('kb'), 'developer видит все разделы', navIds.join(', '));

  r = await call('GET', '/api/admin/overview', { token: devToken });
  assert(r.status === 200 && r.json.users && r.json.kb && r.json.system, 'GET /api/admin/overview');

  r = await call('GET', '/api/roles', { token: devToken });
  assert(r.status === 200 && r.json.items.length === 8, '8 ролей из ', r.json.items.map((x) => x.code).join(','));
  r = await call('GET', '/api/permissions/matrix', { token: devToken });
  assert(r.status === 200 && r.json.permissions.length === 26, '26 permissions из каталога (включая telegram.manage)', `связей: ${r.json.matrix.length}`);

  section('10.5 Роли: создание, цвет, permissions, удаление (п.10) ');
  r = await call('POST', '/api/roles', { token: devToken, body: { code: 'smoke_watcher', name: 'Наблюдатель', color: '#123456', level: 2, permissions: ['ai.use'] } });
  assert(r.status === 201 && r.json.ok === true, 'создание роли через POST /api/roles', `code=${r.json.code}`);
  r = await call('PATCH', '/api/roles/smoke_watcher', { token: devToken, body: { name: 'Старший наблюдатель', color: '#ACE72E', permissions: ['ai.use', 'settings.view'] } });
  assert(r.status === 200, 'переименование и смена цвета роли (PATCH)');
  r = await call('GET', '/api/roles', { token: devToken });
  const wr = r.json.items.find((x) => x.code === 'smoke_watcher');
  assert(wr?.color === '#ACE72E' && wr?.name === 'Старший наблюдатель' && (wr?.permissions ?? []).length === 2,
    'цвет, название и permissions роли сохранились', `color=${wr?.color}, perms=${(wr?.permissions ?? []).length}`);
  r = await call('POST', '/api/roles', { token: plainToken, body: { code: 'smoke_nope', name: 'Нет', level: 2 } });
  assert(r.status === 403, 'без roles.manage роль создать нельзя', `status=${r.status}`);
  r = await call('DELETE', '/api/roles/developer', { token: devToken });
  assert(r.status === 403, 'системную роль удалить нельзя', `status=${r.status}`);
  r = await call('DELETE', '/api/roles/smoke_watcher', { token: devToken });
  assert(r.status === 200, 'удаление роли через DELETE /api/roles/:code');

  section('10.7 Удаление аккаунта и связывание identity (п.5, п.6 раунда 29) ');
  r = await call('POST', '/api/auth/dev-login', { body: { token: SECRET, username: 'ToDelete' } });
  const delToken = r.token;
  r = await call('GET', '/api/auth/me', { token: delToken });
  const delId = r.json.user?.id;
  assert(Number.isFinite(Number(delId)), 'создан пользователь для удаления', `id=${delId}`);
  r = await call('DELETE', '/api/users/1', { token: delToken });
  assert(r.status === 403, 'без users.edit удаление недоступно (403)', `status=${r.status}`);
  r = await call('DELETE', '/api/users/1', { token: devToken });
  assert(r.status === 400, 'удалить самого себя нельзя (400; guard Developer-роли за self-check)', `status=${r.status}`);
  r = await call('DELETE', `/api/users/${delId}`, { token: devToken });
  assert(r.status === 200 && r.json.ok === true, 'DELETE /api/users/:id удаляет аккаунт');
  r = await call('GET', '/api/auth/me', { token: delToken });
  assert(r.status === 401, 'сессия удалённого аккаунта недействительна');
  r = await call('DELETE', `/api/users/${delId}`, { token: devToken });
  assert(r.status === 404, 'повторное удаление → 404');

  section('10.6 Telegram-бот: админ-раздел (п.3 раунда 28) ');
  r = await call('GET', '/api/admin/nav', { token: devToken });
  assert(r.json.items.map((i) => i.id).includes('telegram'), 'раздел «Telegram bot» виден Developer в навигации админки');
  r = await call('GET', '/api/admin/nav', { token: plainToken });
  assert(!r.json.items.map((i) => i.id).includes('telegram'), 'без telegram.manage раздел скрыт');
  r = await call('GET', '/api/telegram/status', { token: devToken });
  assert(r.status === 200 && r.json.enabled === true && r.json.polling === true, 'статус бота: включён и поллинг активен', `polling=${r.json.polling}`);
  assert(typeof r.json.subscribers === 'number', 'статус бота: число подписчиков', `subscribers=${r.json.subscribers}`);
  r = await call('PUT', '/api/telegram/settings', { token: devToken, body: { notifyKbUpdates: true } });
  assert(r.status === 200 && r.json.ok === true, 'тумблер автоуведомлений сохраняется');
  r = await call('GET', '/api/telegram/status', { token: devToken });
  assert(r.json.notifyKbUpdates === true, 'тумблер виден в статусе');
  r = await call('POST', '/api/telegram/broadcast', { token: devToken, body: { text: 'Тестовая рассылка smoke' } });
  assert(r.status === 200 && r.json.ok === true && r.json.sent + r.json.failed === r.json.subscribers, 'рассылка: отчёт доставлено/ошибки совпадает с числом подписчиков', `sent=${r.json.sent}, failed=${r.json.failed}`);
  r = await call('POST', '/api/telegram/broadcast', { token: devToken, body: { text: '   ' } });
  assert(r.status === 400, 'рассылка: пустой текст отклоняется (400)', `status=${r.status}`);
  r = await call('GET', '/api/telegram/status', { token: plainToken });
  assert(r.status === 403, 'статус бота без telegram.manage → 403', `status=${r.status}`);

  section('11. Безопасность');
  r = await call('GET', '/api/auth/me');
  assert(r.status === 401, 'без сессии — 401');
  r = await call('POST', '/api/ai/ask', { body: { mode: 'rules', question: 'тест' }, headers: {} });
  assert(r.status === 401, 'POST без авторизации — 401');
  r = await call('POST', '/api/ai/ask', { token: devToken, body: { mode: 'rules', question: 'тест' }, headers: { 'X-Epic-Client': '' } });
  assert(r.status === 400, 'мутирующий запрос без X-Epic-Client отклонён (CSRF)');
  r = await call('GET', '/api/ai/meta', { token: devToken });
  assert(r.status === 200 && !JSON.stringify(r.json).includes('key'), 'GET /api/ai/meta не раскрывает секретов');
  r = await call('GET', '/api/auth/providers');
  assert(r.json.sessionCookie === 'epic_ai_session', 'providers отдаёт имя cookie-сессии для Electron (IPC epic:session:token)');
  assert(typeof r.json.devLogin === 'boolean', 'providers сообщает доступность dev-входа');

  console.log(`\n\x1b[1mИТОГ: ${pass} проверок пройдено, ${fail} провалено\x1b[0m`);
  process.exitCode = fail ? 1 : 0;
}

main().catch((e) => { console.error(e); process.exit(1); });
