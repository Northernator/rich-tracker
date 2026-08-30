/**
 * Rebuild: drop → migrate → load raw → load curated → snapshot
 *
 * Full pipeline for a clean database:
 * 1. Drop and recreate data/app.db
 * 2. Apply the baseline SQL schema directly via better-sqlite3
 * 3. Load raw data: slice1 (rtb-api people + estimates)
 * 4. Load curated data: slice2 (holdings + Yahoo prices), slice5 (pledges), slice6 (assets)
 * 5. Seed demo data: slice6b (Forbes estimates), slice8 (events)
 *
 * Run: npm run rebuild
 *
 * Note: This does NOT run the SEC-based loaders (slice10, slice11, slice13)
 * because they require live network access and may be rate-limited.
 * Run them separately after a rebuild if needed:
 *   pnpm exec tsx src/lib/db/load_slice10.ts
 *   pnpm exec tsx src/lib/db/load_slice11.ts
 *   pnpm exec tsx src/lib/db/load_slice13.ts
 */

import { readFileSync, readdirSync, writeFileSync, mkdirSync, rmSync, existsSync } from "fs";
import { join } from "path";
import { execSync } from "child_process";
import Database from "better-sqlite3";

const DB_PATH = join(process.cwd(), "data", "app.db");
const DATA_DIR = join(process.cwd(), "data");
const DRIZZLE_DIR = join(process.cwd(), "drizzle");

/**
 * Every migration in filename order, not just the baseline.
 *
 * Reading only 0000_baseline.sql meant a rebuilt database silently missed
 * 0012 (provenance constraints) and everything after it, so the schema you
 * got from `pnpm rebuild` was not the schema the app ran against.
 */
const MIGRATION_FILES = readdirSync(DRIZZLE_DIR)
  .filter((f) => /^\d{4}_.*\.sql$/.test(f))
  .sort();

// ---------------------------------------------------------------------------
// Step 0: Ensure data directory exists
// ---------------------------------------------------------------------------
mkdirSync(DATA_DIR, { recursive: true });

// ---------------------------------------------------------------------------
// Step 1: Drop existing database (best-effort — skip if locked)
// ---------------------------------------------------------------------------
console.log("Step 1: Dropping existing database...");
try {
  for (const ext of ["", "-shm", "-wal"]) {
    const p = DB_PATH + ext;
    if (existsSync(p)) rmSync(p);
  }
  console.log("  Database dropped.");
} catch (err) {
  console.warn("  Could not drop DB (locked?):", (err as Error).message);
  console.log("  Will attempt migration on existing database.");
}

// ---------------------------------------------------------------------------
// Step 2: Apply baseline SQL schema
// ---------------------------------------------------------------------------
console.log("Step 2: Applying migrations...");
const sqlite = new Database(DB_PATH);
sqlite.pragma("foreign_keys = ON");
for (const f of MIGRATION_FILES) {
  console.log(`  ${f}`);
  sqlite.exec(readFileSync(join(DRIZZLE_DIR, f), "utf8"));
}
// Record what was applied so scripts/apply-migrations.mjs stays in sync.
sqlite.exec(`
  CREATE TABLE IF NOT EXISTS __drizzle_migrations (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    hash       TEXT NOT NULL,
    created_at numeric
  );
`);
const recordMigration = sqlite.prepare(
  "INSERT OR IGNORE INTO __drizzle_migrations (hash, created_at) VALUES (?, ?)"
);
for (const f of MIGRATION_FILES) recordMigration.run(f.replace(/\.sql$/, ""), Date.now());

// Verify tables exist
const tables = sqlite
  .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name")
  .all() as Array<{ name: string }>;
console.log("  Tables created:", tables.map(t => t.name).join(", "));

// Write a simple snapshot for future reference
writeFileSync(
  join(process.cwd(), "data", "schema_snapshot.json"),
  JSON.stringify(
    {
      tables: tables.map(t => t.name),
      migratedAt: new Date().toISOString(),
      migrations: MIGRATION_FILES,
    },
    null,
    2
  )
);
console.log("  Snapshot written.");
sqlite.close();

// ---------------------------------------------------------------------------
// Step 3: Load raw data (rtb-api → people + baseline estimates)
// ---------------------------------------------------------------------------
console.log("Step 3: Loading raw data (slice1 — rtb-api)...");
try {
  execSync(`pnpm exec tsx src/lib/db/load_slice1.ts`, {
    cwd: process.cwd(),
    stdio: "inherit",
  });
} catch (err) {
  console.warn("  slice1 failed (expected if rtb-api is down):", err instanceof Error ? err.message : err);
}

// ---------------------------------------------------------------------------
// Step 4: Load curated data
// ---------------------------------------------------------------------------
console.log("Step 4: Loading curated data...");

console.log("  slice2 — holdings + Yahoo prices...");
try {
  execSync(`pnpm exec tsx src/lib/db/load_slice2.ts`, {
    cwd: process.cwd(),
    stdio: "inherit",
  });
} catch (err) {
  console.warn("  slice2 failed:", err instanceof Error ? err.message : err);
}

console.log("  slice5 — pledge holdings...");
try {
  execSync(`pnpm exec tsx src/lib/db/load_slice5.ts`, {
    cwd: process.cwd(),
    stdio: "inherit",
  });
} catch (err) {
  console.warn("  slice5 failed:", err instanceof Error ? err.message : err);
}

console.log("  slice6 — physical assets...");
try {
  execSync(`pnpm exec tsx src/lib/db/load_slice6.ts`, {
    cwd: process.cwd(),
    stdio: "inherit",
  });
} catch (err) {
  console.warn("  slice6 failed:", err instanceof Error ? err.message : err);
}

// ---------------------------------------------------------------------------
// Step 5: Seed demo data
// ---------------------------------------------------------------------------
console.log("Step 5: Seeding demo data...");

console.log("  slice6b — Forbes estimates...");
try {
  execSync(`pnpm exec tsx src/lib/db/seed_slice6b.ts`, {
    cwd: process.cwd(),
    stdio: "inherit",
  });
} catch (err) {
  console.warn("  slice6b failed:", err instanceof Error ? err.message : err);
}

console.log("  slice8 — demo events...");
try {
  execSync(`pnpm exec tsx src/lib/db/seed_slice8.ts`, {
    cwd: process.cwd(),
    stdio: "inherit",
  });
} catch (err) {
  console.warn("  slice8 failed:", err instanceof Error ? err.message : err);
}

// ---------------------------------------------------------------------------
// Step 6: Summary
// ---------------------------------------------------------------------------
console.log("\nRebuild complete.");
console.log("  DB path:", DB_PATH);
console.log("\nTo load SEC filing data (optional, requires network):");
console.log("  pnpm exec tsx src/lib/db/load_slice10.ts  # 13F-HR holdings");
console.log("  pnpm exec tsx src/lib/db/load_slice11.ts  # real events (USGS, SEC)");
console.log("  pnpm exec tsx src/lib/db/load_slice13.ts  # Form 4 holdings");
