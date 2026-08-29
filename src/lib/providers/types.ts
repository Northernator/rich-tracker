export interface DailyBar {
  asOf: string;
  ticker: string;
  priceCents: number;
  currency: string;
}

export type ProviderLicence = "display-permitted" | "internal-only" | "unlicensed";

export interface PriceProvider {
  readonly name: string;
  readonly licence: ProviderLicence;
  dailyBars(ticker: string, fromISO: string, toISO: string): Promise<DailyBar[]>;
  latest(tickers: string[]): Promise<DailyBar[]>;
}

export interface FxProvider {
  readonly name: string;
  ratesToUsd(asOfISO?: string): Promise<Record<string, number>>;
}
