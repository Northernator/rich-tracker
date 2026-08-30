/**
 * Snapshot writer — persists "the honest number" to valuation_snapshots.
 *
 * `npm run snapshot` writes one row per tracked person per run. Each row
 * freezes liquid_cents, baseline_cents, pledged_cents and verifiability, plus
 * an `inputs` JSON that records EVERY number that produced liquid_cents (per
 * holding: security_id, share count, price_cents, as_of, FX rate; plus the
 * baseline row id). A person with the stored inputs and a calculator can
 * reproduce liquid_cents exactly.
 *
 * Anti-duplicate: ts is truncated to the minute and (person_id, ts,
 * method_version) is unique, so running twice within the same minute inserts
 * nothing. Rows are never deleted or recomputed — method_version only ever
 * moves forward and new runs insert new rows alongside old ones.
 *
 * Run: npm run snapshot
 */

import { createId } from "@paralleldrive/cuid2";
import { db } from "@/lib/db";
import { sql, asc } from "drizzle-orm";
import {
  baselineEstimates,
  equityHoldings,
  people,
  pledgeHoldings,
  securities,
  stockSnapshots,
  valuationSnapshots,
} from "@/lib/db/schema";
import { loadFxLookup } from "@/lib/db/fx";
import { computeValuation, METHOD_VERSION } from "@/lib/valuation";

/** ISO timestamp truncated to the minute: two runs in the same minute collide on the unique index. */
function minuteTruncatedNow(): string {
  const iso = new Date().toISOString();
  return `${iso.slice(0, 16)}:00.000Z`;
}

async function main() {
  console.log(`Snapshot writer starting (method_version=${METHOD_VERSION})`);
  const fx = await loadFxLookup();

  // Latest price per ticker (most recent as_of) — same feed /equity uses, so
  // the frozen row can never disagree with the page that day.
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

  const allHoldings = await db.select().from(equityHoldings).orderBy(asc(equityHoldings.id));
  const allPledges = await db.select().from(pledgeHoldings).orderBy(asc(pledgeHoldings.id));

  const securityRows = await db.select({ id: securities.id, ticker: securities.ticker }).from(securities);
  const securityIdsByTicker = new Map<string, string>();
  for (const s of securityRows) securityIdsByTicker.set(s.ticker, s.id);

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

  const holdingsByPerson = new Map<string, (typeof allHoldings)[number][]>();
  for (const h of allHoldings) {
    if (!holdingsByPerson.has(h.personId)) holdingsByPerson.set(h.personId, []);
    holdingsByPerson.get(h.personId)!.push(h);
  }
  const pledgesByPerson = new Map<string, (typeof allPledges)[number][]>();
  for (const p of allPledges) {
    if (!pledgesByPerson.has(p.personId)) pledgesByPerson.set(p.personId, []);
    pledgesByPerson.get(p.personId)!.push(p);
  }

  // One row per tracked person: everyone with a baseline estimate (the
  // leaderboard universe). A person with no holdings still gets a row — their
  // liquid is zero, which is itself the honest number.
  const tracked = await db
    .select({ id: people.id, fullName: people.fullName })
    .from(people)
    .innerJoin(
      sql`(SELECT DISTINCT person_id FROM ${baselineEstimates}) b`,
      sql`b.person_id = ${people.id}`
    )
    .orderBy(asc(people.fullName));

  const ts = minuteTruncatedNow();
  console.log(`  Writing ${tracked.length} rows at ts=${ts}`);

  let inserted = 0;
  let alreadyPresent = 0;
  let failed = 0;

  for (const person of tracked) {
    const holdings = holdingsByPerson.get(person.id) ?? [];
    const pledges = pledgesByPerson.get(person.id) ?? [];
    const baseline = baselineByPerson.get(person.id) ?? null;

    const valuation = computeValuation({
      personId: person.id,
      holdings,
      pledges,
      latestPrices: latestByTicker,
      securityIds: securityIdsByTicker,
      baseline,
      fx,
    });

    try {
      const result = await db
        .insert(valuationSnapshots)
        .values({
          id: createId(),
          personId: person.id,
          ts,
          liquidCents: valuation.liquidCents,
          baselineCents: valuation.baselineCents,
          pledgedCents: valuation.pledgedCents,
          verifiability: valuation.verifiability,
          methodVersion: METHOD_VERSION,
          inputs: JSON.stringify(valuation.inputs),
          createdAt: new Date().toISOString(),
        })
        .onConflictDoNothing() // (person_id, ts, method_version) — same-minute re-run inserts 0 rows
        .run();
      if (result.changes > 0) inserted++;
      else alreadyPresent++;
    } catch (err) {
      failed++;
      console.warn(`    Insert failed for ${person.fullName}: ${String(err)}`);
    }
  }

  console.log(`\nDone. ${inserted} rows inserted, ${alreadyPresent} already present` + (failed ? `, ${failed} failed` : "") + ".");
  console.log(`  method_version=${METHOD_VERSION} — old rows are never recomputed or deleted.`);
  console.log(`  Running again in the same minute changes nothing (unique person_id+ts+method).`);
}

main().catch((err) => {
  console.error("Snapshot writer failed:", err);
  process.exit(1);
});
