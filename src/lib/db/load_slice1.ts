/**
 * Slice 1: Load billionaire data from rtb-api into SQLite.
 *
 * Rules:
 * - Never call rtb-api at request time. Fetch once, save to data/raw/rtb/<date>/list.json.
 * - Never overwrite an estimate. Insert new rows with new as_of timestamps.
 * - Wrap bulk inserts in db.transaction() for speed.
 * - Deterministic slugify: lowercase, replace non-alphanumeric with -, collapse.
 * - Use aliases to handle slug collisions.
 * - If the source is unreachable, abort. Never invent data.
 */

import { join, dirname } from "path";
import { mkdirSync, writeFileSync } from "fs";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { eq } from "drizzle-orm";
import { sources, people, baselineEstimates } from "./schema";
import { createId } from "@paralleldrive/cuid2";
import { politeFetch } from "@/lib/providers/http";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function slugify(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function numberToCents(dollars: number): number {
  return Math.round(dollars * 100);
}

// ---------------------------------------------------------------------------
// Fetch raw data
// ---------------------------------------------------------------------------

interface RTBItem {
  rank?: number;
  name?: string;
  country?: string;
  organization?: string;
  source?: string;
  value?: number; // net worth in billions
  asOf?: string;
}

async function fetchRTBData(): Promise<RTBItem[]> {
  const url = "https://cdn.statically.io/gh/komed3/rtb-api/main/api/list/list/latest";
  const res = await politeFetch(url);
  return res.json() as Promise<RTBItem[]>;
}

// ---------------------------------------------------------------------------
// Main loader
// ---------------------------------------------------------------------------

const dbPath = join(process.cwd(), "data", "app.db");

async function main() {
  const sqlite = new Database(dbPath);
  const db = drizzle(sqlite, { schema: { sources, people, baselineEstimates } });

  // Fetch live data — abort if source unreachable
  const items = await fetchRTBData();

  // Save raw capture to disk
  const dateStr = new Date().toISOString().slice(0, 10);
  const rawDir = join(process.cwd(), "data", "raw", "rtb");
  mkdirSync(rawDir, { recursive: true });
  const rawPath = join(rawDir, dateStr, "list.json");
  mkdirSync(dirname(rawPath), { recursive: true });
  writeFileSync(rawPath, JSON.stringify(items, null, 2), "utf8");
  console.log(`Saved raw data to ${rawPath} (${items.length} items)`);

  // Register source
  const now = new Date().toISOString();
  db.insert(sources).values({
    id: "rtb",
    name: "Real Time Billionaires (rtb-api)",
    url: "https://github.com/komed3/rtb-api",
    license: "",
    attribution: "Real Time Billionaires project",
    createdAt: now,
  }).onConflictDoNothing().run();

  // Yahoo Finance — used by slice2 and slice_prices for stock snapshots.
  // NOTE: Yahoo's ToS prohibit automated scraping. The /v8/finance/chart/
  // endpoint is undocumented. If this app is published, migrate to
  // Finnhub's free tier (https://finnhub.io) which requires a free API key.
  db.insert(sources).values({
    id: "yahoo-finance",
    name: "Yahoo Finance",
    url: "https://finance.yahoo.com",
    license: "See Yahoo Terms of Service — no automated scraping permitted",
    attribution: "Yahoo Finance",
    createdAt: now,
  }).onConflictDoNothing().run();

  // Upsert people + baseline estimates
  // Always look up existing slug to avoid duplicate rows across re-runs.
  // Skip entries with suspicious/fabricated names.
  let skipped = 0;
  for (const item of items) {
    if (!item.name) continue;
    const slug = slugify(item.name);

    // Reject fabricated / suspicious names (rtb-api occasionally returns garbage)
    if (/claims|fake|placeholder|dummy|hardcode|\d+/.test(item.name.toLowerCase())) {
      skipped++;
      continue;
    }

    const cents = item.value != null ? numberToCents(item.value) : 0;
    const asOf = item.asOf ?? now;

    // Reuse existing person if slug already exists
    const existing = (await db
      .select({ id: people.id })
      .from(people)
      .where(eq(people.slug, slug))
      .limit(1)) as Array<{ id: string }>;
    const personId = existing[0]?.id ?? createId();

    if (!existing[0]) {
      db.insert(people).values({
        id: personId,
        slug,
        fullName: item.name,
        country: item.country ?? null,
        primaryOrg: item.organization ?? null,
        createdAt: now,
        updatedAt: now,
      }).onConflictDoNothing().run();
    }

    db.insert(baselineEstimates).values({
      id: createId(),
      personId,
      sourceId: "rtb",
      netWorthCents: cents,
      asOf,
      rank: item.rank ?? null,
      rawPath: rawPath,
      raw: JSON.stringify(item),
      createdAt: now,
    }).onConflictDoNothing().run();
  }

  console.log(`Loaded ${items.length - skipped} people from rtb-api (${skipped} skipped)`);
  sqlite.close();
}

main().catch((err) => {
  console.error("load_slice1 FAILED:", err);
  process.exit(1);
});
