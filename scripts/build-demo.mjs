/**
 * EPIC AI — генератор интерактивных демо-страниц.
 *
 *   node scripts/build-demo.mjs
 *
 * Создаёт renderer/demo/*.html — те же окна Epic AI (main / sources / admin /
 * splash), но с встроенным mock-backend'ом и mock-мостом window.epicAI.
 * Демо открывается в обычном браузере и работает без Electron, без сервера
 * и без обращения к форуму.
 *
 * Как это устроено: ESM-модули renderer'а инлайнятся в одну страницу
 * (import-блоки удаляются, export-ключевые слова снимаются, зависимости
 * подставляются раньше использующего их кода). Это нужно только потому, что
 * jsdom и некоторые предпросмотрщики не исполняют <script type="module">.
 * В реальном приложении renderer грузит обычные ESM-модули — код один и тот же.
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync, rmSync, readdirSync } from 'node:fs';
import { dirname, resolve, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const RENDERER = resolve(ROOT, 'renderer');
const DEMO = resolve(RENDERER, 'demo');

/* ------------------------------------------------------------------ */
/*  Чтение ресурсов                                                     */
/* ------------------------------------------------------------------ */

function readCss(...names) {
  return names.map((n) => readFileSync(resolve(RENDERER, 'styles', n), 'utf8')).join('\n\n');
}

function bodyOf(htmlFile) {
  const src = readFileSync(resolve(RENDERER, htmlFile), 'utf8');
  const inner = src.match(/<body[^>]*>([\s\S]*?)<\/body>/)?.[1] ?? '';
  return inner.replace(/<script[\s\S]*?<\/script>/g, '');
}

/* ------------------------------------------------------------------ */
/*  Инлайн ESM-модулей                                                  */
/* ------------------------------------------------------------------ */

/**
 * Убирает import-блоки (в том числе многострочные) и возвращает список
 * локальных зависимостей. Построчный сканер, а не регулярка: ленивый шаблон
 * через несколько операторов съедал бы реальный код.
 */
function stripImports(src) {
  const lines = src.split('\n');
  const out = [];
  const deps = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    const trimmed = line.trim();
    if (!trimmed.startsWith('import ') && trimmed !== 'import') {
      out.push(line);
      i++;
      continue;
    }
    let buf = line;
    while (
      !/from\s*['"][^'"]+['"]\s*;?\s*$/.test(buf.trim()) &&
      !/^import\s*['"][^'"]+['"]\s*;?\s*$/.test(buf.trim()) &&
      i + 1 < lines.length
    ) {
      i++;
      buf += '\n' + lines[i];
    }
    const m = buf.match(/from\s*'\.\/([\w.-]+)'/);
    if (m) deps.push(m[1]);
    // Поддерживаем алиасы (`import { Settings as SettingsApi } from './api.js'`):
    // после удаления import создаём локальные const-привязки на уже
    // инлайненные объявления. Без этого алиас просто исчез бы.
    const names = buf.match(/\{([\s\S]*?)\}\s*from/);
    if (names) {
      for (const piece of names[1].split(',')) {
        const t = piece.trim();
        if (!t) continue;
        const as = t.match(/^(\w+)\s+as\s+(\w+)$/);
        // алиас объявляем один раз на страницу: несколько модулей могут
        // импортировать одно и то же имя под одним и тем же алиасом
        if (as && !emittedAliases.has(as[2])) {
          emittedAliases.add(as[2]);
          out.push(`const ${as[2]} = ${as[1]};`);
        }
      }
    }
    const def = buf.match(/^\s*import\s+(\w+)\s*,?\s*(?:\{[\s\S]*?\})?\s*from/);
    if (def && !/\bas\s+/.test(buf)) void def; // default-импортов в проекте нет
    i++;
  }
  return { code: out.join('\n'), deps };
}

/** Уже встроенные в страницу модули: общие util/api/settings не дублируются. */
const inlinedOnce = new Set();
/** Уже объявленные алиасы импортов (в пределах одной страницы). */
const emittedAliases = new Set();

function inlineModule(entry, order = []) {
  const seen = new Set(inlinedOnce);   // копия, а не ссылка
  const parts = [];

  const walk = (file) => {
    if (seen.has(file)) return;
    seen.add(file);
    const raw = readFileSync(resolve(RENDERER, 'scripts', file), 'utf8');
    const { code, deps } = stripImports(raw);
    for (const d of deps) walk(d);     // зависимости — раньше модуля
    const src = code
      .replace(/^export\s+(async\s+)?function/gm, (_m, a) => `${a ?? ''}function`)
      .replace(/^export\s+const\s+/gm, 'const ')
      .replace(/^export\s+let\s+/gm, 'let ')
      .replace(/^export\s+class\s+/gm, 'class ')
      // ВАЖНО: только однострочные export-списки. Шаблон с \s+ пересёк бы
      // переносы строк и съел соседний объект вида `export const X = { … }`.
      .replace(/^export\s*\{[^{}\n]*\};?[ \t]*$/gm, '')
      .replace(/^export\s+default\s+/gm, 'const __default = ');
    // Точка входа (main.js / admin.js / sources.js) ничего не экспортирует наружу,
    // поэтому заворачиваем её в IIFE: её top-level идентификаторы (например ctx)
    // не конфликтуют с инлайновыми модулями в общем scope демо-страницы.
    const isEntry = file === entry;
    const body = isEntry ? `(function () {\n'use strict';\n${src}\n})();` : src;
    parts.push(`/* ==== ${file} ==== */\n${body}`);
  };

  for (const dep of order) walk(dep);
  walk(entry);
  for (const f of seen) inlinedOnce.add(f);
  return parts.join('\n\n');
}

/* ------------------------------------------------------------------ */
/*  Каркас страницы                                                     */
/* ------------------------------------------------------------------ */

function page({ title, css, body, scripts, note }) {
  return `<!DOCTYPE html>
<html lang="ru" data-blur="true" data-animations="true" data-lowperf="false">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>${title}</title>
<!-- Демо-страница Epic AI: mock-backend встроен, сеть не требуется -->
<style>
${css}
</style>
<style>
${DEMO_CHROME_CSS}
</style>
</head>
<body>
${note ? `<div class="demo-note">${note}</div>` : ''}
${body}
<script type="module">
${scripts.join('\n\n')}
</script>
</body>
</html>
`;
}

const DEMO_CHROME_CSS = `
/* Оформление самой демо-страницы — не часть продукта */
body { background: #07080a !important; height: auto !important; min-height: 100vh; overflow: auto !important;
       background-image: radial-gradient(circle at 18% 12%, rgba(172,231,46,.10), transparent 42%),
                         radial-gradient(circle at 82% 78%, rgba(52,152,219,.10), transparent 45%),
                         linear-gradient(#0b0d10, #07080a) !important; }
.demo-note { max-width: 1240px; margin: 18px auto 14px; padding: 10px 14px; font-size: 11.5px; line-height: 1.65;
             color: #888; border: 1px dashed rgba(238,249,244,.16); border-radius: 10px; background: rgba(18,20,22,.5); }
.demo-note a { color: #ACE72E; }
.demo-stage { display: flex; gap: 14px; align-items: flex-start; justify-content: center; flex-wrap: wrap; padding: 0 18px 44px; }
.demo-window { flex: none; position: relative; }
`;

/* ------------------------------------------------------------------ */
/*  Mock-мост + mock-backend                                            */
/* ------------------------------------------------------------------ */

let MOCK_BRIDGE = readFileSync(resolve(ROOT, 'scripts', 'demo-bridge.js'), 'utf8');
// Мост рисует копию окна источников рядом с панелью — ему нужен его CSS.
MOCK_BRIDGE = MOCK_BRIDGE.split('__SOURCES_CSS__').join(JSON.stringify(readCss('sources.css')).slice(1, -1));
// Мост рисует копию окна профиля рядом с панелью — ему нужен его CSS.

/* ------------------------------------------------------------------ */
/*  Страницы                                                            */
/* ------------------------------------------------------------------ */

function build() {
  if (existsSync(DEMO)) rmSync(DEMO, { recursive: true, force: true });
  mkdirSync(DEMO, { recursive: true });

  const cssCore = readCss('tokens.css', 'base.css');
  const noteCommon = 'Демо Epic AI: внутри встроен mock-backend с <b>вымышленными учебными</b> документами — это не официальные правила EpicRP. ';

  // 1) Основная панель
  writeFileSync(resolve(DEMO, 'main.html'), page({
    title: 'Epic AI — демо основной панели',
    css: `${cssCore}\n\n${readCss('main.css')}\n\n${readCss('kb.css')}\n\n${readCss('profile.css')}`,
    note: `${noteCommon}Отправьте запрос (например «что такое DM»), переключите ПРАВИЛА / ЗАКОНЫ, нажмите ⚙ и откройте раздел «Правила» → «Посмотреть» — база знаний раскроется внутри панели. Подтверждение «Спросить ИИ?» и профиль открываются отдельными «окнами» рядом с панелью.`,
    body: `<div class="demo-stage"><div class="demo-window" style="width:900px">${bodyOf('main.html')}</div><div id="demo-confirm-slot"></div><div id="demo-sources-slot"></div><div id="demo-history-slot"></div></div>`,
    scripts: [MOCK_BRIDGE, inlineModule('main.js', ['settings.js', 'kbview.js'])],
  }));

  // 2) Окно источников
  inlinedOnce.clear(); emittedAliases.clear();
  writeFileSync(resolve(DEMO, 'sources.html'), page({
    title: 'Epic AI — демо окна источников',
    css: `${cssCore}\n\n${readCss('sources.css')}`,
    note: `${noteCommon}В приложении это отдельный BrowserWindow справа от панели .`,
    body: `<div class="demo-stage"><div class="demo-window" style="width:440px;height:620px">${bodyOf('sources.html')}</div></div>`,
    scripts: [MOCK_BRIDGE, `window.__DEMO_SOURCES_AUTOLOAD__ = true;`, inlineModule('sources.js')],
  }));

  // 3) Splash
  inlinedOnce.clear(); emittedAliases.clear();
  writeFileSync(resolve(DEMO, 'splash.html'), page({
    title: 'Epic AI — демо splash screen',
    css: `${cssCore}\n\n${readCss('splash.css')}`,
    note: 'Демо: splash screen 360×220 . Девять этапов инициализации проигрываются автоматически, после завершения splash закрывается.',
    body: `<div class="demo-stage" style="flex-direction:column;align-items:center;gap:18px">
  <div class="demo-window" style="width:360px;height:220px">${bodyOf('splash.html')}</div>
  <button class="btn" id="demo-replay" type="button">Проиграть заново</button>
</div>`,
    scripts: [MOCK_BRIDGE, inlineModule('splash.js'), SPLASH_DRIVER],
  }));

  // 4) Административная панель
  inlinedOnce.clear(); emittedAliases.clear();
  writeFileSync(resolve(DEMO, 'admin.html'), page({
    title: 'Epic AI — демо административной панели',
    css: `${cssCore}\n\n${readCss('admin.css')}`,
    note: `${noteCommon}Переключайте роль в правом верхнем углу — видимость разделов зависит от permissions .`,
    body: `<div class="demo-stage"><div class="demo-window" style="width:100%;max-width:1320px;height:840px">${bodyOf('admin.html')}</div></div>`,
    scripts: [MOCK_BRIDGE, inlineModule('admin.js', ['settings.js', 'admin-views.js'])],
  }));

  // 5) Окно подтверждения «Спросить ИИ?» (отдельное окно, не inline-модалка)
  inlinedOnce.clear(); emittedAliases.clear();
  writeFileSync(resolve(DEMO, 'confirm.html'), page({
    title: 'Epic AI — демо окна подтверждения',
    css: `${cssCore}\n\n${readCss('main.css')}`,
    note: `${noteCommon}В приложении это отдельный BrowserWindow (380×236) поверх панели: показывает остаток дневного лимита перед отправкой вопроса. Enter — спросить, Esc — отмена; результат возвращается панели через main process.`,
    body: `<div class="demo-stage"><div class="demo-window" style="width:380px;height:236px">${bodyOf('confirm.html')}</div></div>`,
    scripts: [MOCK_BRIDGE, inlineModule('confirm.js')],
  }));

  // 6) Окно профиля (открывается из меню пользователя)
  inlinedOnce.clear(); emittedAliases.clear();
  writeFileSync(resolve(DEMO, 'index.html'), page({
    title: 'Epic AI — демо интерфейса',
    css: cssCore,
    note: null,
    body: `<div class="demo-stage" style="padding-top:26px">
  <div class="demo-window glass" style="width:580px;padding:26px 28px;border-radius:14px">
    <div style="display:flex;align-items:center;gap:10px;margin-bottom:6px">
      <svg width="26" height="26" viewBox="0 0 32 32" fill="none"><path d="M5 25 L16 5 L27 25 Z" stroke="#ACE72E" stroke-width="2.4" stroke-linejoin="round"/><circle cx="16" cy="19.5" r="2.6" fill="#E2FF3F"/></svg>
      <div style="font-size:17px;font-weight:800;letter-spacing:.2em">EPIC <span style="color:#ACE72E">AI</span></div>
    </div>
    <div class="subtle" style="font-size:11.5px;margin-bottom:20px;line-height:1.7">
      Интерактивные демо-страницы интерфейса из  v1.0. Работают без Electron и без сети:
      внутри встроен mock-backend с тестовыми данными. Код renderer'а — тот же самый, что в продукте.
    </div>
    <div style="display:flex;flex-direction:column;gap:8px">
      <a class="btn btn--lg" href="main.html" style="text-decoration:none">Основная панель · ответ AI · настройки</a>
      <a class="btn btn--lg" href="sources.html" style="text-decoration:none">Окно найденных источников</a>
      <a class="btn btn--lg" href="confirm.html" style="text-decoration:none">Окно подтверждения «Спросить ИИ?»</a>
      <a class="btn btn--lg" href="main.html#kb" style="text-decoration:none">База знаний: «Посмотреть» и «История изменений»</a>
      <a class="btn btn--lg" href="admin.html" style="text-decoration:none">Административная панель</a>
      <a class="btn btn--lg" href="splash.html" style="text-decoration:none">Splash screen</a>
    </div>
    <div class="subtle" style="font-size:10.5px;margin-top:20px;line-height:1.8">
      Демо-документы вымышлены и нужны только для проверки интерфейса.<br>
      Реальная база знаний наполняется crawler'ом с forum.epic-gta.com — порядок согласования описан в docs/LEGAL.md.
    </div>
  </div>
</div>`,
    scripts: [],
  }));
}

const SPLASH_DRIVER = `
/* Демо-драйвер splash: проигрывает этапы инициализации  */
(function () {
  const STEPS = [
    ['config', 'http://127.0.0.1:8787'], ['local_data', 'настроек: 24'], ['session', 'sqlite / sql.js'],
    ['user', 'Alexander'], ['status', 'active'], ['role', 'Игрок'], ['permissions', '7 прав'],
    ['ui', ''], ['main', ''],
  ];
  let timers = [];
  function play() {
    timers.forEach(clearTimeout);
    timers = [];
    let t = 200;
    for (const [id, detail] of STEPS) {
      timers.push(setTimeout(() => window.dispatchEvent(new CustomEvent('demo-splash-step', { detail: { id, status: 'active', detail: '' } })), t));
      t += 340;
      timers.push(setTimeout(() => window.dispatchEvent(new CustomEvent('demo-splash-step', { detail: { id, status: 'done', detail } })), t));
      t += 120;
    }
    timers.push(setTimeout(() => window.dispatchEvent(new CustomEvent('demo-splash-done')), t + 200));
  }
  const btn = document.getElementById('demo-replay');
  if (btn) btn.addEventListener('click', play);
  play();
})();
`;

build();

console.log(`[epic-ai] демо-страницы собраны в ${relative(ROOT, DEMO)}/`);
for (const f of readdirSync(DEMO).sort()) {
  const size = (readFileSync(resolve(DEMO, f), 'utf8').length / 1024).toFixed(0);
  console.log(`  • demo/${f} (${size} KB)`);
}
