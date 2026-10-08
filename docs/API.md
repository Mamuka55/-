# HTTP API EPIC AI

Base URL: `http://127.0.0.1:8787` локально, `https://api.…` на VPS.
Клиент (Electron) обращается **только** сюда; никаких секретов API не отдаёт (§62).

## Соглашения

- **Авторизация:** cookie `epic_ai_session` (httpOnly, в production — secure).
  Допустим также `Authorization: Bearer <token>`.
- **CSRF:** любой не-GET запрос к `/api/*` обязан нести заголовок
  `X-Epic-Client: desktop | admin-web | cli`. Без него — `400 missing_client_header`.
- **Формат ответа:** JSON. Ошибки — `{ "error": "<code>", "message": "<текст>" }`
  с соответствующим HTTP-статусом.
- **Проверка блокировки** выполняется на backend при каждом запросе:
  заблокированный аккаунт получает `403 blocked` (§41).
- В production тексты 5xx-ошибок заменяются на «Внутренняя ошибка сервера».

| Код | Когда |
|---|---|
| 400 | некорректные данные, отсутствует `X-Epic-Client` |
| 401 | нет сессии / сессия истекла |
| 403 | аккаунт заблокирован либо не хватает permissions |
| 404 | объект не найден (или нет доступа — чтобы не раскрывать существование) |
| 405 | Audit Log: попытка изменения |
| 409 | конфликт (синхронизация уже идёт, bootstrap уже выполнен, identity занята) |

---

## Служебные

| Метод | Путь | Доступ | Описание |
|---|---|---|---|
| GET | `/api/health` | публично | Состояние сервиса, БД, AI-провайдера, crawler'а. Используется splash-экраном и мониторингом |
| GET | `/api/bootstrap/status` | публично | Нужен ли первичный setup Developer |
| POST | `/api/bootstrap/developer` | `BOOTSTRAP_TOKEN` | Одноразовое создание первого Developer (§45). Если Developer уже есть → `409` **до** проверки токена |

## Авторизация (§33–§37)

| Метод | Путь | Описание |
|---|---|---|
| POST | `/api/auth/desktop/start` | Начать вход из приложения: `{provider, device?, os?}` → `{ticket, url, displayCode?}`; `url` открывается во ВНЕШНЕМ браузере |
| GET | `/api/auth/desktop/status?ticket=` | Статус тикета: `pending / ready / denied / expired` |
| POST | `/api/auth/desktop/claim` | Одноразовый обмен подтверждённого тикета на cookie-сессию клиента |
| GET | `/auth/discord/start` | Начало OAuth2 (генерирует `state`) |
| GET | `/auth/discord/callback` | Callback Discord: обмен кода, получение user id/username/avatar, создание/привязка аккаунта, выдача сессии |
| GET | `/auth/telegram` | Проверка подписи Telegram Login Widget и вход |
| POST | `/auth/telegram` | То же, но JSON-ответом (для невиджет-сценариев) |
| GET | `/auth/done` | Страница успеха во внешнем браузере («вкладку можно закрыть») |
| GET | `/api/auth/me` | Текущий пользователь, роль, permissions, `isDeveloper`, `maxRoleLevel`. Именно его опрашивает splash на этапах «Пользователь → Статус → Роль → Разрешения» |
| POST | `/api/auth/logout` | Отзыв текущей сессии + очистка cookie |
| GET | `/api/auth/providers` | Какие способы входа включены |
| POST | `/api/auth/dev-login` | **Только `NODE_ENV != production`.** Локальный вход без OAuth по `SESSION_SECRET`. Пользователя создаёт `npm run bootstrap:developer -- --local <name>` |

## AI (§13–§16, §58)

| Метод | Путь | Право | Описание |
|---|---|---|---|
| POST | `/api/ai/ask` | `ai.use` + `ai.rules`/`ai.laws` | `{mode, question, includeArchive?}` → `{requestId, verdict, verdictLabel, explanation, basis, sources[], relatedDocuments[], kbVersion, status, confidence, latencyMs, provider, model, quota}`. При пустой выдаче `status: "no_data"` и LLM не вызывается. При исчерпанном дневном лимите — `429 quota_exceeded` с телом `{error, message, quota}` |
| GET | `/api/ai/quota` | `ai.use` | Дневной лимит запросов: `{used, limit, left, resetAt, personal}`. Общий лимит — 50 запросов в сутки; персональный (`personal: true`) выдаёт администратор. Используется модалкой «Спросить ИИ?» и профилем настроек |
| GET | `/api/ai/sources?requestId=` | `ai.sources` | Содержимое окна источников. Чужой запрос — только с `ai.reports.view` |
| GET | `/api/ai/search?mode=&q=` | `ai.use` | Поиск по базе **без** обращения к AI — отладка RAG |
| GET | `/api/ai/history` | `ai.history` | Своя история запросов |
| GET | `/api/ai/request/:id` | `ai.use` | Полный контекст запроса (для формы дизлайка и админки) |
| GET | `/api/ai/meta` | авторизация | Версия базы, провайдер, модель, настроен ли AI. Секретов не содержит |
| GET | `/api/ai/feedback/categories` | `ai.use` | 6 категорий формы дизлайка + 4 типа анализа (§15, §18) |
| POST | `/api/ai/feedback/like` | `ai.feedback` | 👍 — только статистика, отчёт не создаётся |
| POST | `/api/ai/reports` | `ai.feedback` | 👎 → `{requestId, category, comment?}`. `category` обязательна, иначе `400` |
| GET | `/api/ai/reports` | `ai.reports.view` | Очередь с фильтрами `status`, `category`, `analysis`, `userId`, `from` + счётчики по статусам |
| GET | `/api/ai/reports/:id` | `ai.reports.view` | Карточка: пользователь и роль, вопрос, режим, ответ AI, найденные источники, причина, комментарий, статус, версия базы |
| PATCH | `/api/ai/reports/:id` | `ai.reports.manage` | `{status?, analysis?, resolution?}` — кнопки «В РАБОТУ» / «РЕШЕНО» |
| GET | `/api/ai/stats` | `ai.reports.view` | Статистика качества: лайки/дизлайки, satisfaction, запросы по статусам, среднее время, распределение по категориям и типам анализа |

## Knowledge Base (§21–§26, §52–§57)

| Метод | Путь | Право | Описание |
|---|---|---|---|
| GET | `/api/kb/status` | `settings.view` | Блок «ПРАВИЛА / ● База актуальна / Обновлено: …» + счётчики «Обновления сегодня» |
| POST | `/api/kb/sync` | `knowledge.sync` | «ОБНОВИТЬ БАЗУ». Запускается фоново, ответ `202`. При `CRAWLER_ENABLED=false` → `403 crawler_disabled` |
| GET | `/api/kb/sync/logs` | `knowledge.view` | Журнал синхронизаций |
| GET | `/api/kb/changes/today` | `knowledge.view` | Обновления за сегодня |
| GET | `/api/kb/changes?day=YYYY-MM-DD` | `knowledge.view` | Обновления за конкретный день |
| GET | `/api/kb/changes/history` | `knowledge.view` | Список дней с итогами (`3 новых · 7 изменений`) |
| GET | `/api/kb/changes/:id` | `knowledge.history` | Карточка изменения: «Было / Стало» + `diff.ops` для цветного рендера |
| GET | `/api/kb/documents` | `knowledge.view` | Список документов, фильтры `type=RULE\|LAW`, `status`, `search` |
| GET | `/api/kb/documents/:id` | `knowledge.view` | Документ с актуальным содержимым и списком версий |
| GET | `/api/kb/documents/:id/versions` | `knowledge.history` | Все версии (§53) |
| GET | `/api/kb/documents/:id/diff?from=&to=` | `knowledge.history` | Сравнение двух конкретных версий |
| GET | `/api/kb/nodes` | `knowledge.view` | Дерево разделов форума с типами и флагами архива |
| PATCH | `/api/kb/nodes/:nodeId` | `knowledge.manage` | Включить/выключить обход раздела, переопределить `docType`/`isArchive` |
| POST | `/api/kb/ingest` | `knowledge.manage` | Ручной приём документа. Использует **тот же** Version Manager, что и crawler: создаёт версию, считает diff, переиндексирует chunks |
| PATCH | `/api/kb/settings` | `system.settings` | Интервал автосинхронизации, вкл/выкл автомата |

## Пользователи (§38, §40, §41, §48, §49)

| Метод | Путь | Право | Описание |
|---|---|---|---|
| GET | `/api/users/me` | авторизация | Профиль: аватар, ник, роль, статус, Discord, Telegram, дата создания, permissions, overrides |
| GET | `/api/users` | `users.view` | Список. Поиск по никнейму, ID, Discord, Telegram; фильтры `role`, `status` |
| GET | `/api/users/:id` | `users.view` | Карточка: identity, роли, эффективные permissions, дополнительные и запрещённые, история действий, сессии, `availableActions`, `quota` (дневной лимит запросов к ИИ) |
| PUT | `/api/users/:id/quota` | `users.edit` | `{dailyLimit: number|null}` — персональный дневной лимит запросов к ИИ (карточка пользователя в админ-панели); `null` возвращает общий лимит 50. Ответ `{ok, userId, quota}`; пишется в аудит (`user.quota.change`) |
| PATCH | `/api/users/:id/role` | `roles.assign` | Назначение роли с проверкой иерархии (§46). Системные роли отклоняются |
| PATCH | `/api/users/:id/status` | `users.block` | `{blocked, reason}` — блокировка/разблокировка + инвалидация сессий |
| GET | `/api/users/:id/permissions` | `permissions.view` | Эффективные права с разбивкой: из ролей / выдано дополнительно / запрещено |
| PUT | `/api/users/:id/permissions` | `permissions.manage` | `{permission, effect: allow\|deny\|null, reason?}` (§43, §44) |
| POST | `/api/users/:id/sessions/revoke` | `users.edit` | Принудительно завершить сессии |
| GET | `/api/users/blocked` | `users.view` | Раздел «Блокировки» |

## Роли и permissions (§39, §42, §46)

| Метод | Путь | Право | Описание |
|---|---|---|---|
| GET | `/api/roles` | `roles.view` | Роли с permissions, числом пользователей и флагами `assignable`/`visible` |
| GET | `/api/roles/assignable` | `roles.assign` | Только те роли, которые текущий администратор может выдать |
| POST | `/api/roles` | `roles.manage` | Создание роли (нельзя уровень ≥ своего) |
| PATCH | `/api/roles/:code` | `roles.manage` | Название, цвет, набор permissions |
| DELETE | `/api/roles/:code` | `roles.manage` | Удаление (нельзя системные, базовые из ТЗ §39 и назначенные кому-либо) |
| GET | `/api/permissions` | `permissions.view` | Каталог, сгруппированный по категориям |
| GET | `/api/permissions/matrix` | `permissions.view` | Матрица «роль × permission» для таблицы в админке |
| POST | `/api/permissions/sync` | `permissions.manage` | Досинхронизировать каталог из кода |

## Audit Log (§50)

| Метод | Путь | Право | Описание |
|---|---|---|---|
| GET | `/api/audit-logs` | `system.logs` | Фильтры: `action`, `action_prefix`, `entity_type`, `entity_id`, `actor_id`, `from`, `to`, `search`, `limit`, `offset` |
| GET | `/api/audit-logs/actions` | `system.logs` | Справочник действий для фильтра |
| POST/PUT/PATCH/DELETE | `/api/audit-logs[/:id]` | — | Всегда `405 audit_readonly` — журнал нельзя изменить через интерфейс |

## Настройки и администрирование (§19, §20, §47)

| Метод | Путь | Право | Описание |
|---|---|---|---|
| GET | `/api/settings/me` | `settings.view` | Настройки пользователя + значения по умолчанию + список допустимых ключей |
| PUT | `/api/settings/me` | `settings.view` | Частичное обновление. Значения валидируются по схеме; неизвестные ключи игнорируются; невалидный хоткей откатывается к `F10` |
| POST | `/api/settings/me/reset` | `settings.view` | Сброс к значениям по умолчанию |
| GET | `/api/settings/system` | `system.settings` | Серверные настройки |
| PUT | `/api/settings/system` | `system.settings` | Изменение (белый список ключей) |
| GET | `/api/admin/overview` | `users.view` | Сводка: пользователи, запросы AI, одобрение ответов, ошибки AI, база знаний, система, последние события |
| GET | `/api/admin/nav` | авторизация | Дерево разделов админки **с учётом permissions** — клиент рисует только то, что вернул сервер |

---

## Страницы (не API)

| Путь | Что отдаёт |
|---|---|
| `/api/auth/desktop/*` | Тикет-флоу входа из внешнего браузера |
| `/auth/done` | Страница успеха во внешнем браузере |
| `/ui/…` | Статика `renderer/` — в том числе `/ui/admin.html` и `/ui/demo/index.html` для доступа к админке и демо из браузера |

---

## Пример полного сценария

```bash
B=http://127.0.0.1:8787
H='-H Content-Type:application/json -H X-Epic-Client:cli'

# 1. Локальный вход (development)
curl -c jar.txt -X POST $B/api/auth/dev-login $H \
  -d '{"token":"<SESSION_SECRET>","username":"developer"}'

# 2. Кто я
curl -b jar.txt $B/api/auth/me | jq '.user.primaryRole, (.permissions|length)'

# 3. Вопрос по правилам
curl -b jar.txt -X POST $B/api/ai/ask $H \
  -d '{"mode":"rules","question":"Что такое DM и можно ли убивать без причины?"}' \
  | jq '{verdict, explanation, sources: [.sources[] | {title, heading, revisionLabel, url}]}'

# 4. Дизлайк → отчёт
curl -b jar.txt -X POST $B/api/ai/reports $H \
  -d '{"requestId":1,"category":"misinterpreted","comment":"Пункт процитирован неточно"}'

# 5. Обработка администратором
curl -b jar.txt -X PATCH $B/api/ai/reports/1 $H \
  -d '{"status":"resolved","analysis":"ai_error","resolution":"Уточнён промпт"}'

# 6. Что изменилось в базе сегодня
curl -b jar.txt $B/api/kb/changes/today | jq '.counts, [.items[].title]'
```
