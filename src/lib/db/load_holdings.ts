/**
 * Additive loader for the curated holdings CSV.
 *
 * Reads data/curated/holdings.csv and inserts each row once, keyed on the
 * (person_id, ticker) natural key. It never deletes — a re-run inserts nothing
 * new, and existing rows are left untouched. This is the standing rule applied
 * to a claims table: DELETE-then-reload is how real history gets destroyed.
 *
 * Every row carries the source_url straight from the CSV (the document that
 * supports the holding), so nothing is ever inserted without a citation.
 *
 * Run: pnpm exec tsx src/lib/db/load_holdings.ts
 */

import { join } from "path";
import { existsSync, readFileSync } from "fs";
import { db } from "@/lib/db";
import { and, eq } from "drizzle-orm";
import { createId } from "@paralleldrive/cuid2";
import { equityHoldings, people } from "@/lib/db/schema";

function readCsv<T extends Record<string, string>>(filePath: string): T[] {
  if (!existsSync(filePath)) throw new Error(`Missing required CSV: ${filePath}`);
  const lines = readFileSync(filePath, "utf8").trim().split("\n");
  const headers = lines[0].split(",").map((h) => h.trim());
  return lines.slice(1).map((line) => {
    const vals = line.split(",").map((v) => v.trim());
    const obj: Record<string, string> = {};
    headers.forEach((h, i) => (obj[h] = vals[i] ?? ""));
    return obj as unknown as T;
  });
}

async function main() {
  const csvPath = join(process.cwd(), "data", "curated", "holdings.csv");
  const rows = readCsv<{
    slug: string;
    ticker: string;
    exchange: string;
    shares: string;
    estimated: string;
    source_url: string;
    source: string;
  }>(csvPath);

  // Resolve slugs once.
  const slugToId = new Map<string, string>();
  for (const p of await db.select({ id: people.id, slug: people.slug }).from(people)) {
    slugToId.set(p.slug, p.id);
  }

  let inserted = 0;
  let already = 0;
  let skipped = 0;

  for (const row of rows) {
    const personId = slugToId.get(row.slug);
    if (!personId) {
      console.warn(`  skip ${row.slug}/${row.ticker}: no person with that slug`);
      skipped++;
      continue;
    }
    if (!row.source_url || !row.source_url.startsWith("http")) {
      throw new Error(
        `holdings/${row.slug}/${row.ticker} has no resolvable source_url — refusing to insert without a citation`
      );
    }

    const existing = await db
      .select({ id: equityHoldings.id })
      .from(equityHoldings)
      .where(and(eq(equityHoldings.personId, personId), eq(equityHoldings.ticker, row.ticker)))
      .limit(1);

    if (existing.length > 0) {
      already++;
      continue;
    }

    const shares = parseInt(row.shares, 10);
    if (!Number.isFinite(shares) || shares <= 0) {
      throw new Error(`holdings/${row.slug}/${row.ticker} has nonsensical shares "${row.shares}"`);
    }

    await db.insert(equityHoldings).values({
      id: createId(),
      personId,
      ticker: row.ticker,
      exchange: row.exchange,
      shares,
      asOf: new Date().toISOString().slice(0, 10),
      estimated: row.estimated === "1" ? 1 : 0,
      source: row.source || null,
      sourceUrl: row.source_url,
      createdAt: new Date().toISOString(),
    });
    inserted++;
    console.log(`  + ${row.slug}: ${row.ticker} x ${shares.toLocaleString()}`);
  }

  console.log(`\nDone. ${inserted} inserted, ${already} already present, ${skipped} skipped.`);
  console.log("  Re-running changes nothing — this loader is additive (check-then-insert, never delete).");
}

main().catch((err) => {
  console.error("Holdings loader failed:", err);
  process.exit(1);
});
