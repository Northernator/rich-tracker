/**
 * Chunk 8 acceptance gate — pledged shares from DEF 14A.
 *
 * Verifies, against the database and the on-disk raw filings:
 *   1. every evidence_text contains pledge language
 *   2. no source_url points at a 13F or a Form 4
 *   3. every evidence_text is a FULL SENTENCE present byte-for-byte in the
 *      linked document (checked against data/raw/sec/<cik>/<accession>.htm,
 *      parsed with the same stripHtml()/splitSentences() the loader uses)
 *   4. pledged shares do not alter any net-worth total
 *
 * Run: npx tsx scripts/verify_pledges.ts
 * Exit code 1 on any failure.
 */

import Database from "better-sqlite3";
import { existsSync, readFileSync } from "fs";
import { join } from "path";
import { stripHtml, splitSentences } from "../src/lib/providers/sec/def14a";

const db = new Database("data/app.db");
const RAW = join(process.cwd(), "data", "raw", "sec");

let failures = 0;
const ok = (cond: boolean, label: string, detail = "") => {
  if (!cond) failures++;
  console.log(`${cond ? "PASS" : "FAIL"}  ${label}${detail ? " — " + detail : ""}`);
};

// ---------------------------------------------------------------------------
// 1 & 2 — SQL gates
// ---------------------------------------------------------------------------
const notPledg = db
  .prepare("SELECT COUNT(*) c FROM pledge_holdings WHERE evidence_text NOT LIKE '%pledg%'")
  .get().c;
ok(notPledg === 0, "evidence_text NOT LIKE '%pledg%' returns 0", `got ${notPledg}`);

const badForms = db
  .prepare(
    "SELECT COUNT(*) c FROM pledge_holdings WHERE LOWER(source_url) LIKE '%13f%' OR LOWER(source_url) LIKE '%form4%'"
  )
  .get().c;
ok(badForms === 0, "no source_url contains '13F' or 'form4'", `got ${badForms}`);

const rows = db
  .prepare(
    `SELECT ph.ticker, ph.shares_pledged, ph.source_url, ph.evidence_text, ph.filing_id, s.cik
       FROM pledge_holdings ph
       LEFT JOIN securities s ON s.ticker = ph.ticker`
  )
  .all() as Array<{
  ticker: string;
  shares_pledged: number;
  source_url: string;
  evidence_text: string;
  filing_id: string;
  cik: string | null;
}>;

const total = db.prepare("SELECT COUNT(*) c FROM pledge_holdings").get().c;
console.log(`\nVerifying ${total} pledge row(s) byte-for-byte against cached filings…\n`);

// ---------------------------------------------------------------------------
// 3 — verbatim sentence, byte-for-byte, from the document on disk
// ---------------------------------------------------------------------------
for (const r of rows) {
  const label = `${r.ticker} (${r.shares_pledged.toLocaleString()} shares)`;

  const cik = (r.cik ?? "").replace(/\D/g, "").padStart(10, "0");
  const docPath = join(RAW, cik, `${r.filing_id}.htm`);

  if (!existsSync(docPath)) {
    ok(false, `${label}: raw filing present on disk`, `missing ${docPath}`);
    continue;
  }
  ok(true, `${label}: raw filing present on disk`, docPath.replace(process.cwd(), "."));

  const text = stripHtml(readFileSync(docPath, "utf8"));

  // Byte-for-byte: no normalisation, no trimming, no case folding.
  const verbatim = text.includes(r.evidence_text);
  ok(verbatim, `${label}: evidence_text found byte-for-byte in document`);

  // Full sentence: it must be one of the sentences the splitter produces.
  const isFullSentence = splitSentences(text).includes(r.evidence_text);
  ok(isFullSentence, `${label}: evidence_text is a complete sentence`);

  // Sanity on shape: capital start, terminal punctuation, pledge language.
  ok(/^["“]?[A-Z]/.test(r.evidence_text), `${label}: starts like a sentence`);
  ok(/[.!?]$/.test(r.evidence_text), `${label}: ends with terminal punctuation`);
  ok(/pledg/i.test(r.evidence_text), `${label}: contains pledge language`);

  // The URL must be the human-openable document that carries the quote.
  ok(
    r.source_url.includes(r.filing_id.replace(/-/g, "")),
    `${label}: source_url points at the filing containing the quote`
  );

  console.log(`      quoted: "${r.evidence_text.slice(0, 120)}${r.evidence_text.length > 120 ? "…" : ""}"`);
  console.log(`      source: ${r.source_url}\n`);
}

// ---------------------------------------------------------------------------
// 4 — net worth is unchanged by pledges, proved arithmetically
//
// Runs the real computeValuation() (the same function behind /equity and
// `npm run snapshot`) twice per person: once with their pledge rows and once
// with the pledge list emptied. If liquidCents is identical in both runs, the
// pledge cannot have reduced net worth. pledgedCents is reported alongside as
// a separate, non-deducting figure.
// ---------------------------------------------------------------------------
async function netWorthChecks() {
  console.log("Net-worth independence (arithmetic proof):");

  const { computeValuation } = await import("../src/lib/valuation");
  const { loadFxLookup } = await import("../src/lib/db/fx");
  const { db: drizzle } = await import("../src/lib/db");
  const schema = await import("../src/lib/db/schema");

  const fx = await loadFxLookup();

  // Latest price per ticker (max as_of), mirroring snapshot.ts.
  const snapshots = await drizzle.select().from(schema.stockSnapshots);
  const latestByTicker = new Map<string, { priceCents: number; currency: string; asOf: string }>();
  for (const s of snapshots) {
    const prev = latestByTicker.get(s.ticker);
    if (!prev || s.asOf >= prev.asOf) {
      latestByTicker.set(s.ticker, {
        priceCents: s.priceCents,
        currency: s.currency ?? "USD",
        asOf: s.asOf,
      });
    }
  }

  const securityIds = new Map<string, string>();
  for (const sec of await drizzle.select().from(schema.securities)) securityIds.set(sec.ticker, sec.id);

  const allHoldings = await drizzle.select().from(schema.equityHoldings);
  const allPledges = await drizzle.select().from(schema.pledgeHoldings);

  const pledgesByPerson = new Map<string, typeof allPledges>();
  for (const p of allPledges) {
    const arr = pledgesByPerson.get(p.personId) ?? [];
    arr.push(p);
    pledgesByPerson.set(p.personId, arr);
  }

  const affected = [...pledgesByPerson.keys()];

  for (const personId of affected) {
    const holdings = allHoldings.filter((h) => h.personId === personId);
    const pledges = pledgesByPerson.get(personId) ?? [];

    const base = { latestPrices: latestByTicker, securityIds, baseline: null, fx };

    const withPledges = computeValuation({ personId, holdings, pledges, ...base });
    const without = computeValuation({ personId, holdings, pledges: [], ...base });

    const slug = db.prepare("SELECT slug FROM people WHERE id = ?").get(personId)?.slug ?? personId;

    ok(
      withPledges.liquidCents === without.liquidCents,
      `${slug}: net worth identical with and without pledge rows`,
      `${withPledges.liquidCents.toLocaleString()} vs ${without.liquidCents.toLocaleString()} cents`
    );
    ok(
      withPledges.pledgedCents > 0 && without.pledgedCents === 0,
      `${slug}: pledged value reported separately, never subtracted`,
      `${withPledges.pledgedCents.toLocaleString()} cents pledged (collateral)`
    );
  }

  console.log(`  people carrying a verified pledge  : ${affected.length}`);
  console.log(`  total verified pledge rows         : ${allPledges.length}`);
}

netWorthChecks()
  .catch((err) => {
    failures++;
    console.error("net-worth check threw:", err);
  })
  .then(() => {
    console.log(`\n${failures === 0 ? "ALL CHECKS PASSED" : `${failures} CHECK(S) FAILED`}`);
    process.exit(failures === 0 ? 0 : 1);
  });
