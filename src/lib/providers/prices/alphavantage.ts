import type { DailyBar, PriceProvider } from "../types";

function requireKey(): string {
  const key = process.env.ALPHAVANTAGE_API_KEY;
  if (!key) {
    throw new Error(
      "ALPHAVANTAGE_API_KEY not set — set it in .env.local or choose PRICE_PROVIDER=yahoo"
    );
  }
  return key;
}

export const alphavantageProvider: PriceProvider = {
  name: "alphavantage",
  licence: "display-permitted",

  async dailyBars(): Promise<DailyBar[]> {
    requireKey();
    throw new Error(
      "AlphaVantage provider not configured — dailyBars not yet implemented"
    );
  },

  async latest(): Promise<DailyBar[]> {
    requireKey();
    throw new Error(
      "AlphaVantage provider not configured — latest not yet implemented"
    );
  },
};
