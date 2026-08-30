/**
 * Apply pending migrations from drizzle/ in filename order.
 *
 * Why this exists: `__drizzle_migrations` is empty in data/app.db, and the
 * meta snapshot (drizzle/meta/0000_snapshot.json) predates 0012, so
 * `drizzle-kit generate` currently refuses to run and `drizzle-kit migrate`
 * would replay 0012 against live tables. Migrations in this project are
 * applied by executing the SQL files, and this script does that with a ledger
 * so a migration can never be applied twice.
 *
 * Usage:
 *   node scripts/apply-migrations.mjs          # apply pending
 *   node scripts/apply-migrations.mjs --dry    # show pending, change nothing
 *   node scripts/apply-migrations.mjs --record 0012_provenance_constraints
 *                                              # record as already applied
 *                                              # (DDL verified in the live DB
 *                                              # before this ledger existed)
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import Database from 'better-sqlite3';

const DB_PATH = join(process.cwd(), 'data', 'app.db');
const DIR = join(process.cwd(), 'drizzle');
const dry = process.argv.includes('--dry');

const files = readdirSync(DIR)
  .filter((f) => /^\d{4}_.*\.sql$/.test(f))
  .sort();

if (files.length === 0) {
  console.error('No migration files found in drizzle/');
  process.exit(1);
}

const recordOnly = [];
for (let i = 0; i < process.argv.length; i++) {
  if (process.argv[i] === '--record' && process.argv[i + 1]) recordOnly.push(process.argv[i + 1]);
}

const db = new Database(DB_PATH);
db.pragma('foreign_keys = ON');
db.pragma('journal_mode = WAL');

// Use drizzle's own ledger shape so this stays compatible with drizzle tooling:
// the migration tag goes in `hash`, same as drizzle-kit migrate does.
db.exec(`
  CREATE TABLE IF NOT EXISTS __drizzle_migrations (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    hash       TEXT NOT NULL,
    created_at numeric
  );
`);

if (recordOnly.length > 0) {
  const insert = db.prepare('INSERT OR IGNORE INTO __drizzle_migrations (hash, created_at) VALUES (?, ?)');
  for (const tag of recordOnly) {
    if (!files.some((f) => f === `${tag}.sql`)) {
      console.error(`Refusing to record "${tag}": no such file in drizzle/`);
      db.close();
      process.exit(1);
    }
    insert.run(tag, Date.now());
    console.log(`Recorded ${tag} as already applied (no SQL executed).`);
  }
  db.close();
  process.exit(0);
}

const applied = new Set(db.prepare('SELECT hash FROM __drizzle_migrations').all().map((r) => r.hash));
const pending = files.filter((f) => !applied.has(f.replace(/\.sql$/, '')));

console.log(`drizzle/: ${files.length} migration file(s), ${applied.size} applied, ${pending.length} pending`);

if (pending.length === 0) {
  console.log('Nothing to do.');
  db.close();
  process.exit(0);
}

for (const f of pending) {
  console.log(`  PENDING ${f}`);
}
if (dry) {
  db.close();
  process.exit(0);
}

const insert = db.prepare('INSERT INTO __drizzle_migrations (hash, created_at) VALUES (?, ?)');

for (const f of pending) {
  const tag = f.replace(/\.sql$/, '');
  const sql = readFileSync(join(DIR, f), 'utf8');
  console.log(`\nApplying ${f} …`);
  try {
    db.exec('BEGIN');
    db.exec(sql);
    insert.run(tag, Date.now());
    db.exec('COMMIT');
    console.log(`  applied ${tag}`);
  } catch (err) {
    db.exec('ROLLBACK');
    console.error(`  FAILED ${tag}: ${err.message}`);
    console.error('  Database left unchanged — migration is atomic.');
    db.close();
    process.exit(1);
  }
}

const after = db.prepare('SELECT hash, created_at FROM __drizzle_migrations ORDER BY id').all();
console.log('\nApplied migrations:');
for (const r of after) console.log(`  ${r.hash}  ${new Date(r.created_at).toISOString()}`);
db.close();
