/**
 * Insert-time sanity gates for holdings.
 *
 * Two impossible things shipped to the live site before this existed:
 *   - Bezos at 122% "verifiable" and Zuckerberg at 104% — verified liquid
 *     equity exceeding total net worth, printed without comment on a page
 *     titled "The Honest Leaderboard".
 *   - Buffett at 152,000 BRK-B shares, wrong by ~1,800x, rendering as 0.1%.
 *
 * `securities.outstanding_shares` was already populated and would have caught
 * the first class; nothing checked it. These helpers are cheap and belong on
 * every path that writes a holding.
 */
import Database from "better-sqlite3";

export interface HoldingCandidate {
  personSlug: string;
  ticker: string;
  shares: number;
  sourceUrl?: string | null;
}

/**
 * Discriminated union so a rejection can never be logged without its reason —
 * `verdict.reason` is only reachable once `ok` is known false, which is what
 * makes "every skip is logged with a reason" a compile-time guarantee rather
 * than a convention.
 */
export type SanityVerdict = { ok: true } | { ok: false; reason: string };

/** Nobody personally owns more than half a listed company. */
export const MAX_OUTSTANDING_FRACTION = 0.5;

/**
 * Verified liquid equity above this multiple of the baseline net worth means
 * the share count, the price, or the baseline is wrong. 1.0 would be the
 * strict bound; a little headroom absorbs stale baselines.
 */
export const MAX_LIQUID_OVER_BASELINE = 1.05;

export function checkAgainstOutstanding(
  db: Database.Database,
  c: HoldingCandidate
): SanityVerdict {
  if (!Number.isFinite(c.shares) || c.shares <= 0) {
    return { ok: false, reason: `share count is not a positive number (${c.shares})` };
  }

  const row = db
    .prepare("SELECT outstanding_shares FROM securities WHERE ticker = ? LIMIT 1")
    .get(c.ticker) as { outstanding_shares: number | null } | undefined;

  const outstanding = row?.outstanding_shares ?? null;
  if (outstanding == null) return { ok: true }; // unknown float — can't judge

  const fraction = c.shares / outstanding;
  if (fraction > MAX_OUTSTANDING_FRACTION) {
    return {
      ok: false,
      reason:
        `${c.shares.toLocaleString()} ${c.ticker} is ${(fraction * 100).toFixed(1)}% of ` +
        `${outstanding.toLocaleString()} shares outstanding (cap ${MAX_OUTSTANDING_FRACTION * 100}%)`,
    };
  }
  return { ok: true };
}

export function checkAgainstBaseline(
  db: Database.Database,
  c: HoldingCandidate
): SanityVerdict {
  const price = db
    .prepare(
      "SELECT price_cents FROM stock_snapshots WHERE ticker = ? ORDER BY as_of DESC LIMIT 1"
    )
    .get(c.ticker) as { price_cents: number } | undefined;
  if (!price) return { ok: true }; // no price yet — nothing to compare

  const baseline = db
    .prepare(
      `SELECT b.net_worth_cents AS cents
         FROM baseline_estimates b
         JOIN people p ON p.id = b.person_id
        WHERE p.slug = ?
        ORDER BY b.as_of DESC
        LIMIT 1`
    )
    .get(c.personSlug) as { cents: number } | undefined;
  if (!baseline) return { ok: true };

  const liquidCents = price.price_cents * c.shares;
  const ratio = liquidCents / baseline.cents;
  if (ratio > MAX_LIQUID_OVER_BASELINE) {
    return {
      ok: false,
      reason:
        `${c.personSlug}: ${c.ticker} alone values at ${(ratio * 100).toFixed(0)}% of ` +
        `baseline net worth — share count, price or baseline is wrong`,
    };
  }
  return { ok: true };
}

/**
 * Run every gate. Returns ok:false with a human reason on the first failure.
 * Callers must SKIP the row and log — never clamp the value and insert anyway.
 */
export function checkHolding(db: Database.Database, c: HoldingCandidate): SanityVerdict {
  if (c.sourceUrl != null && !/^https?:\/\//.test(c.sourceUrl)) {
    return { ok: false, reason: `source_url is not resolvable: "${c.sourceUrl}"` };
  }
  const a = checkAgainstOutstanding(db, c);
  if (!a.ok) return a;
  return checkAgainstBaseline(db, c);
}

// ---------------------------------------------------------------------------
// Baseline (net-worth) estimates
// ---------------------------------------------------------------------------

/**
 * Every row in `people` came from a billionaire list, so a claim that one of
 * them is worth less than a million dollars is a unit or data error, not a
 * disagreement. $1M in cents.
 */
export const MIN_PLAUSIBLE_NET_WORTH_CENTS = 100_000_000;

/**
 * The largest fortune ever recorded is a few hundred billion dollars. Ten
 * times that is a ceiling no real figure can reach; anything above it is a
 * currency-unit mix-up (an amount in rupees stamped as dollars, typically),
 * not a wide-but-genuine disagreement. Deliberately loose — this gate exists
 * to catch errors, not to suppress the spread this project exists to show.
 */
export const MAX_PLAUSIBLE_NET_WORTH_CENTS = 500_000_000_000_000;

export interface BaselineCandidate {
  personSlug: string;
  netWorthCents: number;
  currency: string;
  sourceUrl: string | null;
}

/**
 * Gates for a net-worth claim. Unlike holdings there is no shares-outstanding
 * figure to cross-check against, so these are structural: the citation must
 * resolve and the magnitude must be physically possible.
 */
export function checkBaseline(c: BaselineCandidate): SanityVerdict {
  if (!Number.isFinite(c.netWorthCents) || !Number.isInteger(c.netWorthCents)) {
    return { ok: false, reason: `net worth is not an integer number of cents (${c.netWorthCents})` };
  }
  if (typeof c.sourceUrl !== "string" || !/^https?:\/\/\S+$/.test(c.sourceUrl)) {
    return {
      ok: false,
      reason: `no resolvable source_url${c.sourceUrl == null ? "" : ` ("${c.sourceUrl}")`} — an uncited claim is not inserted`,
    };
  }
  if (c.netWorthCents < MIN_PLAUSIBLE_NET_WORTH_CENTS) {
    return {
      ok: false,
      reason:
        `${(c.netWorthCents / 100).toLocaleString()} ${c.currency} is below the $1M floor — ` +
        `a unit error, not a small fortune`,
    };
  }
  if (c.netWorthCents > MAX_PLAUSIBLE_NET_WORTH_CENTS) {
    return {
      ok: false,
      reason:
        `${(c.netWorthCents / 100).toLocaleString()} ${c.currency} exceeds the $5T ceiling — ` +
        `currency unit is wrong`,
    };
  }
  return { ok: true };
}
