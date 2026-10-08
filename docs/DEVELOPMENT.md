# Разработка EPIC AI

## Окружение

- **Node.js 20.11+** (проверено на 20.20).
- **Electron 33** — ставится отдельно в `electron/`.
- База данных: по умолчанию **SQLite**, ничего ставить не нужно.
  PostgreSQL нужен только для production-стенда.
- **`better-sqlite3`** объявлен в `optionalDependencies`: на Windows и macOS
  ставится готовый prebuilt-бинарник, а в окружении без `make`/`g++` npm
  не уронит всю установку. Если драйвер недоступен, слой БД **автоматически**
  переключается на `sql.js` (WASM, ноль нативных зависимостей) и печатает об этом
  предупреждение — всё работает, но медленнее и с ограничением: база держится
  в памяти процесса, поэтому нельзя одновременно держать запущенными сервер и
  CLI-команды (`db:migrate`, `sync`, `bootstrap`).

  Проверить, какой драйвер используется: `curl http://127.0.0.1:8787/api/health`
  → `"db":{"driver":"sqlite","engine":"better-sqlite3"|"sql.js"}`.
  Принудительный выбор: `DB_SQLITE_ENGINE=better-sqlite3 | sql.js | auto`.

## Команды

Из корня репозитория:

```bash
npm run install:all      # зависимости backend и electron
node scripts/dev.mjs     # backend + Electron одним процессом
node scripts/test-all.mjs  # все тесты: backend (69) + UI (84)
node scripts/build-demo.mjs  # собрать интерактивные демо-страницы
```

Из `backend/`:

```bash
npm run dev              # tsx watch src/index.ts
npm run typecheck        # tsc --noEmit
npm run build            # tsc → dist/
npm run db:migrate       # применить миграции
npm run db:seed          # роли, permissions, матрица, серверные настройки
npm run db:reset         # удалить БД и создать заново (миграции + сиды)
npm run db:status        # какие миграции применены / ожидают
npm run bootstrap:developer -- --local developer     # локальный вход без OAuth
npm run bootstrap:developer -- --discord 482913745629184011 --name "ВашНик"
npm run crawl            # разведка структуры форума (БЕЗ записи в БД)
npm run crawl -- --threads        # + списки тем
npm run crawl -- --thread 13      # содержимое конкретной темы
npm run crawl -- --rss            # проверка RSS-лент разделов
npm run crawl -- --force          # разрешить разведку при CRAWLER_ENABLED=false
npm run sync               # синхронизация Knowledge Base
npm run sync -- --offline  # переиндексация из кэша, без сети
npm run kb:reindex         # полная пересборка поискового индекса

npm run users              # список пользователей (id, статус, роль, сессии)
npm run doctor             # диагностика: Developer, блокировки, база, AI, OAuth
npm run users -- --unblock 1        # разблокировать
npm run users -- --unblock-all      # разблокировать всех
npm run users -- --developer 1      # выдать Developer в обход ограничения интерфейса
npm run users -- --role 1 admin     # назначить роль
npm run users -- --revoke-all       # завершить все сессии
npm run users -- --delete 3         # удалить пользователя
```

`users`/`doctor` — это `backend/src/bootstrap/admin-cli.ts`. Он работает напрямую
с БД, минуя HTTP и RBAC, поэтому выручает, когда в приложение войти невозможно.
Каждое действие пишется в Audit Log с пометкой `via: cli`.
На драйвере `sql.js` перед запуском CLI нужно остановить сервер.

## Локальная разработка без Discord и Telegram

OAuth-приложения требуют публичного redirect URI, поэтому на этапе разработки
удобнее локальный вход:

```bash
cd backend
# в .env: SESSION_SECRET=<любая длинная строка>, NODE_ENV=development
npm run bootstrap:developer -- --local developer
npm run dev
```

Затем в любом HTTP-клиенте:

```bash
curl -c jar.txt -X POST http://127.0.0.1:8787/api/auth/dev-login \
  -H 'Content-Type: application/json' -H 'X-Epic-Client: cli' \
  -d '{"token":"<SESSION_SECRET>","username":"developer"}'
```

Electron использует тот же механизм: если сессии нет, откроется окно `/login`,
а в development на этой странице дополнительно доступен dev-вход.
`/api/auth/dev-login` возвращает `404` при `NODE_ENV=production` — в production
его не существует.

## Настройка Discord OAuth

1. <https://discord.com/developers/applications> → New Application.
2. OAuth2 → Add Redirect: `http://127.0.0.1:8787/auth/discord/callback`.
3. Scope: `identify` (этого достаточно: нужны id, username/display name, avatar — §35).
4. В `backend/.env`:

```ini
DISCORD_ENABLED=true
DISCORD_CLIENT_ID=…
DISCORD_CLIENT_SECRET=…
DISCORD_REDIRECT_URI=http://127.0.0.1:8787/auth/discord/callback
```

## Настройка Telegram Login Widget

1. Через [@BotFather](https://t.me/BotFather): `/newbot`, затем `/setdomain` —
   укажите домен, с которого будет отдаваться виджет (для локальной разработки
   нужен публичный HTTPS-домен, например через туннель; Telegram не принимает `127.0.0.1`).
2. В `backend/.env`:

```ini
TELEGRAM_ENABLED=true
TELEGRAM_BOT_USERNAME=your_bot
TELEGRAM_BOT_TOKEN=123456:ABC-…
```

Подпись виджета проверяется на backend по официальному алгоритму
(`HMAC_SHA256(data_check_string, SHA256(bot_token))`) с контролем возраста `auth_date`.

## Настройка AI

Бесплатный вариант по умолчанию — **Groq** (<https://console.groq.com>, ключ `gsk_…`):

```ini
AI_PROVIDER=groq
AI_API_KEY=gsk_…
AI_MODEL=llama-3.3-70b-versatile
```

Альтернативы:

```ini
# любой OpenAI-совместимый endpoint (OpenRouter, vLLM, LM Studio)
AI_PROVIDER=openai_compatible
AI_BASE_URL=https://openrouter.ai/api/v1
AI_MODEL=openai/gpt-4o-mini
AI_API_KEY=sk-or-…

# полностью локально, без ключей и интернета
AI_PROVIDER=ollama
AI_MODEL=llama3.1:8b

# заглушка для разработки интерфейса
AI_PROVIDER=mock
```

Пока база знаний пуста, `AI_PROVIDER` не важен: при пустой выдаче модель не
вызывается вовсе и возвращается стандартная формулировка из ТЗ §14.

## Наполнение базы знаний

Три способа — см. [`LEGAL.md`](LEGAL.md) за правовыми деталями.

**1. Ручной импорт (легально, без crawler'а).** Работает уже сейчас:

```bash
curl -b jar.txt -X POST http://127.0.0.1:8787/api/kb/ingest \
  -H 'Content-Type: application/json' -H 'X-Epic-Client: cli' \
  -d '{
    "docType": "RULE",
    "title": "Правила сервера",
    "text": "1. Основные положения\n1.1. …",
    "url": "https://forum.epic-gta.com/threads/pravila-servera.13/",
    "threadId": 13, "nodeId": 38,
    "section": "Сервер / Правила сервера / Общие правила"
  }'
```

**2. Тестовые фикстуры** (вымышленные учебные документы) — для разработки и тестов:

```bash
node scripts/fixtures.mjs     # загрузит 9 документов + 2 обновления через боевой /api/kb/ingest
```

**3. Crawler** — только после согласования с администрацией форума:

```ini
CRAWLER_ENABLED=true
CRAWLER_USER_AGENT=EpicAI-KnowledgeBot/1.0 (+ваш контакт)
```

```bash
cd backend
npm run crawl -- --threads --force   # разведка: какие разделы и темы увидит система
npm run sync                         # боевой прогон
npm run sync -- --offline            # переиндексация из кэша без сети
```

Кэш страниц лежит в `backend/data/crawler-cache/` (метаданные + тела), поэтому
`--offline` и повторные прогоны не нагружают форум.

## Отладка

**Electron.** В `main.js` есть обработчик `epic:devtools` — можно повесить на
сочетание клавиш. Быстрый способ: запустить с `--inspect` и подключиться
DevTools к main process; для renderer'а — `webContents.openDevTools({mode:'detach'})`
в `createMainPanel()`.

**Backend.** `LOG_LEVEL=debug npm run dev`. Логи встроенного backend'а видны
в админке → System → «Логи встроенного backend» (IPC `epic:backend:logs`).

Логи печатает собственный логгер (`backend/src/config/logger.ts`), а не pino:
pino пишет UTF-8 байты в stdout напрямую, и в консоли Windows (OEM-кодировка
cp866/cp1251) русские сообщения превращаются в нечитаемую кашу. Логгер поверх
`console.log` транскодируется Node'ом в консольную кодировку, поэтому текст
остаётся читаемым и в PowerShell, и в cmd. Формат:

```
12:19:47.773 • Epic AI backend: http://127.0.0.1:8787 (db: sqlite, ai: groq)
12:19:47.773 ⚠ [epic-ai] CRAWLER_ENABLED=false — автоматическая синхронизация…
```

Для production-стенда с агрегатором логов, где нужен JSON, верните
`logger: { level: config.logLevel }` вместо `loggerInstance` в `http/server.ts`.

Если кириллица всё равно ломается (например, в старом cmd с cp866), переключите
кодировку консоли на UTF-8:

```powershell
chcp 65001
$OutputEncoding = [Console]::OutputEncoding = [Text.Encoding]::UTF8
```

**RAG без AI.** `GET /api/ai/search?mode=rules&q=…` возвращает ровно те фрагменты,
которые попали бы в промпт, — это самый быстрый способ понять, почему ответ
получился таким, а не иным.

**Почему документ не обновился.** Смотрите `sync_logs.meta.warnings` и
`GET /api/kb/sync/logs`. Быстрый путь синхронизации пропускает тему, если её
`lastPostAt` из списка не изменился, — это ожидаемое поведение.

**Diff выглядит странно.** Diff сохраняется в `document_versions.diff_from_prev`
и `document_changes.diff_json`, поэтому его можно посмотреть напрямую в БД,
не пересчитывая:

```sql
SELECT version, change_kind, changed_words FROM document_changes ORDER BY id DESC LIMIT 20;
```

## Известные ограничения

| Ограничение | Обход / план |
|---|---|
| `sql.js` держит БД в памяти процесса → два backend'а одновременно недопустимы | `config/lock.ts` не даёт второму экземпляру стартовать. На `better-sqlite3`/PostgreSQL ограничения нет |
| FTS5 недоступен в `sql.js` | Поиск собственный (BM25 + русский стеммер), от драйвера не зависит |
| В CLI (`db:migrate`, `sync`, `bootstrap`) и в запущенном сервере нельзя работать одновременно на `sql.js` | Сначала остановите сервер. На `better-sqlite3`/PostgreSQL CLI и сервер сосуществуют |
| XenForo-парсер привязан к классам разметки | Классы структурные (`node--idN`, `structItem--thread`, `message-body .bbWrapper`, `time[data-timestamp]`) и в XenForo 2.x стабильны; есть запасные селекторы. При смене движка форума потребуется новый провайдер данных |
| Лексический поиск не понимает синонимы | Колонка `embedding` и заготовка `pgvector` уже есть — семантическое переранжирование включается без изменения схемы |

## Соглашения по коду

- Цвета, роли, статусы, категории ошибок и значения по умолчанию — **только** из
  `shared/tokens.js`. Никаких хардкод-цветов в CSS и в коде: `renderer/styles/tokens.css`
  повторяет тот же набор и не должен расходиться.
- Новый permission добавляется в `backend/src/permissions/catalog.ts` — при старте
  backend он автоматически появится в БД (`syncPermissionCatalog`).
- Новые разделы админки: добавьте маршрут в `VIEWS` (`renderer/scripts/admin.js`)
  и пункт в `/api/admin/nav` (`backend/src/http/system.ts`) — видимость по permissions
  обеспечит сервер.
- Миграции: только диалектно-независимый SQL + `{PK}`/`{TIMESTAMP}`/`{NOW}`.
  Драйвер-специфичное — в `NNN_name.postgres.sql`.
- Все значимые действия администратора пишите в Audit Log через `audit()` /
  `auditFromReq()` (§50).

## Этапы разработки (§72) и текущее состояние

| Этап | Содержание | Статус |
|---|---|---|
| 1 | Electron + визуальная оболочка + splash + tray | ✅ |
| 2 | Основная панель + настройки + overlay + автоскрытие | ✅ |
| 3 | Discord/Telegram authentication | ✅ (код готов; для боевого включения нужны ключи) |
| 4 | Users / Roles / Permissions / Blocked | ✅ |
| 5 | Административная панель | ✅ |
| 6 | Crawler форума | ✅ (проверен на живом XenForo 2.3; выключен по умолчанию — см. LEGAL.md) |
| 7 | Knowledge Base + versioning + diff | ✅ |
| 8 | RAG + AI | ✅ |
| 9 | Sources Window + feedback + AI Reports | ✅ |
| 10 | Оптимизация и подготовка к VPS | ✅ (перенос = смена `DB_DRIVER` и `backendUrl`) |
