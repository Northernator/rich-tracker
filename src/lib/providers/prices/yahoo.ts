import { politeFetch } from "../http";
import type { DailyBar, PriceProvider } from "../types";

export const yahooProvider: PriceProvider = {
  name: "yahoo",
  licence: "unlicensed",

  async dailyBars(ticker: string, fromISO: string, toISO: string): Promise<DailyBar[]> {
    const symbol = encodeURIComponent(ticker);
    const fromSec = Math.floor(new Date(fromISO).getTime() / 1000);
    // toISO is inclusive — add 1 day to make period2 exclusive
    const toSec = Math.floor(new Date(toISO).getTime() / 1000) + 86400;
    const url = `https://query1.finance.yahoo.com/v8/finance/chart/${symbol}?period1=${fromSec}&period2=${toSec}&interval=1d`;

    const res = await politeFetch(url);
    const json = (await res.json()) as {
      chart: {
        result: Array<{
          timestamp: number[];
          indicators: { quote: Array<{ close: (number | null)[] }> };
        }>;
        error: unknown;
      };
    };

    const result = json.chart?.result?.[0];
    if (!result) {
      const err = json.chart?.error;
      throw new Error(`Yahoo dailyBars empty result for ${ticker}: ${JSON.stringify(err)}`);
    }

    const closes = result.indicators?.quote?.[0]?.close ?? [];
    const bars: DailyBar[] = [];
    for (let i = 0; i < result.timestamp.length; i++) {
      const close = closes[i];
      if (close == null || !Number.isFinite(close) || close <= 0) continue;
      const date = new Date(result.timestamp[i] * 1000).toISOString().slice(0, 10);
      bars.push({
        asOf: date,
        ticker,
        priceCents: Math.round(close * 100),
        currency: "USD",
      });
    }
    return bars;
  },

  async latest(tickers: string[]): Promise<DailyBar[]> {
    const results: DailyBar[] = [];
    // Yahoo has no batch latest endpoint suitable for display-permitted use.
    // Fetch last 5 days per ticker and take the most recent bar.
    const toISO = new Date().toISOString().slice(0, 10);
    const fromISO = new Date(Date.now() - 7 * 86400 * 1000)
      .toISOString()
      .slice(0, 10);

    for (const ticker of tickers) {
      const bars = await yahooProvider.dailyBars(ticker, fromISO, toISO);
      if (bars.length === 0) continue;
      // bars are chronological from API
      bars.sort((a, b) => a.asOf.localeCompare(b.asOf));
      results.push(bars[bars.length - 1]);
    }
    return results;
  },
};
