/**
 * Slice 12: Restore and schedule price history
 *
 * Fetches daily history via the configured PriceProvider (yahoo | finnhub)
 * for all tracked tickers (~90 days) and inserts additively using
 * INSERT OR IGNORE. Never deletes or overwrites existing data.
 *
 * Provider is chosen by PRICE_PROVIDER env var and resolved via
 * src/lib/providers/registry.ts — one place to swap the data source.
 *
 * Run manually: pnpm exec tsx src/lib/db/load_slice_prices.ts
 * Scheduled: every weekday at 16:30 (after market close)
 */

import { db } from "@/lib/db";
import { stockSnapshots } from "@/lib/db/schema";
import { createId } from "@paralleldrive/cuid2";
import { getPriceProvider } from "@/lib/providers/registry";

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  const provider = getPriceProvider();
  console.log(`Slice 12: Price history loader starting (provider=${provider.name}, licence=${provider.licence})`);

  // Get all unique tickers from stock_snapshots and equity_holdings
  const tickers = await db
    .select({ ticker: stockSnapshots.ticker })
    .from(stockSnapshots)
    .groupBy(stockSnapshots.ticker)
    .orderBy(stockSnapshots.ticker);

  const tickerList = [...new Set(tickers.map((t) => t.ticker))].sort();
  console.log(`  Found ${tickerList.length} unique tickers`);

  if (tickerList.length === 0) {
    console.log("  No tickers to fetch — exiting (empty table is honest).");
    return;
  }

  const toISO = new Date().toISOString().slice(0, 10);
  const fromISO = new Date(Date.now() - 90 * 86400 * 1000).toISOString().slice(0, 10);

  let inserted = 0;

  for (const ticker of tickerList) {
    console.log(`  Fetching ${ticker} via ${provider.name}...`);
    const bars = await provider.dailyBars(ticker, fromISO, toISO);
    console.log(`    Got ${bars.length} days of history`);

    for (const bar of bars) {
      if (bar.priceCents == null || bar.priceCents <= 0) continue;
      try {
        await db
          .insert(stockSnapshots)
          .values({
            id: createId(),
            ticker: bar.ticker,
            exchange: "NYSE",
            priceCents: bar.priceCents,
            asOf: bar.asOf,
            source: provider.name,
            currency: bar.currency,
            createdAt: new Date().toISOString(),
          })
          .onConflictDoNothing()
          .run();
        inserted++;
      } catch (err) {
        console.warn(`    Insert failed for ${ticker} on ${bar.asOf}: ${err}`);
      }
    }
  }

  console.log(`\nDone. Inserted ${inserted} new rows (skipped duplicates via INSERT OR IGNORE).`);
}

main().catch((err) => {
  console.error("Slice 12 failed:", err);
  process.exit(1);
});
