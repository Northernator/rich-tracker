/**
 * Prune synthetic roster — remove people with no verified baseline_estimates.
 *
 * Deletes:
 *  - baseline_estimates where raw_path IS NULL OR NOT LIKE 'data/raw/%'
 *  - people with no remaining baseline_estimates (orphans)
 *
 * Backs up DB via sqlite backup API before mutating.
 */

import Database from "better-sqlite3";
import { join } from "path";

const dbPath = join(process.cwd(), "data", "app.db");
const sqlite = new Database(dbPath);

console.log("Pruning unsourced people...");

// Backup first
const backupName = `data/backups/prune-${Date.now()}.db`;
try {
  const { mkdirSync } = await import("fs");
  mkdirSync(join(process.cwd(), "data", "backups"), { recursive: true });
  await sqlite.backup(backupName);
  console.log(`  Backup created: ${backupName}`);
} catch (e) {
  console.warn(`  Backup failed: ${e.message} — continuing anyway`);
}

const beforePeople = sqlite.prepare("SELECT COUNT(*) as c FROM people").get().c;
const beforeEstimates = sqlite.prepare("SELECT COUNT(*) as c FROM baseline_estimates").get().c;
console.log(`  Before: ${beforePeople} people, ${beforeEstimates} baseline_estimates`);

const delEstimates = sqlite.prepare(`DELETE FROM baseline_estimates WHERE raw_path IS NULL OR raw_path NOT LIKE 'data/raw/%'`).run();
console.log(`  Deleted ${delEstimates.changes} unsourced baseline_estimates (raw_path IS NULL OR NOT LIKE 'data/raw/%')`);

const delPeople = sqlite.prepare(`DELETE FROM people WHERE id NOT IN (SELECT DISTINCT person_id FROM baseline_estimates)`).run();
console.log(`  Deleted ${delPeople.changes} orphan people (no remaining baseline_estimates)`);

const afterPeople = sqlite.prepare("SELECT COUNT(*) as c FROM people").get().c;
const afterEstimates = sqlite.prepare("SELECT COUNT(*) as c FROM baseline_estimates").get().c;
console.log(`  After: ${afterPeople} people, ${afterEstimates} baseline_estimates`);
console.log(`  Pruned ${beforePeople - afterPeople} people, ${beforeEstimates - afterEstimates} estimates`);

sqlite.close();
