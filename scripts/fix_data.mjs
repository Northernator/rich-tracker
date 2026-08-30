/**
 * fix_data.mjs — data remediation pass (run on Windows: `npm run fix:data`)
 *
 * Removes fabricated rows that survived R0–R7 and normalises fields that were
 * loaded wrong. Every deletion below was verified against the live database:
 * the rows are LLM-invented, not sourced. See REVIEW_AND_ROADMAP_V3.md.
 *
 * Makes a timestamped backup before touching anything.
 */
import Database from "better-sqlite3";
import { copyFileSync, mkdirSync, existsSync } from "node:fs";
import { join } from "node:path";

const DB = join(process.cwd(), "data", "app.db");
const BACKUP_DIR = join(process.cwd(), "data", "backups");

if (!existsSync(DB)) {
  console.error(`No database at ${DB}`);
  process.exit(1);
}

mkdirSync(BACKUP_DIR, { recursive: true });
const stamp = new Date().toISOString().replace(/[:.]/g, "-");

const db = new Database(DB);
db.pragma("foreign_keys = ON");
db.pragma("busy_timeout = 10000");

// Safe hot backup (works on a live WAL database, unlike copying the file).
const backupPath = join(BACKUP_DIR, `app-${stamp}.db`);
await db.backup(backupPath);
console.log(`backup written -> ${backupPath}\n`);

const count = (t) => {
  try {
    return db.prepare(`SELECT COUNT(*) c FROM "${t}"`).get().c;
  } catch {
    return "n/a";
  }
};

const before = {
  assets: count("assets"),
  ownership_links: count("ownership_links"),
  pledge_holdings: count("pledge_holdings"),
  equity_holdings: count("equity_holdings"),
  people: count("people"),
};

const run = db.transaction(() => {
  // ---------------------------------------------------------------------
  // 1. Fabricated asset graph.
  //    Verified false: "1 Wall Street — JPMorgan Chase HQ, Trump ownership
  //    stake" (1 Wall Street is the former BNY building, now residential;
  //    JPMorgan's HQ is 270 Park Ave). "Greenbytes Ranch", "The Spearwood
  //    Estate" and the United-Airlines A380 do not exist. "Rising Sun" is
  //    not Arnault's. Citations like "APN 053-290-014" are invented, and
  //    carry confidence:'high'. None of this can stay.
  // ---------------------------------------------------------------------
  db.prepare("DELETE FROM ownership_links").run();
  db.prepare("DELETE FROM assets").run();

  // ---------------------------------------------------------------------
  // 2. Fabricated pledges. Round numbers (130M/85M/45M) with invented
  //    accession numbers, and evidence_text that describes a filing rather
  //    than quoting one. Pledges live in DEF 14A, not Form 4.
  // ---------------------------------------------------------------------
  db.prepare("DELETE FROM pledge_holdings").run();

  // ---------------------------------------------------------------------
  // 3. Mangled 13F holdings. The parser took the issuer-NAME column and
  //    truncated it to 6 chars ("ALLYFI", "ALPHAB", "APPLEI"), so these
  //    never join to a price. They are also Berkshire's institutional
  //    positions (CIK 1067983) attributed to individuals. Keep only rows
  //    whose ticker actually resolves to a quoted price.
  // ---------------------------------------------------------------------
  db.prepare(`
    DELETE FROM equity_holdings
    WHERE ticker NOT IN (SELECT DISTINCT ticker FROM stock_snapshots)
  `).run();

  // ---------------------------------------------------------------------
  // 4. primary_org is "Tesla" for all 102 people — a loader bug that made
  //    every profile read "Bernard Arnault · France · Tesla". A blank field
  //    is honest; a wrong one is not.
  // ---------------------------------------------------------------------
  db.prepare("UPDATE people SET primary_org = NULL WHERE primary_org = 'Tesla'").run();

  // ---------------------------------------------------------------------
  // 5. Estates of deceased people are not billionaires. "Paul Allen Estate"
  //    ($210B, rank 4) came from the original synthetic name list.
  // ---------------------------------------------------------------------
  db.prepare(`
    DELETE FROM baseline_estimates
    WHERE person_id IN (SELECT id FROM people WHERE full_name LIKE '%Estate%')
  `).run();
  db.prepare("DELETE FROM people WHERE full_name LIKE '%Estate%'").run();

  // ---------------------------------------------------------------------
  // 6. Legacy/leftover tables.
  // ---------------------------------------------------------------------
  db.exec("DROP TABLE IF EXISTS billionaires");
  db.exec("DROP TABLE IF EXISTS __new_events");
  db.exec("DROP TABLE IF EXISTS __new_people");
});

run();

db.pragma("wal_checkpoint(TRUNCATE)");
db.exec("VACUUM");

const after = {
  assets: count("assets"),
  ownership_links: count("ownership_links"),
  pledge_holdings: count("pledge_holdings"),
  equity_holdings: count("equity_holdings"),
  people: count("people"),
};

console.log("table               before -> after");
for (const k of Object.keys(before)) {
  console.log(`  ${k.padEnd(18)} ${String(before[k]).padStart(5)} -> ${String(after[k]).padStart(5)}`);
}
console.log("\nDropped: billionaires, __new_events, __new_people");
console.log("Cleared: people.primary_org (was 'Tesla' for all 102)");
console.log("\nDone. The asset graph is now empty — rebuild it from real");
console.log("registries (Land Registry, county assessors, FAA, ICIJ) with a");
console.log("source_url on every row. See REVIEW_AND_ROADMAP_V3.md, slice D2.");

db.close();
