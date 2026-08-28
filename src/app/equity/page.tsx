import { db } from "@/lib/db";
import {
  equityHoldings,
  stockSnapshots,
  baselineEstimates,
  people,
  pledgeHoldings,
} from "@/lib/db/schema";
import { sql, asc, eq } from "drizzle-orm";
import Database from "better-sqlite3";
import { join } from "path";

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
  slug: string;
  name: string;
  country: string;
  org: string | null;
  liquidCents: number;
  baselineCents: number;
  liquidPct: number | null;
  pledgedCents: number;
  leverageRatio: number | null; // baseline / (liquid - pledged)
  tickers: Array<{
    ticker: string;
    exchange: string;
    shares: number;
    price: number;
    estimated: number;
  }>;
  pledges: Array<{ ticker: string; shares: number; source: string }>;
  sparkData: Array<{ date: string; price: number }>;
}

export default async function EquityPage() {
  // Latest price per ticker (most recent as_of)
  const latestPriceRows = (await db
    .select({ ticker: stockSnapshots.ticker, priceCents: stockSnapshots.priceCents })
    .from(stockSnapshots)
    .orderBy(asc(stockSnapshots.asOf))) as Array<{ ticker: string; priceCents: number }>;

  const latestByTicker = new Map<string, number>();
  for (const s of latestPriceRows) {
    latestByTicker.set(s.ticker, s.priceCents);
  }

  // All holdings
  const allHoldings = await db
    .select()
    .from(equityHoldings)
    .orderBy(asc(equityHoldings.id));

  // All people
  const allPeople = await db.select().from(people);
  const peopleById = new Map<string, typeof allPeople[number]>();
  for (const p of allPeople) {
    peopleById.set(p.id, p);
  }

  // Latest baseline per person (max as_of) — raw SQL since drizzle's aggregate
  // doesn't cleanly support correlated subqueries in this version
  const sqliteRaw = new Database(join(process.cwd(), "data", "app.db"));
  const latestBaselineRaw = sqliteRaw
    .prepare(
      `SELECT person_id, net_worth_cents
       FROM baseline_estimates
       WHERE as_of = (
         SELECT MAX(as_of) FROM baseline_estimates be2
         WHERE be2.person_id = baseline_estimates.person_id
       )`
    )
    .all() as Array<{ person_id: string; net_worth_cents: number }>;
  sqliteRaw.close();

  const baselineByPerson = new Map<string, number>();
  for (const r of latestBaselineRaw) {
    baselineByPerson.set(r.person_id, r.net_worth_cents);
  }

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

  for (const [personId, holds] of personHoldings) {
    const person = peopleById.get(personId);
    if (!person) continue;

    let liquidCents = 0;
    for (const h of holds) {
      const price = latestByTicker.get(h.ticker) ?? 0;
      liquidCents += price * h.shares;
    }

    const baselineCents = baselineByPerson.get(personId) ?? 0;
    const liquidPct = baselineCents > 0 ? (liquidCents / baselineCents) * 100 : null;

    // 30-day history for sparkline (combine all tickers for this person)
    const tickerList = holds.map((h) => h.ticker);
    const historyRows = (await db
      .select({ date: stockSnapshots.asOf, priceCents: stockSnapshots.priceCents })
      .from(stockSnapshots)
      .where(sql`${stockSnapshots.ticker} IN (${sql.join(tickerList.map((t) => sql`${t}`))})`)
      .orderBy(sql`${stockSnapshots.asOf} DESC`)
      .limit(30)) as Array<{ date: string; priceCents: number }>;

    historyRows.reverse();
    const sparkData: PersonRow["sparkData"] = historyRows.map((s) => ({
      date: s.date,
      price: s.priceCents / 100,
    }));

    rows.push({
      slug: person.slug,
      name: person.fullName,
      country: person.country ?? "",
      org: person.primaryOrg ?? "",
      liquidCents,
      baselineCents,
      liquidPct,
      pledgedCents: 0,
      leverageRatio: null,
      tickers: holds.map((h) => ({
        ticker: h.ticker,
        exchange: h.exchange,
        shares: h.shares,
        price: latestByTicker.get(h.ticker) ?? 0,
        estimated: h.estimated,
      })),
      pledges: [],
      sparkData,
    });
  }

  // Enrich rows with pledge data and compute leverage
  for (const row of rows) {
    // Find personId for this row's slug
    const person = allPeople.find(p => p.slug === row.slug);
    if (!person) continue;
    const personId = person.id;

    const pledges = personPledges.get(personId) ?? [];

    let pledgedCents = 0;
    for (const pledge of pledges) {
      const price = latestByTicker.get(pledge.ticker) ?? 0;
      pledgedCents += price * pledge.sharesPledged;
    }

    const netEquityCents = Math.max(0, row.liquidCents - pledgedCents);
    const leverageRatio = netEquityCents > 0 ? row.baselineCents / netEquityCents : null;

    row.pledgedCents = pledgedCents;
    row.leverageRatio = leverageRatio;
    row.pledges = pledges.map(p => ({
      ticker: p.ticker,
      shares: p.sharesPledged,
      source: p.source ?? "",
    }));
  }

  rows.sort((a, b) => b.liquidCents - a.liquidCents);

  const totalLiquid = rows.reduce((s, r) => s + r.liquidCents, 0);
  const totalBaseline = rows.reduce((s, r) => s + r.baselineCents, 0);
  const totalPledged = rows.reduce((s, r) => s + r.pledgedCents, 0);

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
          <span className="text-warning font-medium">Leverage blind spot:</span> Pledged shares reduce
          reported 13F holdings but economic exposure remains. A margin call can force fire-sale
          liquidation, creating a feedback loop that net-worth models ignore.
        </p>
      </div>

      {/* Summary bar */}
      <div className="border border-border rounded-md bg-surface px-6 py-5 mb-8 flex items-center gap-12 flex-wrap">
        <div>
          <p className="text-xs uppercase tracking-widest text-fg-muted mb-1">Liquid total (top {rows.length})</p>
          <p className="font-mono text-2xl font-medium text-fg">{formatB(totalLiquid / 1e9)}</p>
        </div>
        <div>
          <p className="text-xs uppercase tracking-widest text-fg-muted mb-1">Baseline total</p>
          <p className="font-mono text-2xl font-medium text-fg">{formatB(totalBaseline / 1e9)}</p>
        </div>
        <div>
          <p className="text-xs uppercase tracking-widest text-fg-muted mb-1">Liquid fraction</p>
          <p className="font-mono text-2xl font-medium text-fg">
            {totalBaseline > 0 ? `${(totalLiquid / totalBaseline * 100).toFixed(1)}%` : "—"}
          </p>
        </div>
        <div className="pl-8 border-l border-border">
          <p className="text-xs uppercase tracking-widest text-fg-muted mb-1">Pledged (est.)</p>
          <p className="font-mono text-2xl font-medium text-warning">{formatB(totalPledged / 1e9)}</p>
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
                  {row.tickers.map((t) => (
                    <span key={t.ticker} className="font-mono text-xs">
                      {t.ticker}
                      {t.estimated === 1 && <span className="text-fg-faint ml-1">~</span>}
                      {row.tickers.indexOf(t) < row.tickers.length - 1 && (
                        <span className="text-fg-muted">,</span>
                      )}
                    </span>
                  ))}
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
                    <div key={t.ticker} className={t.price > 0 ? "text-fg" : "text-fg-faint"}>
                      {t.price > 0 ? formatCents(t.price) : "—"}
                      {row.tickers.indexOf(t) < row.tickers.length - 1 ? <br /> : ""}
                    </div>
                  ))}
                </td>
                <td className="px-4 py-3 text-right font-mono font-medium text-fg">
                  {row.liquidCents > 0 ? formatB(row.liquidCents / 1e9) : "—"}
                </td>
                <td className="px-4 py-3 text-right">
                  {row.liquidPct != null ? (
                    <span
                      className={`font-mono text-xs ${
                        row.liquidPct >= 50
                          ? "text-success"
                          : row.liquidPct >= 25
                          ? "text-fg"
                          : "text-warning"
                      }`}
                    >
                      {row.liquidPct.toFixed(1)}%
                    </span>
                  ) : (
                    <span className="font-mono text-xs text-fg-faint">—</span>
                  )}
                </td>
                <td className="px-4 py-3 text-right">
                  {row.pledgedCents > 0 ? (
                    <div>
                      <span className="font-mono text-xs text-warning">{formatB(row.pledgedCents / 1e9)}</span>
                      <div className="text-xs text-fg-faint mt-1">
                        {row.pledges.map(p => (
                          <div key={p.ticker} className="font-mono">{p.ticker}: {(p.shares / 1e6).toFixed(1)}M</div>
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
          Source: SEC 13F filings, AMF disclosures, CNMV filings, and Bloomberg/Forbes estimates for
          approximated holdings. Stock prices from Yahoo Finance (daily close). Baseline net worth
          from Forbes Real-Time Billionaires.
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
