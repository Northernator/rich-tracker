/**
 * Valuation — the one place "the honest number" is computed.
 *
 * `computeValuation` is the shared formula behind BOTH the /equity page and
 * `npm run snapshot`, so the persisted row can never drift from what the page
 * shows. It returns the three headline figures (liquid, baseline, pledged),
 * the per-holding resolved prices, any FX failures, and the full `inputs`
 * object that gets stored in `valuation_snapshots.inputs`.
 *
 * The reproducibility contract: a person with `inputs` and a calculator must
 * be able to reproduce `liquid_cents` exactly. To make that true, `inputs`
 * records every number that entered the sum — per holding: security_id, share
 * count, price_cents, as_of, the FX rate applied, and the baseline row id.
 *
 * `verifiability` is liquid/baseline and is deliberately NOT clamped: a value
 * above 1.0 is a signal that a share count or a baseline is wrong, and the UI
 * flags it (the same 122%⚠ case already rendered on /equity). Hiding an
 * impossible ratio would hide the bug.
 */

import type { FxLookup } from "@/lib/money";

/** The current valuation formula. Bump when the formula changes, never recompute old rows. */
export const METHOD_VERSION = "v1";

export interface HoldingLike {
  id: string;
  personId: string;
  ticker: string;
  exchange: string;
  shares: number;
  asOf: string;
  estimated: number;
  sourceUrl: string;
}

export interface PledgeLike {
  id: string;
  personId: string;
  ticker: string;
  exchange: string;
  sharesPledged: number;
  asOf: string;
  sourceType: string;
}

export interface LatestPrice {
  priceCents: number;
  asOf: string;
  currency: string;
}

export interface BaselineLike {
  id: string;
  netWorthCents: number;
  asOf: string;
  sourceId: string;
}

export interface ResolvedHolding {
  ticker: string;
  exchange: string;
  shares: number;
  estimated: number;
  /** USD price of one share, or null when the price or its FX rate is unavailable. */
  priceUsdCents: number | null;
  currency: string;
  fxError: string | null;
}

export interface ValuationResult {
  personId: string;
  liquidCents: number;
  baselineCents: number;
  pledgedCents: number;
  verifiability: number | null;
  fxErrors: Array<{ ticker: string; message: string }>;
  holdings: ResolvedHolding[];
  inputs: object;
}

interface ComputeParams {
  personId: string;
  holdings: HoldingLike[];
  pledges: PledgeLike[];
  /** Latest price per ticker (most recent as_of), with its own asOf + currency. */
  latestPrices: Map<string, LatestPrice>;
  /** securities.id by ticker — recorded in inputs so each holding is traceable. */
  securityIds: Map<string, string>;
  baseline: BaselineLike | null;
  fx: FxLookup;
}

/** USD cents for one share, or null. Throws only when the rate is missing — never silently 1. */
function resolveUsdPriceCents(priceCents: number, currency: string, asOf: string, fx: FxLookup): {
  usdPriceCents: number;
  fxRate: number;
} | null {
  if (currency === "USD") return { usdPriceCents: priceCents, fxRate: 1 };
  const fxRate = fx.get(currency, asOf);
  if (fxRate == null) return null;
  // Mirrors toUsdCents exactly so the recorded rate IS the rate that was used.
  return { usdPriceCents: Math.round(priceCents * fxRate), fxRate };
}

export function computeValuation(params: ComputeParams): ValuationResult {
  const { personId, holdings, pledges, latestPrices, securityIds, baseline, fx } = params;

  let liquidCents = 0;
  const fxErrors: ValuationResult["fxErrors"] = [];
  const resolved: ResolvedHolding[] = [];
  const holdingInputs: object[] = [];

  for (const h of holdings) {
    const latest = latestPrices.get(h.ticker);
    let priceUsdCents: number | null = null;
    let fxRate: number | null = null;
    let fxError: string | null = null;
    let priceCents: number | null = null;
    let priceAsOf: string | null = null;
    let priceCurrency: string | null = null;

    if (latest) {
      priceCents = latest.priceCents;
      priceAsOf = latest.asOf;
      priceCurrency = latest.currency;
      const r = resolveUsdPriceCents(latest.priceCents, latest.currency, latest.asOf, fx);
      if (r == null) {
        fxError = `No FX rate for ${latest.currency} on or before ${latest.asOf}`;
        fxErrors.push({ ticker: h.ticker, message: fxError });
      } else {
        priceUsdCents = r.usdPriceCents;
        fxRate = r.fxRate;
        liquidCents += priceUsdCents * h.shares;
      }
    }

    resolved.push({
      ticker: h.ticker,
      exchange: h.exchange,
      shares: h.shares,
      estimated: h.estimated,
      priceUsdCents,
      currency: priceCurrency ?? "USD",
      fxError,
    });

    holdingInputs.push({
      security_id: securityIds.get(h.ticker) ?? h.ticker,
      ticker: h.ticker,
      exchange: h.exchange,
      shares: h.shares,
      estimated: h.estimated,
      price_cents: priceCents,
      as_of: priceAsOf,
      currency: priceCurrency,
      fx_rate_to_usd: fxRate, // 1 unit of currency = this many USD, at as_of
      usd_price_cents: priceUsdCents,
      holding_source_url: h.sourceUrl,
    });
  }

  let pledgedCents = 0;
  const pledgeInputs: object[] = [];
  for (const p of pledges) {
    const latest = latestPrices.get(p.ticker);
    if (latest) {
      const r = resolveUsdPriceCents(latest.priceCents, latest.currency, latest.asOf, fx);
      if (r == null) {
        fxErrors.push({ ticker: p.ticker, message: `No FX rate for ${latest.currency} on or before ${latest.asOf}` });
      } else {
        pledgedCents += r.usdPriceCents * p.sharesPledged;
      }
      pledgeInputs.push({
        ticker: p.ticker,
        shares_pledged: p.sharesPledged,
        price_cents: latest.priceCents,
        as_of: latest.asOf,
        currency: latest.currency,
        fx_rate_to_usd: r?.fxRate ?? null,
        usd_price_cents: r?.usdPriceCents ?? null,
      });
    }
  }

  const baselineCents = baseline?.netWorthCents ?? 0;
  const verifiability = baselineCents > 0 ? liquidCents / baselineCents : null;

  const inputs = {
    method_version: METHOD_VERSION,
    person_id: personId,
    baseline: baseline
      ? {
          baseline_id: baseline.id,
          net_worth_cents: baseline.netWorthCents,
          as_of: baseline.asOf,
          source_id: baseline.sourceId,
        }
      : null,
    holdings: holdingInputs,
    pledges: pledgeInputs,
    // The three figures so a reader can check the sum without re-adding.
    liquid_cents: liquidCents,
    pledged_cents: pledgedCents,
    baseline_cents: baselineCents,
    verifiability,
  };

  return {
    personId,
    liquidCents,
    baselineCents,
    pledgedCents,
    verifiability,
    fxErrors,
    holdings: resolved,
    inputs,
  };
}
