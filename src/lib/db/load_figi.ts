/**
 * Symbology loader — fill NULL FIGI columns in `securities` via OpenFIGI.
 *
 * A FIGI is evidence that a ticker+exchange pair names the instrument we
 * think it does. The loader maps each unmapped security once and stores the
 * FIGI, share-class FIGI and the mapping endpoint as the citation, plus a
 * raw capture under data/raw/openfigi/ (the audit trail).
 *
 * What this loader will NOT do
 *   - Never invent a security. Only rows already in `securities` are mapped;
 *     an unknown ticker yields a warning and a NULL, not a row.
 *   - Never overwrite a FIGI. The UPDATE is guarded by `figi IS NULL`.
 *   - Never guess an exchange. Exchanges outside EXCHANGE_TO_EXCHCODE are
 *     skipped and counted, not mapped to a "closest" venue.
 *   - Never pick between lookalikes. The provider returns null on ambiguity;
 *     the loader stores nothing for those rows.
 *
 * Cost: one batched request per 100 securities with a key (5 without),
 * inside the key-aware politeFetch bucket (25/min keyless, 25/6s with key).
 *
 * Run: pnpm exec tsx src/lib/db/load_figi.ts [-- --dry-run]
 */

import { mkdirSync, writeFileSync } from "fs";
import { join } from "path";
import { db } from "@/lib/db";
import { securities } from "./schema";
import { and, eq, isNull } from "drizzle-orm";
import {
  EXCHANGE_TO_EXCHCODE,
  EXCHANGE_YAHOO_SUFFIX,
  OPENFIGI_DOC_URL,
  mapTickers,
  type FigiJob,
} from "@/lib/providers/symbology/openfigi";
import { loadLocalEnv } from "@/lib/providers/uk/env";
import { formatRateLimitReport, rateLimitStats } from "@/lib/providers/http";

const MAPPING_URL = "https://api.openfigi.com/v3/mapping";

async function main() {
  const dryRun = process.argv.includes("--dry-run");
  loadLocalEnv();

  console.log("=== Symbology: tickers → FIGI (OpenFIGI) ===");
  console.log(`docs: ${OPENFIGI_DOC_URL}\n`);

  const rows = await db
    .select({
      id: securities.id,
      ticker: securities.ticker,
      exchange: securities.exchange,
    })
    .from(securities)
    .where(isNull(securities.figi))
    .execute();

  const jobs: FigiJob[] = [];
  const jobRowId: string[] = [];
  let skippedExchange = 0;
  for (const r of rows) {
    const exchCode = EXCHANGE_TO_EXCHCODE[r.exchange];
    if (!exchCode) {
      skippedExchange++;
      console.warn(`  ! ${r.ticker}: exchange "${r.exchange}" has no exchCode mapping — skipping`);
      continue;
    }
    // The registry stores Yahoo composites ("MC.PA"); OpenFIGI wants the
    // bare venue ticker ("MC"). Only the exchange's own documented suffix is
    // stripped — anything else (e.g. BRK-B) goes verbatim and warns/skips.
    let ticker = r.ticker;
    const suffix = EXCHANGE_YAHOO_SUFFIX[r.exchange];
    if (suffix && ticker.toUpperCase().endsWith(suffix)) {
      ticker = ticker.slice(0, -suffix.length);
      console.log(`  ~ ${r.ticker} → venue ticker "${ticker}" for ${exchCode}`);
    }
    jobs.push({ ticker, exchCode });
    jobRowId.push(r.id);
  }
  console.log(
    `securities without FIGI: ${rows.length} · mappable: ${jobs.length} · ` +
      `skipped (unknown exchange): ${skippedExchange}`
  );

  if (dryRun) {
    for (const j of jobs) console.log(`  would map ${j.ticker}/${j.exchCode}`);
    return;
  }
  if (jobs.length === 0) {
    console.log("Nothing to map.");
    return;
  }

  const matches = await mapTickers(jobs);

  // Raw capture first — the evidence the FIGIs below came from. Timestamped
  // to the second so each run keeps its own capture instead of overwriting
  // the previous one.
  const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  const rawDir = join(process.cwd(), "data", "raw", "openfigi");
  mkdirSync(rawDir, { recursive: true });
  const rawPath = join(rawDir, `figi-${stamp}.json`);
  writeFileSync(
    rawPath,
    JSON.stringify(
      { capturedAt: new Date().toISOString(), jobs, matches },
      null,
      2
    )
  );
  console.log(`raw capture: ${rawPath}`);

  let filled = 0;
  let unmatched = 0;
  for (let i = 0; i < jobs.length; i++) {
    const m = matches[i];
    if (!m) {
      unmatched++;
      continue;
    }
    if (m.ticker.toUpperCase() !== jobs[i].ticker.toUpperCase() || m.exchCode !== jobs[i].exchCode) {
      throw new Error(
        `OpenFIGI result misaligned for ${jobs[i].ticker} — refusing to store it`
      );
    }
    const res = await db
      .update(securities)
      .set({
        figi: m.figi,
        shareClassFigi: m.shareClassFigi ?? undefined,
        figiSourceUrl: MAPPING_URL,
      })
      .where(and(eq(securities.id, jobRowId[i]), isNull(securities.figi)))
      .run();
    filled += Number(res.changes ?? 0);
    console.log(`  + ${m.ticker}/${m.exchCode} → FIGI ${m.figi}${m.name ? ` (${m.name})` : ""}`);
  }

  const breached = rateLimitStats().filter((s) => s.breached);
  console.log("\n" + formatRateLimitReport());
  console.log(
    `\n=== Symbology summary ===\n` +
      `  FIGIs stored: ${filled}\n` +
      `  unmatched/ambiguous (left NULL): ${unmatched}\n` +
      `  skipped (unknown exchange): ${skippedExchange}`
  );
  if (breached.length > 0) {
    throw new Error(
      `Rate limit breached for: ${breached.map((b) => `${b.host} (${b.maxObservedInWindow}/${b.limit})`).join(", ")}`
    );
  }
}

main().catch((err) => {
  console.error("\nSymbology loader failed:", err);
  process.exit(1);
});
