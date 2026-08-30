import { db } from "@/lib/db";
import {
  equityHoldings,
  stockSnapshots,
  baselineEstimates,
  people,
  pledgeHoldings,
  securities,
} from "@/lib/db/schema";
import { loadFxLookup } from "@/lib/db/fx";
import { computeValuation } from "@/lib/valuation";
import { sql, asc, eq, or } from "drizzle-orm";

function formatCents(cents: number): string {
  return `$${(cents / 100).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function formatB(billions: number): string {
  return `$${billions.toFixed(2)}B`;
}

function sparklineSVG(
  data: Array<{ date: string; price: number }>,
  width = 120,
  height = 32
): string {
  if (data.length < 2) return "";
  const prices = data.map((d) => d.price);
  const min = Math.min(...prices);
  const max = Math.max(...prices);
  const range = max - min || 1;
  const step = width / (data.length - 1);

  const points = data
    .map((_, i) => {
      const x = i * step;
      const y = height - ((prices[i] - min) / range) * (height - 4) - 2;
      return `${x.toFixed(1)},${y.toFixed(1)}`;
    })
    .join(" ");

  const isUp = prices[prices.length - 1] >= prices[0];
  const color = isUp ? "#1a8a5c" : "#c0392b";

  return `<svg width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" xmlns="http://www.w3.org/2000/svg">
    <polyline points="${points}" fill="none" stroke="${color}" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>
  </svg>`;
}

interface PersonRow {
  personId: string;
  slug: string;
  name: string;
  country: string;
  org: string | null;
  liquidCents: number;
  baselineCents: number;
  liquidPct: number | null;
  pledgedCents: number;
  leverageRatio: number | null; // baseline / (liquid - pledged)
  /** Holdings whose local-currency value could not be converted (no FX rate). */
  fxErrors: Array<{ ticker: string; message: string }>;
  tickers: Array<{
    ticker: string;
    exchange: string;
    shares: number;
    /** USD cents for the latest price, or null when the price or its FX rate is unavailable. */
    priceUsdCents: number | null;
    currency: string;
    estimated: number;
    fxError: string | null;
    /** Document stating this share count — the ticker renders as a citation link. */
    sourceUrl: string;
  }>;
  pledges: Array<{ ticker: string; shares: number; source: string; sourceType: "verified" | "unverified" }>;
  sparkData: Array<{ date: string; price: number }>;
}

export default async function EquityPage() {
  const fx = await loadFxLookup();

  // Latest price per ticker (most recent as_of), carrying its own asOf and
  // currency so a local-currency price converts at the rate that applied then.
  const latestPriceRows = (await db
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

  const latestByTicker = new Map<string, { priceCents: number; asOf: string; currency: string }>();
  for (const s of latestPriceRows) {
    latestByTicker.set(s.ticker, {
      priceCents: s.priceCents,
      asOf: s.asOf,
      currency: s.currency,
    });
  }

  // All holdings
  const allHoldings = await db
    .select()
    .from(equityHoldings)
    .orderBy(asc(equityHoldings.id));

  // All people — every public figure renders, with "no verified holdings"
  // for those without a filing-derived holding.
  const allPeople = await db.select().from(people).where(eq(people.isPublicFigure, 1));

  // Latest baseline per person (max as_of), carrying the row id for inputs.
  const latestBaselines = (await db
    .select({
      personId: baselineEstimates.personId,
      id: baselineEstimates.id,
      netWorthCents: baselineEstimates.netWorthCents,
      asOf: baselineEstimates.asOf,
      sourceId: baselineEstimates.sourceId,
    })
    .from(baselineEstimates)
    .innerJoin(
      sql`(SELECT person_id, MAX(as_of) AS max_as_of FROM ${baselineEstimates} GROUP BY person_id) latest`,
      sql`${baselineEstimates.personId} = latest.person_id AND ${baselineEstimates.asOf} = latest.max_as_of`
    )) as Array<{
    personId: string;
    id: string;
    netWorthCents: number;
    asOf: string;
    sourceId: string;
  }>;

  const baselineByPerson = new Map<string, {
    id: string;
    netWorthCents: number;
    asOf: string;
    sourceId: string;
  }>();
  for (const r of latestBaselines) {
    baselineByPerson.set(r.personId, {
      id: r.id,
      netWorthCents: r.netWorthCents,
      asOf: r.asOf,
      sourceId: r.sourceId,
    });
  }

  // securities.id by ticker — recorded in snapshot inputs so each holding is traceable.
  const securityRows = await db
    .select({ id: securities.id, ticker: securities.ticker })
    .from(securities);
  const securityIdsByTicker = new Map<string, string>();
  for (const s of securityRows) securityIdsByTicker.set(s.ticker, s.id);

  // Group holdings by person
  const personHoldings = new Map<string, typeof allHoldings[number][]>();
  for (const h of allHoldings) {
    if (!personHoldings.has(h.personId)) personHoldings.set(h.personId, []);
    personHoldings.get(h.personId)!.push(h);
  }

  // All pledge holdings
  const allPledges = await db
    .select()
    .from(pledgeHoldings)
    .orderBy(asc(pledgeHoldings.id));

  const personPledges = new Map<string, typeof allPledges[number][]>();
  for (const p of allPledges) {
    if (!personPledges.has(p.personId)) personPledges.set(p.personId, []);
    personPledges.get(p.personId)!.push(p);
  }

  const rows: PersonRow[] = [];

  for (const person of allPeople) {
    const holds = personHoldings.get(person.id) ?? [];
    const baseline = baselineByPerson.get(person.id) ?? null;

    // A person without a filing-derived holding has no verified liquid
    // equity. That is an honest result and renders as "no verified
    // holdings" — it is not a zero, and never an estimate.
    if (holds.length === 0) {
      rows.push({
        personId: person.id,
        slug: person.slug,
        name: person.fullName,
        country: person.country ?? "",
        org: person.primaryOrg ?? "",
        liquidCents: 0,
        baselineCents: baseline?.netWorthCents ?? 0,
        liquidPct: null,
        pledgedCents: 0,
        leverageRatio: null,
        fxErrors: [],
        tickers: [],
        pledges: [],
        sparkData: [],
      });
      continue;
    }

    const valuation = computeValuation({
      personId: person.id,
      holdings: holds,
      pledges: personPledges.get(person.id) ?? [],
      latestPrices: latestByTicker,
      securityIds: securityIdsByTicker,
      baseline,
      fx,
    });

    const liquidCents = valuation.liquidCents;
    const pledgedCents = valuation.pledgedCents;
    const baselineCents = valuation.baselineCents;
    const liquidPct = baselineCents > 0 ? (liquidCents / baselineCents) * 100 : null;

    // Leverage is only meaningful when the verified liquid stake is a
    // material share of the baseline. Below that the denominator is noise
    // and the ratio explodes (Bezos previously rendered as 3511.88x).
    const netEquityCents = Math.max(0, liquidCents - pledgedCents);
    const liquidShare = baselineCents > 0 ? liquidCents / baselineCents : 0;
    const leverageRatio =
      netEquityCents > 0 && liquidShare >= 0.05 && pledgedCents > 0
        ? baselineCents / netEquityCents
        : null;

    // 30-day history for sparkline (combine all tickers for this person)
    const tickerList = holds.map((h) => h.ticker);
    // Build parameterized IN clause: chain `eq` predicates with `or`
    const tickerInWhere =
      tickerList.length === 1
        ? eq(stockSnapshots.ticker, tickerList[0])
        : tickerList.slice(1).reduce(
            (acc: ReturnType<typeof or>, t) => or(acc, eq(stockSnapshots.ticker, t)),
            eq(stockSnapshots.ticker, tickerList[0]) as ReturnType<typeof or>
          );
    const historyRows = (await db
      .select({ date: stockSnapshots.asOf, priceCents: stockSnapshots.priceCents })
      .from(stockSnapshots)
      .where(tickerInWhere)
      .orderBy(sql`${stockSnapshots.asOf} DESC`)
      .limit(30)) as Array<{ date: string; priceCents: number }>;

    historyRows.reverse();
    const sparkData: PersonRow["sparkData"] = historyRows.map((s) => ({
      date: s.date,
      price: s.priceCents / 100,
    }));

    rows.push({
      personId: person.id,
      slug: person.slug,
      name: person.fullName,
      country: person.country ?? "",
      org: person.primaryOrg ?? "",
      liquidCents,
      baselineCents,
      liquidPct,
      pledgedCents,
      leverageRatio,
      fxErrors: valuation.fxErrors,
      tickers: valuation.holdings,
      pledges: (personPledges.get(person.id) ?? []).map((p) => ({
        ticker: p.ticker,
        shares: p.sharesPledged,
        source: p.source ?? "",
        sourceType: (p.sourceType as "verified" | "unverified") ?? "unverified",
      })),
      sparkData,
    });
  }

  rows.sort((a, b) => b.liquidCents - a.liquidCents);

  const totalLiquid = rows.reduce((s, r) => s + r.liquidCents, 0);
  const totalBaseline = rows.reduce((s, r) => s + r.baselineCents, 0);
  const totalPledged = rows.reduce((s, r) => s + r.pledgedCents, 0);
  const verifiedCount = rows.filter((r) => r.tickers.length > 0).length;

  return (
    <div className="max-w-5xl mx-auto px-6 py-12">
      <div className="mb-12">
        <p className="text-xs uppercase tracking-widest text-fg-muted mb-2">Slice 2 — Liquid Equity</p>
        <h1 className="font-serif text-4xl font-semibold tracking-tight text-fg mb-4">
          The Honest Number
        </h1>
        <p className="text-lg text-fg-muted leading-relaxed max-w-2xl">
          Public-equity stakes revalued at today&apos;s closing prices. The rest — private companies,
          real estate, art, trusts — is estimated and unverified. For the richest, the liquid portion
          is often under 40% of the headline number.
        </p>
        <p className="text-sm text-fg-faint mt-3 max-w-2xl">
          <span className="text-warning font-medium">Leverage blind spot:</span> Executives pledge shares as
          collateral for personal loans — disclosed in DEF 14A proxy statements, not Form 4 or 13F.
          Headline net-worth figures ignore it entirely. A margin call can force fire-sale
          liquidation, creating a feedback loop that net-worth models ignore.
        </p>
      </div>

      {/* Summary bar */}
      <div className="border border-border rounded-md bg-surface px-6 py-5 mb-8 flex items-center gap-12 flex-wrap">
        <div>
          <p className="text-xs uppercase tracking-widest text-fg-muted mb-1">
            Liquid total ({verifiedCount} of {rows.length} verified)
          </p>
          <p className="font-mono text-2xl font-medium text-fg">{formatB(totalLiquid / 1e11)}</p>
        </div>
        <div>
          <p className="text-xs uppercase tracking-widest text-fg-muted mb-1">Baseline total</p>
          <p className="font-mono text-2xl font-medium text-fg">{formatB(totalBaseline / 1e11)}</p>
        </div>
        <div>
          <p className="text-xs uppercase tracking-widest text-fg-muted mb-1">Liquid fraction</p>
          <p className="font-mono text-2xl font-medium text-fg">
            {totalBaseline > 0 ? `${(totalLiquid / totalBaseline * 100).toFixed(1)}%` : "—"}
          </p>
        </div>
        <div className="pl-8 border-l border-border">
          <p className="text-xs uppercase tracking-widest text-fg-muted mb-1">Pledged (est.)</p>
          <p className="font-mono text-2xl font-medium text-warning">{formatB(totalPledged / 1e11)}</p>
        </div>
      </div>

      {/* Table */}
      <div className="border border-border rounded-md overflow-hidden">
        <table className="w-full text-sm">
          <thead>
            <tr className="bg-surface border-b border-border">
              <th className="text-left px-4 py-3 text-xs uppercase tracking-widest text-fg-muted font-medium w-12">#</th>
              <th className="text-left px-4 py-3 text-xs uppercase tracking-widest text-fg-muted font-medium">Name</th>
              <th className="text-left px-4 py-3 text-xs uppercase tracking-widest text-fg-muted font-medium">Ticker</th>
              <th className="text-right px-4 py-3 text-xs uppercase tracking-widest text-fg-muted font-medium">Holdings</th>
              <th className="text-right px-4 py-3 text-xs uppercase tracking-widest text-fg-muted font-medium">Price</th>
              <th className="text-right px-4 py-3 text-xs uppercase tracking-widest text-fg-muted font-medium">Liquid</th>
              <th className="text-right px-4 py-3 text-xs uppercase tracking-widest text-fg-muted font-medium">of Total</th>
              <th className="text-right px-4 py-3 text-xs uppercase tracking-widest text-fg-muted font-medium">Pledged</th>
              <th className="text-right px-4 py-3 text-xs uppercase tracking-widest text-fg-muted font-medium">Leverage</th>
              <th className="text-right px-4 py-3 text-xs uppercase tracking-widest text-fg-muted font-medium w-32">30-Day</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row, i) => (
              <tr key={row.slug} className={`border-b border-border ${i % 2 === 1 ? "bg-surface" : ""}`}>
                <td className="px-4 py-3 font-mono text-fg-muted">{i + 1}</td>
                <td className="px-4 py-3">
                  <div className="font-medium text-fg">{row.name}</div>
                  <div className="text-xs text-fg-faint">{row.org}</div>
                </td>
                <td className="px-4 py-3">
                  {row.tickers.length === 0 ? (
                    <span className="text-xs text-fg-faint italic">no verified holdings</span>
                  ) : (
                    row.tickers.map((t) => (
                      <span key={t.ticker} className="font-mono text-xs whitespace-nowrap">
                        <a
                          href={t.sourceUrl}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="text-accent hover:underline"
                          title={`Filing stating this share count: ${t.sourceUrl}`}
                        >
                          {t.ticker}
                        </a>
                        {t.estimated === 1 && <span className="text-fg-faint ml-1">~</span>}
                        {row.tickers.indexOf(t) < row.tickers.length - 1 && (
                          <span className="text-fg-muted">,</span>
                        )}
                      </span>
                    ))
                  )}
                </td>
                <td className="px-4 py-3 text-right font-mono text-xs text-fg-muted">
                  {row.tickers.map((t) => (
                    <div key={t.ticker}>
                      {t.shares.toLocaleString()}
                      {row.tickers.indexOf(t) < row.tickers.length - 1 ? <br /> : ""}
                    </div>
                  ))}
                </td>
                <td className="px-4 py-3 text-right font-mono">
                  {row.tickers.map((t) => (
                    <div
                      key={t.ticker}
                      className={
                        t.fxError != null
                          ? "text-danger"
                          : t.priceUsdCents != null && t.priceUsdCents > 0
                          ? "text-fg"
                          : "text-fg-faint"
                      }
                    >
                      {t.fxError != null ? (
                        <span
                          title={`No FX rate for ${t.currency} on the price date: ${t.fxError}`}
                        >
                          &#9888; n/a
                        </span>
                      ) : t.priceUsdCents != null && t.priceUsdCents > 0 ? (
                        formatCents(t.priceUsdCents)
                      ) : (
                        "—"
                      )}
                      {row.tickers.indexOf(t) < row.tickers.length - 1 ? <br /> : ""}
                    </div>
                  ))}
                </td>
                <td className="px-4 py-3 text-right font-mono font-medium text-fg">
                  {row.fxErrors.length > 0 ? (
                    <span
                      className="text-danger"
                      title={`Skipped ${row.fxErrors.length} holding(s): ${row.fxErrors
                        .map((e) => e.ticker)
                        .join(", ")} — no FX rate, value excluded from total.`}
                    >
                      &#9888; partial
                    </span>
                  ) : row.liquidCents > 0 ? (
                    formatB(row.liquidCents / 1e11)
                  ) : (
                    "—"
                  )}
                </td>
                <td className="px-4 py-3 text-right">
                  {row.liquidPct != null ? (
                    <span
                      className={`font-mono text-xs ${
                        row.liquidPct > 100
                          ? "text-danger"
                          : row.liquidPct >= 50
                          ? "text-success"
                          : row.liquidPct >= 25
                          ? "text-fg"
                          : "text-warning"
                      }`}
                    >
                      {row.liquidPct.toFixed(1)}%
                      {row.liquidPct > 100 && (
                        <span
                          className="ml-1"
                          title="Liquid equity exceeds baseline net worth — share count, price or baseline is wrong."
                        >
                          &#9888;
                        </span>
                      )}
                    </span>
                  ) : (
                    <span className="font-mono text-xs text-fg-faint">—</span>
                  )}
                </td>
                <td className="px-4 py-3 text-right">
                  {row.pledgedCents > 0 ? (
                    <div>
                      <span className="font-mono text-xs text-warning">{formatB(row.pledgedCents / 1e11)}</span>
                      <div className="text-xs text-fg-faint mt-1">
                        {row.pledges.map(p => (
                          <div key={p.ticker} className="font-mono flex items-center justify-end gap-1">
                            <span>{p.ticker}: {(p.shares / 1e6).toFixed(1)}M</span>
                            {p.sourceType === "verified"
                              ? <span className="text-success" title="SEC filing source">✓</span>
                              : <span className="text-warning" title="Estimated — no SEC filing found">?</span>
                            }
                          </div>
                        ))}
                      </div>
                    </div>
                  ) : (
                    <span className="font-mono text-xs text-fg-faint">—</span>
                  )}
                </td>
                <td className="px-4 py-3 text-right">
                  {row.leverageRatio != null ? (
                    <span className={`font-mono text-xs ${row.leverageRatio > 2 ? "text-danger" : row.leverageRatio > 1.5 ? "text-warning" : "text-success"}`}>
                      {row.leverageRatio.toFixed(2)}x
                    </span>
                  ) : (
                    <span className="font-mono text-xs text-fg-faint">—</span>
                  )}
                </td>
                <td className="px-4 py-3 text-right">
                  {row.sparkData.length > 0 ? (
                    <div className="flex justify-end">
                      <div
                        className="w-28"
                        dangerouslySetInnerHTML={{ __html: sparklineSVG(row.sparkData) }}
                      />
                    </div>
                  ) : (
                    <span className="text-fg-faint text-xs">no data</span>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="mt-6 text-xs text-fg-faint leading-relaxed">
        <p>
          Holdings come only from SEC Form 3/4/5 ownership filings — each share count appears in
          the filing cited on its row. People whose stakes are held through private entities,
          trusts, or non-US registries have no individual-level filing, and are shown here with
          no verified holdings rather than an estimate. Stock prices from Yahoo Finance (daily
          close). Baseline net worth from Forbes Real-Time Billionaires.
        </p>
        <p className="mt-2">
          The &ldquo;liquid&rdquo; figure is the portion of reported net worth that can be verified
          by multiplying known share counts by public market prices. The remainder — private stakes,
          real estate, art, trusts — is either unverified or moves on different timescales.
        </p>
      </div>
    </div>
  );
}
