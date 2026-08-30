import type { PriceProvider, FxProvider } from "./types";
import { assertLicence } from "./licences";
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

  // Refuses to hand back a provider whose adapter claims a licence the register
  // cannot evidence. This is what stops an unconfirmed "display-permitted" from
  // being written into stock_snapshots.licence and onto a public page.
  assertLicence(provider);

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
export { canDisplayPublicly, LICENCE_REGISTER, licenceFor } from "./licences";
export const _priceProviders = PRICE_PROVIDERS;
