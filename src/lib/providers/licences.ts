/**
 * Provider licence register — the app's answer to "may I show this publicly?"
 *
 * Why this file exists: `finnhub.ts` and `alphavantage.ts` shipped declaring
 * `licence: "display-permitted"` while being empty stubs that had never made a
 * request. Nothing checked the claim. A licence assertion that nothing verifies
 * is exactly the shape of problem this project keeps having — it is a
 * provenance claim with no source, and it would have been copied into
 * `stock_snapshots.licence` and onto a public page as fact.
 *
 * So the licence value is no longer free-floating. It lives here, in one
 * register, and `assertLicence()` refuses to boot a provider whose adapter
 * claims more than the register can evidence. Flipping a provider to
 * "display-permitted" now requires adding a `url` that resolves to the terms
 * and the date they were read — the same standard as every other claim in the
 * database.
 *
 * Until terms are confirmed in writing, every provider is "unlicensed". That is
 * not a placeholder; it is the correct current value, and it is why the app
 * must treat all price data as internal-only.
 */
import type { ProviderLicence } from "./types";

export interface LicenceEvidence {
  /** Resolves to the document granting the right — terms, licence, contract. */
  url: string;
  /** ISO date (YYYY-MM-DD) the terms were actually read. */
  confirmedOn: string;
  /** What the document permits, in plain terms. */
  note: string;
}

export interface LicenceRecord {
  provider: string;
  licence: ProviderLicence;
  /** What the provider costs, in the currency actually billed. */
  cost: string;
  /**
   * Required whenever `licence !== "unlicensed"`. Optional only so the
   * unlicensed entries below can stay honest without inventing a citation.
   */
  evidence?: LicenceEvidence;
}

/**
 * The single source of truth for what each provider may be used for.
 *
 * To upgrade a provider: add `evidence` with a URL that opens the terms and
 * the date you read them. Empty-handed upgrades are rejected at boot by
 * `assertLicence()`, not discovered after launch.
 */
export const LICENCE_REGISTER: Record<string, LicenceRecord> = {
  yahoo: {
    provider: "yahoo",
    licence: "unlicensed",
    cost: "£0",
    // No paid display licence is offered for the query1 chart endpoint. The
    // public terms permit personal, non-commercial use only, so there is no
    // price at which this becomes display-permitted. Recorded in
    // docs/LICENSING.md.
  },
  finnhub: {
    provider: "finnhub",
    licence: "unlicensed",
    cost: "$0–79/mo depending on tier",
    // UNCONFIRMED. Finnhub publishes tiered plans, but the redistribution and
    // public-display terms have not been read and recorded. Do not set this to
    // "display-permitted" until `evidence` below is filled in.
  },
  alphavantage: {
    provider: "alphavantage",
    licence: "unlicensed",
    cost: "$0 (25 req/day) or paid tiers",
    // UNCONFIRMED. Same position as finnhub. Note that Alpha Vantage's free
    // key terms have historically restricted redistribution; the cross-check
    // role below does not depend on displaying their data publicly.
  },
};

/**
 * Whether data carrying this licence may be rendered on a public page.
 *
 * "internal-only" is deliberately not enough. A provider can be lawful to use
 * for analysis and still forbid republication, and this app publishes.
 */
export function canDisplayPublicly(licence: ProviderLicence): boolean {
  return licence === "display-permitted";
}

export interface LicencedThing {
  readonly name: string;
  readonly licence: ProviderLicence;
}

/**
 * Boot-time gate. Called by the registry for every provider it hands out, so an
 * inflated licence is a hard failure at startup rather than a silent row in a
 * public table.
 */
export function assertLicence(provider: LicencedThing): void {
  const record = LICENCE_REGISTER[provider.name];

  if (!record) {
    throw new Error(
      `Provider "${provider.name}" has no entry in LICENCE_REGISTER — ` +
        `add one before using it. Unregistered providers cannot assert a licence.`
    );
  }

  if (record.licence !== provider.licence) {
    throw new Error(
      `Licence mismatch for "${provider.name}": adapter declares ` +
        `"${provider.licence}" but LICENCE_REGISTER declares "${record.licence}". ` +
        `Update the register with evidence, not the adapter on its own.`
    );
  }

  if (provider.licence !== "unlicensed" && !record.evidence) {
    throw new Error(
      `Provider "${provider.name}" claims "${provider.licence}" but ` +
        `LICENCE_REGISTER has no evidence for it. Add a { url, confirmedOn, note } ` +
        `pointing at the terms before claiming a licence — an unevidenced ` +
        `licence claim is not inserted.`
    );
  }

  if (record.evidence && !/^https?:\/\/\S+$/.test(record.evidence.url)) {
    throw new Error(
      `Provider "${provider.name}" has licence evidence with an unresolvable url: ` +
        `"${record.evidence.url}"`
    );
  }
}

/** Convenience for callers that already hold a provider name. */
export function licenceFor(providerName: string): ProviderLicence {
  const record = LICENCE_REGISTER[providerName];
  if (!record) {
    throw new Error(`No licence recorded for provider "${providerName}"`);
  }
  return record.licence;
}
