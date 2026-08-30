/**
 * Backfill baseline_estimates.source_url for rows loaded before the column
 * existed (migration 0013).
 *
 * The URL is taken from the sibling .meta.json of each row's raw capture —
 * the exact endpoint the payload came from. It is never constructed, guessed
 * or defaulted. Rows whose capture has no readable meta (or no http 200) are
 * left NULL and counted, so the loader's own gap is visible rather than
 * papered over.
 *
 * Usage: node scripts/backfill_baseline_source_url.mjs
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import Database from 'better-sqlite3';

const db = new Database(join(process.cwd(), 'data', 'app.db'));
db.pragma('journal_mode = WAL');

const paths = db
  .prepare(
    `SELECT DISTINCT raw_path FROM baseline_estimates
      WHERE source_url IS NULL AND raw_path IS NOT NULL AND raw_path <> ''`
  )
  .all()
  .map((r) => r.raw_path);

console.log(`${paths.length} distinct raw_path value(s) to resolve`);

const update = db.prepare(
  `UPDATE baseline_estimates SET source_url = ? WHERE source_url IS NULL AND raw_path = ?`
);

let filled = 0;
const unresolved = [];

for (const rel of paths) {
  const abs = join(process.cwd(), rel);
  const metaPath = abs.replace(/\.json$/, '.meta.json');
  if (!existsSync(metaPath)) {
    unresolved.push({ rel, why: 'no sibling .meta.json' });
    continue;
  }
  let meta;
  try {
    meta = JSON.parse(readFileSync(metaPath, 'utf8'));
  } catch (err) {
    unresolved.push({ rel, why: `unreadable meta: ${err.message}` });
    continue;
  }
  if (meta.http_status !== 200) {
    unresolved.push({ rel, why: `meta http_status ${meta.http_status}` });
    continue;
  }
  if (typeof meta.url !== 'string' || !/^https?:\/\//.test(meta.url)) {
    unresolved.push({ rel, why: 'meta has no resolvable url' });
    continue;
  }
  const { changes } = update.run(meta.url, rel);
  console.log(`  ${rel} -> ${meta.url}  (${changes} row(s))`);
  filled += changes;
}

console.log(`\nBackfilled ${filled} row(s).`);
const stillNull = db
  .prepare('SELECT COUNT(*) AS c FROM baseline_estimates WHERE source_url IS NULL')
  .get();
console.log(`Rows still without a source_url: ${stillNull.c}`);
if (unresolved.length > 0) {
  console.log('\nUnresolved captures (left NULL, not invented):');
  for (const u of unresolved) console.log(`  ${u.rel} — ${u.why}`);
}

const bySource = db
  .prepare(
    `SELECT source_id, COUNT(*) AS n, SUM(source_url IS NULL) AS missing
       FROM baseline_estimates GROUP BY source_id`
  )
  .all();
console.log('\nPer source:');
for (const r of bySource) console.log(`  ${r.source_id}: ${r.n} rows, ${r.missing} missing url`);

db.close();
