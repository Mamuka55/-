-- 001_init.common.sql — ядро схемы, диалектно-независимая часть.
-- Выполняется и для SQLite, и для PostgreSQL (миграционный раннер подставляет
-- тип PK/boolean в зависимости от драйвера — см. backend/src/db/index.ts).

-- ============================================================
--  ПОЛЬЗОВАТЕЛИ / ИДЕНТИЧНОСТИ  (ТЗ §34–§40)
-- ============================================================

CREATE TABLE users (
  id                 {PK},
  username           VARCHAR(64)  NOT NULL,
  display_name       VARCHAR(128),
  avatar_url         TEXT,
  status             VARCHAR(16)  NOT NULL DEFAULT 'active',   -- active | blocked
  blocked_reason     TEXT,
  blocked_by         BIGINT,
  blocked_at         {TIMESTAMP},
  created_at         {TIMESTAMP} NOT NULL DEFAULT {NOW},
  updated_at         {TIMESTAMP} NOT NULL DEFAULT {NOW},
  last_login_at      {TIMESTAMP}
);
CREATE UNIQUE INDEX ux_users_username ON users (username);
CREATE INDEX ix_users_status ON users (status);

-- Внешние identity provider'ы. Discord/Telegram НЕ определяют роль (ТЗ §34).
CREATE TABLE identities (
  id                 {PK},
  user_id            BIGINT       NOT NULL,
  provider           VARCHAR(16)  NOT NULL,                      -- discord | telegram
  provider_user_id   VARCHAR(64)  NOT NULL,
  username           VARCHAR(128),
  first_name         VARCHAR(128),
  last_name          VARCHAR(128),
  display_name       VARCHAR(160),
  avatar_url         TEXT,
  raw                TEXT,                                       -- JSON ответа провайдера
  created_at         {TIMESTAMP} NOT NULL DEFAULT {NOW},
  last_used_at       {TIMESTAMP}
);
-- Один Discord/Telegram identity принадлежит только одному Epic AI Account (ТЗ §37)
CREATE UNIQUE INDEX ux_identities_provider_uid ON identities (provider, provider_user_id);
CREATE INDEX ix_identities_user ON identities (user_id);

-- ============================================================
--  RBAC  (ТЗ §39, §42–§46)
-- ============================================================

CREATE TABLE roles (
  id                 {PK},
  code               VARCHAR(48)  NOT NULL,
  name               VARCHAR(128) NOT NULL,
  color              VARCHAR(16)  NOT NULL DEFAULT '#888888',
  level              INT          NOT NULL DEFAULT 1,            -- иерархия (ТЗ §39)
  is_system          SMALLINT     NOT NULL DEFAULT 0,            -- developer: нельзя выдать из панели (ТЗ §45)
  created_at         {TIMESTAMP} NOT NULL DEFAULT {NOW}
);
CREATE UNIQUE INDEX ux_roles_code ON roles (code);

CREATE TABLE permissions (
  id                 {PK},
  code               VARCHAR(64)  NOT NULL,                      -- например ai.use
  category           VARCHAR(32)  NOT NULL DEFAULT 'general',    -- ai | knowledge | users | roles | system | settings
  description        TEXT,
  created_at         {TIMESTAMP} NOT NULL DEFAULT {NOW}
);
CREATE UNIQUE INDEX ux_permissions_code ON permissions (code);

CREATE TABLE role_permissions (
  role_id            BIGINT       NOT NULL,
  permission_id      BIGINT       NOT NULL,
  created_at         {TIMESTAMP} NOT NULL DEFAULT {NOW}
);
CREATE UNIQUE INDEX ux_role_permissions ON role_permissions (role_id, permission_id);

CREATE TABLE user_roles (
  user_id            BIGINT       NOT NULL,
  role_id            BIGINT       NOT NULL,
  assigned_by        BIGINT,
  assigned_at        {TIMESTAMP} NOT NULL DEFAULT {NOW}
);
CREATE UNIQUE INDEX ux_user_roles ON user_roles (user_id, role_id);

-- Дополнительные разрешения и индивидуальные запреты (ТЗ §43, §44).
-- effect: 'allow' | 'deny'. deny имеет приоритет над allow роли.
CREATE TABLE user_permission_overrides (
  id                 {PK},
  user_id            BIGINT       NOT NULL,
  permission_id      BIGINT       NOT NULL,
  effect             VARCHAR(8)   NOT NULL DEFAULT 'allow',
  reason             TEXT,
  granted_by         BIGINT,
  created_at         {TIMESTAMP} NOT NULL DEFAULT {NOW}
);
CREATE UNIQUE INDEX ux_user_perm_override ON user_permission_overrides (user_id, permission_id);

-- ============================================================
--  СЕССИИ  (ТЗ §41 — инвалидация при блокировке)
-- ============================================================

CREATE TABLE sessions (
  id                 {PK},
  user_id            BIGINT       NOT NULL,
  token_hash         VARCHAR(128) NOT NULL,
  created_at         {TIMESTAMP} NOT NULL DEFAULT {NOW},
  expires_at         {TIMESTAMP} NOT NULL,
  last_seen_at       {TIMESTAMP},
  ip                 VARCHAR(64),
  user_agent         TEXT,
  revoked_at         {TIMESTAMP},
  revoke_reason      VARCHAR(64)
);
CREATE UNIQUE INDEX ux_sessions_token ON sessions (token_hash);
CREATE INDEX ix_sessions_user ON sessions (user_id);
CREATE INDEX ix_sessions_expires ON sessions (expires_at);

-- ============================================================
--  AUDIT LOG  (ТЗ §50) — append-only, интерфейс не умеет его менять
-- ============================================================

CREATE TABLE audit_logs (
  id                 {PK},
  actor_id           BIGINT,
  actor_name         VARCHAR(128),
  action             VARCHAR(64)  NOT NULL,   -- login, logout, block, unblock, role.change, permission.add, ...
  entity_type        VARCHAR(32),
  entity_id          VARCHAR(64),
  meta               TEXT,                    -- JSON
  ip                 VARCHAR(64),
  created_at         {TIMESTAMP} NOT NULL DEFAULT {NOW}
);
CREATE INDEX ix_audit_created ON audit_logs (created_at);
CREATE INDEX ix_audit_actor ON audit_logs (actor_id);
CREATE INDEX ix_audit_action ON audit_logs (action);
CREATE INDEX ix_audit_entity ON audit_logs (entity_type, entity_id);

-- ============================================================
--  KNOWLEDGE BASE  (ТЗ §52, §53, §59, §60)
-- ============================================================

CREATE TABLE kb_nodes (
  id                 {PK},
  node_id            INT          NOT NULL,   -- id раздела XenForo
  parent_node_id     INT,
  title              VARCHAR(255) NOT NULL,
  url                TEXT,
  depth              INT          NOT NULL DEFAULT 0,
  doc_type           VARCHAR(8),             -- RULE | LAW | NULL
  is_archive         SMALLINT     NOT NULL DEFAULT 0,
  crawl_enabled      SMALLINT     NOT NULL DEFAULT 1,
  synced_at          {TIMESTAMP},
  created_at         {TIMESTAMP} NOT NULL DEFAULT {NOW}
);
CREATE UNIQUE INDEX ux_kb_nodes_node ON kb_nodes (node_id);

-- document = тема форума (или её значимая часть)
CREATE TABLE documents (
  id                 {PK},
  doc_type           VARCHAR(8)   NOT NULL,   -- RULE | LAW
  category           VARCHAR(128),
  node_id            INT,
  title              VARCHAR(512) NOT NULL,
  section            VARCHAR(255),
  url                TEXT         NOT NULL,
  thread_id          BIGINT       NOT NULL,
  post_id            BIGINT,                  -- id первого (основного) поста
  author_name        VARCHAR(128),
  current_version_id BIGINT,
  content_hash       VARCHAR(64),
  source_created_at  {TIMESTAMP},
  source_modified_at {TIMESTAMP},
  status             VARCHAR(16)  NOT NULL DEFAULT 'active',  -- active | archive | deleted
  created_at         {TIMESTAMP} NOT NULL DEFAULT {NOW},
  updated_at         {TIMESTAMP} NOT NULL DEFAULT {NOW}
);
CREATE UNIQUE INDEX ux_documents_thread ON documents (thread_id);
CREATE INDEX ix_documents_type ON documents (doc_type);
CREATE INDEX ix_documents_status ON documents (status);
CREATE INDEX ix_documents_node ON documents (node_id);

-- Старая версия НЕ удаляется (ТЗ §53)
CREATE TABLE document_versions (
  id                 {PK},
  document_id        BIGINT       NOT NULL,
  version            INT          NOT NULL,
  title              VARCHAR(512) NOT NULL,
  content_text       TEXT         NOT NULL,   -- нормализованный текст
  content_html       TEXT,
  content_hash       VARCHAR(64)  NOT NULL,
  word_count         INT          NOT NULL DEFAULT 0,
  change_kind        VARCHAR(16)  NOT NULL DEFAULT 'NEW',  -- NEW | UPDATED | ARCHIVED
  diff_from_prev     TEXT,                                   -- JSON: {removed:[],added:[],ops:[]}
  source_created_at  {TIMESTAMP},
  source_modified_at {TIMESTAMP},
  fetched_at         {TIMESTAMP} NOT NULL DEFAULT {NOW},
  created_at         {TIMESTAMP} NOT NULL DEFAULT {NOW}
);
CREATE UNIQUE INDEX ux_docver ON document_versions (document_id, version);
CREATE INDEX ix_docver_doc ON document_versions (document_id);
CREATE INDEX ix_docver_created ON document_versions (created_at);

-- Chunks для RAG (ТЗ §58)
CREATE TABLE document_chunks (
  id                 {PK},
  document_id        BIGINT       NOT NULL,
  version_id         BIGINT       NOT NULL,
  seq                INT          NOT NULL,
  heading            VARCHAR(512),
  content            TEXT         NOT NULL,
  token_estimate     INT          NOT NULL DEFAULT 0,
  char_start         INT          NOT NULL DEFAULT 0,
  char_end           INT          NOT NULL DEFAULT 0,
  embedding          TEXT,                     -- JSON-массив float; при EMBEDDING_ENABLED
  is_current         SMALLINT     NOT NULL DEFAULT 1,
  created_at         {TIMESTAMP} NOT NULL DEFAULT {NOW}
);
CREATE UNIQUE INDEX ux_chunk_seq ON document_chunks (version_id, seq);
CREATE INDEX ix_chunks_doc ON document_chunks (document_id);
CREATE INDEX ix_chunks_current ON document_chunks (is_current);

-- ============================================================
--  СИНХРОНИЗАЦИЯ  (ТЗ §56, §57)
-- ============================================================

CREATE TABLE sync_logs (
  id                 {PK},
  started_at         {TIMESTAMP} NOT NULL DEFAULT {NOW},
  finished_at        {TIMESTAMP},
  trigger_type       VARCHAR(16)  NOT NULL DEFAULT 'auto',   -- auto | manual
  triggered_by       BIGINT,
  status             VARCHAR(16)  NOT NULL DEFAULT 'running',-- running | success | error
  docs_new           INT          NOT NULL DEFAULT 0,
  docs_updated       INT          NOT NULL DEFAULT 0,
  docs_archived      INT          NOT NULL DEFAULT 0,
  docs_unchanged     INT          NOT NULL DEFAULT 0,
  pages_fetched      INT          NOT NULL DEFAULT 0,
  error              TEXT,
  meta               TEXT
);
CREATE INDEX ix_sync_started ON sync_logs (started_at);

-- ============================================================
--  AI: ЗАПРОСЫ, FEEDBACK, REPORTS  (ТЗ §15–§18)
-- ============================================================

CREATE TABLE ai_requests (
  id                 {PK},
  user_id            BIGINT,
  mode               VARCHAR(8)   NOT NULL,     -- rules | laws
  question           TEXT         NOT NULL,
  answer_text        TEXT,
  verdict            VARCHAR(32),               -- allowed | forbidden | depends | unknown
  explanation        TEXT,
  basis              TEXT,
  sources_json       TEXT,                      -- JSON массива источников, показанных пользователю
  model              VARCHAR(64),
  provider           VARCHAR(32),
  tokens_prompt      INT,
  tokens_completion  INT,
  latency_ms         INT,
  status             VARCHAR(16)  NOT NULL DEFAULT 'ok',   -- ok | no_data | error
  error              TEXT,
  kb_version         VARCHAR(64),               -- «версия документов» для отчёта (ТЗ §16)
  created_at         {TIMESTAMP} NOT NULL DEFAULT {NOW}
);
CREATE INDEX ix_ai_requests_user ON ai_requests (user_id);
CREATE INDEX ix_ai_requests_created ON ai_requests (created_at);

CREATE TABLE ai_feedback (
  id                 {PK},
  request_id         BIGINT       NOT NULL,
  user_id            BIGINT,
  vote               SMALLINT     NOT NULL,      -- 1 | -1
  created_at         {TIMESTAMP} NOT NULL DEFAULT {NOW}
);
CREATE UNIQUE INDEX ux_ai_feedback_request ON ai_feedback (request_id);

CREATE TABLE ai_reports (
  id                 {PK},
  request_id         BIGINT       NOT NULL,
  feedback_id        BIGINT,
  user_id            BIGINT,
  user_role_snapshot VARCHAR(64),
  category           VARCHAR(32)  NOT NULL,      -- см. FEEDBACK_CATEGORIES
  comment            TEXT,
  status             VARCHAR(16)  NOT NULL DEFAULT 'new',   -- new | in_progress | resolved
  analysis           VARCHAR(32),                -- kb_outdated | search_miss | ai_error | technical (ТЗ §18)
  resolution         TEXT,
  handled_by         BIGINT,
  handled_at         {TIMESTAMP},
  created_at         {TIMESTAMP} NOT NULL DEFAULT {NOW}
);
CREATE INDEX ix_reports_status ON ai_reports (status);
CREATE INDEX ix_reports_created ON ai_reports (created_at);

-- ============================================================
--  НАСТРОЙКИ
-- ============================================================

-- Пользовательские настройки клиента (ТЗ §20)
CREATE TABLE user_settings (
  user_id            BIGINT       NOT NULL,
  key                VARCHAR(64)  NOT NULL,
  value              TEXT,
  updated_at         {TIMESTAMP} NOT NULL DEFAULT {NOW}
);
CREATE UNIQUE INDEX ux_user_settings ON user_settings (user_id, key);

-- Серверные настройки (интервал синхронизации, включён ли crawler и т.д.)
CREATE TABLE app_settings (
  key                VARCHAR(64)  NOT NULL,
  value              TEXT,
  updated_by         BIGINT,
  updated_at         {TIMESTAMP} NOT NULL DEFAULT {NOW}
);
CREATE UNIQUE INDEX ux_app_settings ON app_settings (key);
