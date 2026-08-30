import { politeFetch } from "../http";
import type { FxProvider } from "../types";

const SYMBOLS = "INR,EUR,GBP,JPY,CNY,HKD";

export const frankfurterProvider: FxProvider = {
  name: "frankfurter",

  async ratesToUsd(asOfISO?: string): Promise<Record<string, number>> {
    const baseParam = "base=USD";
    const symbolsParam = `symbols=${SYMBOLS}`;
    const path = asOfISO ? `/${asOfISO}` : "/latest";
    const url = `https://api.frankfurter.app${path}?${baseParam}&${symbolsParam}`;

    const res = await politeFetch(url);
    const data = (await res.json()) as {
      base: string;
      date: string;
      rates: Record<string, number>;
    };

    if (data.base !== "USD") {
      throw new Error(
        `Expected base USD from frankfurter, got "${data.base}" — refusing to guess direction`
      );
    }

    const out: Record<string, number> = { USD: 1 };
    for (const [currency, usdToCurrency] of Object.entries(data.rates)) {
      if (!Number.isFinite(usdToCurrency) || usdToCurrency <= 0) {
        throw new Error(`Nonsensical FX rate for ${currency}: ${usdToCurrency}`);
      }
      out[currency] = 1 / usdToCurrency; // 1 unit of currency = N USD
    }
    return out;
  },

  /**
   * Date-keyed series from frankfurter's `{start}..{end}` endpoint — one call
   * for the whole history instead of one per day.
   *
   * The endpoint defaults to base=EUR, which is the exact bug that wrote
   * EUR→INR (111.06) as if it were INR→USD. base=USD is passed explicitly and
   * the response is asserted, then each day's rates are inverted so the
   * returned map is "1 unit of X = N USD", the same shape as `ratesToUsd`.
   */
  async ratesToUsdSeries(
    startISO: string,
    endISO: string
  ): Promise<Array<{ asOf: string; rates: Record<string, number> }>> {
    const url = `https://api.frankfurter.app/${startISO}..${endISO}?base=USD&symbols=${SYMBOLS}`;

    const res = await politeFetch(url);
    const data = (await res.json()) as {
      base: string;
      start_date: string;
      end_date: string;
      rates: Record<string, Record<string, number>>;
    };

    if (data.base !== "USD") {
      throw new Error(
        `Expected base USD from frankfurter, got "${data.base}" — refusing to guess direction`
      );
    }

    const out: Array<{ asOf: string; rates: Record<string, number> }> = [];
    for (const [asOf, dayRates] of Object.entries(data.rates)) {
      const day: Record<string, number> = { USD: 1 };
      for (const [currency, usdToCurrency] of Object.entries(dayRates)) {
        if (!Number.isFinite(usdToCurrency) || usdToCurrency <= 0) {
          throw new Error(`Nonsensical FX rate for ${currency} on ${asOf}: ${usdToCurrency}`);
        }
        day[currency] = 1 / usdToCurrency; // 1 unit of currency = N USD
      }
      out.push({ asOf, rates: day });
    }
    return out.sort((a, b) => (a.asOf < b.asOf ? -1 : 1));
  },
};
