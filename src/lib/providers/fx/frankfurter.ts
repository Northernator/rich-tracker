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
};
