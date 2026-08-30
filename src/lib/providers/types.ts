export interface DailyBar {
  asOf: string;
  ticker: string;
  priceCents: number;
  /**
   * ISO 4217, and always populated. A provider that cannot state the currency
   * of a quote must be handed the expected one rather than being allowed to
   * fill in "USD" — see `resolveCurrency` in ./currency.ts.
   */
  currency: string;
}

export type ProviderLicence = "display-permitted" | "internal-only" | "unlicensed";

export interface BarQueryOptions {
  /**
   * The currency the caller expects, taken from the `securities` registry.
   *
   * - Providers with `reportsCurrency: true` use it as a cross-check and throw
   *   on a mismatch.
   * - Providers with `reportsCurrency: false` adopt it as the value, and throw
   *   if it is not supplied.
   */
  expectedCurrency?: string;
}

export interface TickerQuery {
  ticker: string;
  /** See BarQueryOptions.expectedCurrency. */
  expectedCurrency?: string;
}

export interface PriceProvider {
  readonly name: string;
  readonly licence: ProviderLicence;

  /**
   * Whether the provider's own payload states the quote currency.
   *
   * Yahoo reports it (`meta.currency`) and Finnhub can be made to via
   * `/stock/profile2`. Alpha Vantage's daily and quote endpoints do not carry
   * one at all — for that provider the currency has to come from the registry,
   * and absence of an expected currency is a hard error, never "USD".
   */
  readonly reportsCurrency: boolean;

  dailyBars(
    ticker: string,
    fromISO: string,
    toISO: string,
    opts?: BarQueryOptions
  ): Promise<DailyBar[]>;

  latest(queries: TickerQuery[]): Promise<DailyBar[]>;
}

export interface FxProvider {
  readonly name: string;
  ratesToUsd(asOfISO?: string): Promise<Record<string, number>>;
}
