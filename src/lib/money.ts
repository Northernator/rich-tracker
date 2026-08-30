/**
 * Money — the single rule for turning a local-currency amount into USD cents.
 *
 * Every page that values a holding goes through `toUsdCents`. There is no
 * second code path that multiplies a price by a share count, because that is
 * exactly the path where a EUR or INR price silently joined a USD total.
 *
 * `fx_rates` rows are stored as "1 base = rate quote" (quote is USD), which is
 * the rate that applied on `as_of`. The lookup always resolves the most recent
 * rate ON OR BEFORE the requested date — a historical snapshot converts at the
 * rate that applied then, and a future date falls back to the latest known
 * rate. It never falls back to 1, and a missing rate is an error, not parity.
 */

/** USD value of 1 unit of `currency`, resolved at the latest rate on or before `asOf`. */
export interface FxLookup {
  get(currency: string, asOf: string): number | undefined;
}

interface FxRow {
  base: string;
  quote: string;
  asOf: string;
  rate: number;
}

/**
 * Concrete FxLookup built from `fx_rates` rows.
 *
 * Rows are keyed by `base` currency and sorted by `as_of` ascending, so `get`
 * is a binary search for the latest rate that is not newer than the requested
 * date. If no rate exists on or before the date, the result is `undefined` and
 * `toUsdCents` throws — a silently wrong number is never produced.
 */
export class FxRates implements FxLookup {
  private readonly byCurrency: Map<string, Array<{ asOf: string; rate: number }>> = new Map();

  constructor(rows: FxRow[]) {
    for (const r of rows) {
      if (r.quote !== "USD") continue; // only USD-quoted rows express "1 base = N USD"
      const list = this.byCurrency.get(r.base);
      if (list) list.push({ asOf: r.asOf, rate: r.rate });
      else this.byCurrency.set(r.base, [{ asOf: r.asOf, rate: r.rate }]);
    }
    for (const list of this.byCurrency.values()) {
      list.sort((a, b) => (a.asOf < b.asOf ? -1 : a.asOf > b.asOf ? 1 : 0));
    }
  }

  get(currency: string, asOf: string): number | undefined {
    if (currency === "USD") return 1;
    const list = this.byCurrency.get(currency);
    if (!list || list.length === 0) return undefined;
    let lo = 0;
    let hi = list.length - 1;
    let best = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (list[mid].asOf <= asOf) {
        best = mid;
        lo = mid + 1;
      } else {
        hi = mid - 1;
      }
    }
    return best === -1 ? undefined : list[best].rate;
  }
}

/**
 * Convert `amountCents` (in `currency`) to USD cents at the rate that applied
 * on or before `asOf`. USD is identity; every other currency must resolve to a
 * rate or the call throws.
 */
export function toUsdCents(
  amountCents: number,
  currency: string,
  asOf: string,
  rates: FxLookup
): number {
  if (currency === "USD") return amountCents;
  const rate = rates.get(currency, asOf);
  if (rate == null) {
    throw new Error(`No FX rate for ${currency} on or before ${asOf}`);
  }
  return Math.round(amountCents * rate);
}
