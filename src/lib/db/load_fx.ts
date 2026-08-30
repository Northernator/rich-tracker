/**
 * FX backfill + daily refresh — frankfurter.app / ECB, base=USD asserted.
 *
 * Backfills `fx_rates` from the earliest `stock_snapshots.as_of` through today
 * in ONE call using frankfurter's `{start}..{end}` date-keyed series endpoint,
 * then refreshes today's row. Inserts are additive (`onConflictDoNothing` on
 * the (base, quote, as_of) natural key) — re-running changes nothing, and no
 * row is ever deleted. That is how price history was lost once before, and it
 * must not happen to rates.
 *
 * The bug that must not come back: frankfurter defaults to base=EUR, so
 * `?symbols=INR,EUR,GBP` without base=USD returns EUR→INR (111.06) and a naive
 * loader stores it as INR→USD — inflating a rupee holding ~12,000×. This
 * loader always passes `base=USD`, asserts `data.base === "USD"`, and inverts:
 * 1 unit of X = 1 / (USD→X) USD.
 *
 * Run manually: pnpm exec tsx src/lib/db/load_fx.ts
 * Also invoked by the daily cron alongside the price loader.
 */

import { db } from "@/lib/db";
import { fxRates, stockSnapshots } from "@/lib/db/schema";
import { sql } from "drizzle-orm";
import { getFxProvider } from "@/lib/providers/registry";

async function main() {
  const provider = getFxProvider();
  console.log(`FX loader starting (provider=${provider.name})`);

  // Earliest price snapshot defines how far back rates must go.
  const earliest = await db
    .select({ m: sql<string>`MIN(${stockSnapshots.asOf})` })
    .from(stockSnapshots);
  const startISO = earliest[0]?.m ?? new Date().toISOString().slice(0, 10);
  const endISO = new Date().toISOString().slice(0, 10);

  console.log(`  Backfilling rates from ${startISO} to ${endISO}`);

  const series = await provider.ratesToUsdSeries(startISO, endISO);
  console.log(`  Got ${series.length} days of rates`);

  if (series.length === 0) {
    console.log("  No rates returned — nothing to insert (empty table is honest).");
    return;
  }

  const sourceUrl = `https://api.frankfurter.app/${startISO}..${endISO}?base=USD`;

  let inserted = 0;
  let already = 0;
  for (const day of series) {
    for (const [currency, rate] of Object.entries(day.rates)) {
      if (currency === "USD") continue; // USD=1 is implicit, not a row
      if (!Number.isFinite(rate) || rate <= 0) {
        throw new Error(`Nonsensical FX rate ${currency}->USD on ${day.asOf}: ${rate}`);
      }
      try {
        const result = await db
          .insert(fxRates)
          .values({
            base: currency,
            quote: "USD",
            asOf: day.asOf,
            rate,
            sourceUrl,
            createdAt: new Date().toISOString(),
          })
          .onConflictDoNothing()
          .run();
        if (result.changes > 0) inserted++;
        else already++;
      } catch (err) {
        // Surface but do not abort — same posture as the price loader.
        console.warn(`    Insert failed for ${currency} on ${day.asOf}: ${String(err)}`);
      }
    }
  }

  console.log(`\nDone. ${inserted} new rate rows, ${already} already present.`);
  console.log(`  Running again changes nothing — inserts are additive (INSERT OR IGNORE).`);
}

main().catch((err) => {
  console.error("FX loader failed:", err);
  process.exit(1);
});
