/**
 * Macro loader — FRED benchmark series → `macro_observations`.
 *
 * Three series, capped history, one call each per run:
 *   CPIAUCSL  — Consumer Price Index for All Urban Consumers
 *   FEDFUNDS  — Effective Federal Funds Rate
 *   DGS10     — 10-Year Treasury Constant Maturity Rate
 *
 * Context, not a warehouse: event impacts and methodology can cite the actual
 * CPI / policy-rate / long-rate values instead of prose. History is capped at
 * FRED_SINCE (default: 5 years ago) via `observation_start`.
 *
 * What this loader will NOT do
 *   - Never store a missing reading. FRED marks gaps as "."; those are
 *     skipped (and counted), never stored as zero.
 *   - Never store an undated or non-numeric observation — the provider
 *     throws on those instead.
 *   - Never double-insert: (series_id, as_of) is unique, re-runs insert
 *     nothing.
 *
 * Cost: 1 request per series per run (3 by default), keyless-impossible —
 * FRED_API_KEY is required and the loader fails loudly without it. The
 * politeFetch bucket stays at half the published 120 req/min ceiling.
 *
 * Run: pnpm exec tsx src/lib/db/load_fred.ts [-- --dry-run]
 *   FRED_SINCE=2020-01-01 pnpm exec tsx src/lib/db/load_fred.ts
 */

import { db } from "@/lib/db";
import { macroObservations } from "./schema";
import { fredSeriesUrl, seriesObservations } from "@/lib/providers/macro/fred";
import { loadLocalEnv } from "@/lib/providers/uk/env";
import { formatRateLimitReport, rateLimitStats } from "@/lib/providers/http";

const SERIES = ["CPIAUCSL", "FEDFUNDS", "DGS10"] as const;

function defaultSince(): string {
  const d = new Date();
  d.setUTCFullYear(d.getUTCFullYear() - 5);
  return d.toISOString().slice(0, 10);
}

async function main() {
  const dryRun = process.argv.includes("--dry-run");
  loadLocalEnv();

  const since = process.env.FRED_SINCE ?? defaultSince();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(since)) {
    throw new Error(`FRED_SINCE must be YYYY-MM-DD, got "${since}"`);
  }

  console.log("=== Macro: FRED → macro_observations ===");
  console.log(`series: ${SERIES.join(", ")} · since: ${since}${dryRun ? " (dry run)" : ""}\n`);

  let inserted = 0;
  for (const seriesId of SERIES) {
    const series = await seriesObservations(seriesId, { observationStart: since });
    console.log(`  ${seriesId}: ${series.observations.length} observations (units: ${series.units || "?"})`);
    if (dryRun) continue;
    const sourceUrl = fredSeriesUrl(seriesId);
    for (const o of series.observations) {
      const res = await db
        .insert(macroObservations)
        .values({
          seriesId,
          asOf: o.date,
          value: o.value,
          unit: series.units || null,
          sourceUrl,
          createdAt: new Date().toISOString(),
        })
        .onConflictDoNothing()
        .run();
      inserted += Number(res.changes ?? 0);
    }
  }

  const breached = rateLimitStats().filter((s) => s.breached);
  console.log("\n" + formatRateLimitReport());
  console.log(`\n=== Macro summary ===\n  observations inserted: ${inserted}`);
  if (breached.length > 0) {
    throw new Error(
      `Rate limit breached for: ${breached.map((b) => `${b.host} (${b.maxObservedInWindow}/${b.limit})`).join(", ")}`
    );
  }
}

main().catch((err) => {
  console.error("\nMacro loader failed:", err);
  process.exit(1);
});
