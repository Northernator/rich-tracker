/**
 * Finnhub — the planned launch provider (see docs/LICENSING.md).
 *
 * Licence: "unlicensed" until the redistribution and public-display terms are
 * read and recorded in src/lib/providers/licences.ts. This file shipped
 * declaring "display-permitted" while being an empty stub that had never made a
 * request; that claim is now withdrawn. Finnhub sells tiers, but a paid tier is
 * not the same thing as a right to republish, and nothing here asserts more
 * than has been evidenced.
 *
 * Currency: neither /quote nor /stock/candle states the quote currency, so it is
 * resolved through /stock/profile2 and cached per symbol. If the profile cannot
 * supply one, this throws rather than defaulting to USD.
 *
 * Verified live: the three paths below exist and require a key (each returned
 * HTTP 401 {"error":"Please use an API key."} rather than 404). The success
 * payloads could NOT be exercised — no FINNHUB_API_KEY is configured in this
 * environment — so they are written against
 * https://finnhub.io/docs/api/stock-candles and https://finnhub.io/docs/api/quote
 * and are unproven until a key is present.
 */
import { politeFetch } from "../http";
import { resolveCurrency } from "../currency";
import type { BarQueryOptions, DailyBar, PriceProvider, TickerQuery } from "../types";

const BASE = "https://finnhub.io/api/v1";

function requireKey(): string {
  const key = process.env.FINNHUB_API_KEY;
  if (!key) {
    throw new Error(
      "FINNHUB_API_KEY not set — set it in .env.local or choose PRICE_PROVIDER=yahoo"
    );
  }
  return key;
}

interface QuoteResponse {
  /** Current price */
  c?: number | null;
  /** Previous close */
  pc?: number | null;
  /** UNIX timestamp of the quote */
  t?: number | null;
}

interface CandleResponse {
  /** "ok" | "no_data" */
  s?: string;
  /** UNIX timestamps, parallel to c/h/l/o/v */
  t?: number[];
  c?: (number | null)[];
}

interface ProfileResponse {
  currency?: string | null;
}

/** Currency is per-symbol and stable; one profile lookup per ticker per process. */
const currencyCache = new Map<string, string>();

async function currencyFor(ticker: string): Promise<string> {
  const cached = currencyCache.get(ticker);
  if (cached) return cached;

  const key = requireKey();
  const url = `${BASE}/stock/profile2?symbol=${encodeURIComponent(ticker)}&token=${key}`;
  const res = await politeFetch(url);
  const json = (await res.json()) as ProfileResponse;

  const raw = typeof json?.currency === "string" ? json.currency : null;
  if (!raw) {
    throw new Error(
      `Finnhub /stock/profile2 returned no currency for ${ticker} ` +
        `(response: ${JSON.stringify(json).slice(0, 200)}). ` +
        `Refusing to assume USD.`
    );
  }
  const currency = raw.trim().toUpperCase();
  currencyCache.set(ticker, currency);
  return currency;
}

function dayISO(unixSeconds: number): string {
  return new Date(unixSeconds * 1000).toISOString().slice(0, 10);
}

export const finnhubProvider: PriceProvider = {
  name: "finnhub",
  licence: "unlicensed",
  // True only because /stock/profile2 is consulted first; the price endpoints
  // themselves carry no currency field.
  reportsCurrency: true,

  async dailyBars(
    ticker: string,
    fromISO: string,
    toISO: string,
    opts?: BarQueryOptions
  ): Promise<DailyBar[]> {
    const key = requireKey();
    const fromSec = Math.floor(new Date(fromISO).getTime() / 1000);
    const toSec = Math.floor(new Date(toISO).getTime() / 1000);

    const currency = await currencyFor(ticker);
    resolveCurrency("finnhub", currency, opts?.expectedCurrency);

    const url =
      `${BASE}/stock/candle?symbol=${encodeURIComponent(ticker)}` +
      `&resolution=D&from=${fromSec}&to=${toSec}&token=${key}`;

    const res = await politeFetch(url);
    const json = (await res.json()) as CandleResponse;

    // "no_data" is a real, honest answer: this symbol has no candles in range.
    // Returning [] is correct; inventing a series is not.
    if (json?.s === "no_data") return [];

    if (json?.s && json.s !== "ok") {
      throw new Error(`Finnhub /stock/candle returned status "${json.s}" for ${ticker}`);
    }

    const timestamps = json.t ?? [];
    const closes = json.c ?? [];

    const bars: DailyBar[] = [];
    for (let i = 0; i < timestamps.length; i++) {
      const close = closes[i];
      if (close == null || !Number.isFinite(close) || close <= 0) continue;
      bars.push({
        asOf: dayISO(timestamps[i]),
        ticker,
        priceCents: Math.round(close * 100),
        currency,
      });
    }
    return bars;
  },

  async latest(queries: TickerQuery[]): Promise<DailyBar[]> {
    const key = requireKey();
    const results: DailyBar[] = [];

    for (const q of queries) {
      const currency = await currencyFor(q.ticker);
      resolveCurrency("finnhub", currency, q.expectedCurrency);

      const url =
        `${BASE}/quote?symbol=${encodeURIComponent(q.ticker)}&token=${key}`;
      const res = await politeFetch(url);
      const json = (await res.json()) as QuoteResponse;

      if (json.c == null || !Number.isFinite(json.c) || json.c <= 0) continue;

      // Without a timestamp there is no defensible as_of; fall back to the
      // quote's own timestamp, and refuse rather than stamp "today" if absent.
      const ts = json.t;
      if (ts == null || !Number.isFinite(ts) || ts <= 0) {
        throw new Error(
          `Finnhub /quote returned no timestamp for ${q.ticker} — cannot date the bar`
        );
      }

      results.push({
        asOf: dayISO(ts),
        ticker: q.ticker,
        priceCents: Math.round(json.c * 100),
        currency,
      });
    }
    return results;
  },
};
