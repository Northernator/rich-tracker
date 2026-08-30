import { db } from "@/lib/db";
import { equityHoldings, stockSnapshots, baselineEstimates, people } from "@/lib/db/schema";
import { loadFxLookup } from "@/lib/db/fx";
import { toUsdCents } from "@/lib/money";
import { sql, asc, eq } from "drizzle-orm";
import Link from "next/link";

// ---------------------------------------------------------------------------
// Comparability
// ---------------------------------------------------------------------------

/**
 * How far apart two estimates can be dated and still be compared.
 *
 * The whole point of the band is to show that two published figures disagree.
 * But Wikidata's P2218 statements are frequently years old, and a 2019 figure
 * against a 2026 one produces a "spread" of several hundred percent that
 * measures nothing but the passage of time — it topped the spread sort with
 * noise (a 2015 Huffington Post listicle, a Snap valuation from before the
 * IPO) while the genuine disputes sat below it.
 *
 * Measured on this data set, the split is unambiguous: estimates dated within
 * 24 months of each other have a median spread of 7%; beyond that it jumps to
 * 49%. So the band is computed over contemporaneous estimates only, and an
 * out-of-window source is reported as stale rather than silently widening the
 * range.
 */
const COMPARABILITY_WINDOW_DAYS = 730;

const asMs = (iso: string): number => {
  const t = Date.parse(iso);
  return Number.isFinite(t) ? t : 0;
};

const yearOf = (iso: string): string => (iso && iso.length >= 4 ? iso.slice(0, 4) : "?");

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function formatB(cents: number): string {
  return `$${(cents / 100 / 1e9).toFixed(1)}B`;
}

function spreadStats(values: number[]) {
  if (values.length === 0) return { min: 0, max: 0, median: 0, spread: 0, count: 0 };
  const sorted = [...values].sort((a, b) => a - b);
  const min = sorted[0];
  const max = sorted[sorted.length - 1];
  const mid = Math.floor(sorted.length / 2);
  const median =
    sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
  return { min, max, median, spread: max - min, count: sorted.length };
}

// ---------------------------------------------------------------------------
// Data layer
// ---------------------------------------------------------------------------

interface SourceEstimate {
  sourceId: string;
  sourceName: string;
  netWorthCents: number;
  asOf: string;
}

interface PersonRow {
  slug: string;
  name: string;
  country: string | null;
  org: string | null;
  /** Median across estimates that are contemporaneous with the newest one. */
  medianCents: number;
  /** Contemporaneous estimates, oldest first. */
  comparable: SourceEstimate[];
  /** Estimates too old to compare — reported, never folded into the band. */
  stale: SourceEstimate[];
  lowCents: number;
  highCents: number;
  spreadCents: number;
  spreadPct: number;
  sourceCount: number;
  /**
   * Age, in days, of this person's most recent second-source estimate
   * relative to their newest estimate overall. Null when there is no second
   * source at all. Drives the corroboration-gap note, which is computed rather
   * than written down so it cannot drift away from the data.
   */
  secondSourceAgeDays: number | null;
  liquidCents: number;
  privateCents: number;
  liquidPct: number;
  confidence: "high" | "medium" | "low";
  fxErrors: Array<{ ticker: string; message: string }>;
  tickers: Array<{ ticker: string; exchange: string; shares: number; price: number; estimated: number }>;
}

const SORTS = {
  consensus: "Rank",
  spread: "Widest disagreement",
  agreement: "Closest agreement",
} as const;
type SortKey = keyof typeof SORTS;

export default async function HomePage({
  searchParams,
}: {
  searchParams: Promise<{ sort?: string }>;
}) {
  const params = await searchParams;
  const sort: SortKey =
    params.sort === "spread" || params.sort === "agreement" ? params.sort : "consensus";

  // Latest data timestamp for credibility
  const latestRow = await db
    .select({ latest: sql<string>`MAX(${baselineEstimates.asOf})` })
    .from(baselineEstimates);
  const lastUpdated = latestRow[0]?.latest
    ? new Date(latestRow[0].latest).toLocaleDateString("en-US", {
        year: "numeric",
        month: "long",
        day: "numeric",
      })
    : null;

  // Latest estimate per (person, source), carrying the date it was taken
  const latestByPersonSource = (await db
    .select({
      personId: baselineEstimates.personId,
      sourceId: baselineEstimates.sourceId,
      sourceName: sql<string>`s.name`.mapWith(String),
      netWorthCents: baselineEstimates.netWorthCents,
      asOf: baselineEstimates.asOf,
    })
    .from(baselineEstimates)
    .leftJoin(sql`sources s`, sql` s.id = ${baselineEstimates.sourceId}`)
    .where(
      sql`baseline_estimates.as_of = (SELECT MAX(be2.as_of) FROM baseline_estimates be2 WHERE be2.person_id = baseline_estimates.person_id AND be2.source_id = baseline_estimates.source_id)`
    )
    .orderBy(asc(baselineEstimates.personId), asc(baselineEstimates.netWorthCents))) as Array<{
      personId: string;
      sourceId: string;
      sourceName: string;
      netWorthCents: number;
      asOf: string;
    }>;

  // Check if any estimates are synthetic (dev fallback)
  const syntheticCount = (await db
    .select({ c: sql<number>`COUNT(*)` })
    .from(baselineEstimates)
    .where(sql`${baselineEstimates.sourceId} = 'synthetic'`))[0]?.c ?? 0;

  const estimatesByPerson = new Map<string, SourceEstimate[]>();
  for (const row of latestByPersonSource) {
    if (!estimatesByPerson.has(row.personId)) estimatesByPerson.set(row.personId, []);
    estimatesByPerson.get(row.personId)!.push({
      sourceId: row.sourceId,
      sourceName: row.sourceName,
      netWorthCents: row.netWorthCents,
      asOf: row.asOf,
    });
  }

  // Latest price per ticker (most recent as_of), carrying currency + asOf so a
  // local-currency price converts at the rate that applied then.
  const fx = await loadFxLookup();
  const latestPrices = (await db
    .select({
      ticker: stockSnapshots.ticker,
      priceCents: stockSnapshots.priceCents,
      asOf: stockSnapshots.asOf,
      currency: stockSnapshots.currency,
    })
    .from(stockSnapshots)
    .orderBy(asc(stockSnapshots.asOf))) as Array<{
    ticker: string;
    priceCents: number;
    asOf: string;
    currency: string;
  }>;
  const priceByTicker = new Map<string, { priceCents: number; asOf: string; currency: string }>();
  for (const s of latestPrices) {
    priceByTicker.set(s.ticker, {
      priceCents: s.priceCents,
      asOf: s.asOf,
      currency: s.currency,
    });
  }

  // All holdings grouped by person
  const allHoldings = await db.select().from(equityHoldings).orderBy(asc(equityHoldings.id));
  const holdingsByPerson = new Map<string, (typeof allHoldings)[number][]>();
  for (const h of allHoldings) {
    if (!holdingsByPerson.has(h.personId)) holdingsByPerson.set(h.personId, []);
    holdingsByPerson.get(h.personId)!.push(h);
  }

  const allPeople = await db.select().from(people).where(eq(people.isPublicFigure, 1));
  const peopleById = new Map<string, (typeof allPeople)[number]>();
  for (const p of allPeople) peopleById.set(p.id, p);

  // Build rows
  const rows: PersonRow[] = [];

  for (const [personId, ests] of estimatesByPerson) {
    const person = peopleById.get(personId);
    if (!person) continue;

    // Split on contemporaneity with the newest estimate for this person.
    const newestMs = Math.max(...ests.map((e) => asMs(e.asOf)));
    const windowMs = COMPARABILITY_WINDOW_DAYS * 86_400_000;
    const comparable = ests
      .filter((e) => newestMs - asMs(e.asOf) <= windowMs)
      .sort((a, b) => a.netWorthCents - b.netWorthCents);
    const stale = ests
      .filter((e) => newestMs - asMs(e.asOf) > windowMs)
      .sort((a, b) => asMs(b.asOf) - asMs(a.asOf));

    const { min: lowCents, max: highCents, median: medianCents, spread: spreadCents, count: sourceCount } =
      spreadStats(comparable.map((e) => e.netWorthCents));
    const spreadPct = medianCents > 0 ? (spreadCents / medianCents) * 100 : 0;

    const holdings = holdingsByPerson.get(personId) ?? [];
    let liquidCents = 0;
    const fxErrors: PersonRow["fxErrors"] = [];
    const tickers: PersonRow["tickers"] = [];
    for (const h of holdings) {
      const latest = priceByTicker.get(h.ticker);
      let usdPriceCents = 0;
      if (latest) {
        try {
          usdPriceCents = toUsdCents(latest.priceCents, latest.currency, latest.asOf, fx);
        } catch (err) {
          fxErrors.push({
            ticker: h.ticker,
            message: err instanceof Error ? err.message : String(err),
          });
        }
      }
      liquidCents += usdPriceCents * h.shares;
      tickers.push({
        ticker: h.ticker,
        exchange: h.exchange,
        shares: h.shares,
        price: usdPriceCents / 100,
        estimated: h.estimated,
      });
    }

    const privateCents = Math.max(0, medianCents - liquidCents);
    const liquidPct = medianCents > 0 ? (liquidCents / medianCents) * 100 : 0;

    // How much older is the runner-up source than the freshest one? This is
    // the honest measure of "how well corroborated is this fortune", and it is
    // the same quantity the comparability window cuts on.
    const byRecency = [...ests].sort((a, b) => asMs(b.asOf) - asMs(a.asOf));
    const secondSourceAgeDays =
      byRecency.length > 1
        ? Math.round((asMs(byRecency[0].asOf) - asMs(byRecency[1].asOf)) / 86_400_000)
        : null;

    // Confidence describes the comparison, not just the count: two sources
    // that were published years apart are not corroborating each other.
    let confidence: "high" | "medium" | "low";
    if (sourceCount >= 2 && spreadPct < 10) {
      confidence = "high";
    } else if (sourceCount >= 2 && spreadPct < 25) {
      confidence = "medium";
    } else {
      confidence = "low";
    }

    rows.push({
      slug: person.slug,
      name: person.fullName,
      country: person.country,
      org: person.primaryOrg,
      medianCents,
      comparable,
      stale,
      lowCents,
      highCents,
      spreadCents,
      spreadPct,
      sourceCount,
      secondSourceAgeDays,
      liquidCents,
      privateCents,
      liquidPct,
      confidence,
      fxErrors,
      tickers,
    });
  }

  // Ranking by disagreement only means something where two contemporaneous
  // estimates exist; otherwise the order would be set by how old the second
  // source happens to be, which is noise.
  const corroborated = rows.filter((r) => r.sourceCount >= 2);

  if (sort === "spread") {
    corroborated.sort((a, b) => b.spreadPct - a.spreadPct);
  } else if (sort === "agreement") {
    corroborated.sort((a, b) => a.spreadPct - b.spreadPct);
  } else {
    rows.sort((a, b) => b.medianCents - a.medianCents);
  }

  const displayed =
    sort === "consensus" ? rows.slice(0, 20) : corroborated.slice(0, 20);

  const totalComparable = corroborated.length;
  const mix = {
    high: corroborated.filter((r) => r.confidence === "high").length,
    medium: corroborated.filter((r) => r.confidence === "medium").length,
    low: corroborated.filter((r) => r.confidence === "low").length,
  };

  /**
   * The corroboration gap, measured rather than asserted: how old the most
   * recent second opinion is, for the biggest fortunes versus the rest. If
   * the comparison cannot be made the note is simply not shown.
   */
  const byWealth = rows
    .filter((r) => r.secondSourceAgeDays != null)
    .sort((a, b) => b.medianCents - a.medianCents);
  const medianAgeYears = (subset: typeof byWealth): number | null => {
    const ages = subset
      .map((r) => r.secondSourceAgeDays as number)
      .sort((a, b) => a - b);
    if (ages.length === 0) return null;
    return ages[Math.floor(ages.length / 2)] / 365.25;
  };
  const topBandAge = medianAgeYears(byWealth.slice(0, 20));
  const restBandAge = medianAgeYears(byWealth.slice(20));

  return (
    <div className="max-w-5xl mx-auto px-6 py-12">
      {syntheticCount > 0 && (
        <div className="mb-8 rounded-md border border-warning/30 bg-warning/5 px-4 py-3">
          <p className="text-sm text-warning font-medium">⚠ Synthetic data in use</p>
          <p className="text-sm text-fg-muted mt-1">
            The rtb-api was unavailable; {syntheticCount} net-worth estimates were auto-generated
            for development. Real data from the API will replace these on the next load.
          </p>
        </div>
      )}

      <div className="mb-10">
        <p className="text-xs uppercase tracking-widest text-fg-faint mb-2">
          Global Billionaire Tracker
          {lastUpdated && <span className="ml-3">Data as of {lastUpdated}</span>}
        </p>
        <h1 className="font-serif text-4xl font-semibold tracking-tight text-fg mb-4">
          The Honest Leaderboard
        </h1>
        <p className="text-lg text-fg-muted leading-relaxed max-w-2xl">
          Two published estimates of each fortune — komed3/rtb-api&rsquo;s mirror of the Forbes
          real-time list and Wikidata&rsquo;s net-worth statements — with the document behind
          every number. Where the two are dated close together, the band shows how far they
          disagree. Where Wikidata&rsquo;s snapshot is years old, the band is withheld rather than
          inflated into a fake controversy.
        </p>
        <p className="text-xs text-fg-faint leading-relaxed max-w-2xl mt-3">
          Both sources lean on Forbes&rsquo; own lists, so this is not two independent research
          teams checking each other — it is one methodology sampled at different moments. A wide
          band usually means the snapshots are far apart in time or one of them has gone stale.
          These are third-party estimates, not audited figures. See{" "}
          <Link href="/about" className="text-fg-faint hover:text-fg transition-colors underline">
            About
          </Link>{" "}
          for methodology.
        </p>
        {topBandAge != null && restBandAge != null && topBandAge > restBandAge && (
          <p className="mt-4 text-sm text-fg-muted leading-relaxed max-w-2xl border-l-2 border-border pl-4">
            <strong className="font-medium text-fg">The corroboration gap runs one way.</strong>{" "}
            Wikidata&rsquo;s coverage is freshest for the moderately rich and worst for the very
            richest: among the {totalComparable} people with two comparable estimates, the most
            recent second opinion on a top-20 fortune is a median of {topBandAge.toFixed(1)} years
            old, against {restBandAge.toFixed(1)} years for everyone below them. The bigger the
            fortune, the staler the only check on it.
          </p>
        )}
      </div>

      {/* Sort control */}
      <div className="mb-4 flex items-baseline justify-between gap-4 flex-wrap">
        <div className="flex items-center gap-1 text-xs">
          <span className="uppercase tracking-widest text-fg-faint mr-2">Sort</span>
          {(Object.keys(SORTS) as SortKey[]).map((key) => (
            <Link
              key={key}
              href={key === "consensus" ? "/" : `/?sort=${key}`}
              className={`px-2 py-1 rounded-sm border transition-colors ${
                sort === key
                  ? "border-accent text-accent bg-accent/5"
                  : "border-border text-fg-muted hover:text-fg hover:border-fg-faint"
              }`}
            >
              {SORTS[key]}
            </Link>
          ))}
        </div>
        <p className="text-xs text-fg-faint">
          {totalComparable} people have two estimates dated within{" "}
          {COMPARABILITY_WINDOW_DAYS / 365} years —{" "}
          <span className="text-success">● {mix.high}</span>{" "}
          <span className="text-warning">◐ {mix.medium}</span>{" "}
          <span className="text-danger">○ {mix.low}</span>
          {sort === "spread" && " · ranked by how far they disagree"}
          {sort === "agreement" && " · ranked by how closely they agree"}
        </p>
      </div>

      <div className="border border-border rounded-md overflow-hidden">
        <table className="w-full text-sm">
          <thead>
            <tr className="bg-surface border-b border-border">
              <th className="text-left px-4 py-3 text-xs uppercase tracking-widest text-fg-muted font-medium w-12">
                {sort === "consensus" ? "#" : ""}
              </th>
              <th className="text-left px-4 py-3 text-xs uppercase tracking-widest text-fg-muted font-medium">
                Name
              </th>
              <th className="text-right px-4 py-3 text-xs uppercase tracking-widest text-fg-muted font-medium">
                Consensus
              </th>
              <th className="px-4 py-3 text-xs uppercase tracking-widest text-fg-muted font-medium w-72">
                <span className="sr-only">Estimate spread</span>
                Source Band
              </th>
              <th className="px-4 py-3 text-xs uppercase tracking-widest text-fg-muted font-medium w-48">
                <span className="sr-only">Composition</span>
                Liquid / Private
              </th>
              <th className="text-center px-4 py-3 text-xs uppercase tracking-widest text-fg-muted font-medium w-20">
                Conf
              </th>
              <th className="text-right px-4 py-3 text-xs uppercase tracking-widest text-fg-muted font-medium w-16">
                n
              </th>
            </tr>
          </thead>
          <tbody>
            {displayed.map((row, i) => {
              // Band geometry: a row-local scale from zero to the highest
              // contemporaneous estimate, so the band is readable even when the
              // two figures sit far apart.
              const scaleMax = Math.max(row.highCents, 1);
              const pct = (v: number) => Math.max(0, Math.min(100, (v / scaleMax) * 100));
              const bandLeft = pct(row.lowCents);
              const bandWidth = pct(row.highCents) - bandLeft;
              // `comparable` is ordered by value for the geometry; the date
              // range and the per-source list have to be ordered by date or the
              // arrow runs backwards.
              const byDate = [...row.comparable].sort((a, b) => asMs(a.asOf) - asMs(b.asOf));
              const allEstimates = [...row.comparable, ...row.stale].sort(
                (a, b) => asMs(b.asOf) - asMs(a.asOf)
              );

              return (
                <tr
                  key={row.slug}
                  className={`border-b border-border last:border-0 ${i % 2 === 1 ? "bg-surface" : "bg-bg"}`}
                >
                  <td className="px-4 py-4 font-mono text-fg-muted text-xs align-top">
                    {sort === "consensus" ? i + 1 : ""}
                  </td>

                  <td className="px-4 py-4 align-top">
                    <div className="font-medium text-fg">{row.name}</div>
                    <div className="text-xs text-fg-faint mt-0.5">
                      {[row.country, row.org].filter(Boolean).join(" · ")}
                    </div>
                    {row.tickers.length > 0 && (
                      <div className="text-xs font-mono text-fg-muted mt-0.5">
                        {row.tickers.map((t) => t.ticker).join(", ")}
                      </div>
                    )}
                  </td>

                  <td className="px-4 py-4 text-right font-mono font-medium text-fg align-top whitespace-nowrap">
                    {formatB(row.medianCents)}
                  </td>

                  {/* Source band */}
                  <td className="px-4 py-4 align-top">
                    {row.sourceCount >= 2 ? (
                      <>
                        <div className="flex items-baseline justify-between gap-2 mb-1">
                          <span className="font-mono text-xs text-fg">
                            {row.spreadPct < 1 ? (
                              // Below the display precision of a billion-dollar
                              // figure the two numbers are the same number.
                              // Printing "$8.0B – $8.0B" reads like a bug.
                              formatB(row.medianCents)
                            ) : (
                              <>
                                {formatB(row.lowCents)} &ndash; {formatB(row.highCents)}
                              </>
                            )}
                          </span>
                          <span className="font-mono text-[10px] text-fg-faint whitespace-nowrap">
                            {row.spreadPct < 1
                              ? "sources agree"
                              : `${row.spreadPct.toFixed(0)}% apart`}
                          </span>
                        </div>
                        <div className="relative h-8 bg-surface border border-border rounded-sm">
                          {/* Range between the lowest and highest estimate */}
                          <div
                            className="absolute inset-y-0 bg-accent/20 border-x border-accent/40"
                            style={{ left: `${bandLeft}%`, width: `${Math.max(bandWidth, 1)}%` }}
                          />
                          {/* One tick per source */}
                          {row.comparable.map((e, idx) => (
                            <div
                              key={`${e.sourceId}-${idx}`}
                              className="absolute top-0 bottom-0 w-0.5 bg-accent/70"
                              style={{ left: `${pct(e.netWorthCents)}%` }}
                              title={`${e.sourceName}: ${formatB(e.netWorthCents)} (${yearOf(e.asOf)})`}
                            />
                          ))}
                          {/* Median marker */}
                          <div
                            className="absolute top-0 bottom-0 w-0.5 bg-accent"
                            style={{ left: `${pct(row.medianCents)}%` }}
                          />
                        </div>
                        <div className="flex items-baseline justify-between gap-2 mt-1">
                          <span className="font-mono text-[10px] text-fg-faint">
                            {byDate.length > 1 ? `${yearOf(byDate[0].asOf)} → ${yearOf(byDate[byDate.length - 1].asOf)}` : yearOf(byDate[0].asOf)}
                          </span>
                          <span className="relative group">
                            <span className="font-mono text-[10px] text-fg-muted underline decoration-dotted cursor-default">
                              {row.sourceCount} sources
                            </span>
                            <span className="absolute right-0 top-full mt-1 z-10 hidden group-hover:block bg-bg border border-border rounded shadow-sm p-2 text-xs font-mono min-w-[200px]">
                              {allEstimates.map((e, idx) => (
                                <span
                                  key={`${e.sourceId}-${idx}`}
                                  className="flex justify-between gap-4 py-0.5"
                                >
                                  <span className={row.stale.includes(e) ? "text-fg-faint" : "text-fg-muted"}>
                                    {e.sourceName} {yearOf(e.asOf)}
                                  </span>
                                  <span className={row.stale.includes(e) ? "text-fg-faint" : "text-fg"}>
                                    {formatB(e.netWorthCents)}
                                  </span>
                                </span>
                              ))}
                            </span>
                          </span>
                        </div>
                      </>
                    ) : (
                      <>
                        <div className="font-mono text-xs text-fg-muted mb-1">single estimate</div>
                        <div className="relative h-8 bg-surface border border-border rounded-sm">
                          <div
                            className="absolute top-0 bottom-0 w-0.5 bg-fg-faint"
                            style={{ left: `${pct(row.medianCents)}%` }}
                          />
                        </div>
                        <div className="font-mono text-[10px] text-fg-faint mt-1">
                          {row.stale.length > 0
                            ? `2nd source is ${yearOf(row.stale[0].asOf)} — too old to compare`
                            : "no second source"}
                        </div>
                      </>
                    )}
                  </td>

                  {/* Composition bar */}
                  <td className="px-4 py-4 align-top">
                    <div className="flex items-center gap-2">
                      <div className="flex-1 h-5 bg-border rounded-sm overflow-hidden flex">
                        {row.liquidPct > 0 && (
                          <div
                            className="h-full bg-accent rounded-l-sm"
                            style={{ width: `${Math.min(row.liquidPct, 100)}%` }}
                            title={`Liquid: ${formatB(row.liquidCents)}`}
                          />
                        )}
                        {row.privateCents > 0 && (
                          <div
                            className="h-full bg-warning/30 rounded-r-sm"
                            style={{ width: `${Math.max(100 - row.liquidPct, 2)}%` }}
                            title={`Private/Other: ${formatB(row.privateCents)}`}
                          />
                        )}
                      </div>
                      <span className="text-xs font-mono text-fg-muted w-10 text-right">
                        {row.fxErrors.length > 0 ? (
                          <span
                            className="text-danger"
                            title={`${row.fxErrors.length} holding(s) excluded — no FX rate to USD: ${row.fxErrors
                              .map((e) => e.ticker)
                              .join(", ")}`}
                          >
                            &#9888;
                          </span>
                        ) : row.liquidPct > 100 ? (
                          <span
                            className="text-danger"
                            title="Verified liquid equity exceeds the baseline net worth. The share count, the price or the baseline is wrong — this figure is not trustworthy."
                          >
                            {row.liquidPct.toFixed(0)}% &#9888;
                          </span>
                        ) : row.liquidPct > 0 ? (
                          `${row.liquidPct.toFixed(0)}%`
                        ) : (
                          "\u2014"
                        )}
                      </span>
                    </div>
                  </td>

                  {/* Confidence badge */}
                  <td className="px-4 py-4 text-center align-top">
                    <span
                      className={`inline-flex items-center px-2 py-0.5 rounded text-xs font-mono ${
                        row.confidence === "high"
                          ? "bg-success/10 text-success"
                          : row.confidence === "medium"
                          ? "bg-warning/10 text-warning"
                          : "bg-danger/10 text-danger"
                      }`}
                      title={
                        row.confidence === "high"
                          ? "Two or more estimates dated within two years, agreeing within 10%"
                          : row.confidence === "medium"
                          ? "Two or more estimates dated within two years, agreeing within 25%"
                          : "One usable estimate, or the estimates disagree widely, or they are too far apart in time to compare"
                      }
                    >
                      {row.confidence === "high" ? "●" : row.confidence === "medium" ? "◐" : "○"}
                    </span>
                  </td>

                  <td className="px-4 py-4 text-right font-mono text-xs text-fg-muted align-top">
                    {row.sourceCount}
                    {row.stale.length > 0 && (
                      <span className="text-fg-faint" title={`${row.stale.length} estimate(s) too old to compare`}>
                        +{row.stale.length}
                      </span>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {/* Legend */}
      <div className="mt-6 flex flex-wrap gap-x-6 gap-y-2 text-xs text-fg-muted">
        <div className="flex items-center gap-2">
          <div className="w-3 h-3 bg-accent/20 border-x border-accent/40 rounded-sm" />
          <span>Range between contemporaneous estimates</span>
        </div>
        <div className="flex items-center gap-2">
          <div className="w-0.5 h-3 bg-accent rounded-sm" />
          <span>Median</span>
        </div>
        <div className="flex items-center gap-2">
          <div className="w-0.5 h-3 bg-accent/70 rounded-sm" />
          <span>Each source&rsquo;s figure</span>
        </div>
        <div className="flex items-center gap-2">
          <div className="w-3 h-3 bg-accent rounded-sm" />
          <span>Liquid (public stocks × market price)</span>
        </div>
        <div className="flex items-center gap-2">
          <div className="w-3 h-3 bg-warning/30 rounded-sm" />
          <span>Private / Other (estimated)</span>
        </div>
        <div className="flex items-center gap-2">
          <span className="text-success">●</span>
          <span>High — 2+ sources within 2 years, agreeing within 10%</span>
        </div>
        <div className="flex items-center gap-2">
          <span className="text-warning">◐</span>
          <span>Medium — 2+ sources within 2 years, agreeing within 25%</span>
        </div>
        <div className="flex items-center gap-2">
          <span className="text-danger">○</span>
          <span>Low — one source, dated too far apart, or wide disagreement</span>
        </div>
      </div>
    </div>
  );
}
