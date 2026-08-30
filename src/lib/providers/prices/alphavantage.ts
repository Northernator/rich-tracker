/**
 * Alpha Vantage — cross-check provider, not the primary feed.
 *
 * Role: at 25 requests/day it cannot backfill 34 tickers, but one quote per
 * ticker is enough to independently confirm a suspicious price from whichever
 * provider is primary. That is the whole justification for its presence.
 *
 * Licence: "unlicensed". The free key's terms have historically restricted
 * redistribution, and they have not been read and recorded in
 * src/lib/providers/licences.ts. Withdrawn from "display-permitted" until they
 * are.
 *
 * Currency: TIME_SERIES_DAILY and GLOBAL_QUOTE do not state the quote currency
 * anywhere in the payload. This provider therefore declares
 * `reportsCurrency: false` and adopts the currency the caller supplies from the
 * securities registry; with none supplied it throws. There is no USD fallback
 * in this file.
 *
 * Verified live (2026-08-30, public "demo" key):
 *   - GLOBAL_QUOTE success shape: {"Global Quote": {"01. symbol", "05. price",
 *     "07. latest trading day", ...}} — confirmed verbatim.
 *   - Throttle/error shape: {"Information": "..."} — confirmed verbatim.
 * Not verified: the TIME_SERIES_DAILY success payload. The demo key refuses
 * that function, so `Meta Data` / `Time Series (Daily)` / "4. close" come from
 * https://www.alphavantage.co/documentation/ and are unproven here.
 */
import { politeFetch } from "../http";
import { resolveCurrency } from "../currency";
import type { BarQueryOptions, DailyBar, PriceProvider, TickerQuery } from "../types";

const BASE = "https://www.alphavantage.co/query";

/** Free-tier ceiling. Overridable because paid tiers raise it. */
const DAILY_LIMIT = Number(process.env.ALPHAVANTAGE_DAILY_LIMIT ?? 25);

let budgetDay = "";
let budgetUsed = 0;

/**
 * A throttle must never look like an empty market. If the daily budget is gone
 * this throws, so a skipped cross-check is visible instead of silently reading
 * as "no data".
 */
function takeBudget(): void {
  const today = new Date().toISOString().slice(0, 10);
  if (today !== budgetDay) {
    budgetDay = today;
    budgetUsed = 0;
  }
  if (budgetUsed >= DAILY_LIMIT) {
    throw new Error(
      `Alpha Vantage daily request budget exhausted (${budgetUsed}/${DAILY_LIMIT} on ` +
        `${budgetDay}). Raise ALPHAVANTAGE_DAILY_LIMIT only if the plan allows it.`
    );
  }
  budgetUsed++;
}

export function _budgetState(): { day: string; used: number; limit: number } {
  return { day: budgetDay, used: budgetUsed, limit: DAILY_LIMIT };
}

function requireKey(): string {
  const key = process.env.ALPHAVANTAGE_API_KEY;
  if (!key) {
    throw new Error(
      "ALPHAVANTAGE_API_KEY not set — set it in .env.local or choose PRICE_PROVIDER=yahoo"
    );
  }
  return key;
}

interface GlobalQuoteResponse {
  "Global Quote"?: {
    "01. symbol"?: string;
    "05. price"?: string;
    "07. latest trading day"?: string;
  };
  Note?: string;
  Information?: string;
  "Error Message"?: string;
}

interface DailyResponse {
  "Meta Data"?: { "2. Symbol"?: string };
  "Time Series (Daily)"?: Record<string, { "4. close"?: string }>;
  Note?: string;
  Information?: string;
  "Error Message"?: string;
}

/**
 * Alpha Vantage answers quota and lookup failures with HTTP 200 and a message
 * body, so a naive `res.ok` check walks straight past them. Every response is
 * inspected for these keys before anything is parsed as data.
 */
function assertNoApiMessage(json: GlobalQuoteResponse | DailyResponse, ticker: string): void {
  const note = json.Note ?? json.Information ?? json["Error Message"];
  if (note) {
    throw new Error(`Alpha Vantage refused ${ticker}: ${note}`);
  }
}

export const alphavantageProvider: PriceProvider = {
  name: "alphavantage",
  licence: "unlicensed",
  reportsCurrency: false,

  async dailyBars(
    ticker: string,
    _fromISO: string,
    _toISO: string,
    opts?: BarQueryOptions
  ): Promise<DailyBar[]> {
    const key = requireKey();
    // reportsCurrency is false, so this throws when no expected currency is
    // supplied rather than falling back to USD.
    const currency = resolveCurrency("alphavantage", null, opts?.expectedCurrency);

    takeBudget();
    const url =
      `${BASE}?function=TIME_SERIES_DAILY&symbol=${encodeURIComponent(ticker)}` +
      `&outputsize=compact&datatype=json&apikey=${key}`;

    const res = await politeFetch(url);
    const json = (await res.json()) as DailyResponse;
    assertNoApiMessage(json, ticker);

    const series = json["Time Series (Daily)"];
    if (!series) {
      throw new Error(
        `Alpha Vantage returned no "Time Series (Daily)" for ${ticker} ` +
          `(keys: ${Object.keys(json).join(", ")})`
      );
    }

    // The payload can silently resolve to a different listing. Confirm the
    // symbol came back as requested before trusting a single close.
    const returned = json["Meta Data"]?.["2. Symbol"];
    if (returned && returned.trim().toUpperCase() !== ticker.trim().toUpperCase()) {
      throw new Error(
        `Alpha Vantage resolved ${ticker} to "${returned}" — refusing to store a ` +
          `price for a different listing`
      );
    }

    const bars: DailyBar[] = [];
    for (const [asOf, ohlc] of Object.entries(series)) {
      const close = Number(ohlc?.["4. close"]);
      if (!Number.isFinite(close) || close <= 0) continue;
      bars.push({
        asOf,
        ticker,
        priceCents: Math.round(close * 100),
        currency,
      });
    }
    bars.sort((a, b) => a.asOf.localeCompare(b.asOf));
    return bars;
  },

  async latest(queries: TickerQuery[]): Promise<DailyBar[]> {
    const key = requireKey();
    const results: DailyBar[] = [];

    for (const q of queries) {
      const currency = resolveCurrency("alphavantage", null, q.expectedCurrency);

      takeBudget();
      const url =
        `${BASE}?function=GLOBAL_QUOTE&symbol=${encodeURIComponent(q.ticker)}` +
        `&datatype=json&apikey=${key}`;

      const res = await politeFetch(url);
      const json = (await res.json()) as GlobalQuoteResponse;
      assertNoApiMessage(json, q.ticker);

      const quote = json["Global Quote"];
      if (!quote) continue;

      const price = Number(quote["05. price"]);
      const asOf = quote["07. latest trading day"];
      if (!Number.isFinite(price) || price <= 0) continue;
      if (!asOf || !/^\d{4}-\d{2}-\d{2}$/.test(asOf)) {
        throw new Error(
          `Alpha Vantage GLOBAL_QUOTE returned no usable trading day for ` +
            `${q.ticker} (${JSON.stringify(asOf)}) — cannot date the bar`
        );
      }

      results.push({
        asOf,
        ticker: q.ticker,
        priceCents: Math.round(price * 100),
        currency,
      });
    }
    return results;
  },
};
