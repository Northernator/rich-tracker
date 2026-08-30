/**
 * Remove baseline_estimates rows that fail the claim-date plausibility gate
 * added in Phase 1 Chunk 3.
 *
 * Two rows currently in the database carry a P585 that is a typo rather than a
 * date ("0024-09-24", "0018-05-20"). They were inserted before the gate
 * existed. They are not reloaded and not corrected — the true date is
 * unknowable, and inventing 2024 from "0024" is the failure mode this project
 * is built to prevent — so they are removed and recorded here.
 *
 * This is a one-off, targeted correction, not a loader. It is deliberately
 * narrow: it only ever touches rows that fail the same gate the loader now
 * applies, it prints every row before touching anything, and it does nothing
 * at all without --apply.
 *
 * Usage:
 *   node scripts/prune_implausible_baselines.mjs           # report only
 *   node scripts/prune_implausible_baselines.mjs --apply   # delete
 */
import { appendFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import Database from 'better-sqlite3';

const EARLIEST = Date.UTC(1990, 0, 1);
const LATEST = Date.now() + 86_400_000;
const apply = process.argv.includes('--apply');

const db = new Database(join(process.cwd(), 'data', 'app.db'));
db.pragma('foreign_keys = ON');
db.pragma('journal_mode = WAL');

const rows = db
  .prepare(
    `SELECT b.id, b.person_id, b.source_id, b.net_worth_cents, b.as_of, b.raw,
            p.slug, p.full_name
       FROM baseline_estimates b
       JOIN people p ON p.id = b.person_id`
  )
  .all();

const bad = rows.filter((r) => {
  const ms = Date.parse(`${r.as_of.slice(0, 10)}T00:00:00Z`);
  return !Number.isFinite(ms) || ms < EARLIEST || ms > LATEST;
});

console.log(`${rows.length} baseline_estimates row(s) checked`);
console.log(`${bad.length} fail the claim-date plausibility gate (1990-01-01 … today):\n`);

for (const r of bad) {
  let raw = {};
  try { raw = JSON.parse(r.raw ?? '{}'); } catch { /* raw is opaque by design */ }
  console.log(`  ${r.full_name} (${r.slug})`);
  console.log(`    source=${r.source_id}  as_of=${r.as_of}  cents=${r.net_worth_cents}`);
  console.log(`    reference=${raw.reference_url ?? '(none)'}  id=${r.id}`);
}

if (bad.length === 0) {
  console.log('\nNothing to remove.');
  db.close();
  process.exit(0);
}

if (!apply) {
  console.log('\nReport only. Re-run with --apply to remove these rows.');
  db.close();
  process.exit(0);
}

const del = db.prepare('DELETE FROM baseline_estimates WHERE id = ?');
const removed = db.transaction((list) => {
  const out = [];
  for (const r of list) {
    del.run(r.id);
    out.push(r);
  }
  return out;
})(bad);

// Keep a record of what was removed and why — the audit trail outlives the row.
const dir = join(process.cwd(), 'data', 'raw', 'wikidata');
mkdirSync(dir, { recursive: true });
const logPath = join(dir, 'removed-implausible-dates.jsonl');
for (const r of removed) {
  appendFileSync(
    logPath,
    JSON.stringify({
      removed_at: new Date().toISOString(),
      reason: 'P585 point in time fails the 1990-01-01…today plausibility gate',
      person_id: r.person_id,
      slug: r.slug,
      full_name: r.full_name,
      source_id: r.source_id,
      as_of: r.as_of,
      net_worth_cents: r.net_worth_cents,
      estimate_id: r.id,
    }) + '\n',
    'utf8'
  );
}

console.log(`\nRemoved ${removed.length} row(s). Recorded in ${logPath}`);
const after = db
  .prepare('SELECT COUNT(*) AS c FROM baseline_estimates')
  .get();
console.log(`baseline_estimates now holds ${after.c} row(s).`);
db.close();
