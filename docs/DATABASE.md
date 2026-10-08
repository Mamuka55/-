# Схема базы данных EPIC AI

16 основных таблиц (§71) + 3 служебные. Один набор миграций работает и на SQLite,
и на PostgreSQL: в SQL-файлах используются плейсхолдеры `{PK}`, `{TIMESTAMP}`,
`{NOW}`, `{BOOL}`, которые подставляются по драйверу.

```
database/migrations/
├── 001_init.common.sql             ядро схемы
├── 001_init.postgres.sql           tsvector + GIN (опционально, для ускорения на VPS)
├── 002_search_index.common.sql     собственный полнотекстовый индекс (BM25)
└── 003_document_changes.common.sql материализованная лента изменений по дням
database/seeds/
└── 001_roles_permissions.sql       8 ролей, 25 permissions, матрица, серверные настройки
```

Команды: `npm run db:migrate | db:seed | db:reset | db:status` (из `backend/`).
Сиды идемпотентны (`ON CONFLICT DO UPDATE/NOTHING`) — их можно запускать повторно.

---

## ER-обзор

```
                        ┌──────────────┐
        ┌──────────────►│  identities  │  provider + provider_user_id  (UNIQUE)
        │               └──────────────┘  один identity = один аккаунт (§37)
┌───────┴──────┐        ┌──────────────┐        ┌───────────┐
│    users     │───────►│  user_roles  ├───────►│   roles   │ level 1..8, is_system
│ status       │        └──────────────┘        └─────┬─────┘
│ blocked_*    │                                      │
└───┬───┬──────┘        ┌──────────────────────┐      │
    │   │               │ role_permissions     │◄─────┘        ┌──────────────┐
    │   └──────────────►│ user_permission_     ├──────────────►│ permissions  │
    │                   │   overrides (allow|  │               └──────────────┘
    │                   │   deny) (§43, §44)   │
    │                   └──────────────────────┘
    │  ┌──────────────┐  ┌──────────────────┐  ┌──────────────────────┐
    ├──►  sessions   │  │  user_settings   │  │     audit_logs       │ append-only (§50)
    │  └──────────────┘  └──────────────────┘  └──────────────────────┘
    │
    │  ┌────────────────┐   ┌────────────────────┐   ┌──────────────────┐
    └─►│  ai_requests   │──►│    ai_feedback     │──►│    ai_reports    │
       │  + sources_json│   │  vote: 1 | -1      │   │ status/analysis  │
       └────────────────┘   └────────────────────┘   └──────────────────┘

┌──────────────┐   ┌─────────────────────┐   ┌──────────────────────┐
│   kb_nodes   │   │     documents       │──►│  document_versions   │ старые НЕ удаляются (§53)
│ дерево форума│──►│ doc_type RULE|LAW   │   │  content_hash        │
└──────────────┘   │ current_version_id  │   │  diff_from_prev      │
                   │ status active|arch  │   └──────────┬───────────┘
                   └──────────┬──────────┘              │
                              │                         ▼
                   ┌──────────▼──────────┐   ┌──────────────────────┐
                   │  document_chunks    │──►│  search_terms /      │ BM25-индекс
                   │  heading, content   │   │  chunk_terms         │ раздельно RULE|LAW (§59)
                   └─────────────────────┘   └──────────────────────┘
                   ┌─────────────────────┐   ┌──────────────────────┐
                   │  document_changes   │   │      sync_logs       │
                   │  лента по дням (§26)│   │  журнал синхронизаций│
                   └─────────────────────┘   └──────────────────────┘
                   ┌─────────────────────┐
                   │  kb_state, app_settings │
                   └─────────────────────┘
```

---

## Пользователи и доступ

### `users` — единая учётная запись Epic AI (§34, §37, §38)

| Колонка | Назначение |
|---|---|
| `username` (UNIQUE) | внутренний ник, нормализуется из данных провайдера |
| `display_name`, `avatar_url` | автоматически из Discord/Telegram (§35, §36) |
| `status` | `active` \| `blocked` — **не роль** (§40) |
| `blocked_reason`, `blocked_by`, `blocked_at` | контекст блокировки для карточки пользователя и Audit Log |
| `last_login_at` | для списка пользователей (§48) |

### `identities` — внешние провайдеры (§35–§37)

`UNIQUE (provider, provider_user_id)` — один Discord/Telegram принадлежит ровно
одному аккаунту. Хранятся `username`, `first_name`, `last_name`, `display_name`,
`avatar_url` и `raw` (JSON ответа провайдера — для отладки и будущих полей).
При каждом входе данные провайдера обновляются: аватар и ник могли измениться.

### `roles` (§39)

`level` 1..8 задаёт иерархию, `is_system=1` у Developer — такую роль нельзя
ни назначить из панели, ни удалить (§45, §46).

### `permissions`, `role_permissions`, `user_roles`, `user_permission_overrides` (§42–§44)

Каталог из 25 разрешений синхронизируется из кода (`syncPermissionCatalog`)
при старте backend'а, поэтому новые permissions в коде автоматически появляются в БД.

Эффективные права вычисляются в `computeEffectivePermissions()`:

```
codes = (⋃ permissions всех ролей) ∪ {override.effect = 'allow'} − {override.effect = 'deny'}
```

`deny` приоритетнее `allow` — это и есть «индивидуальный запрет» (§44).

### `sessions` (§41)

`token_hash` — sha256 токена (сам токен в БД не хранится), `UNIQUE`.
`revoked_at` + `revoke_reason` (`logout` / `blocked` / `admin_revoke`).
При блокировке пользователя все его активные сессии инвалидируются.
`last_seen_at` обновляется не чаще раза в минуту, чтобы не нагружать БД.

### `audit_logs` (§50)

Append-only. API намеренно не предоставляет update/delete — соответствующие
маршруты возвращают `405 audit_readonly`. `meta` — JSON с деталями
(например `{from: 'player', to: 'helper'}` для смены роли).
`actor_name` дублируется, чтобы журнал оставался читаемым после удаления пользователя.

---

## База знаний

### `kb_nodes` — дерево разделов форума

`node_id` (id раздела XenForo), `parent_node_id`, `depth`, `doc_type`,
`is_archive`, `crawl_enabled`. Нужна, чтобы:

- offline-прогон синхронизации работал без сети;
- администратор мог точечно выключить обход раздела или переопределить его тип.

Проверено на живом форуме: 62 узла, из них 19 классифицированы как RULE/LAW.

### `documents` — документ = тема форума (§52, §59, §60)

| Колонка | Назначение |
|---|---|
| `doc_type` | `RULE` \| `LAW` — жёсткое разделение баз (§59) |
| `thread_id` (UNIQUE) | id темы XenForo — естественный ключ при синхронизации |
| `post_id` | id первого поста: даёт ссылку на конкретный пост (`…#post-N`) в окне источников (§11) |
| `node_id`, `section`, `category` | раздел форума, путь раздела, префикс темы («Важно») |
| `current_version_id` | указатель на актуальную редакцию |
| `content_hash` | sha256 нормализованного текста — основа детекции изменений (§55) |
| `source_created_at`, `source_modified_at` | даты источника; `source_modified_at` используется для быстрого пути синхронизации без загрузки страницы |
| `status` | `active` \| `archive` \| `deleted`. Архивные **не участвуют в поиске** (§60), но сохраняются для истории и расследования ошибок |

### `document_versions` (§53)

Каждая редакция — отдельная строка: полный `content_text` (нормализованный),
`content_html` (исходный HTML постов), `content_hash`, `word_count`,
`change_kind` (`NEW` \| `UPDATED` \| `ARCHIVED`) и `diff_from_prev` (JSON с
`ops`/`removedText`/`addedText`/`changedRatio`). Старые версии не удаляются —
это позволяет строить историю (§26) и проверять, на какой редакции был дан
старый ответ AI (§60).

### `document_chunks` (§58)

Фрагменты актуальной версии для RAG: `seq`, `heading` («Пункт 4.2», «Статья 12.4»),
`content`, `char_start`/`char_end`, `token_estimate`, `embedding` (JSON-массив,
заполняется при `EMBEDDING_ENABLED`), `is_current`.

При новой версии старые фрагменты помечаются `is_current=0` и удаляются из
поискового индекса — в поиске участвует только актуальная редакция.

### `search_terms`, `search_docs`, `chunk_terms` — поисковый индекс

```
search_terms(term, doc_type, field, postings JSON [[chunkId, tf], …], df)
chunk_terms(chunk_id, field, term)   -- обратный список: какие термы содержит chunk
```

`chunk_terms` нужен, чтобы при переиндексации версии не сканировать весь
`search_terms` (это O(всех термов) на каждый chunk).
Подробнее об устройстве поиска — в `ARCHITECTURE.md` §2.3.

### `document_changes` — лента изменений по дням (§23, §26)

Материализованная таблица: `day` (YYYY-MM-DD), `change_kind`, `title`, `doc_type`,
`changed_words`, `total_words`, `diff_json`, `sync_log_id`.
Без неё экраны «Обновления за сегодня» и «История изменений» пересчитывали бы
diff по всем версиям на каждый запрос.

### `sync_logs` (§56)

Журнал прогонов: `trigger_type` (`auto` \| `manual`), `status`,
счётчики `docs_new/docs_updated/docs_archived/docs_unchanged`, `pages_fetched`,
`error`, `meta` (предупреждения crawler'а и версия базы).

### `kb_state`, `app_settings`

`kb_state['version']` — версия базы знаний, которая попадает в каждый ответ AI
и в каждый AI Report (§16: «версия документов»). Формат: `<кол-во документов>-<дата последней правки>`.
`app_settings` — серверные настройки: интервал синхронизации, автосинхронизация,
включён ли crawler.

---

## AI и обратная связь

### `ai_requests`

Полный слепок запроса: `mode` (rules/laws), `question`, `answer_text`, `verdict`,
`explanation`, `basis`, `sources_json` (**те самые источники, которые увидел
пользователь** — критично для разбора ошибок), `model`, `provider`,
`tokens_*`, `latency_ms`, `status` (`ok` \| `no_data` \| `error`), `kb_version`.

### `ai_feedback` (§15)

Один голос на один запрос: `vote` = `1` (👍) или `-1` (👎).
Повторное нажатие меняет знак. Upsert сделан вручную (без `ON CONFLICT`),
чтобы одинаково работать на SQLite и PostgreSQL.

### `ai_reports` (§16–§18)

| Колонка | Назначение |
|---|---|
| `category` | одна из 6 категорий формы дизлайка (обязательна) |
| `comment` | необязательный комментарий пользователя |
| `user_role_snapshot` | роль на момент отправки — история не должна «плыть» после смены роли |
| `status` | `new` → `in_progress` → `resolved` (§16) |
| `analysis` | `kb_outdated` \| `search_miss` \| `ai_error` \| `technical` (§18); заполняется подсказкой системы, утверждается администратором |
| `resolution`, `handled_by`, `handled_at` | итог обработки |

---

## Настройки

- `user_settings(user_id, key, value)` — клиентские настройки (§20): прозрачность,
  blur, размеры, положение панели, always-on-top, горячая клавиша, аппаратное
  ускорение и т. д. Хранятся на сервере, чтобы не теряться при переустановке
  и быть общими для одного аккаунта на нескольких машинах. Electron держит
  локальную копию в `%APPDATA%/Epic AI/settings.json` — она нужна main process'у
  для геометрии окон до первого ответа API.
- `app_settings(key, value)` — серверные настройки, управляются из админки.

---

## Типы данных и переносимость

| Аспект | SQLite | PostgreSQL |
|---|---|---|
| Первичный ключ | `INTEGER PRIMARY KEY AUTOINCREMENT` | `BIGSERIAL PRIMARY KEY` |
| Время | `TEXT` (ISO-8601) | `TIMESTAMPTZ` |
| Boolean | `SMALLINT` 0/1 | `SMALLINT` 0/1 (единообразно) |
| JSON | `TEXT` | `TEXT` (парсится в коде) |
| Плейсхолдеры | `?` | `?` → `$1..$n` (трансляция в `toDriverSql`) |
| Возврат id после INSERT | `last_insert_rowid()` | `RETURNING id` (`insertReturningId`) |
| Полнотекстовый поиск | собственный BM25 | собственный BM25 (+ опционально `tsvector`/GIN из `001_init.postgres.sql` и `pgvector`) |

**Соглашение для новых миграций:** пишите только диалектно-независимый SQL
и используйте `{PK}`/`{TIMESTAMP}`/`{NOW}`. Драйвер-специфичное — в отдельный
файл `NNN_name.postgres.sql`. Избегайте `ON CONFLICT (…) DO UPDATE SET col = EXCLUDED.col`
для таблиц с суррогатным PK: в SQLite `EXCLUDED` в такой позиции работает иначе —
лучше явный select-then-insert/update (см. `upsertVote`).
