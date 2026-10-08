/**
 * EPIC AI — проверка демо-страниц в jsdom.
 *
 * Демо-страницы содержат реальный код renderer'а (main.js, sources.js, admin.js,
 * splash.js, settings.js, admin-views.js) + mock-backend. Этот тест поднимает их
 * в DOM и проверяет, что:
 *   • нет необработанных JS-ошибок;
 *   • интерфейс доходит до ожидаемого состояния;
 *   • ключевые сценарии  отрабатывают (запрос → ответ → источники → 👎 → отчёт).
 *
 *   node scripts/test-demo-dom.mjs
 */
import { readFileSync, existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';


const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const DEMO = resolve(ROOT, 'renderer/demo');

/** jsdom ищем в node_modules проекта, затем — по списку запасных путей. */
async function loadJsdom() {
  // Прямой путь к lib/api.js предпочтительнее: при импорте пакета целиком
  // jsdom отдаёт ESM-обёртку, у которой контекст vm ведёт себя иначе.
  const candidates = [
    resolve(ROOT, 'node_modules/jsdom/lib/api.js'),
    '/tmp/domtest/node_modules/jsdom/lib/api.js',
    'jsdom',
  ];
  for (const c of candidates) {
    try { return await import(c); } catch { /* пробуем следующий */ }
  }
  return null;
}
const jsdomModule = await loadJsdom();
if (!jsdomModule) {
  console.error('jsdom не найден. Установите: npm install   (корень репозитория)');
  process.exit(2);
}
const { JSDOM, VirtualConsole } = jsdomModule;

let pass = 0;
let fail = 0;
const ok = (n, d = '') => { pass++; console.log(`  \x1b[32m✓\x1b[0m ${n}${d ? ' — ' + d : ''}`); };
const no = (n, d = '') => { fail++; console.log(`  \x1b[31m✗\x1b[0m ${n}${d ? ': ' + d : ''}`); };
const check = (c, n, d = '') => (c ? ok(n, d) : no(n, d));
const section = (t) => console.log(`\n\x1b[1m${t}\x1b[0m`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
/** Ждать условие шагами по 60 мс (флейки таймингов после ctx.reload). */
async function waitFor(fn, timeoutMs = 5000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    if (fn()) return true;
    await sleep(60);
  }
  return false;
}

/**
 * jsdom не исполняет <script type="module">, поэтому демо-скрипты
 * (которые сборщик уже инлайнит и лишает import/export) выполняются
 * вручную в контексте окна через node:vm. Это даёт настоящую проверку
 * кода renderer'а, а не только вёрстки.
 */
async function loadPage(file) {
  const html = readFileSync(resolve(DEMO, file), 'utf8');
  const errors = [];
  const vc = new VirtualConsole();
  vc.on('jsdomError', (e) => errors.push(String(e.message ?? e)));
  vc.on('error', (...a) => errors.push(a.map(String).join(' ')));

  const dom = new JSDOM(html, {
    runScripts: 'outside-only',
    pretendToBeVisual: true,
    url: 'https://demo.local/renderer/demo/' + file,
    virtualConsole: vc,
  });
  const w = dom.window;

  // Заглушки API, которых нет в jsdom
  w.requestAnimationFrame = (cb) => setTimeout(() => cb(Date.now()), 0);
  w.cancelAnimationFrame = (id) => clearTimeout(id);
  w.confirm = () => false;
  w.prompt = () => 'причина из теста';
  w.scrollTo = () => {};
  w.fetch = w.fetch ?? (() => Promise.reject(new Error('no fetch')));
  Object.defineProperty(w.HTMLElement.prototype, 'scrollHeight', { configurable: true, get() { return 420; } });
  Object.defineProperty(w.HTMLElement.prototype, 'offsetHeight', { configurable: true, get() { return 420; } });
  Object.defineProperty(w.Element.prototype, 'scrollTop', { configurable: true, get() { return 0; }, set() {} });

  const scripts = [...html.matchAll(/<script type="module">([\s\S]*?)<\/script>/g)].map((m) => m[1]);
  const context = vm.createContext(w);
  w.addEventListener('error', (e) => errors.push('window.onerror: ' + (e.error?.stack ?? e.message)));
  for (const [i, code] of scripts.entries()) {
    try {
      vm.runInContext(code, context, { filename: `${file}#script${i}`, timeout: 15000 });
    } catch (e) {
      errors.push(`script#${i}: ${e.stack ?? e.message}`);
    }
  }
  // DOMContentLoaded уже произошёл до выполнения скриптов — эмулируем
  try {
    w.dispatchEvent(new w.Event('DOMContentLoaded', { bubbles: true }));
    w.document.dispatchEvent(new w.Event('DOMContentLoaded', { bubbles: true }));
  } catch (e) { errors.push('DOMContentLoaded: ' + e.message); }

  await sleep(80);
  return { dom, window: w, errors, scriptCount: scripts.length };
}

/* ------------------------------------------------------------------ */

async function testMain() {
  section('Основная панель (renderer/demo/main.html)');
  const { window: w, errors } = await loadPage('main.html');
  const d = w.document;
  await sleep(600);

  check(errors.length === 0, 'нет JS-ошибок при загрузке', errors.slice(0, 3).join(' | '));
  check(Boolean(d.querySelector('.panel')), 'панель отрисована');
  check(d.querySelector('#mode-rules')?.classList.contains('is-active'), 'ПРАВИЛА активны по умолчанию');
  check(d.querySelector('#mode-laws') && !d.querySelector('#mode-laws').classList.contains('is-active'), 'ЗАКОНЫ — вторая отдельная кнопка (не dropdown)');
  check(d.querySelector('#query-input')?.placeholder === 'Вопрос, ситуация, пункт или номер статьи…', 'placeholder строки запроса в референс-стиле');
  const exp = d.querySelector('#expander');
  check(!exp.classList.contains('is-open') && d.querySelector('#pane-answer').hidden && d.querySelector('#pane-settings').hidden,
    'без запроса нет большой области ответа ');
  check(d.querySelectorAll('.expander .settings__nav-item').length === 0, 'настройки не отрисованы до открытия ⚙');
  check(Boolean(d.querySelector('#settings-btn')), 'кнопка ⚙ на панели');
  check(d.querySelector('#user-btn')?.hidden === false, 'пилюля пользователя в баре (референс)');
  // П.3: пилюля БЕЗ шеврона и БЕЗ dropdown-меню — только аватар и ник
  check(d.querySelector('#user-menu') === null, 'dropdown-меню пользователя удалено (п.3)');
  check(d.querySelector('#user-btn .userpill__chev') === null, 'у пилюли нет шеврона разворачивания (п.3)');
  check((d.querySelector('#user-name')?.textContent ?? '').length > 1, 'в пилюле остаётся ник (п.3)');
  // П.4/п.5: клик по пилюле открывает НАСТРОЙКИ на вкладке «Профиль»
  d.querySelector('#user-btn').dispatchEvent(new w.MouseEvent('click', { bubbles: true }));
  await sleep(450);
  const setPane = d.querySelector('#pane-settings');
  check(setPane?.hidden === false, 'клик по пилюле открывает панель настроек (п.4)');
  const profPage = d.querySelector('#settings-pages')?.textContent ?? '';
  check(/Профиль и аккаунт/.test(profPage), 'настройки открыты на вкладке «Профиль» (п.4)');
  check(/Ответы ИИ сегодня/.test(profPage), 'в профиле — карточка «Ответы ИИ сегодня» (п.4)');
  check(/\d+ из \d+/.test(profPage), 'в профиле — остаток дневного лимита (п.4)', (profPage.match(/\d+ из \d+/) ?? [])[0]);
  check(/Выйти из аккаунта/.test(profPage), 'в профиле — блок «Выйти из аккаунта» (п.4)');
  check(/вход через Telegram/.test(profPage), 'в профиле — «@ник · вход через Telegram» (п.4)');
  check(d.querySelector('#settings-side .settings__nav-item.is-active') === null, 'в навигации настроек нет активной вкладки: «Профиль» скрыт из списка (п.2)');
  check(![...d.querySelectorAll('#settings-side .settings__nav-item')].some((n) => n.textContent.includes('Профиль')), 'пункта «Профиль» нет в сайдбаре настроек (п.2)');
  check(Boolean([...d.querySelectorAll('#settings-pages button')].find((b) => b.textContent.includes('к настройкам'))), 'в профиле есть кнопка возврата к настройкам');
  // повторный клик сворачивает панель
  d.querySelector('#user-btn').dispatchEvent(new w.MouseEvent('click', { bubbles: true }));
  await sleep(250);
  check(d.querySelector('#pane-settings')?.hidden === true, 'повторный клик по пилюле сворачивает настройки');
  // п.3: профиль открывается в настройках по клику на пилюлю, возврат — кнопкой
  d.querySelector('#user-btn').dispatchEvent(new w.MouseEvent('click', { bubbles: true }));
  await sleep(400);
  const backBtn = [...d.querySelectorAll('#settings-pages button')].find((b) => b.textContent.includes('к настройкам'));
  backBtn?.dispatchEvent(new w.MouseEvent('click', { bubbles: true }));
  await sleep(300);
  check(/Горячая клавиша/.test(d.querySelector('#settings-pages')?.textContent ?? ''), 'кнопка «← к настройкам» возвращает в раздел «Основное»');
  check(d.querySelector('#settings-side .settings__nav-item.is-active')?.textContent.includes('Основное') === true, 'после возврата активна вкладка «Основное»');

  // Звезда: открепление — это состояние, а не ошибка (фикс ложного «не удалось закрепить»)
  d.querySelector('#pin-btn').dispatchEvent(new w.MouseEvent('click', { bubbles: true }));
  await sleep(200);
  check(!/Не удалось закрепить/.test(d.querySelector('#toast')?.textContent ?? ''), 'звезда: открепление не показывает «не удалось закрепить»');
  check(d.querySelector('#pin-btn')?.getAttribute('aria-pressed') === 'false', 'звезда переключилась в «откреплено»');
  d.querySelector('#pin-btn').dispatchEvent(new w.MouseEvent('click', { bubbles: true }));
  await sleep(200);
  check(d.querySelector('#pin-btn')?.getAttribute('aria-pressed') === 'true', 'звезда переключилась обратно в «закреплено»');
  check((d.querySelector('#user-name')?.textContent ?? '').length > 1, 'имя пользователя в пилюле', d.querySelector('#user-name')?.textContent);
  check(Boolean(d.querySelector('#pin-btn')) && Boolean(d.querySelector('#history-btn')) && Boolean(d.querySelector('#mic-btn')), 'звёздочка, история и микрофон в баре (референс)');

  // --- панель тянется за ЛЮБОЕ свободное место, а не только за логотип (п.15) ---
  w.__DEMO_PANEL_MOVE__ = null;
  d.querySelector('.panel__in').dispatchEvent(new w.MouseEvent('mousedown', { bubbles: true, button: 0, screenX: 100, screenY: 100 }));
  await sleep(60);
  w.dispatchEvent(new w.MouseEvent('mousemove', { screenX: 140, screenY: 130 }));
  await sleep(60);
  w.dispatchEvent(new w.MouseEvent('mouseup', {}));
  check(Boolean(w.__DEMO_PANEL_MOVE__), 'панель перетаскивается за свободное место бара (п.15)');
  // за логотип — по-прежнему можно
  w.__DEMO_PANEL_MOVE__ = null;
  d.querySelector('#logo').dispatchEvent(new w.MouseEvent('mousedown', { bubbles: true, button: 0, screenX: 100, screenY: 100 }));
  await sleep(60);
  w.dispatchEvent(new w.MouseEvent('mousemove', { screenX: 160, screenY: 120 }));
  await sleep(60);
  w.dispatchEvent(new w.MouseEvent('mouseup', {}));
  check(Boolean(w.__DEMO_PANEL_MOVE__), 'перетаскивание за логотип сохранено (п.15)');
  // интерактивные элементы drag НЕ начинают
  w.__DEMO_PANEL_MOVE__ = null;
  d.querySelector('#query-input').dispatchEvent(new w.MouseEvent('mousedown', { bubbles: true, button: 0, screenX: 100, screenY: 100 }));
  await sleep(60);
  w.dispatchEvent(new w.MouseEvent('mousemove', { screenX: 180, screenY: 140 }));
  await sleep(60);
  w.dispatchEvent(new w.MouseEvent('mouseup', {}));
  check(w.__DEMO_PANEL_MOVE__ === null, 'поле ввода не начинает перетаскивание (п.15)');

  // --- режимы ---
  d.querySelector('#mode-laws').dispatchEvent(new w.MouseEvent('click', { bubbles: true }));
  check(d.querySelector('#mode-laws').classList.contains('is-active'), 'переключение на ЗАКОНЫ');
  d.querySelector('#mode-rules').dispatchEvent(new w.MouseEvent('click', { bubbles: true }));

  // --- запрос → ответ + окно источников  ---
  const input = d.querySelector('#query-input');
  input.value = 'Что такое DM и можно ли убивать игрока без причины?';
  input.dispatchEvent(new w.Event('input', { bubbles: true }));
  input.dispatchEvent(new w.KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
  await sleep(500);

  // Окно подтверждения «Спросить ИИ?» — ОТДЕЛЬНОЕ окно (п.1): в демо рисуется
  // рядом с панелью в #demo-confirm-slot, в приложении — BrowserWindow confirm.html.
  const confirmSlot = d.querySelector('#demo-confirm-slot');
  check(Boolean(confirmSlot?.querySelector('.modal__box')), 'перед отправкой открылось ОТДЕЛЬНОЕ окно «Спросить ИИ?» (п.1)');
  check(d.querySelector('#ask-modal') === null, 'inline-модалки внутри панели больше нет (п.1)');
  await sleep(200);
  check(/Спросить ИИ\?/.test(confirmSlot?.textContent ?? ''), 'заголовок окна — «Спросить ИИ?»');
  check(/Осталось сегодня/.test(confirmSlot?.textContent ?? ''), 'в окне строка «Осталось сегодня»');
  check(/\d+ из \d+/.test(confirmSlot?.querySelector('[data-role=quota]')?.textContent ?? ''), 'остаток лимита: X из Y', confirmSlot?.querySelector('[data-role=quota]')?.textContent);
  check(Boolean(confirmSlot?.querySelector('.modal__bar [data-role=bar]')), 'прогресс-бар остатка запросов');
  check(/Отмена/.test(confirmSlot?.querySelector('[data-role=cancel]')?.textContent ?? '') && /Esc/.test(confirmSlot?.querySelector('[data-role=cancel]')?.textContent ?? ''), 'кнопка «Отмена Esc»');
  check(/Спросить/.test(confirmSlot?.querySelector('[data-role=ok]')?.textContent ?? '') && /Enter/.test(confirmSlot?.querySelector('[data-role=ok]')?.textContent ?? ''), 'кнопка «Спросить Enter»');
  check(d.querySelector('#pane-answer').hidden === true, 'до подтверждения ответ не показывается');
  // Esc отменяет отправку
  d.body.dispatchEvent(new w.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  await sleep(300);
  check((confirmSlot?.innerHTML ?? '') === '', 'Esc отменяет вопрос и закрывает окно подтверждения');
  check(d.querySelector('#pane-answer').hidden === true, 'после отмены ответ не появился');
  // Повторная отправка + подтверждение
  input.dispatchEvent(new w.KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
  await sleep(400);
  confirmSlot.querySelector('[data-role=ok]').dispatchEvent(new w.MouseEvent('click', { bubbles: true }));
  await sleep(1400);

  check(d.querySelector('#expander').classList.contains('is-open'), 'панель развернулась после запроса');
  check(d.querySelector('#pane-answer').hidden === false, 'отображается область ответа');
  check(d.querySelector('#pane-settings').hidden === true, 'ответ и настройки не показываются вместе ');
  const verdict = d.querySelector('#answer-verdict')?.textContent ?? '';
  check(/Запрещено|Разрешено|Зависит/.test(verdict), 'вердикт в структуре ответа ', verdict.trim().slice(0, 40));
  check((d.querySelector('#answer-explanation')?.textContent ?? '').length > 40, 'объяснение заполнено');
  check((d.querySelector('#answer-basis')?.textContent ?? '').includes('Правила сервера'), 'основание ссылается на документ из базы', d.querySelector('#answer-basis')?.textContent.slice(0, 60));
  check(d.querySelectorAll('#answer-sources .src-chip').length >= 1, 'чипы источников под ответом', String(d.querySelectorAll('#answer-sources .src-chip').length));

  // окно источников (в демо рисуется рядом)
  const srcSlot = d.getElementById('demo-sources-slot');
  check(Boolean(srcSlot?.querySelector('.src-card')), 'окно источников открылось рядом с панелью');
  const card = srcSlot?.querySelector('.src-card');
  check(card?.querySelector('.src-card__doc')?.textContent?.length > 3, 'в карточке есть название документа');
  check(/Дата редакции/.test(card?.textContent ?? ''), 'в карточке есть дата редакции ');
  check(/Открыть источник/.test(card?.textContent ?? ''), 'кнопка «Открыть источник ↗»');

  // --- feedback  ---
  const like = d.querySelector('#vote-up');
  const dislike = d.querySelector('#vote-down');
  check(Boolean(like) && Boolean(dislike), 'под ответом есть 👍 и 👎');
  like.dispatchEvent(new w.MouseEvent('click', { bubbles: true }));
  await sleep(350);
  check(like.classList.contains('is-on'), '👍 засчитан и не открыл форму');
  check(d.querySelector('#report-form').classList.contains('is-open') === false, 'после 👍 форма ошибки закрыта');

  dislike.dispatchEvent(new w.MouseEvent('click', { bubbles: true }));
  await sleep(500);
  check(d.querySelector('#report-form').classList.contains('is-open'), '👎 открыл форму «Почему ответ неверный?»');
  const radios = d.querySelectorAll('#report-categories input[name="report-category"]');
  check(radios.length === 6, '6 категорий ошибки из ', String(radios.length));
  const labels = [...d.querySelectorAll('#report-categories .radio__label')].map((x) => x.textContent);
  check(labels.includes('Неверно истолковано правило') && labels.includes('Устаревшая информация') && labels.includes('Другое'), 'категории соответствуют ');

  d.querySelector('#report-form').dispatchEvent(new w.Event('submit', { bubbles: true, cancelable: true }));
  await sleep(300);
  check(/категория обязательна|должна быть выбрана/.test(d.querySelector('#report-error').textContent ?? ''),
    'без выбранной категории отчёт не отправляется ', d.querySelector('#report-error').textContent);

  radios[2].checked = true;                       // «Устаревшая информация»
  radios[2].dispatchEvent(new w.Event('change', { bubbles: true }));
  d.querySelector('#report-comment').value = 'Цитата из старой редакции';
  d.querySelector('#report-form').dispatchEvent(new w.Event('submit', { bubbles: true, cancelable: true }));
  await sleep(500);
  check(/Отчёт #\d+ создан/.test(d.querySelector('#feedback-hint')?.textContent ?? ''), 'отчёт создан после 👎', d.querySelector('#feedback-hint')?.textContent);

  // --- настройки разворачивают панель вниз  ---
  d.querySelector('#settings-btn').dispatchEvent(new w.MouseEvent('click', { bubbles: true }));
  await sleep(400);
  check(d.querySelector('#pane-settings').hidden === false, 'настройки открылись внутри панели (без нового окна)');
  check(d.querySelector('#pane-answer').hidden === true, 'ответ скрыт при открытых настройках');
  const navLabels = [...d.querySelectorAll('.settings__nav-item')].map((x) => x.textContent.trim());
  check(navLabels.join(',').includes('Основное') && navLabels.join(',').includes('Производительность') && navLabels.join(',').includes('Правила') && navLabels.join(',').includes('Клавиши') && navLabels.join(',').includes('Частые вопросы'),
    'разделы настроек: Основное/Правила/Клавиши/Производительность/Частые вопросы', navLabels.join(' · '));
  check(!navLabels.join(',').includes('Интерфейс'), 'вкладка «Интерфейс» убрана — прозрачность переехала в «Основное» (п.14)', navLabels.join(' · '));
  check(!navLabels.join(',').includes('Профиль'), 'вкладка «Профиль» НЕ показывается в навигации настроек (п.2 раунда 19)', navLabels.join(' · '));
  check(!navLabels.join(',').includes('Ответы ИИ') && !navLabels.join(',').includes('О программе'),
    'вкладок «Ответы ИИ» и «О программе» больше нет (требование пользователя)', navLabels.join(' · '));
  check(Boolean(d.querySelector('.set-side .side-user')), 'в сайдбаре настроек — карточка пользователя (референс)');
  check(/v\d/.test(d.querySelector('.side-foot')?.textContent ?? ''), 'внизу сайдбара — версия');

  // --- раздел «Основное»: прозрачность (переехала из «Интерфейса»), микрофон, стример (п.13, п.14) ---
  const mainBtn = [...d.querySelectorAll('.settings__nav-item')].find((x) => x.textContent.trim() === 'Основное');
  mainBtn?.dispatchEvent(new w.MouseEvent('click', { bubbles: true }));
  await sleep(300);
  const mainText = d.querySelector('.settings__pages')?.textContent ?? '';
  check(/Прозрачность/.test(mainText), '«Основное»: прозрачность на месте (переехала из «Интерфейса», п.14)');
  check(Boolean(d.querySelector('.settings__pages .range')), '«Основное»: слайдер прозрачности');
  check(/Микрофон/.test(mainText), '«Основное»: выбор устройства микрофона (п.13)');
  check(/Режим стримера/.test(mainText), '«Основное»: тумблер «Режим стримера»');
  check(!/blur|Blur/.test(mainText), 'blur не предлагается нигде в настройках', mainText.slice(0, 80));
  check(!/Анимаци/.test(mainText), 'настройки анимаций убраны', mainText.slice(0, 60));
  check(!/Ширина окна источников/.test(mainText) && !/Высота окна источников/.test(mainText), 'размеров окна источников больше нет');
  check(!/Положение на экране/.test(mainText), 'селекта положения нет — панель перетаскивается свободно');
  check(!d.querySelector('#frost'), 'живой фон убран полностью: #frost в DOM отсутствует');

  // раздел «Правила» 
  const rulesBtn = [...d.querySelectorAll('.settings__nav-item')].find((x) => x.textContent.trim() === 'Правила');
  rulesBtn.dispatchEvent(new w.MouseEvent('click', { bubbles: true }));
  await sleep(1200);
  const rulesText = d.querySelector('.settings__pages')?.textContent ?? '';
  check(/Обновлены сегодня/.test(rulesText), 'карточка «Обновлены сегодня» (референс)', rulesText.slice(0, 60));
  check(/Последние изменения/.test(rulesText), 'подпись «Последние изменения» (референс)');
  check(/Обновление сегодня/.test(rulesText), 'карточка «Обновление сегодня» (референс)');
  check(/изменены \d|новых \d|в архиве \d|Сегодня изменений нет/.test(rulesText), 'чипы с числом изменений (референс)');
  check(/база v.+ · синхронизация/.test(rulesText), 'показана версия базы и время синхронизации');
  check(/Посмотреть/.test(rulesText), 'кнопка ПОСМОТРЕТЬ на месте');
  check(![...d.querySelectorAll('.settings__pages button')].some((b) => b.textContent.trim() === 'История изменений'),
    'кнопка «История изменений» из вкладки «Правила» убрана (п.9) — история доступна в самой области БЗ');
  check(!/Обновить базу/.test(rulesText), 'кнопки «Обновить базу» нет (база обновляется при запуске)');
  check(/обновляется автоматически при запуске/.test(rulesText), 'подсказка про автообновление при запуске');
  // Размер области настроек не меняется по вкладкам (п.3)
  check(Boolean(d.querySelector('.set-main.scroll')), 'контент настроек скроллится внутри фиксированной области');

  // «Посмотреть» / «История изменений» → выпадающая область панели ВНЕ настроек
  const viewBtn = [...d.querySelectorAll('.settings__pages button')].find((b) => b.textContent.trim() === 'Посмотреть');
  viewBtn.dispatchEvent(new w.MouseEvent('click', { bubbles: true }));
  await sleep(1600);
  const kbSlot = d.querySelector('#pane-kb');
  check(Boolean(kbSlot) && kbSlot.hidden === false, '«Посмотреть» раскрыл базу знаний внутри панели (вне настроек)');
  check(d.querySelector('#pane-settings').hidden === true, 'настройки при этом скрыты');
  const updText = kbSlot?.textContent ?? '';
  check(/Изменения правил/.test(updText), 'заголовок «Изменения правил» с датой (референс)');
  check(/все \d/.test(updText) && /изменены \d/.test(updText), 'фильтры-чипы «все N» / «изменены N» (референс)');
  check(/Изменён пункт|Новый пункт/.test(updText), 'левая колонка со списком изменений');
  const diffNode = kbSlot?.querySelector('.diff-view');
  check(Boolean(diffNode), 'правая колонка показывает diff');
  const spans = diffNode ? [...diffNode.querySelectorAll('span')] : [];
  check(spans.some((s) => /231,\s*76,\s*60/.test(s.style.background ?? '')), 'удалённый текст окрашен в #E74C3C ');
  check(spans.some((s) => /172,\s*231,\s*46|var\(--accent\)/.test(s.style.background ?? '')), 'добавленный текст окрашен в #ACE72E ');

  // «История изменений» — переключатель ВНУТРИ области базы знаний (кнопка из
  // вкладки «Правила» убрана, п.9): список дней в том же окне БЗ
  const kbHistTab = d.querySelector('#kb-tab-history');
  check(Boolean(kbHistTab), 'в области БЗ остался переключатель «История изменений»');
  kbHistTab?.dispatchEvent(new w.MouseEvent('click', { bubbles: true }));
  await sleep(900);
  const histText = kbSlot?.textContent ?? '';
  check((kbSlot?.querySelectorAll('.kb-hist__row').length ?? 0) >= 1, 'переключатель «История изменений» открыл список дней', histText.slice(0, 40));
  const openDayBtn = kbSlot?.querySelector('.kb-hist__row .btn');
  openDayBtn?.dispatchEvent(new w.MouseEvent('click', { bubbles: true }));
  await sleep(900);
  check(/Изменения правил/.test(kbSlot?.textContent ?? ''), 'клик по дню открывает обновления этого дня');
  d.querySelector('#kb-close').dispatchEvent(new w.MouseEvent('click', { bubbles: true }));
  await sleep(250);
  check(d.querySelector('#pane-kb').hidden === true && !d.querySelector('#expander').classList.contains('is-open'), '«закрыть» сворачивает область базы знаний');
  d.querySelector('#settings-btn').dispatchEvent(new w.MouseEvent('click', { bubbles: true }));
  await sleep(300);

  // --- раздел «Клавиши»: кейкапы (референс) ---
  const navBtn = (label) => [...d.querySelectorAll('.settings__nav-item')].find((x) => x.textContent.trim() === label);
  navBtn('Клавиши')?.dispatchEvent(new w.MouseEvent('click', { bubbles: true }));
  await sleep(300);
  const kbdCount = d.querySelectorAll('.settings__pages .kbd').length;
  check(kbdCount >= 6, 'раздел «Клавиши» показывает кейкапы', String(kbdCount));
  const editableRows = d.querySelectorAll('.settings__pages .kbd-row.is-editable').length;
  check(editableRows >= 4, 'меняются глобальная клавиша и три локальных сочетания', String(editableRows));

  // --- раздел «Частые вопросы»: аккордеон (референс) ---
  navBtn('Частые вопросы')?.dispatchEvent(new w.MouseEvent('click', { bubbles: true }));
  await sleep(300);
  const faqItems = d.querySelectorAll('.settings__pages .faq-item');
  check(faqItems.length >= 8, 'аккордеон «Частые вопросы» с группами', String(faqItems.length));
  const firstFaq = faqItems[0];
  firstFaq?.querySelector('.faq-item__head')?.dispatchEvent(new w.MouseEvent('click', { bubbles: true }));
  await sleep(150);
  check(Boolean(firstFaq?.classList.contains('is-open')), 'аккордеон раскрывается по клику');
  check(Boolean(firstFaq?.querySelector('.crumbs .crumb')), 'в ответе — цепочка шагов-«хлебных крошек» (референс)');

  // --- история ответов: отдельное окно (как источники), не вкладка настроек ---
  d.querySelector('#settings-btn').dispatchEvent(new w.MouseEvent('click', { bubbles: true }));
  await sleep(250);
  d.querySelector('#history-btn').dispatchEvent(new w.MouseEvent('click', { bubbles: true }));
  await sleep(900);
  const histSlot = d.querySelector('#demo-history-slot');
  check(/История ответов/.test(histSlot?.textContent ?? ''), 'кнопка истории открыла окно истории (как источники)', (histSlot?.textContent ?? '').slice(0, 40));
  const histItems = histSlot.querySelectorAll('.hist-item');
  check(histItems.length >= 2, 'список истории вопросов', String(histItems.length));
  histItems[0]?.dispatchEvent(new w.MouseEvent('click', { bubbles: true }));
  await sleep(800);
  check(d.querySelector('#pane-answer').hidden === false, 'клик по истории открывает старый ответ');
  check(/Запрещено|Разрешено|Зависит|Нет данных/.test(d.querySelector('#answer-verdict')?.textContent ?? ''), 'у старого ответа есть вердикт');

  // --- режим стримера (тумблер переехал в «Основное», п.5/п.6): ник
  // подменяется случайным, аватар — заглушка (без blur), ник каждый раз новый ---
  d.querySelector('#answer-close').dispatchEvent(new w.MouseEvent('click', { bubbles: true }));
  await sleep(200);
  d.querySelector('#settings-btn').dispatchEvent(new w.MouseEvent('click', { bubbles: true }));
  await sleep(300);
  navBtn('Основное')?.dispatchEvent(new w.MouseEvent('click', { bubbles: true }));
  await sleep(300);
  const findStreamerRow = () => [...d.querySelectorAll('.settings__pages .opt-row')].find((r) => /Режим стримера/.test(r.textContent));
  findStreamerRow()?.querySelector('input[type="checkbox"]')?.click();   // click: jsdom переключает checked и шлёт change
  await sleep(600);
  check(d.documentElement.dataset.streamer === 'true', 'стример-режим включён: data-streamer=true');
  const nick1 = d.querySelector('#user-name')?.textContent ?? '';
  check(nick1 !== 'Alexander' && nick1.length > 1, 'стример-режим: ник в пилюле заменён случайным', nick1);
  check(/[A-Za-z]+_\d{3}/.test(nick1), 'случайный ник формата Word_123', nick1);
  check(/Ник в стриме/.test(d.querySelector('.settings__pages')?.textContent ?? ''), 'в «Основном» показан случайный ник стрима');
  // П.2: заглушка-силуэт убрана — аватар размывается фильтром
  check(Boolean(d.querySelector('#user-ava .avatar--blurred')), 'в стрим-режиме аватар размыт (.avatar--blurred, п.2)');
  check(!d.querySelector('#user-ava .avatar--streamer'), 'заглушка-силуэт больше не рисуется (п.2)');
  check(!/@Alexander/.test(d.querySelector('#user-btn')?.textContent ?? ''), 'настоящий ник не светится в стрим-режиме');
  // Выключение → настоящий ник и аватар возвращаются
  findStreamerRow()?.querySelector('input[type="checkbox"]')?.click();
  await sleep(500);
  check(d.documentElement.dataset.streamer !== 'true', 'стример-режим выключается обратно');
  check((d.querySelector('#user-name')?.textContent ?? '') === 'Alexander', 'после выключения возвращён настоящий ник');
  // Повторное включение → ник ДРУГОЙ (перегенерируется, п.5)
  findStreamerRow()?.querySelector('input[type="checkbox"]')?.click();
  await sleep(600);
  const nick2 = d.querySelector('#user-name')?.textContent ?? '';
  check(nick2 !== nick1 && /[A-Za-z]+_\d{3}/.test(nick2), 'при повторном включении ник перегенерирован (п.5)', `${nick1} → ${nick2}`);
  findStreamerRow()?.querySelector('input[type="checkbox"]')?.click();
  await sleep(400);
  // Выбор устройства микрофона (п.13): в jsdom нет mediaDevices — «По умолчанию»
  const micRow = [...d.querySelectorAll('.settings__pages .opt-row')].find((r) => /Микрофон/.test(r.textContent));
  check(Boolean(micRow?.querySelector('select.sel')), 'в «Основном» есть селект устройства микрофона (п.13)');
  check(/По умолчанию|Микрофон/.test(micRow?.querySelector('select.sel')?.textContent ?? ''), 'в селекте микрофона есть вариант «По умолчанию»');

  // микрофон в jsdom скрыт (нет getUserMedia) — в приложении работает через backend
  check(d.querySelector('#mic-btn').hidden === true, 'без getUserMedia кнопка микрофона скрыта');

  // настройки всё ещё открыты — финальная проверка ⚙
  check(d.querySelector('#pane-settings').hidden === false, 'настройки снова открыты перед финальным сворачиванием');

  // сворачивание настроек повторным нажатием ⚙
  d.querySelector('#settings-btn').dispatchEvent(new w.MouseEvent('click', { bubbles: true }));
  await sleep(250);
  check(!d.querySelector('#expander').classList.contains('is-open'), 'повторное нажатие ⚙ сворачивает настройки ');

  check(errors.length === 0, 'нет JS-ошибок после всех сценариев', errors.slice(0, 3).join(' | '));
  w.close();
}

async function testSources() {
  section('Окно источников (renderer/demo/sources.html)');
  const { window: w, errors } = await loadPage('sources.html');
  const d = w.document;
  await sleep(700);
  check(errors.length === 0, 'нет JS-ошибок', errors.slice(0, 2).join(' | '));
  check(/Найденные источники/.test(d.body.textContent), 'заголовок «НАЙДЕННЫЕ ИСТОЧНИКИ»');
  const cards = d.querySelectorAll('.src-card');
  check(cards.length > 0, 'карточки источников отрисованы', String(cards.length));
  if (!cards.length) { w.close(); return; }
  const c = cards[0];
  check(Boolean(c.querySelector('.src-card__doc')), 'название документа');
  check(/Дата редакции/.test(c.textContent), 'дата редакции');
  check(/Версия:/.test(c.textContent), 'версия документа');
  check(/Открыть источник/.test(c.textContent), '«Открыть источник ↗»');
  check(Boolean(c.querySelector('.src-card__text mark')), 'найденные термины подсвечены Accent');
  w.close();
}

async function testSplash() {
  section('Splash screen (renderer/demo/splash.html)');
  const { window: w, errors } = await loadPage('splash.html');
  const d = w.document;
  await sleep(400);
  const labels = [...d.querySelectorAll('.splash__steps li .label')].map((x) => x.textContent);
  check(errors.length === 0, 'нет JS-ошибок', errors.slice(0, 2).join(' | '));
  check(labels.length === 9, '9 этапов инициализации ', labels.join(' → '));
  check(labels[0] === 'Конфигурация' && labels[8] === 'Основное окно', 'порядок этапов соответствует ');
  await sleep(5200);
  const done = [...d.querySelectorAll('.splash__steps li')].filter((li) => li.dataset.state === 'done').length;
  check(done === 9, 'все этапы доходят до ✓', `${done}/9`);
  check(d.querySelector('.splash').classList.contains('is-done'), 'splash помечен завершённым → main process его закрывает');
  w.close();
}

async function testAdmin() {
  section('Административная панель (renderer/demo/admin.html)');
  const { window: w, errors } = await loadPage('admin.html');
  const d = w.document;
  await sleep(900);
  check(errors.length === 0, 'нет JS-ошибок', errors.slice(0, 3).join(' | '));

  const nav = [...d.querySelectorAll('.nav-item')].map((x) => x.textContent.trim());
  check(nav.includes('Обзор') && nav.includes('Пользователи') && nav.includes('Ошибки AI') && nav.includes('Audit Log') && nav.includes('System'),
    'разделы админки из ', nav.join(' · '));
  check(/Пользователей|Одобрение|Новых ошибок/.test(d.querySelector('#admin-content')?.textContent ?? ''), 'Обзор со сводкой');

  // Пользователи 
  // Навигация с ожиданием маркера раздела вместо фиксированной паузы:
  // jsdom-рендер асинхронный, фикс-слипы давали флейки под нагрузкой.
  const go = async (label, matcher, timeoutMs = 5000) => {
    // Ретрай клика: навигация может перерисоваться предыдущим reload,
    // и клик по отцепленному узлу терялся (флейки под нагрузкой).
    for (let attempt = 0; attempt < 3; attempt++) {
      const b = [...d.querySelectorAll('.nav-item')].find((x) => x.textContent.trim() === label);
      b?.dispatchEvent(new w.MouseEvent('click', { bubbles: true }));
      const ok = await waitFor(() => matcher(d.querySelector('#admin-content')?.textContent ?? ''), timeoutMs);
      if (ok) break;
      if (attempt === 2) console.log(`  (warn) раздел «${label}» не отрисовался за 3 попытки`);
    }
    return d.querySelector('#admin-content')?.textContent ?? '';
  };
  const modalText = () => d.querySelector('#modal')?.textContent ?? '';

  let t = await go('Пользователи', () => Boolean(d.querySelector('#admin-content tbody tr')));
  check(/Alexander|Stefan/.test(t), 'список пользователей с никнеймами');
  check(/Последний вход/.test(t), 'колонка «Последний вход»');

  const row = d.querySelector('#admin-content tbody tr');
  row?.dispatchEvent(new w.MouseEvent('click', { bubbles: true }));
  await waitFor(() => d.querySelector('#modal-backdrop')?.hidden === false && /Telegram|Discord|local/.test(modalText()));
  const cardText = modalText();
  check(d.querySelector('#modal-backdrop').hidden === false, 'карточка пользователя открылась ');
  check(/Discord|local/.test(cardText) && /Telegram/.test(cardText), 'в карточке показаны identity');
  check(/Эффективные permissions/.test(cardText), 'в карточке показаны permissions');
  check(/История действий/.test(cardText), 'в карточке есть история действий');
  check(/Лимит запросов к ИИ/.test(cardText), 'в карточке — блок «Лимит запросов к ИИ» (п.7)');
  check(/Осталось сегодня: \d+ из \d+/.test(cardText), 'в блоке лимита виден остаток на сегодня');
  // П.1 раунда 30: блокировка и удаление из карточки работают без window.prompt
  {
    const rows = [...d.querySelectorAll('#admin-content tbody tr')];
    const target = rows.find((r) => /Stefan/.test(r.textContent)) ?? rows[1];
    const openBtn = [...(target?.querySelectorAll('button') ?? [])].find((b) => b.textContent.trim() === 'Открыть');
    (openBtn ?? target)?.dispatchEvent(new w.MouseEvent('click', { bubbles: true }));
    await sleep(900);
    const blockBtn = [...d.querySelectorAll('#modal button')].find((b) => b.textContent.trim() === 'Заблокировать');
    check(Boolean(blockBtn), 'в карточке есть кнопка «Заблокировать»');
    blockBtn?.dispatchEvent(new w.MouseEvent('click', { bubbles: true }));
    await sleep(400);
    check(Boolean(d.querySelector('#modal input.field')), 'причина блокировки спрашивается модалкой, а не window.prompt');
    [...d.querySelectorAll('#modal button')].find((b) => b.textContent.trim() === 'Заблокировать')
      ?.dispatchEvent(new w.MouseEvent('click', { bubbles: true }));
    // ждём НЕ пустой контейнер со статусом: иначе следующий клик гонится с reload
    await waitFor(() => {
      const c = d.querySelector('#admin-content');
      return Boolean(c?.querySelector('tbody tr')) && /blocked/.test(c?.textContent ?? '');
    });
    check(/blocked/.test(d.querySelector('#admin-content')?.textContent ?? ''), 'после блокировки статус в списке — blocked');

    const rows2 = [...d.querySelectorAll('#admin-content tbody tr')];
    const target2 = rows2.find((r) => /Stefan/.test(r.textContent));
    const openBtn2 = [...(target2?.querySelectorAll('button') ?? [])].find((b) => b.textContent.trim() === 'Открыть');
    (openBtn2 ?? target2)?.dispatchEvent(new w.MouseEvent('click', { bubbles: true }));
    await waitFor(() => [...d.querySelectorAll('#modal button')].some((b) => b.textContent.trim() === 'Удалить аккаунт'));
    const delBtn = [...d.querySelectorAll('#modal button')].find((b) => b.textContent.trim() === 'Удалить аккаунт');
    check(Boolean(delBtn), 'в карточке есть кнопка «Удалить аккаунт»');
    delBtn?.dispatchEvent(new w.MouseEvent('click', { bubbles: true }));
    await waitFor(() => [...d.querySelectorAll('#modal button')].some((b) => b.textContent.trim() === 'Удалить навсегда'));
    const delConf = [...d.querySelectorAll('#modal button')].find((b) => b.textContent.trim() === 'Удалить навсегда');
    check(Boolean(delConf), 'удаление спрашивает подтверждение модалкой');
    delConf?.dispatchEvent(new w.MouseEvent('click', { bubbles: true }));
    await waitFor(() => {
      const c = d.querySelector('#admin-content');
      return Boolean(c?.querySelector('tbody tr')) && !/Stefan/.test(c?.textContent ?? '');
    });
    check(!/Stefan/.test(d.querySelector('#admin-content')?.textContent ?? ''), 'удалённый пользователь исчез из списка');
  }
  d.querySelector('#modal-backdrop').hidden = true;

  // Ошибки AI 
  // матчер ждёт СТРОКИ таблицы, а не заголовок раздела: иначе клик по строке
  // уходил в null и карточка отчёта не открывалась
  t = await go('Ошибки AI', () => Boolean(d.querySelector('#admin-content tbody tr')));
  check(/ОШИБКА AI|Ошибки AI/.test(t) || /Новые/.test(t), 'очередь ошибок AI');
  const reportRow = d.querySelector('#admin-content tbody tr');
  reportRow?.dispatchEvent(new w.MouseEvent('click', { bubbles: true }));
  await waitFor(() => /ОШИБКА AI #/.test(modalText()));
  const rep = modalText();
  check(/ОШИБКА AI #/.test(rep), 'карточка «ОШИБКА AI #ID» ');
  check(/Пользователь/.test(rep) && /Вопрос/.test(rep) && /Ответ AI/.test(rep), 'в карточке: пользователь, вопрос, ответ AI');
  check(/Найденные источники/.test(rep), 'в карточке: найденные источники');
  check(/Причина/.test(rep), 'в карточке: причина');
  const buttons = [...d.querySelectorAll('#modal button')].map((b) => b.textContent.trim());
  check(buttons.some((b) => /В работу/.test(b)) && buttons.some((b) => /Решено/.test(b)), 'кнопки [В РАБОТУ] и [РЕШЕНО]');
  check(buttons.some((b) => /Открыть источник/.test(b)), 'кнопка [ОТКРЫТЬ ИСТОЧНИК]');
  check(/Устарела база|Ошибка поиска|Ошибка AI|Техническая ошибка/.test(rep), 'классификация источника проблемы ');
  d.querySelector('#modal-backdrop').hidden = true;

  // Knowledge Base → Изменения 
  t = await go('Изменения', (c) => /Изменения базы знаний/.test(c));
  check(/Изменения базы знаний/.test(t), 'раздел «Изменения»');
  const firstDay = d.querySelector('#admin-content .chip');
  firstDay?.dispatchEvent(new w.MouseEvent('click', { bubbles: true }));
  await waitFor(() => Boolean(d.querySelector('#admin-content .split__list-item')));
  check(Boolean(d.querySelector('#admin-content .split__list-item')), 'список изменившихся документов слева');
  const item = d.querySelector('#admin-content .split__list-item');
  item?.dispatchEvent(new w.MouseEvent('click', { bubbles: true }));
  await waitFor(() => Boolean(d.querySelector('#admin-content .diff-view')) || /НОВОЕ/.test(d.querySelector('#admin-content')?.textContent ?? ''));
  check(Boolean(d.querySelector('#admin-content .diff-view')) || /НОВОЕ/.test(d.querySelector('#admin-content')?.textContent ?? ''), 'справа — «Было / Стало» или новое правило');

  t = await go('Документы', (c) => /Конституция|Penal Code|Правила сервера/.test(c));
  check(/Конституция|Penal Code|Правила сервера/.test(t), 'раздел «Документы» со списком базы');

  t = await go('Синхронизация', (c) => /Журнал синхронизаций/.test(c));
  check(/Журнал синхронизаций/.test(t), 'раздел «Синхронизация» с журналом');
  check(/robots\.txt|LEGAL\.md/.test(t), 'предупреждение про robots.txt и docs/LEGAL.md');

  t = await go('Audit Log', (c) => /user\.role\.change|user\.block|login/.test(c));
  check(/user\.role\.change|user\.block|login/.test(t), 'Audit Log содержит критические действия ');

  t = await go('Роли', (c) => /Игрок/.test(c) && /Разработчик/.test(c));
  check(/Игрок/.test(t) && /Разработчик/.test(t), 'все 8 ролей ');
  check(/системная/.test(t), 'Developer помечена как системная и не выдаётся из панели ');

  t = await go('Permissions', (c) => /ai\.use/.test(c) && /system\.manage/.test(c));
  check(/ai\.use/.test(t) && /system\.manage/.test(t), 'матрица permissions ');

  t = await go('Блокировки', (c) => /Dmitry|Заблокированных/.test(c));
  check(/Dmitry|Заблокированных/.test(t), 'раздел «Блокировки»');

  check(errors.length === 0, 'нет JS-ошибок после обхода всех разделов', errors.slice(0, 3).join(' | '));
  w.close();
}

async function main() {
  for (const f of ['main.html', 'sources.html', 'splash.html', 'admin.html']) {
    if (!existsSync(resolve(DEMO, f))) {
      console.error(`Демо не собрано: renderer/demo/${f}. Выполните node scripts/build-demo.mjs`);
      process.exit(1);
    }
  }
  await testSplash();
  await testMain();
  await testSources();
  await testAdmin();
  console.log(`\n\x1b[1mИТОГ: ${pass} проверок пройдено, ${fail} провалено\x1b[0m`);
  process.exitCode = fail ? 1 : 0;
}

main().catch((e) => { console.error(e); process.exit(1); });
