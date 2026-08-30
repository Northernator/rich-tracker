/**
 * Load an FxLookup from the `fx_rates` table.
 *
 * Pages that value holdings call this once per request. Rates are keyed by
 * `base` currency and quoted in USD; the lookup resolves the most recent rate
 * on or before the requested date (see src/lib/money.ts).
 */
import { db } from "@/lib/db";
import { fxRates } from "@/lib/db/schema";
import { FxRates, type FxLookup } from "@/lib/money";

export async function loadFxLookup(): Promise<FxLookup> {
  const rows = await db
    .select({
      base: fxRates.base,
      quote: fxRates.quote,
      asOf: fxRates.asOf,
      rate: fxRates.rate,
    })
    .from(fxRates);
  return new FxRates(rows);
}
