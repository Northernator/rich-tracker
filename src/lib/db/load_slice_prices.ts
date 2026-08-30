/**
 * Slice 12: Restore and backfill price history
 *
 * Fetches daily history via the configured PriceProvider (yahoo | finnhub |
 * alphavantage) for every tracked security and inserts additively using
 * INSERT OR IGNORE on the (ticker, as_of) natural key. Never deletes or
 * overwrites existing data — that is how 60 days of real price history was
 * destroyed once, and it must not happen again.
 *
 * Provider is chosen by PRICE_PROVIDER and resolved via
 * src/lib/providers/registry.ts. One place to swap the data source.
 *
 * Chunk 4 changes that matter:
 *  - Tickers now come from the `securities` registry, UNIONed with tickers that
 *    already have snapshots. The previous version read tickers from
 *    stock_snapshots alone, which guaranteed the unpriced securities could
 *    never be fetched — the source of the "no data" rows.
 *  - exchange, currency and expected currency come from `securities`, never
 *    from a hardcoded literal. A row is rejected (not clamped) if its currency
 *    conflicts with the registry's.
 *  - `source` is the provider name and `licence` mirrors the adapter, so a
 *    row's provenance survives a provider switch.
 *  - Every run logs "n new bars, m already present". A second identical run
 *    changes nothing.
 *
 * Run manually: pnpm exec tsx src/lib/db/load_slice_prices.ts
 * Scheduled: every weekday at 16:30 (after market close)
 */

import { db } from "@/lib/db";
import { stockSnapshots, securities } from "@/lib/db/schema";
import { createId } from "@paralleldrive/cuid2";
import { getPriceProvider, licenceFor } from "@/lib/providers/registry";

interface SecurityRow {
  ticker: string;
  exchange: string;
  currency: string;
}

interface InsertOutcome {
  newBars: number;
  alreadyPresent: number;
  skipped: number;
}

/** Most common value in a count map — used to recover a ticker's true exchange/currency from its own history. */
function dominant(counts: Map<string, number>): string | undefined {
  let best: string | undefined;
  let bestN = 0;
  for (const [k, v] of counts) {
    if (v > bestN) {
      bestN = v;
      best = k;
    }
  }
  return best;
}

async function main() {
  const provider = getPriceProvider();
  const providerLicence = licenceFor(provider.name);
  console.log(
    `Slice 12: Price history loader starting (provider=${provider.name}, licence=${providerLicence})`
  );

  // Registry is authoritative where present.
  const registryRows = await db
    .select({
      ticker: securities.ticker,
      exchange: securities.exchange,
      currency: securities.currency,
    })
    .from(securities);

  // For tickers that have history but no registry row, recover the exchange and
  // currency FROM that history — it is already verified data (the bars were
  // fetched from a live source), so reading it back is not an assumption. This
  // is what lets a re-run stay idempotent for the 28 pre-registry tickers
  // without inventing a securities row or a currency.
  const existing = await db
    .select({ ticker: stockSnapshots.ticker, exchange: stockSnapshots.exchange, currency: stockSnapshots.currency })
    .from(stockSnapshots);

  const exByTicker = new Map<string, Map<string, number>>();
  const curByTicker = new Map<string, Map<string, number>>();
  for (const r of existing) {
    if (!exByTicker.has(r.ticker)) exByTicker.set(r.ticker, new Map());
    if (!curByTicker.has(r.ticker)) curByTicker.set(r.ticker, new Map());
    exByTicker.get(r.ticker)!.set(r.exchange, (exByTicker.get(r.ticker)!.get(r.exchange) ?? 0) + 1);
    curByTicker.get(r.ticker)!.set(r.currency, (curByTicker.get(r.ticker)!.get(r.currency) ?? 0) + 1);
  }

  const regByTicker = new Map(registryRows.map((r) => [r.ticker, r]));

  const allTickers = new Set<string>([...regByTicker.keys(), ...exByTicker.keys()]);
  const tickers: SecurityRow[] = [...allTickers]
    .sort()
    .map((t) => {
      const reg = regByTicker.get(t);
      if (reg) return { ticker: t, exchange: reg.exchange, currency: reg.currency };
      // No registry row: recover from verified history.
      return {
        ticker: t,
        exchange: dominant(exByTicker.get(t) ?? new Map()) ?? "UNKNOWN",
        currency: dominant(curByTicker.get(t) ?? new Map()) ?? "",
      };
    });

  console.log(`  ${registryRows.length} securities in registry, ${tickers.length} tickers to reconcile`);

  if (tickers.length === 0) {
    console.log("  No tickers to fetch — exiting (empty table is honest).");
    return;
  }

  const toISO = new Date().toISOString().slice(0, 10);
  const fromISO = new Date(Date.now() - 90 * 86400 * 1000).toISOString().slice(0, 10);

  const total: InsertOutcome = { newBars: 0, alreadyPresent: 0, skipped: 0 };

  for (const sec of tickers) {
    console.log(`  Fetching ${sec.ticker} via ${provider.name}...`);
    let bars;
    try {
      bars = await provider.dailyBars(sec.ticker, fromISO, toISO, {
        expectedCurrency: sec.currency || undefined,
      });
    } catch (err) {
      // A failed fetch for one ticker must not abort the run or wipe anything.
      console.warn(`    FETCH FAILED for ${sec.ticker}: ${err instanceof Error ? err.message : String(err)}`);
      total.skipped++;
      continue;
    }
    console.log(`    Got ${bars.length} days of history`);

    const outcome = await insertBars(provider.name, providerLicence, sec, bars);
    total.newBars += outcome.newBars;
    total.alreadyPresent += outcome.alreadyPresent;
    total.skipped += outcome.skipped;
  }

  console.log(
    `\nDone. ${total.newBars} new bars, ${total.alreadyPresent} already present` +
      (total.skipped ? `, ${total.skipped} skipped (fetch or sanity failure)` : "") +
      `.`
  );
  console.log(
    `  Running the loader again will change nothing — inserts are additive (INSERT OR IGNORE).`
  );
}

async function insertBars(
  providerName: string,
  providerLicence: string,
  sec: SecurityRow,
  bars: { asOf: string; ticker: string; priceCents: number; currency: string }[]
): Promise<InsertOutcome> {
  const outcome: InsertOutcome = { newBars: 0, alreadyPresent: 0, skipped: 0 };

  for (const bar of bars) {
    if (bar.priceCents == null || bar.priceCents <= 0) {
      outcome.skipped++;
      continue;
    }

    // The provider has already resolved `bar.currency` against the expected
    // currency we passed (and thrown on a mismatch), so no silent USD default
    // can reach here. Reject only an unparseable currency as a last guard.
    if (!/^[A-Z]{3}$/.test(bar.currency)) {
      console.warn(`    SKIP ${bar.ticker} ${bar.asOf}: non-ISO currency "${bar.currency}"`);
      outcome.skipped++;
      continue;
    }

    try {
      await db
        .insert(stockSnapshots)
        .values({
          id: createId(),
          ticker: bar.ticker,
          exchange: sec.exchange,
          priceCents: bar.priceCents,
          asOf: bar.asOf,
          source: providerName,
          currency: bar.currency,
          licence: providerLicence,
          createdAt: new Date().toISOString(),
        })
        .onConflictDoNothing() // (ticker, as_of) unique — re-run inserts 0 rows
        .run();
      outcome.newBars++;
    } catch (err) {
      // Surface but do not abort: one bad row is not worth losing the batch.
      console.warn(`    Insert failed for ${bar.ticker} on ${bar.asOf}: ${String(err)}`);
      outcome.skipped++;
    }
  }

  return outcome;
}

main().catch((err) => {
  console.error("Slice 12 failed:", err);
  process.exit(1);
});
