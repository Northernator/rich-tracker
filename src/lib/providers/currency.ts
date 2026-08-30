/**
 * Currency resolution — the shared rule that "an unknown currency is an error,
 * not USD" is enforced in code rather than in a comment.
 *
 * Every provider calls `resolveCurrency` once per response. There is no code
 * path that produces a DailyBar with a currency the provider did not state or
 * the registry did not assert, so a rupee-denominated price can never be
 * stamped "USD" on its way into `stock_snapshots`.
 */

const ISO_4217 = /^[A-Z]{3}$/;

/**
 * A mismatch here is not a rounding artefact. It means the ticker resolved to a
 * different listing than the registry expects — RELIANCE.NS priced in USD, say,
 * which would understate a holding by ~85x. Refuse rather than reconcile.
 */
export function resolveCurrency(
  providerName: string,
  reported: string | null | undefined,
  expected: string | undefined
): string {
  const r = normalise(reported);
  const e = normalise(expected);

  if (r) {
    if (e && r !== e) {
      throw new Error(
        `Currency mismatch for ${providerName}: provider reports "${r}" but the ` +
          `securities registry expects "${e}". Refusing to store a price in the ` +
          `wrong currency — fix the registry or the ticker mapping.`
      );
    }
    return r;
  }

  if (e) return e;

  throw new Error(
    `${providerName} did not report a currency and the caller supplied no ` +
      `expected currency. An unknown currency is an error, not USD — pass the ` +
      `currency from the securities registry.`
  );
}

function normalise(value: string | null | undefined): string | null {
  if (typeof value !== "string") return null;
  const v = value.trim().toUpperCase();
  if (!ISO_4217.test(v)) return null;
  return v;
}

/** Rejects a payload whose currency cannot be read at all. */
export function assertKnownCurrency(
  providerName: string,
  currency: string | null | undefined,
  context: string
): string {
  const c = normalise(currency);
  if (!c) {
    throw new Error(
      `${providerName}: unreadable currency ${JSON.stringify(currency)} for ${context}. ` +
        `Refusing to guess.`
    );
  }
  return c;
}
