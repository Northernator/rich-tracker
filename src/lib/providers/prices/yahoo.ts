/**
 * Yahoo Finance (query1 chart endpoint) — the incumbent provider.
 *
 * Licence: "unlicensed". The public chart endpoint is offered for personal,
 * non-commercial use and there is no paid tier that converts it into a
 * display-permitted feed, so this stays internal-only forever. See
 * docs/LICENSING.md.
 *
 * Chunk 4 changed one thing that mattered: the currency used to be hardcoded to
 * "USD" on every bar. That is fine while every ticker is a US listing and
 * silently catastrophic the moment one is not — the registry holds RELIANCE.NS
 * (INR), ITX.MC and MC.PA (EUR), and a rupee price stamped USD understates the
 * holding by roughly 85x. The currency now comes from `meta.currency`, which
 * this endpoint does report, and a missing one is a hard failure.
 */
import { politeFetch } from "../http";
import { resolveCurrency } from "../currency";
import type { BarQueryOptions, DailyBar, PriceProvider, TickerQuery } from "../types";

interface YahooChartResponse {
  chart?: {
    result?: Array<{
      meta?: {
        currency?: string;
        symbol?: string;
        exchangeName?: string;
      };
      timestamp?: number[];
      indicators?: { quote?: Array<{ close?: (number | null)[] }> };
    }>;
    error?: unknown;
  };
}

function toDayISO(unixSeconds: number): string {
  // Kept in UTC deliberately: the existing 2,142 rows were derived this way, so
  // changing it would mint new (ticker, as_of) keys and duplicate history that
  // the acceptance checklist requires to stay put.
  return new Date(unixSeconds * 1000).toISOString().slice(0, 10);
}

export const yahooProvider: PriceProvider = {
  name: "yahoo",
  licence: "unlicensed",
  reportsCurrency: true,

  async dailyBars(
    ticker: string,
    fromISO: string,
    toISO: string,
    opts?: BarQueryOptions
  ): Promise<DailyBar[]> {
    const symbol = encodeURIComponent(ticker);
    const fromSec = Math.floor(new Date(fromISO).getTime() / 1000);
    // toISO is inclusive — add 1 day to make period2 exclusive
    const toSec = Math.floor(new Date(toISO).getTime() / 1000) + 86400;
    const url =
      `https://query1.finance.yahoo.com/v8/finance/chart/${symbol}` +
      `?period1=${fromSec}&period2=${toSec}&interval=1d`;

    const res = await politeFetch(url);
    const json = (await res.json()) as YahooChartResponse;

    const result = json.chart?.result?.[0];
    if (!result) {
      const err = json.chart?.error;
      throw new Error(`Yahoo dailyBars empty result for ${ticker}: ${JSON.stringify(err)}`);
    }

    const currency = resolveCurrency(
      "yahoo",
      result.meta?.currency,
      opts?.expectedCurrency
    );

    const timestamps = result.timestamp ?? [];
    const closes = result.indicators?.quote?.[0]?.close ?? [];

    const bars: DailyBar[] = [];
    for (let i = 0; i < timestamps.length; i++) {
      const close = closes[i];
      if (close == null || !Number.isFinite(close) || close <= 0) continue;
      bars.push({
        asOf: toDayISO(timestamps[i]),
        ticker,
        priceCents: Math.round(close * 100),
        currency,
      });
    }
    return bars;
  },

  async latest(queries: TickerQuery[]): Promise<DailyBar[]> {
    const results: DailyBar[] = [];
    // No batch endpoint is available on this endpoint; fetch a short window per
    // ticker and take the most recent bar.
    const toISO = new Date().toISOString().slice(0, 10);
    const fromISO = new Date(Date.now() - 7 * 86400 * 1000).toISOString().slice(0, 10);

    for (const q of queries) {
      const bars = await yahooProvider.dailyBars(q.ticker, fromISO, toISO, {
        expectedCurrency: q.expectedCurrency,
      });
      if (bars.length === 0) continue;
      bars.sort((a, b) => a.asOf.localeCompare(b.asOf));
      results.push(bars[bars.length - 1]);
    }
    return results;
  },
};
