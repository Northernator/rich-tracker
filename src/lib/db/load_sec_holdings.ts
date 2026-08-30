/**
 * Holdings from the filings that actually state them — SEC Form 3/4/5.
 *
 * Replaces the invented share counts whose source_url values pointed at 10-K
 * annual reports. A 10-K does not state any individual's shareholding; those
 * rows were fabrications wearing citations, and this loader removes them by
 * exact (person, ticker) identity with a logged reason for every row.
 *
 * What it does per person with a resolved filing_cik:
 *   1. Reads the submissions JSON (cached raw under data/raw/sec/).
 *   2. Walks ownership filings (Form 4 primary, then 3, then 5) newest-first,
 *      fetching each XML, saving it verbatim, and parsing FROM DISK.
 *   3. Keeps the most recent filing per (person, issuer symbol), preferring
 *      Form 4 over Form 3/5 — per the citation table, a Form 4's
 *      sharesOwnedFollowingTransaction is the exact post-transaction holding.
 *   4. Maps the filing's symbol to a tracked listed security and selects the
 *      security CLASS the filing line actually covers (META insiders hold
 *      huge unlisted Class B; crediting it as META would fabricate value).
 *   5. Runs checkHolding() before every insert. Rejections are skipped and
 *      logged — never clamped.
 *   6. INSERT OR IGNORE on (person_id, ticker, as_of) — re-runs add nothing.
 *
 * 13F-HR is deliberately not used here: it states a fund's portfolio, not an
 * individual's stake. Non-US billionaires have no SEC presence — they get no
 * row, and the UI renders "no verified holdings". A missing holding is
 * correct. An invented one is not.
 *
 * Run: npm run holdings:sec
 */

import { db, sqlite } from "@/lib/db";
import { checkHolding } from "./sanity";
import { eq } from "drizzle-orm";
import * as schema from "./schema";
import { createId } from "@paralleldrive/cuid2";
import { existsSync, readFileSync } from "fs";
import { join } from "path";
import {
  fetchSubmissions,
  fetchFilingXml,
  filingUrl,
  parseOwnershipXml,
  selectEntryForTicker,
  symbolToTrackedTicker,
  type OwnerFiling,
} from "@/lib/providers/sec/edgar";

const OWNERSHIP_FORMS = new Set(["4", "3", "5"]);
const MAX_FILINGS_WALKED = 40;
const MAX_XML_FETCHED = 25;

interface Resolved {
  ticker: string;
  shares: number;
  asOf: string;
  form: string;
  filing: OwnerFiling;
  issuerName: string;
  symbol: string;
  /** Every class the filing reported, for the run log. */
  allTitles: Array<{ title: string; shares: number }>;
}

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

// ---------------------------------------------------------------------------
// Step 0: purge the invented rows, by exact identity, with logged reasons.
// ---------------------------------------------------------------------------

interface CuratedRow {
  slug: string;
  ticker: string;
}

function readCuratedHoldings(): CuratedRow[] {
  const path = join(process.cwd(), "data", "curated", "holdings.csv");
  if (!existsSync(path)) return [];
  const lines = readFileSync(path, "utf8").trim().split("\n");
  const headers = lines[0].split(",").map((h) => h.trim());
  const slugIdx = headers.indexOf("slug");
  const tickerIdx = headers.indexOf("ticker");
  return lines.slice(1).map((line) => {
    const vals = line.split(",").map((v) => v.trim());
    return { slug: vals[slugIdx], ticker: vals[tickerIdx] };
  });
}

async function purgeFabricatedRows(): Promise<number> {
  const curated = readCuratedHoldings();
  if (curated.length === 0) return 0;

  const slugToId = new Map<string, string>();
  for (const p of await db.select({ id: schema.people.id, slug: schema.people.slug }).from(schema.people)) {
    slugToId.set(p.slug, p.id);
  }

  console.log(
    "— Purging invented holdings —\n" +
    "  The rows loaded from data/curated/holdings.csv cite 10-Ks, AMF pages and\n" +
    "  SEBI portals that do not state any individual's share count. They are\n" +
    "  fabricated claims wearing citations and are removed here by identity.\n"
  );

  let purged = 0;
  for (const row of curated) {
    const personId = slugToId.get(row.slug);
    if (!personId) continue;

    const existing = (await db
      .select()
      .from(schema.equityHoldings)
      .where(eq(schema.equityHoldings.personId, personId)))
      .filter((h) => h.ticker === row.ticker);

    for (const h of existing) {
      // Defensive: never purge a row whose citation is an ownership-form XML —
      // that would be real filing-derived data from a previous run.
      if (/\.xml($|\?)/i.test(h.sourceUrl ?? "")) {
        console.log(`  keep ${row.slug}/${row.ticker}: source is an ownership XML (${h.sourceUrl})`);
        continue;
      }
      await db.delete(schema.equityHoldings).where(eq(schema.equityHoldings.id, h.id));
      purged++;
      console.log(`  PURGED ${row.slug}/${row.ticker} (${h.shares.toLocaleString()} shares, invented, cited "${h.sourceUrl}")`);
    }
  }
  if (purged === 0) console.log("  nothing to purge — already replaced by filing-derived rows.");
  return purged;
}

// ---------------------------------------------------------------------------
// Steps 1-3: submissions → newest Form 4 (fallback 3/5) per (person, issuer)
// ---------------------------------------------------------------------------

async function resolvePersonHoldings(
  slug: string,
  cik: string,
  trackedTickers: Set<string>
): Promise<{ resolved: Map<string, Resolved>; untrackedSymbols: Set<string>; fetched: number }> {
  const resolved = new Map<string, Resolved>();
  const untrackedSymbols = new Set<string>();
  const fallbacks = new Map<string, Resolved>(); // form 3/5, used only if no Form 4
  let fetched = 0;

  const sub = await fetchSubmissions(cik);
  const ownershipFilings = sub.recent.filter((f) => OWNERSHIP_FORMS.has(f.form)).slice(0, MAX_FILINGS_WALKED);

  for (const filing of ownershipFilings) {
    if (fetched >= MAX_XML_FETCHED) break;
    let parsed = null as ReturnType<typeof parseOwnershipXml>;
    try {
      const xml = await fetchFilingXml(cik, filing.accession, filing.primaryDocument);
      fetched++;
      parsed = parseOwnershipXml(xml, filing.form, filing.reportDate || filing.filingDate);
    } catch (err) {
      console.warn(`    ! ${slug} ${filing.form} ${filing.accession}: fetch/parse failed: ${(err as Error).message.slice(0, 90)}`);
      continue;
    }
    if (!parsed) continue;

    const ticker = symbolToTrackedTicker(parsed.symbol);
    if (!ticker || !trackedTickers.has(ticker)) {
      untrackedSymbols.add(parsed.symbol);
      continue;
    }

    const entry = selectEntryForTicker(parsed, ticker);
    if (!entry) {
      if (parsed.entries.length === 0 && parsed.disclaimedTitles.length > 0) {
        console.log(
          `    = ${slug} ${filing.form} ${parsed.symbol}: reports only entity-held shares (beneficial ownership disclaimed) — ` +
            `${parsed.disclaimedTitles.map((t) => `${t.title}=${t.shares.toLocaleString()}`).join("; ")}. ` +
            `Not a personal stake; skipped.`
        );
      }
      continue; // filing covers other classes only, or disclaimed entity lines — nothing usable
    }

    const candidate: Resolved = {
      ticker,
      shares: entry.shares,
      asOf: entry.asOf ?? parsed.periodOfReport,
      form: parsed.form,
      filing,
      issuerName: parsed.issuerName,
      symbol: parsed.symbol,
      allTitles: parsed.entries.map((e) => ({ title: e.title, shares: e.shares })),
    };

    if (parsed.form === "4") {
      // Newest-first walk: the first Form 4 seen per ticker is the most recent.
      if (!resolved.has(ticker)) resolved.set(ticker, candidate);
    } else if (!fallbacks.has(ticker)) {
      fallbacks.set(ticker, candidate);
    }

    // Early stop: we hold a primary (Form 4) record for this person and the
    // remaining filings are all older — every later XML would be redundant.
    if (resolved.size > 0) {
      const newestForm4Date = [...resolved.values()][0].filing.filingDate;
      if (filing.filingDate < newestForm4Date && fallbacks.size === 0) break;
    }
  }

  for (const [ticker, fb] of fallbacks) {
    if (!resolved.has(ticker)) resolved.set(ticker, fb);
  }

  return { resolved, untrackedSymbols, fetched };
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  console.log("=== Holdings from SEC ownership filings (Form 4 primary, 3/5 fallback) ===\n");

  const purged = await purgeFabricatedRows();
  console.log("");

  const trackedTickers = new Set(
    (await db.select({ ticker: schema.securities.ticker }).from(schema.securities)).map((s) => s.ticker)
  );

  const peopleWithCik = (await db.select().from(schema.people))
    .filter((p) => p.filingCik != null && p.filingCik !== "");

  if (peopleWithCik.length === 0) {
    console.log("No people with a resolved filing_cik. Run `npm run ciks:resolve` first.");
    return;
  }

  const slugToId = new Map<string, string>();
  for (const p of await db.select({ id: schema.people.id, slug: schema.people.slug }).from(schema.people)) {
    slugToId.set(p.slug, p.id);
  }

  let inserted = 0;
  let rejected = 0;
  let noFiling = 0;
  const runLog: string[] = [];

  for (const person of peopleWithCik) {
    const slug = person.slug;
    const personId = slugToId.get(slug);
    if (!personId) continue;

    const { resolved, untrackedSymbols } = await resolvePersonHoldings(slug, person.filingCik!, trackedTickers);

    if (resolved.size === 0) {
      noFiling++;
      console.log(
        `${slug} (CIK ${person.filingCik}): no ownership filing for a tracked security` +
          (untrackedSymbols.size ? ` — non-tracked symbols seen: ${[...untrackedSymbols].join(", ")}` : "")
      );
      continue;
    }

    for (const r of resolved.values()) {
      console.log(
        `${slug} ${r.ticker}: ${r.shares.toLocaleString()} shares — Form ${r.form} filed ${r.filing.filingDate}, period ${r.asOf} (${r.issuerName}, symbol ${r.symbol})` +
          ` — classes in filing: ${r.allTitles.map((t) => `${t.title}=${t.shares.toLocaleString()}`).join("; ")}`
      );
      runLog.push(
        `${slug} ${r.ticker} ${r.shares} shares (Form ${r.form}, ${r.asOf}) from ${filingUrl(person.filingCik!, r.filing.accession, r.filing.primaryDocument)}`
      );

      const verdict = checkHolding(sqlite, {
        personSlug: slug,
        ticker: r.ticker,
        shares: r.shares,
        sourceUrl: filingUrl(person.filingCik!, r.filing.accession, r.filing.primaryDocument),
      });
      if (!verdict.ok) {
        rejected++;
        console.warn(`    REJECTED (sanity): ${verdict.reason}`);
        runLog.push(`  REJECTED: ${verdict.reason}`);
        continue;
      }

      try {
        const result = await db
          .insert(schema.equityHoldings)
          .values({
            id: createId(),
            personId,
            ticker: r.ticker,
            exchange: (await db.select({ e: schema.securities.exchange }).from(schema.securities).where(eq(schema.securities.ticker, r.ticker)).limit(1))[0]?.e ?? "",
            shares: r.shares,
            asOf: r.asOf,
            estimated: 0,
            source: `SEC Form ${r.form} (period ${r.asOf}, filed ${r.filing.filingDate})`,
            sourceUrl: filingUrl(person.filingCik!, r.filing.accession, r.filing.primaryDocument),
            createdAt: new Date().toISOString(),
          })
          .onConflictDoNothing() // (person_id, ticker, as_of) — additive, idempotent
          .run();
        if (result.changes > 0) {
          inserted++;
          console.log(`    INSERTED (source_url opens the Form ${r.form} that states this count)`);
        } else {
          console.log(`    already present (person, ticker, as_of) — additive no-op`);
        }
      } catch (err) {
        rejected++;
        console.warn(`    insert failed: ${String(err).slice(0, 120)}`);
      }
      await sleep(150);
    }
    await sleep(300);
  }

  console.log(
    `\n=== Run summary ===\n` +
    `  fabricated rows purged: ${purged}\n` +
    `  filing-derived rows inserted: ${inserted}\n` +
    `  rejections (skipped, logged): ${rejected}\n` +
    `  people with no filing for a tracked security: ${noFiling}\n` +
    `\nRun log:\n${runLog.map((l) => "  " + l).join("\n")}`
  );
}

main().catch((err) => {
  console.error("SEC holdings loader failed:", err);
  process.exit(1);
});
