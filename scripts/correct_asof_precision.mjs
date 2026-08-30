/**
 * Correct baseline_estimates.as_of for Wikidata rows whose P585 was padded.
 *
 * The loader originally took SPARQL's `pq:P585` at face value. SPARQL
 * normalises every time value to a full xsd:dateTime, so a statement that says
 * only "2025" arrives as "2025-01-01T00:00:00Z" and was stored as 2025-01-01 —
 * asserting a day Wikidata never claimed, and ageing every year-precision
 * figure by up to twelve months.
 *
 * This re-asks Wikidata for the precision of each statement
 * (pqv:P585 → wikibase:timePrecision) and truncates the stored date back to
 * it. Nothing is invented: where Wikidata cannot be reached or the statement
 * cannot be matched, the row is left exactly as it is and counted.
 *
 * Usage:
 *   node scripts/correct_asof_precision.mjs           # report only
 *   node scripts/correct_asof_precision.mjs --apply   # write
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import Database from 'better-sqlite3';

const UA = 'RichTracker/1.0 (net-worth consensus research; taylorc697@gmail.com)';
const APPLY = process.argv.includes('--apply');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function sparql(query, tries = 6) {
  const url = 'https://query.wikidata.org/sparql?format=json&query=' + encodeURIComponent(query);
  let last;
  for (let i = 1; i <= tries; i++) {
    const res = await fetch(url, { headers: { Accept: 'application/sparql-results+json', 'User-Agent': UA } });
    const text = await res.text();
    if (res.ok) return JSON.parse(text).results.bindings;
    last = `HTTP ${res.status}`;
    if (res.status === 429 || res.status >= 500) {
      const wait = Math.min(60000, 2000 * Math.pow(2, i - 1));
      console.error(`  retry ${i}/${tries} (${last}) — waiting ${wait}ms`);
      await sleep(wait);
      continue;
    }
    throw new Error(`SPARQL ${last}: ${text.slice(0, 200)}`);
  }
  throw new Error(`SPARQL failed after ${tries}: ${last}`);
}

function formatAsOf(value, precision) {
  if (!value) return null;
  const m = value.match(/^(-?\d{4,})-(\d{2})-(\d{2})T/);
  if (!m) return null;
  const [, y, mo, d] = m;
  if (precision == null || !Number.isFinite(precision)) return `${y}-${mo}-${d}`;
  if (precision <= 9) return y;
  if (precision === 10) return `${y}-${mo}`;
  return `${y}-${mo}-${d}`;
}

const db = new Database(join(process.cwd(), 'data', 'app.db'));
db.pragma('journal_mode = WAL');

const rows = db
  .prepare(
    `SELECT id, person_id, net_worth_cents, as_of, raw
       FROM baseline_estimates WHERE source_id = 'wikidata'`
  )
  .all();

const qids = [...new Set(rows.map((r) => JSON.parse(r.raw).qid).filter(Boolean))];
console.log(`${rows.length} Wikidata row(s), ${qids.length} distinct QID(s)`);

// Precision for every P585 on those entities.
const precisionIndex = new Map(); // `${qid}|${amountStr}|${year}` -> asOf
const BATCH = 40;
for (let i = 0; i < qids.length; i += BATCH) {
  const slice = qids.slice(i, i + BATCH);
  const values = slice.map((q) => `wd:${q}`).join(' ');
  const bindings = await sparql(`SELECT ?person ?amount ?pointInTime ?timePrecision WHERE {
  VALUES ?person { ${values} }
  ?person p:P2218 ?stmt .
  ?stmt ps:P2218 ?amount .
  OPTIONAL { ?stmt pq:P585 ?pointInTime . }
  OPTIONAL { ?stmt pqv:P585 ?tn . ?tn wikibase:timePrecision ?timePrecision . }
}`);
  for (const b of bindings) {
    const qid = b.person.value.split('/').pop();
    const amount = b.amount.value.replace(/^\+/, '');
    const precision = b.timePrecision ? parseInt(b.timePrecision.value, 10) : null;
    const asOf = formatAsOf(b.pointInTime?.value, precision);
    if (!asOf) continue;
    // SPARQL returns "2025-01-01T00:00:00Z" with no leading "+".
    const year = (b.pointInTime?.value ?? '').slice(0, 4);
    precisionIndex.set(`${qid}|${amount}|${year}`, { asOf, precision });
  }
}
console.log(`resolved ${precisionIndex.size} statement(s) from Wikidata\n`);

const update = db.prepare('UPDATE baseline_estimates SET as_of = ?, raw = ? WHERE id = ?');
const del = db.prepare('DELETE FROM baseline_estimates WHERE id = ?');
const exists = db.prepare(
  'SELECT id FROM baseline_estimates WHERE person_id = ? AND source_id = ? AND as_of = ?'
);

let corrected = 0;
let unchanged = 0;
let unmatched = 0;
let deduped = 0;
const changes = [];

for (const r of rows) {
  let raw;
  try { raw = JSON.parse(r.raw); } catch { unmatched++; continue; }
  const amount = String(raw.amount).replace(/^\+/, '');
  const storedYear = r.as_of.slice(0, 4);
  const hit = precisionIndex.get(`${raw.qid}|${amount}|${storedYear}`);
  if (!hit) { unmatched++; continue; }
  if (hit.asOf === r.as_of) { unchanged++; continue; }

  const newRaw = JSON.stringify({ ...raw, point_in_time: hit.asOf, point_in_time_precision: hit.precision });
  const clash = exists.get(r.person_id, 'wikidata', hit.asOf);
  changes.push({
    id: r.id,
    person_id: r.person_id,
    from: r.as_of,
    to: hit.asOf,
    precision: hit.precision,
    action: clash ? 'delete (duplicate of the corrected row)' : 'update',
  });
  if (clash) deduped++;
  else corrected++;
}

console.log(`would update:   ${corrected}`);
console.log(`would delete:   ${deduped} (row already exists at the corrected date)`);
console.log(`already right:  ${unchanged}`);
console.log(`unmatched:      ${unmatched} (left untouched — Wikidata not authoritative here)`);

const sample = changes.slice(0, 12);
console.log('\nsample:');
for (const c of sample) {
  console.log(`  ${c.from} -> ${c.to} (precision ${c.precision}) [${c.action}]`);
}

if (!APPLY) {
  console.log('\nReport only. Re-run with --apply to write.');
  db.close();
  process.exit(0);
}

const applied = db.transaction(() => {
  let n = 0;
  for (const r of rows) {
    let raw;
    try { raw = JSON.parse(r.raw); } catch { continue; }
    const amount = String(raw.amount).replace(/^\+/, '');
    const hit = precisionIndex.get(`${raw.qid}|${amount}|${r.as_of.slice(0, 4)}`);
    if (!hit || hit.asOf === r.as_of) continue;
    const newRaw = JSON.stringify({ ...raw, point_in_time: hit.asOf, point_in_time_precision: hit.precision });
    const clash = exists.get(r.person_id, 'wikidata', hit.asOf);
    if (clash) del.run(r.id);
    else update.run(hit.asOf, newRaw, r.id);
    n++;
  }
  return n;
})();

const logPath = join(process.cwd(), 'data', 'raw', 'wikidata', 'asof-precision-corrections.jsonl');
writeFileSync(logPath, '', 'utf8');
for (const c of changes) {
  writeFileSync(logPath, JSON.stringify({ corrected_at: new Date().toISOString(), ...c }) + '\n', { flag: 'a' }, 'utf8');
}

console.log(`\nApplied ${applied} change(s). Log: ${logPath}`);
const after = db
  .prepare("SELECT as_of, COUNT(*) n FROM baseline_estimates WHERE source_id='wikidata' GROUP BY as_of ORDER BY n DESC LIMIT 8")
  .all();
console.log('top as_of values now:', after.map((r) => `${r.as_of}(${r.n})`).join(', '));
db.close();
