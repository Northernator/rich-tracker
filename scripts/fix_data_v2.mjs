/**
 * fix_data_v2.mjs — apply the provenance constraints and clear unsourced rows.
 * Run once on Windows:  npm run fix:data2
 *
 * Backs up first. Applies drizzle/0012_provenance_constraints.sql, which:
 *   - rebuilds assets + ownership_links with source_url NOT NULL CHECK http%
 *   - adds a unique index on (asset_id, person_id)   [35 dupes existed]
 *   - adds a unique index on asset identity          [4x "Boeing 747-8" existed]
 *   - drops the dead `billionaires` table
 *   - clears fx_rates (wrong currency pairs — see 0012 comments)
 *
 * The asset graph is left EMPTY on purpose. Refill it with `npm run rebuild`
 * once data/curated/assets.csv + ownership.csv carry resolvable source_urls.
 */
import Database from "better-sqlite3";
import { readFileSync, mkdirSync, existsSync } from "node:fs";
import { join } from "node:path";

const DB = join(process.cwd(), "data", "app.db");
const MIGRATION = join(process.cwd(), "drizzle", "0012_provenance_constraints.sql");

if (!existsSync(DB)) { console.error(`No database at ${DB}`); process.exit(1); }
if (!existsSync(MIGRATION)) { console.error(`Missing ${MIGRATION}`); process.exit(1); }

mkdirSync(join(process.cwd(), "data", "backups"), { recursive: true });
const stamp = new Date().toISOString().replace(/[:.]/g, "-");

const db = new Database(DB);
db.pragma("busy_timeout = 10000");

const backupPath = join(process.cwd(), "data", "backups", `app-${stamp}.db`);
await db.backup(backupPath);
console.log(`backup -> ${backupPath}\n`);

const count = (t) => {
  try { return db.prepare(`SELECT COUNT(*) c FROM "${t}"`).get().c; } catch { return "-"; }
};
const tables = ["assets", "ownership_links", "fx_rates", "billionaires", "people", "equity_holdings", "stock_snapshots", "events"];
const before = Object.fromEntries(tables.map((t) => [t, count(t)]));

// foreign_keys must be OFF while dropping/recreating referenced tables
db.pragma("foreign_keys = OFF");
db.exec(readFileSync(MIGRATION, "utf8"));
db.pragma("foreign_keys = ON");

const fk = db.pragma("foreign_key_check");
if (fk.length) {
  console.warn(`WARNING: ${fk.length} foreign key violations after migration:`);
  console.warn(JSON.stringify(fk.slice(0, 5), null, 1));
}

db.pragma("wal_checkpoint(TRUNCATE)");
db.exec("VACUUM");

const after = Object.fromEntries(tables.map((t) => [t, count(t)]));
console.log("table                before -> after");
for (const t of tables) {
  console.log(`  ${t.padEnd(18)} ${String(before[t]).padStart(6)} -> ${String(after[t]).padStart(6)}`);
}

console.log(`
Constraints now enforced:
  assets.source_url          NOT NULL, must start with http
  ownership_links.source_url NOT NULL, must start with http
  UNIQUE (asset_id, person_id)
  UNIQUE (name, asset_type, location)

The asset graph is empty. That is the correct state until every row in
data/curated/assets.csv and ownership.csv has a source_url that resolves to a
document supporting the claim. Then: npm run rebuild
`);

db.close();
