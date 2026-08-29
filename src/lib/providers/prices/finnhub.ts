import type { DailyBar, PriceProvider } from "../types";

function requireKey(): string {
  const key = process.env.FINNHUB_API_KEY;
  if (!key) {
    throw new Error(
      "FINNHUB_API_KEY not set — set it in .env.local or choose PRICE_PROVIDER=yahoo"
    );
  }
  return key;
}

export const finnhubProvider: PriceProvider = {
  name: "finnhub",
  licence: "display-permitted",

  async dailyBars(): Promise<DailyBar[]> {
    requireKey();
    throw new Error(
      "Finnhub provider not configured — dailyBars not yet implemented"
    );
  },

  async latest(): Promise<DailyBar[]> {
    requireKey();
    throw new Error(
      "Finnhub provider not configured — latest not yet implemented"
    );
  },
};
