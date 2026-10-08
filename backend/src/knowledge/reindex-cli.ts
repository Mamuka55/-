/**
 * CLI полной переиндексации поискового индекса.
 *
 *   npm run kb:reindex
 *
 * Используется после смены алгоритма токенизации/стемминга или после
 * восстановления базы из бэкапа. Не обращается к сети.
 */
import { migrate, seed } from '../db/migrate.js';
import { getDb, closeDb, type Row } from '../db/index.js';
import { indexChunk } from './search.js';
import { bumpKbVersion } from '../ai/rag/retrieval.js';

async function main() {
  await migrate();
  await seed();
  const db = await getDb();

  await db.run('DELETE FROM chunk_terms');
  await db.run('DELETE FROM search_terms');
  await db.run('DELETE FROM search_docs');

  const rows = await db.all<Row>(
    `SELECT c.id, c.heading, c.content, d.doc_type
       FROM document_chunks c JOIN documents d ON d.id = c.document_id
      WHERE c.is_current = 1 AND d.status = 'active'`,
  );
  console.log(`[epic-ai] reindex: ${rows.length} chunks`);
  let i = 0;
  for (const r of rows) {
    i++;
    if (i % 200 === 0) console.log(`  … ${i}/${rows.length}`);
    await indexChunk({
      chunkId: Number(r.id),
      docType: String(r.doc_type) === 'LAW' ? 'LAW' : 'RULE',
      heading: r.heading == null ? null : String(r.heading),
      content: String(r.content),
    });
  }
  const terms = Number((await db.get<Row>('SELECT COUNT(*) AS c FROM search_terms'))?.c ?? 0);
  const version = await bumpKbVersion();
  console.log(`[epic-ai] done: ${rows.length} chunks, ${terms} terms, kb version ${version}`);
  await closeDb();
}

main().catch(async (e) => { console.error(e); await closeDb(); process.exit(1); });
