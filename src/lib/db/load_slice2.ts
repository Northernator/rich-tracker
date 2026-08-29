/**
 * Slice 2: Liquid equity — holdings × live price
 *
 * Loads from data/curated/holdings.csv and data/curated/securities.csv.
 * Every row must have a non-empty source_url or the loader aborts.
 *
 * Currency handling:
 *   - Securities table stores currency per ticker/exchange (USD default).
 *   - FX rates fetched via FxProvider (frankfurter.app / ECB, no key required).
 *   - Equity holding values are converted to USD cents before insertion.
 *   - Stock snapshots record their currency so price → cents is unambiguous.
 */

import { join } from "path";
import { existsSync, readFileSync } from "fs";
import { db } from "@/lib/db";
import { eq, and } from "drizzle-orm";
import * as schema from "./schema";
import { createId } from "@paralleldrive/cuid2";
import { getFxProvider, getPriceProvider } from "@/lib/providers/registry";

// ---------------------------------------------------------------------------
// CSV helpers
// ---------------------------------------------------------------------------

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

function assertSourceUrl(url: string, context: string): void {
  if (!url || !url.startsWith("http")) {
    throw new Error(`source_url missing or invalid (${JSON.stringify(url)}) in ${context} — no fabrication`);
  }
}

// ---------------------------------------------------------------------------
// FX rate cache — loaded once at startup via provider
// ---------------------------------------------------------------------------

interface FxCache {
  [key: string]: number; // "INR" -> rate (1 INR = ? USD)
}

const FX_CACHE: FxCache = {};

async function loadFxRates(): Promise<void> {
  const fx = getFxProvider();
  const rates = await fx.ratesToUsd();
  // fx.ratesToUsd returns 1 unit -> USD, already inverted by provider.
  // Persist rate validity check: ensure USD present.
  if (rates["USD"] !== 1) throw new Error("FX provider did not return USD=1");

  for (const [currency, rate] of Object.entries(rates)) {
    if (!Number.isFinite(rate) || rate <= 0) {
      throw new Error(`Nonsensical FX rate for ${currency}: ${rate}`);
    }
    FX_CACHE[currency] = rate;
  }
  console.log("  FX rates loaded (1 unit -> USD):", Object.keys(FX_CACHE).join(", "));

  // Persist one row per currency PER DAY, so a historical snapshot can be
  // converted at the rate that applied then.
  const asOf = new Date().toISOString().slice(0, 10);
  const sourceUrl = "https://api.frankfurter.app/latest?base=USD";
  for (const [currency, rate] of Object.entries(FX_CACHE)) {
    if (currency === "USD") continue;
    const existing = await db
      .select()
      .from(schema.fxRates)
      .where(and(eq(schema.fxRates.base, currency), eq(schema.fxRates.asOf, asOf)))
      .limit(1);
    if (existing.length === 0) {
      await db.insert(schema.fxRates).values({
        base: currency,
        quote: "USD",
        asOf,
        rate,
        sourceUrl,
        createdAt: new Date().toISOString(),
      });
    }
  }
}

function getFxRate(currency: string): number {
  if (currency === "USD") return 1;
  const rate = FX_CACHE[currency];
  if (rate == null) {
    // Silently treating an unknown currency as USD is how a rupee-denominated
    // holding gets valued 85x too high with no error anywhere.
    throw new Error(`No FX rate for "${currency}" — refusing to assume parity with USD`);
  }
  return rate;
}

// ---------------------------------------------------------------------------
// Securities registry — backfill from CSV
// ---------------------------------------------------------------------------

async function loadSecurities(): Promise<void> {
  const rows = readCsv<{ ticker: string; exchange: string; name: string; currency: string; cik: string; source_url: string }>(
    join(process.cwd(), "data", "curated", "securities.csv"),
  );
  for (const row of rows) {
    assertSourceUrl(row.source_url, `securities/${row.ticker}`);
    const [existing] = await db
      .select()
      .from(schema.securities)
      .where(eq(schema.securities.ticker, row.ticker))
      .limit(1);
    if (existing) continue;
    await db.insert(schema.securities).values({
      id: createId(),
      ticker: row.ticker,
      exchange: row.exchange,
      name: row.name || null,
      currency: row.currency || "USD",
      cik: row.cik && row.cik !== "NA" ? row.cik : null,
      sourceUrl: row.source_url,
      createdAt: new Date().toISOString(),
    });
  }
  console.log(`  Securities loaded: ${rows.length} rows`);
}

async function getSecurityCurrency(ticker: string): Promise<string> {
  const result = await db
    .select({ currency: schema.securities.currency })
    .from(schema.securities)
    .where(eq(schema.securities.ticker, ticker))
    .limit(1);
  return result[0]?.currency ?? "USD";
}

// ---------------------------------------------------------------------------
// Price history via PriceProvider (yahoo | finnhub)
// ---------------------------------------------------------------------------

async function fetchHistoryViaProvider(
  ticker: string,
  days: number = 90
): Promise<Array<{ date: string; priceCents: number; currency: string }>> {
  const provider = getPriceProvider();
  const toISO = new Date().toISOString().slice(0, 10);
  const fromISO = new Date(Date.now() - days * 86400 * 1000)
    .toISOString()
    .slice(0, 10);
  const bars = await provider.dailyBars(ticker, fromISO, toISO);
  return bars.map((b) => ({ date: b.asOf, priceCents: b.priceCents, currency: b.currency }));
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  console.log("Slice 2: Liquid equity loader starting");

  // 1. FX rates
  await loadFxRates();

  // 2. Securities registry
  await loadSecurities();

  // 3. Resolve person IDs
  const slugToId = new Map<string, string>();
  for (const p of await db.select().from(schema.people)) {
    slugToId.set(p.slug, p.id);
  }

  // 4. Clear and reload equity holdings from CSV
  await db.delete(schema.equityHoldings);
  const holdingsRows = readCsv<{
    slug: string; ticker: string; exchange: string; shares: string; estimated: string; source_url: string; source: string;
  }>(join(process.cwd(), "data", "curated", "holdings.csv"));

  for (const row of holdingsRows) {
    assertSourceUrl(row.source_url, `holdings/${row.slug}`);
    const personId = slugToId.get(row.slug);
    if (!personId) {
      console.warn(`  No person found for slug: ${row.slug}`);
      continue;
    }
    const shares = parseInt(row.shares, 10);
    const estimated = row.estimated === "1" ? 1 : 0;
    const currency = await getSecurityCurrency(row.ticker);

    await db.insert(schema.equityHoldings).values({
      id: createId(),
      personId,
      ticker: row.ticker,
      exchange: row.exchange,
      shares,
      asOf: new Date().toISOString().slice(0, 10),
      estimated,
      source: row.source,
      sourceUrl: row.source_url,
      createdAt: new Date().toISOString(),
    });
    console.log(`  ${row.slug}: ${row.ticker} x ${shares.toLocaleString()} shares (${currency} -> USD @ ${getFxRate(currency)})`);
  }

  // 5. Fetch history and insert snapshots (currency-tagged) via provider
  const tickers = [...new Set(holdingsRows.map((h) => h.ticker))];
  const providerName = getPriceProvider().name;
  for (const ticker of tickers) {
    let history: Array<{ date: string; priceCents: number; currency: string }>;
    try {
      history = await fetchHistoryViaProvider(ticker, 90);
    } catch (err) {
      // Fail loudly per standing rules — no synthetic fallback
      throw new Error(`Price fetch failed for ${ticker} via ${providerName}: ${err instanceof Error ? err.message : String(err)}`);
    }
    const currency = await getSecurityCurrency(ticker);
    for (const point of history) {
      if (point.priceCents == null || point.priceCents <= 0) continue;
      await db.insert(schema.stockSnapshots).values({
        id: createId(),
        ticker,
        exchange: holdingsRows.find((h) => h.ticker === ticker)!.exchange,
        priceCents: point.priceCents,
        asOf: point.date,
        source: providerName,
        currency,
        createdAt: new Date().toISOString(),
      }).onConflictDoNothing().run();
    }
  }
  console.log(`  Stock snapshots inserted for ${tickers.length} tickers via ${providerName}`);
  console.log("Slice 2: Done.");
}

main().catch((err) => {
  console.error("Slice 2 failed:", err);
  process.exit(1);
});
