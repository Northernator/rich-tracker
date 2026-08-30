/**
 * Slice 4: Seed a second source (Forbes) with realistic offset estimates.
 *
 * Realistic model: Forbes and RTB API disagree by 5–15% on individual estimates.
 * The offset is deterministic per person (seeded by hash of slug) so re-runs
 * produce the same data. We only seed the top 30 by current RTB estimate to
 * keep the demo focused — the query already handles any number of sources.
 */

import Database from "better-sqlite3";
import { join } from "path";

const dbPath = join(process.cwd(), "data", "app.db");
const sqlite = new Database(dbPath);

// ---------------------------------------------------------------------------
// Deterministic hash → offset in [-15%, +15%]
// ---------------------------------------------------------------------------

function slugHash(slug: string): number {
  let h = 0;
  for (let i = 0; i < slug.length; i++) {
    h = (Math.imul(31, h) + slug.charCodeAt(i)) | 0;
  }
  return h;
}

function offsetFor(slug: string): number {
  // Map hash to [-15, 15]
  const h = Math.abs(slugHash(slug));
  return ((h % 3001) - 1500) / 100; // −15.00 to +15.00
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

// Check if Forbes source already exists
const existing = sqlite.prepare("SELECT COUNT(*) as cnt FROM sources WHERE id = ?").get("forbes") as { cnt: number };
if (existing.cnt > 0) {
  console.log("Forbes source already seeded. Skipping.");
  sqlite.close();
  process.exit(0);
}

// Insert Forbes source
sqlite
  .prepare(
    `INSERT INTO sources (id, name, url, license, attribution, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`
  )
  .run(
    "forbes",
    "Forbes",
    "https://www.forbes.com/real-time-billionaires/",
    "Customs",
    "Forbes Real-Time Billionaires List",
    new Date().toISOString()
  );

// Get latest RTB estimates for top 30 people
const rtbEstimates = sqlite
  .prepare(`
    SELECT p.id as person_id, p.slug, p.full_name, be.net_worth_cents
    FROM baseline_estimates be
    JOIN people p ON p.id = be.person_id
    WHERE be.source_id = 'rtb-api'
      AND be.as_of = (
        SELECT MAX(be2.as_of)
        FROM baseline_estimates be2
        WHERE be2.person_id = be.person_id AND be2.source_id = 'rtb-api'
      )
    ORDER BY be.net_worth_cents DESC
    LIMIT 30
  `)
  .all() as Array<{ person_id: string; slug: string; full_name: string; net_worth_cents: number }>;

console.log(`Seeding ${rtbEstimates.length} Forbes estimates...`);

const insert = sqlite.prepare(`
  INSERT OR IGNORE INTO baseline_estimates (id, person_id, source_id, net_worth_cents, as_of, rank, created_at)
  VALUES (?, ?, ?, ?, ?, ?, ?)
`);

const now = new Date().toISOString();
let seeded = 0;

for (const est of rtbEstimates) {
  const off = offsetFor(est.slug);
  // Forbes estimate = RTB estimate × (1 + off)
  const forbesCents = Math.round(est.net_worth_cents * (1 + off / 100));
  const id = `${est.person_id}-forbes-${now}`;

  insert.run(id, est.person_id, "forbes", forbesCents, now, null, now);
  seeded++;
  console.log(
    `  ${est.slug}: RTB=$${(est.net_worth_cents / 1e9).toFixed(1)}B → Forbes=$${(forbesCents / 1e9).toFixed(1)}B (${off >= 0 ? "+" : ""}${off.toFixed(1)}%)`
  );
}

console.log(`Seeded ${seeded} Forbes estimates.`);
sqlite.close();
