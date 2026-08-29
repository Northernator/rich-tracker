import type { PriceProvider, FxProvider } from "./types";
import { yahooProvider } from "./prices/yahoo";
import { finnhubProvider } from "./prices/finnhub";
import { alphavantageProvider } from "./prices/alphavantage";
import { frankfurterProvider } from "./fx/frankfurter";

const PRICE_PROVIDERS: Record<string, PriceProvider> = {
  yahoo: yahooProvider,
  finnhub: finnhubProvider,
  alphavantage: alphavantageProvider,
};

const VALID_PRICE_OPTIONS = Object.keys(PRICE_PROVIDERS).join(" | ");

export function getPriceProvider(): PriceProvider {
  const raw = (process.env.PRICE_PROVIDER ?? "yahoo").toLowerCase().trim();
  const provider = PRICE_PROVIDERS[raw];
  if (!provider) {
    throw new Error(
      `Unknown PRICE_PROVIDER "${raw}". Valid options: ${VALID_PRICE_OPTIONS}`
    );
  }
  return provider;
}

export function getFxProvider(): FxProvider {
  // Single FX provider today; env override left for future providers.
  const raw = (process.env.FX_PROVIDER ?? "frankfurter").toLowerCase().trim();
  if (raw !== "frankfurter") {
    throw new Error(`Unknown FX_PROVIDER "${raw}". Valid options: frankfurter`);
  }
  return frankfurterProvider;
}

// Re-exports for direct use and testing
export { yahooProvider, finnhubProvider, alphavantageProvider, frankfurterProvider };
export const _priceProviders = PRICE_PROVIDERS;
