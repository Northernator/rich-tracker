/**
 * Pledges from the filings that actually state them — DEF 14A proxy statements.
 *
 * This loader replaces the invented leverage rows whose numbers never changed,
 * whose accession was fabricated (wf-form4_171234567890456.xml), whose
 * evidence_text described a filing instead of quoting it, and two of which
 * cited Form 13F — which reports a fund's portfolio, never an individual's
 * pledge.
 *
 * Pledges are disclosed in the DEF 14A's beneficial-ownership table
 * footnotes. Nowhere else. The pipeline, per security with a resolved CIK:
 *
 *   1. fetchDef14a() — most recent DEF 14A via the submissions API, saved
 *      verbatim under data/raw/sec/<cik>/<accession>.htm (+ .meta.json) and
 *      parsed FROM DISK (audit-trail rule).
 *   2. Index the stripped text into `filings_fts` (FTS5, porter) keyed by
 *      accession_no + cik. Additive: a re-run skips an already-indexed
 *      accession.
 *   3. Query body MATCH 'pledge OR pledged OR collateral' with snippet() to
 *      confirm the document carries pledge language and to pull the
 *      surrounding sentences.
 *   4. Extract candidates as { shares, person, verbatim_sentence }. The
 *      verbatim sentence must appear byte-for-byte in the document text —
 *      verified programmatically before anything is inserted; a mismatch is
 *      rejected loudly. No sentence, no row.
 *   5. Sanity gate (checkHolding) — a personal pledge cannot exceed the
 *      company's outstanding shares, nor its value the baseline net worth.
 *   6. INSERT OR IGNORE on (person_id, ticker, source_url) — additive,
 *      idempotent; never DELETE-then-reload.
 *
 * Pledged shares are collateral, not a dollar liability: loan size is almost
 * never disclosed, and nothing here subtracts pledges from net worth.
 *
 * Run: npm run pledges:sec
 */

import { db, sqlite } from "@/lib/db";
import { checkHolding } from "./sanity";
import { eq } from "drizzle-orm";
import * as schema from "./schema";
import { createId } from "@paralleldrive/cuid2";
import { fetchDef14a, splitSentences } from "@/lib/providers/sec/def14a";

// ---------------------------------------------------------------------------
// Person matching — scoped to people plausibly connected to the issuer, so a
// shared surname never gets guessed to the wrong billionaire.
// ---------------------------------------------------------------------------

interface PersonMatcher {
  id: string;
  slug: string;
  fullName: string;
  surname: string;
}

/** Map "surname" -> people. Walton/Ellison appear for several people; the issuer scope + full name disambiguate. */
function buildPersonMatcher(): Map<string, PersonMatcher[]> {
  const bySurname = new Map<string, PersonMatcher[]>();
  const rows = db.select().from(schema.people).all();
  for (const p of rows) {
    const names = (p.fullName ?? "").trim().split(/\s+/).filter(Boolean);
    if (names.length === 0) continue;
    const surname = names[names.length - 1].replace(/[^\p{L}'.-]/gu, "");
    if (!surname) continue;
    const m = { id: p.id, slug: p.slug, fullName: (p.fullName ?? "").trim(), surname };
    const arr = bySurname.get(surname) ?? [];
    arr.push(m);
    bySurname.set(surname, arr);
  }
  return bySurname;
}

/**
 * People plausibly connected to an issuer: anyone who holds a tracked stake in
 * the security, or whose primary_org overlaps the issuer's name (a DEF 14A
 * only names its own insiders). Ellison in an ORCL proxy is Larry, not Chris.
 */
function issuerCandidates(sec: { ticker: string; name: string | null }): Set<string> {
  const slugs = new Set<string>();
  const holders = db
    .select({ slug: schema.people.slug, org: schema.people.primaryOrg })
    .from(schema.equityHoldings)
    .innerJoin(schema.people, eq(schema.people.id, schema.equityHoldings.personId))
    .where(eq(schema.equityHoldings.ticker, sec.ticker))
    .all();
  for (const h of holders) slugs.add(h.slug);

  const issuerName = (sec.name ?? "").toLowerCase().replace(/[^a-z0-9 ]/g, " ").replace(/\s+/g, " ").trim();
  const people = db.select().from(schema.people).all();
  for (const p of people) {
    const org = (p.primaryOrg ?? "").toLowerCase().replace(/[^a-z0-9 ]/g, " ").replace(/\s+/g, " ").trim();
    if (issuerName && org && (issuerName.includes(org) || org.includes(issuerName))) {
      slugs.add(p.slug);
    }
  }
  return slugs;
}

function matchPerson(
  sentence: string,
  bySurname: Map<string, PersonMatcher[]>,
  issuerSlugs: Set<string>
): PersonMatcher | null {
  // 1. Full-name match among issuer-connected people is unambiguous.
  for (const people of bySurname.values()) {
    for (const p of people) {
      if (!issuerSlugs.has(p.slug)) continue;
      if (sentence.includes(p.fullName)) return p;
    }
  }
  // 2. Surname match — only when exactly one issuer-connected person has it.
  for (const [surname, people] of bySurname) {
    const connected = people.filter((p) => issuerSlugs.has(p.slug));
    if (connected.length !== 1) continue;
    if (new RegExp(`\\b${surname}\\b`, "i").test(sentence)) return connected[0];
  }
  return null;
}

// ---------------------------------------------------------------------------
// Share-count extraction from a sentence (deterministic contract extractor)
// ---------------------------------------------------------------------------

interface PledgeCandidate {
  shares: number;
  person: PersonMatcher;
  verbatim_sentence: string;
}

/**
 * Extract { shares, person, verbatim_sentence } from a sentence that contains
 * pledge/collateral language. Returns null unless BOTH a share count and a
 * uniquely-matched tracked person are present — the chunk's contract is
 * honoured by the returned shape, and the verbatim sentence is verified
 * byte-for-byte by the caller before insert.
 */
function extractCandidate(
  sentence: string,
  bySurname: Map<string, PersonMatcher[]>,
  issuerSlugs: Set<string>
): PledgeCandidate | null {
  if (!/pledg|collateral/i.test(sentence)) return null;
  if (/climate pledge/i.test(sentence)) return null;

  const person = matchPerson(sentence, bySurname, issuerSlugs);
  if (!person) return null;

  // "pledged 346,000,000 shares" | "pledged 12,000,000 shares of Class B"
  const m = sentence.match(
    /pledg\w*\s+(?:up\s+to\s+)?(\d[\d,]*(?:\.\d+)?)\s*(million|billion|trillion)?\s*(?:shares|shares\s+of)/i
  ) ?? sentence.match(
    /(\d[\d,]*(?:\.\d+)?)\s*(million|billion|trillion)?\s*shares\s+(?:of\s+[^.]*?\s+)?(?:pledg\w*|as collateral)/i
  );
  if (!m) return null;

  let n = parseFloat(m[1].replace(/,/g, ""));
  const unit = (m[2] ?? "").toLowerCase();
  if (unit === "million") n *= 1e6;
  else if (unit === "billion") n *= 1e9;
  else if (unit === "trillion") n *= 1e12;

  if (!Number.isFinite(n) || n <= 0) return null;

  return { shares: Math.round(n), person, verbatim_sentence: sentence };
}

// ---------------------------------------------------------------------------
// FTS5 index (additive) + pledge-language confirmation via snippet()
// ---------------------------------------------------------------------------

function indexDocument(doc: { accession: string; cik: string; text: string }): boolean {
  const existing = sqlite
    .prepare("SELECT 1 FROM filings_fts WHERE accession_no = ? LIMIT 1")
    .get(doc.accession);
  if (existing) return true; // already indexed — additive no-op

  sqlite
    .prepare("INSERT INTO filings_fts (accession_no, cik, body) VALUES (?, ?, ?)")
    .run(doc.accession, doc.cik, doc.text);
  return false;
}

/** Run the FTS MATCH + snippet() per the chunk's DDL. Returns matched snippets. */
function ftsSnippets(accession: string): string[] {
  const rows = sqlite
    .prepare(
      `SELECT snippet(filings_fts, 2, '[', ']', ' … ', 12) AS snip
         FROM filings_fts
        WHERE filings_fts MATCH 'pledge OR pledged OR collateral'
          AND accession_no = ?`
    )
    .all(accession) as Array<{ snip: string }>;
  return rows.map((r) => r.snip);
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  console.log("=== Pledges from DEF 14A proxy statements ===\n");

  const bySurname = buildPersonMatcher();

  const securitiesWithCik = (await db.select().from(schema.securities))
    .filter((s) => s.cik != null && s.cik !== "");

  if (securitiesWithCik.length === 0) {
    console.log("No securities with a resolved issuer CIK.");
    return;
  }

  const slugToId = new Map<string, string>();
  for (const p of await db.select({ id: schema.people.id, slug: schema.people.slug }).from(schema.people)) {
    slugToId.set(p.slug, p.id);
  }

  let inserted = 0;
  let rejected = 0;
  let noDef14a = 0;
  let noPledgeLanguage = 0;
  const runLog: string[] = [];

  for (const sec of securitiesWithCik) {
    const ticker = sec.ticker;
    console.log(`\n--- ${ticker} (CIK ${sec.cik}) ---`);

    // People plausibly connected to this issuer (holders + org overlap). This
    // scope exists so a shared surname never guesses the wrong billionaire.
    const issuerSlugs = issuerCandidates(sec);

    let doc;
    try {
      doc = await fetchDef14a(sec.cik!);
    } catch (err) {
      rejected++;
      console.warn(`  ! fetch failed: ${(err as Error).message.slice(0, 160)}`);
      runLog.push(`  REJECTED ${ticker}: fetch failed — ${(err as Error).message.slice(0, 120)}`);
      continue;
    }
    if (!doc) {
      noDef14a++;
      console.log("  no DEF 14A in recent filings — skipping (an empty table is honest).");
      continue;
    }

    indexDocument(doc);
    const snippets = ftsSnippets(doc.accession);
    if (snippets.length === 0) {
      noPledgeLanguage++;
      console.log(`  indexed ${doc.accession} but no pledge/collateral language matched.`);
      continue;
    }
    console.log(`  indexed ${doc.accession} (filed ${doc.filingDate}) — FTS matched; snippets:`);
    for (const s of snippets.slice(0, 3)) {
      console.log(`    · ${s.slice(0, 140)}`);
    }

    // Pull full sentences from the document text and run the contract extractor.
    const sentences = splitSentences(doc.text);
    const seen = new Set<string>();
    for (const sentence of sentences) {
      if (!/pledg|collateral/i.test(sentence)) continue;
      if (/climate pledge/i.test(sentence)) continue;
      // A proxy often repeats the same footnote boilerplate; process each
      // distinct sentence once so the run log isn't padded with duplicates.
      if (seen.has(sentence)) continue;
      seen.add(sentence);

      const cand = extractCandidate(sentence, bySurname, issuerSlugs);
      if (!cand) continue;

      // Byte-for-byte verification: the quoted sentence must appear exactly in
      // the document. Reject loudly otherwise — never normalize and insert.
      if (!doc.text.includes(cand.verbatim_sentence)) {
        rejected++;
        console.warn(`  REJECTED: verbatim sentence not found byte-for-byte in document — "${cand.verbatim_sentence.slice(0, 90)}…"`);
        runLog.push(`  REJECTED ${ticker}: sentence mismatch`);
        continue;
      }

      const personId = slugToId.get(cand.person.slug);
      if (!personId) {
        rejected++;
        continue;
      }

      const verdict = checkHolding(sqlite, {
        personSlug: cand.person.slug,
        ticker,
        shares: cand.shares,
        sourceUrl: doc.url,
      });
      if (!verdict.ok) {
        rejected++;
        console.warn(`  REJECTED (sanity): ${verdict.reason}`);
        runLog.push(`  REJECTED ${ticker}: ${verdict.reason}`);
        continue;
      }

      try {
        const result = await db
          .insert(schema.pledgeHoldings)
          .values({
            id: createId(),
            personId,
            ticker,
            exchange: sec.exchange,
            sharesPledged: cand.shares,
            asOf: doc.filingDate,
            source: `SEC DEF 14A proxy statement (filed ${doc.filingDate})`,
            sourceUrl: doc.url,
            evidenceText: cand.verbatim_sentence,
            filingId: doc.accession,
            sourceType: "verified",
            createdAt: new Date().toISOString(),
          })
          .onConflictDoNothing() // (person_id, ticker, source_url) — additive, idempotent
          .run();
        if (result.changes > 0) {
          inserted++;
          console.log(
            `  INSERTED ${cand.person.slug} ${ticker}: ${cand.shares.toLocaleString()} pledged (filed ${doc.filingDate})`
          );
          console.log(`    quoted: ${cand.verbatim_sentence.slice(0, 200)}`);
          runLog.push(
            `${cand.person.slug} ${ticker} ${cand.shares} pledged — ${doc.url}`
          );
        } else {
          console.log(`  already present (person, ticker, source_url) — additive no-op`);
        }
      } catch (err) {
        rejected++;
        console.warn(`  insert failed: ${String(err).slice(0, 140)}`);
      }
    }
  }

  console.log(
    `\n=== Run summary ===\n` +
    `  verified pledge rows inserted: ${inserted}\n` +
    `  rejections (skipped, logged): ${rejected}\n` +
    `  securities with no DEF 14A: ${noDef14a}\n` +
    `  securities with no pledge language: ${noPledgeLanguage}\n` +
    `\nRun log:\n${runLog.map((l) => "  " + l).join("\n")}`
  );
}

main().catch((err) => {
  console.error("Pledge loader failed:", err);
  process.exit(1);
});
