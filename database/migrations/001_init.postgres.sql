-- 001_init.postgres.sql — PostgreSQL-специфичные дополнения.
-- В PostgreSQL есть встроенная русская морфология ('russian' text search config),
-- поэтому полнотекстовый поиск здесь работает лучше, чем в SQLite.

ALTER TABLE document_chunks ADD COLUMN IF NOT EXISTS search_tsv tsvector
  GENERATED ALWAYS AS (
    setweight(to_tsvector('russian', coalesce(heading, '')), 'A') ||
    setweight(to_tsvector('russian', coalesce(content, '')), 'B')
  ) STORED;

CREATE INDEX IF NOT EXISTS ix_chunks_tsv ON document_chunks USING GIN (search_tsv);

ALTER TABLE documents ADD COLUMN IF NOT EXISTS search_tsv tsvector
  GENERATED ALWAYS AS (
    setweight(to_tsvector('russian', coalesce(title, '')), 'A') ||
    setweight(to_tsvector('russian', coalesce(section, '')), 'B')
  ) STORED;

CREATE INDEX IF NOT EXISTS ix_documents_tsv ON documents USING GIN (search_tsv);

-- Опционально: pgvector. Раскомментируйте, если расширение установлено на VPS.
-- CREATE EXTENSION IF NOT EXISTS vector;
-- ALTER TABLE document_chunks ADD COLUMN IF NOT EXISTS embedding_vec vector(768);
-- CREATE INDEX IF NOT EXISTS ix_chunks_embedding ON document_chunks USING ivfflat (embedding_vec vector_cosine_ops);
