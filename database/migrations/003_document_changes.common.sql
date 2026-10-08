-- 003_document_changes.common.sql
-- Материализованная лента изменений для быстрого построения экранов
-- «Обновления за сегодня» (ТЗ §21, §23) и «История изменений» (ТЗ §26).
-- Без этой таблицы каждый запрос пришлось бы считать по document_versions.

CREATE TABLE document_changes (
  id                 {PK},
  day                VARCHAR(10)  NOT NULL,     -- YYYY-MM-DD (локальная дата синхронизации)
  document_id        BIGINT       NOT NULL,
  version_id         BIGINT       NOT NULL,
  change_kind        VARCHAR(16)  NOT NULL,      -- NEW | UPDATED | ARCHIVED
  title              VARCHAR(512) NOT NULL,
  doc_type           VARCHAR(8)   NOT NULL,
  node_id            INT,
  url                TEXT,
  changed_words      INT          NOT NULL DEFAULT 0,
  total_words        INT          NOT NULL DEFAULT 0,
  diff_json          TEXT,                       -- {ops:[{kind,text}], removedText, addedText}
  sync_log_id        BIGINT,
  created_at         {TIMESTAMP} NOT NULL DEFAULT {NOW}
);
CREATE INDEX ix_changes_day ON document_changes (day);
CREATE INDEX ix_changes_doc ON document_changes (document_id);
CREATE INDEX ix_changes_kind ON document_changes (change_kind);
CREATE UNIQUE INDEX ux_changes_version ON document_changes (version_id);
