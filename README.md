# EPIC AI

Компактный desktop-overlay интеллектуальный помощник для игрового проекта **EpicRP / Epic GTA**.
Отвечает на вопросы игроков **строго по официальной базе** форума `forum.epic-gta.com`:
правила проекта, правила сервера и законодательная база.

> **Главный принцип (ТЗ §68).** Epic AI — не универсальный ChatGPT, а официальный помощник EpicRP.
> Цепочка доверия: официальный форум → версия документа → поиск → AI → ответ → конкретные источники.
> Если подтвердить ответ официальным источником нельзя, система прямо сообщает об отсутствии подтверждения.

Реализовано по Техническому заданию v1.0. Соответствие пунктов ТЗ реализации — в [`docs/COMPLIANCE.md`](docs/COMPLIANCE.md).

---

## ⚠️ Прочитайте перед включением crawler'а

`robots.txt` форума `forum.epic-gta.com` **запрещает доступ AI-краулерам**
(GPTBot, ClaudeBot, PerplexityBot, CCBot и т. д. — `Disallow: /`).
Поэтому crawler **по умолчанию выключен** (`CRAWLER_ENABLED=false`) и не обходит это ограничение.

Порядок действий, правовые варианты и альтернативы (официальный XenForo REST API, ручной импорт) —
в **[`docs/LEGAL.md`](docs/LEGAL.md)**. Это нужно решить до наполнения базы реальными документами.

---

## Быстрый старт

> **Пошаговая инструкция для Windows — в [`QUICKSTART.md`](QUICKSTART.md).**
> Там же: настройка Discord OAuth, локальный вход без OAuth, наполнение базы,
> разбор типовых ошибок и короткая шпаргалка команд.

Требуется **Node.js 20.11+**. Всё остальное ставится из npm.

```bash
# 1. Backend
cd backend
npm install                 # на Windows/macOS сразу поставит better-sqlite3 (prebuilt)
cp .env.example .env        # в Windows: copy .env.example .env
# затем заполните .env (см. ниже)

# 2. База данных: миграции + роли/permissions
npm run db:migrate
npm run db:seed

# 3. Первый Developer (ТЗ §45) — создаётся только через защищённый bootstrap
npm run bootstrap:developer -- --local developer
#    …или через реальный identity:
# npm run bootstrap:developer -- --discord 482913745629184011 --name "ВашНик"

# 4. Запуск backend
npm run dev                 # http://127.0.0.1:8787

# 5. Electron-клиент (в отдельном терминале)
cd ../electron
npm install
npm run dev
```

Или одной командой из корня репозитория (поднимет backend, дождётся health и запустит Electron):

```bash
node scripts/dev.mjs
```

### Минимальный `.env` для локальной разработки

```ini
HOST=127.0.0.1
PORT=8787
DB_DRIVER=sqlite
SESSION_SECRET=<сгенерируйте: node -e "console.log(require('crypto').randomBytes(48).toString('hex'))">

# AI: YandexGPT (Yandex Cloud) — доступен из РФ, стартовый грант облака
AI_PROVIDER=openai_compatible
AI_API_KEY=<API-ключ сервисного аккаунта>
AI_BASE_URL=https://ai.api.cloud.yandex.net/v1
YANDEX_FOLDER_ID=b1g...
AI_MODEL=yandexgpt-lite
AI_MODEL_FALLBACK=yandexgpt-pro

# Авторизация (можно включить позже)
DISCORD_ENABLED=false
TELEGRAM_ENABLED=false

# Crawler — включайте только после согласования с администрацией форума
CRAWLER_ENABLED=false
```

Без `AI_PROVIDER`/`AI_API_KEY` работает `AI_PROVIDER=mock`: поиск и источники настоящие,
а формулировку ответа генерирует заглушка — удобно для разработки интерфейса.

---

## Что можно посмотреть прямо сейчас (без Electron и без forum.epic-gta.com)

Соберите интерактивные демо-страницы — это **тот же код renderer'а**, что в приложении,
но со встроенным mock-backend'ом:

```bash
node scripts/build-demo.mjs
# откройте renderer/demo/index.html в браузере
```

| Страница | Что показывает |
|---|---|
| `demo/main.html` | Основная панель, режимы ПРАВИЛА/ЗАКОНЫ, запрос → ответ → 👍/👎 → форма ошибки, настройки внутри панели, раздел «Правила», «Обновления за сегодня» с красно-зелёным diff; рядом рисуются отдельные «окна» подтверждения, источников, истории и профиля |
| `demo/sources.html` | Отдельное окно найденных источников |
| `demo/confirm.html` | Отдельное окно подтверждения «Спросить ИИ?» с остатком дневного лимита (Enter — спросить, Esc — отмена) |
| `demo/admin.html` | Административная панель: Обзор, Пользователи, Роли, Permissions, Блокировки, Ошибки AI, Knowledge Base, Audit Log, System. В правом верхнем углу — переключатель роли, чтобы увидеть, как видимость разделов зависит от permissions |
| `demo/splash.html` | Splash screen 360×220 и его 9 этапов |

Демо-документы **вымышленные и учебные** — это не официальные правила EpicRP.

---

## Тесты

```bash
node scripts/test-all.mjs
```

Прогоняет **8 шагов** — ни один не требует Electron и ни один не обращается к форуму.
Актуальные счётчики печатаются в строках `ИТОГ:` каждого набора
(на момент последнего прогона — **431 проверка, 0 провалов**):

| Шаг | Набор | Что проверяет | Проверок |
|---|---|---|---|
| 1 | **TypeScript** | `tsc --noEmit` для `backend/` — типы RBAC, версионирования, RAG | — |
| 2 | **Backend: smoke API** | Чистая БД → миграции → сиды → bootstrap Developer'а → подъём сервера → сквозной тест: авторизация, RBAC и иерархия ролей, индивидуальные разрешения и запреты, блокировка с инвалидацией сессий, RAG-поиск и разделение баз RULE/LAW, честный отказ при отсутствии данных, дневная квота запросов к ИИ, 👍/👎, AI Reports и их обработка, версии документов, word-level diff, Audit Log (включая запрет на изменение), настройки, видимость разделов админки, CSRF-защита, CRUD ролей (создание/цвет/permissions/удаление), вход через Telegram: виджет по подписи HMAC-SHA256 и вход из ВНЕШНЕГО браузера: тикеты desktop, карточка бота с кнопками, QR, Discord через приложение, админ-раздел Telegram-бота, удаление аккаунтов, связывание identity по IP, вход только Telegram, команды бота | 124 |
| 2 | **Backend: unit (логгер)** | `tsx --test`: circular-JSON, сворачивание req/res Fastify, уровни, `silent`, child-логгеры | 9 |
| 3 | **Сборка демо** | `build-demo.mjs` генерирует страницы в `renderer/demo/` | — |
| 4 | **UI в jsdom** | Сценарий «запрос → ответ → источники → дизлайк → отчёт», поведение панели без запроса (§9), настройки внутри панели (§19), раздел «Правила» (§21), экран обновлений с diff (§23–§25), splash (§32), все разделы админки (§47), отсутствие живого фона `#frost` (§5), пилюля без меню открывает профиль в настройках (без пункта в навигации), blur-аватар в стрим-режиме, высота окна ответа не растёт | 171 |
| 5 | **Валидность JSON** | Все `.json` проекта парсятся (комментарии в JSON недопустимы) | 6 файлов |
| 6 | **Electron: конфиг** | Модуль `electron` подменяется заглушкой, проверяется `main/config.js`: валидность `client-config.default.json`, автосоздание конфига, команда запуска backend для dev и production, приоритет пользовательского конфига (сценарий VPS), устойчивость к битому JSON, настройки по умолчанию (F10, 900×56, always-on-top, прозрачность 0.82), синтаксис всех main-модулей и preload | 54 |
| 7 | **Electron: геометрия окон** | Панель 900×56 и её рост вниз, потолок по рабочей области, окна источников (справа) и истории (слева) с зазором 12 px и переносом у края экрана, запоминающиеся позиции, отдельное окно подтверждения, show/hide overlay, сохранение положения панели, прозрачные окна без vulkan/disableHardwareAcceleration | 43 |

Отдельно:

```bash
node scripts/run-smoke.mjs        # только backend
node scripts/test-demo-dom.mjs    # только UI (нужен jsdom)
cd backend && npm run typecheck   # только типы
```

---

## Структура проекта

```
epic-ai/
├── electron/          Desktop-клиент (main + preload), без UI-фреймворка
│   ├── assets/        client-config.default.json (настройки клиента по умолчанию)
│   ├── main/          main.js, windows.js, tray.js, hotkey.js, ipc.js, backend.js, config.js
│   └── preload/       index.js — contextBridge, единственный мост renderer ↔ main
├── renderer/          HTML/CSS/JS интерфейса (vanilla ESM)
│   ├── main.html      компактная горизонтальная панель + ответ + настройки (вкладка «Профиль») + pane-kb
│   ├── sources.html   отдельное окно источников (справа от панели)
│   ├── history.html   отдельное окно истории ответов (слева от панели)
│   ├── confirm.html   отдельное окно подтверждения «Спросить ИИ?»
│   ├── admin.html     административная панель
│   ├── splash.html    splash screen
│   ├── login.html     окно входа по референсу: кнопки открывают ВНЕШНИЙ браузер, QR и код для телефона, сессия — одноразовым тикетом
│   ├── blocked.html   окно блокировки аккаунта
│   ├── styles/        tokens.css (цвета ТЗ §4), base.css, main.css, sources.css, profile.css, kb.css, admin.css, splash.css
│   ├── scripts/       api.js, util.js, main.js, settings.js, sources.js, history.js, confirm.js, login.js, profileview.js, kbview.js, admin.js, admin-views.js, splash.js
│   └── demo/          собранные демо-страницы (генерируется, в git не хранится)
├── backend/           Fastify + TypeScript
│   ├── .env.example   шаблон окружения (скопировать в .env)
│   ├── src/
│   │   ├── ai/        providers (groq/openai_compatible/ollama/mock), rag/ (pipeline, retrieval, prompts), quota.ts, serializer.ts, routes.ts
│   │   ├── audit/     append-only Audit Log (ТЗ §50)
│   │   ├── auth/      Telegram-вход (deep-link + бот), сессии, dev-вход
│   │   ├── bootstrap/ developer.ts (первый Developer, ТЗ §45), admin-cli.ts (управление пользователями, --doctor)
│   │   ├── config/    index.ts (единственное место, где живут секреты), lock.ts, logger.ts
│   │   ├── crawler/   XenForo-парсер, robots.txt, вежливый HTTP-клиент с кэшем
│   │   ├── db/        единый слой доступа: SQLite (better-sqlite3 / sql.js) и PostgreSQL, CLI миграций
│   │   ├── http/      server.ts, guards.ts (RBAC/CSRF), scheduler.ts, system.ts (health, bootstrap)
│   │   ├── knowledge/ версионирование, diff, chunks, BM25-поиск, ingest, синхронизация
│   │   ├── permissions/ каталог и вычисление эффективных прав (ТЗ §42–§44)
│   │   ├── reports/   feedback и AI Reports (ТЗ §15–§18)
│   │   ├── roles/     роли и иерархия (ТЗ §39, §46)
│   │   ├── settings/  пользовательские и системные настройки
│   │   ├── users/     единый аккаунт, identity, профиль, блокировки
│   │   └── index.ts   точка входа
│   ├── test/          logger.test.ts (unit-тесты через node --test)
│   └── data/          БД, lock-файл, кэш краулера (создаётся автоматически, в git не хранится)
├── database/
│   ├── migrations/    001_init, 002_search_index, 003_document_changes, 004_ai_quota
│   └── seeds/         8 ролей, 25 permissions, матрица роль→permissions
├── shared/tokens.js   единый источник цветов, ролей, статусов, категорий
├── scripts/           dev, build-demo, demo-bridge, fixtures, test-all, run-smoke, smoke,
│                      test-demo-dom, test-electron-config, test-electron-windows, make-zip
└── docs/              ARCHITECTURE, DATABASE, API, LEGAL, DEVELOPMENT, COMPLIANCE
```

---

## Стек и почему он такой

| Слой | Решение | Обоснование |
|---|---|---|
| Desktop | Electron 33 + vanilla HTML/CSS/JS | Прямо по ТЗ §2: без тяжёлого UI-фреймворка на первом этапе |
| Backend | Node.js 20 + TypeScript + Fastify | Один язык на клиент и сервер; типизация критична для RBAC и версионирования |
| БД | SQLite локально → PostgreSQL на VPS | ТЗ §63/§64. Один и тот же код на обоих драйверах: перенос = смена `DB_DRIVER` |
| Поиск | Собственный BM25 + русский стеммер | Работает идентично на SQLite и PostgreSQL, понимает «зелёных»→«зеленых», жёстко разделяет RULE/LAW |
| AI | GigaChat (Сбер) — собственный провайдер `gigachat` | РФ-юрисдикция, бесплатные пакеты физлицам, лучший русский; личный токен или OAuth ngw; российские корневые УЦ через `AI_CA_CERT`; YandexGPT и Ollama — альтернативы; цепочка `AI_MODEL_FALLBACK` |

Подробности — в [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md).

---

## Перенос на VPS (ТЗ §64)

Клиент **не переписывается**: он знает только адрес backend.

1. На VPS: `DB_DRIVER=postgres`, заполнить `DB_*`, `PUBLIC_URL=https://api.…`.
2. `npm run build && npm start` за reverse proxy (nginx/Caddy) с TLS.
3. В клиенте `%APPDATA%/Epic AI/config.json` → `"backendUrl": "https://api.…", "embeddedBackend": false`.

---

## Документация

- [`QUICKSTART.md`](QUICKSTART.md) — **как запустить backend и приложение** (Windows, по шагам)
- [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) — архитектура, слои, поток данных, решения и их обоснование
- [`docs/DATABASE.md`](docs/DATABASE.md) — схема БД: 16 таблиц, связи, назначение каждой
- [`docs/API.md`](docs/API.md) — все HTTP-эндпоинты с правами доступа
- [`docs/LEGAL.md`](docs/LEGAL.md) — **robots.txt, правовые риски и легальные альтернативы crawler'у**
- [`docs/DEVELOPMENT.md`](docs/DEVELOPMENT.md) — как разрабатывать, отлаживать, собирать
- [`docs/COMPLIANCE.md`](docs/COMPLIANCE.md) — соответствие каждому пункту ТЗ v1.0 и критериям готовности §73
