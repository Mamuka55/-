-- 004_ai_quota.common.sql — дневной лимит запросов к AI.
--
-- По умолчанию каждому пользователю доступно 50 запросов в сутки
-- (константа DEFAULT_DAILY_LIMIT в backend/src/ai/quota.ts). Персональный
-- лимит выдаётся администратором из админ-панели (карточка пользователя)
-- и хранится здесь; отсутствие строки = лимит по умолчанию.

CREATE TABLE ai_quotas (
  user_id            BIGINT       NOT NULL PRIMARY KEY,
  daily_limit        INT          NOT NULL,
  updated_at         {TIMESTAMP}  NOT NULL DEFAULT {NOW},
  updated_by         BIGINT
);
