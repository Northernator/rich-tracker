/**
 * One-time data cleanup for the people roster.
 *
 * Fixes:
 * 1. Removes "MacKay Claims" — fabricated name from corrupted rtb-api response
 *    (real person is MacKenzie Scott, already in DB)
 * 2. Deduplicates 11 people who had duplicate rows from rtb-api
 *    (keeps the non-suffixed slug, deletes the -1 version)
 * 3. Fixes 6 country mismatches from rtb-api (Russia/USA swap, Germany→India, etc.)
 *
 * Run: npx tsx src/lib/db/cleanup_people.ts
 */

import Database from "better-sqlite3";
import { join } from "path";
import { db } from "@/lib/db";
import { sql } from "drizzle-orm";

const sqlite = new Database(join(process.cwd(), "data", "app.db"));
sqlite.pragma("foreign_keys = ON");
const safeDb = db;

function log(msg: string) {
  console.log(`[cleanup] ${msg}`);
}

function main() {
  // --------------------------------------------------------------------------
  // 1. Remove "MacKay Claims" and its estimate
  // --------------------------------------------------------------------------
  const mackay = sqlite.prepare("SELECT id FROM people WHERE full_name = 'MacKay Claims'").get() as
    | { id: string }
    | undefined;
  if (mackay) {
    sqlite.prepare("DELETE FROM baseline_estimates WHERE person_id = ?").run(mackay.id);
    sqlite.prepare("DELETE FROM people WHERE id = ?").run(mackay.id);
    log(`Removed "MacKay Claims" (id=${mackay.id})`);
  } else {
    log(`"MacKay Claims" not found — already removed`);
  }

  // --------------------------------------------------------------------------
  // 2. Deduplicate: keep non-suffixed slug, delete -1 slug
  // --------------------------------------------------------------------------
  const dupes = sqlite
    .prepare(
      `SELECT p1.id as keep_id, p2.id as delete_id, p1.full_name
       FROM people p1
       JOIN people p2 ON p1.full_name = p2.full_name
         AND p1.slug NOT LIKE '%-1'
         AND p2.slug LIKE '%-1'`
    )
    .all() as Array<{ keep_id: string; delete_id: string; full_name: string }>;

  log(`Found ${dupes.length} duplicate pairs`);

  const delEst = sqlite.prepare("DELETE FROM baseline_estimates WHERE person_id = ?");
  const delPeople = sqlite.prepare("DELETE FROM people WHERE id = ?");

  for (const d of dupes) {
    delEst.run(d.delete_id);
    delPeople.run(d.delete_id);
    log(`Deduped "${d.full_name}": kept ${d.keep_id}, removed ${d.delete_id}`);
  }

  // --------------------------------------------------------------------------
  // 3. Fix country mismatches
  // --------------------------------------------------------------------------
  const countryFixes: Array<[string, string]> = [
    ["Dieter Schwarz", "Germany"],
    ["Giovanni Ferrero", "Italy"],
    ["John Mars", "USA"],
    ["Lee Shau Kee", "Hong Kong"],
    ["Gennady Timchenko", "Russia"],
    ["German Gref", "Russia"],
  ];

  for (const [name, country] of countryFixes) {
    const row = sqlite.prepare("SELECT id, country FROM people WHERE full_name = ?").get(name) as
      | { id: string; country: string | null }
      | undefined;
    if (row && row.country !== country) {
      sqlite.prepare("UPDATE people SET country = ? WHERE id = ?").run(country, row.id);
      log(`Fixed "${name}": ${row.country} → ${country}`);
    } else if (row) {
      log(`"${name}" country already correct: ${row.country}`);
    }
  }

  // --------------------------------------------------------------------------
  // Summary
  // --------------------------------------------------------------------------
  const peopleCount = sqlite.prepare("SELECT COUNT(*) as cnt FROM people").get() as { cnt: number };
  const estCount = sqlite.prepare("SELECT COUNT(*) as cnt FROM baseline_estimates").get() as {
    cnt: number;
  };
  const dupCheck = sqlite
    .prepare(
      `SELECT COUNT(*) as cnt FROM people p1
       JOIN people p2 ON p1.full_name = p2.full_name
         AND p1.id < p2.id`
    )
    .get() as { cnt: number };

  log(`Done. People: ${peopleCount.cnt}, Estimates: ${estCount.cnt}, Remaining duplicates: ${dupCheck.cnt}`);
}

main();
