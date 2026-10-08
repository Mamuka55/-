-- 002_search_index.common.sql
-- Собственный полнотекстовый индекс Epic AI.
--
-- Почему не FTS5/tsvector: поиск должен работать ИДЕНТИЧНО на sqlite
-- (better-sqlite3 и sql.js/WASM) и на postgres, а также поддерживать
-- русскую морфологию (простой стеммер) и фразовые запросы.
--
-- search_terms.term — нормализованное слово (или его основа), postings —
-- компактный JSON-массив пар [chunk_id, частота].

CREATE TABLE search_terms (
  term               VARCHAR(64)  NOT NULL,
  doc_type           VARCHAR(8)   NOT NULL,     -- RULE | LAW  (жёсткое разделение баз, ТЗ §59)
  field              VARCHAR(8)   NOT NULL DEFAULT 'body',  -- body | heading | title
  postings           TEXT         NOT NULL,     -- JSON: [[chunkId, tf], ...]
  df                 INT          NOT NULL DEFAULT 0,       -- document frequency
  updated_at         {TIMESTAMP} NOT NULL DEFAULT {NOW}
);
CREATE UNIQUE INDEX ux_search_terms ON search_terms (term, doc_type, field);

-- Инвертированный индекс по документам (для поиска «какой документ вообще про это»).
CREATE TABLE search_docs (
  term               VARCHAR(64)  NOT NULL,
  doc_type           VARCHAR(8)   NOT NULL,
  postings           TEXT         NOT NULL,     -- JSON: [[documentId, tf], ...]
  df                 INT          NOT NULL DEFAULT 0,
  updated_at         {TIMESTAMP} NOT NULL DEFAULT {NOW}
);
CREATE UNIQUE INDEX ux_search_docs ON search_docs (term, doc_type);

-- Служебная: состояние индекса / версия базы знаний.
CREATE TABLE kb_state (
  key                VARCHAR(64)  NOT NULL,
  value              TEXT,
  updated_at         {TIMESTAMP} NOT NULL DEFAULT {NOW}
);
CREATE UNIQUE INDEX ux_kb_state ON kb_state (key);

-- Обратный список «какие термы содержит chunk» — нужен, чтобы при
-- переиндексации версии не сканировать весь search_terms.
CREATE TABLE chunk_terms (
  chunk_id           BIGINT       NOT NULL,
  field              VARCHAR(8)   NOT NULL DEFAULT 'body',
  term               VARCHAR(64)  NOT NULL
);
CREATE UNIQUE INDEX ux_chunk_terms ON chunk_terms (chunk_id, field, term);
CREATE INDEX ix_chunk_terms_term ON chunk_terms (term);
