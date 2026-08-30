/**
 * Slice 15 / Phase 1 Chunk 3 — a second independent source: Wikidata P2218.
 *
 * With one source per person the consensus band, the spread sort and the
 * confidence tiers were all inert: every row was correctly but uselessly
 * "Low". This loader adds a genuinely independent estimate (Wikidata, CC0) so
 * the band starts to mean something.
 *
 * Rules enforced here:
 * - Never match on name alone. Three rules, tried in order, and the rule that
 *   fired is written into baseline_estimates.raw so any row can be audited:
 *     1. Wikidata QID already recorded in people.aliases
 *     2. exact full_name AND matching born_year
 *     3. exact full_name AND matching country (ISO 3166-1 alpha-2)
 *   Anything else is skipped and logged. A wrong match is worse than a
 *   missing one, so an ambiguous rule (two or more candidates) skips too.
 * - P2218 carries a currency unit. USD is used as-is; every other currency is
 *   converted through fx_rates and SKIPPED when no rate exists for that day.
 *   An unknown unit is an error, never a silent USD.
 * - Wikidata values are often stale. pointInTime is stored as as_of and never
 *   overwritten with today's date — the age of a claim is the whole point.
 * - Additive only: INSERT OR IGNORE on the (person, source, as_of) natural
 *   key. Nothing here deletes.
 * - Every skipped row is written to a JSONL audit file with a reason. There
 *   are no silent drops.
 *
 * Run: pnpm exec tsx src/lib/db/load_slice_wikidata.ts
 */

import { join } from "node:path";
import { mkdirSync, appendFileSync, writeFileSync } from "node:fs";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { createId } from "@paralleldrive/cuid2";
import { sources, people, baselineEstimates } from "./schema";
import { checkBaseline } from "./sanity";
import { countryToIso2 } from "@/lib/matching/country-codes";
import {
  fetchWikidataNetWorth,
  verifyRawCapture,
  type WikidataNetWorthRow,
} from "@/lib/providers/wikidata/networth";

const SOURCE_ID = "wikidata";

/**
 * A net-worth claim must be dated, and the date has to be plausible.
 *
 * Wikidata contains at least two P2218 statements whose P585 is a typo for a
 * 21st-century date ("0024-09-24", "0018-05-20"). Both are well-formed
 * YYYY-MM-DD, so a format check lets them straight through — and once stored,
 * they sort as the oldest claim on record and would silently anchor a
 * "consensus" band a couple of millennia wide. Anything outside this window is
 * corrupt and is rejected rather than corrected, because the real date is
 * unknowable: guessing 2024 from "0024" is exactly the invention this project
 * exists to prevent.
 */
const EARLIEST_PLAUSIBLE_CLAIM = Date.UTC(1990, 0, 1);
/** Claims dated in the future are corrupt too; allow a day of clock skew. */
const LATEST_PLAUSIBLE_CLAIM = () => Date.now() + 86_400_000;

// ---------------------------------------------------------------------------
// Skip log — one JSON object per dropped row, no exceptions
// ---------------------------------------------------------------------------

interface SkipRecord {
  qid: string;
  label: string;
  amount: number | null;
  currency: string | null;
  asOf: string | null;
  reason: string;
}

const DATE_STR = new Date().toISOString().slice(0, 10);
const LOG_DIR = join(process.cwd(), "data", "raw", "wikidata", DATE_STR);
const SKIP_LOG = join(LOG_DIR, "skipped.jsonl");

const skips: SkipRecord[] = [];
const skipCounts = new Map<string, number>();

function skip(row: WikidataNetWorthRow | { qid: string; label: string }, reason: string): void {
  const rec: SkipRecord = {
    qid: row.qid,
    label: row.label,
    amount: "amount" in row ? row.amount : null,
    currency: "currencyIso" in row ? row.currencyIso : null,
    asOf: "asOf" in row ? row.asOf : null,
    reason,
  };
  skips.push(rec);
  skipCounts.set(reason, (skipCounts.get(reason) ?? 0) + 1);
}

function flushSkipLog(): void {
  mkdirSync(LOG_DIR, { recursive: true });
  writeFileSync(SKIP_LOG, "", "utf8");
  for (const s of skips) appendFileSync(SKIP_LOG, JSON.stringify(s) + "\n", "utf8");
  console.log(`\nSkip log: ${SKIP_LOG.replace(/\\/g, "/")} (${skips.length} row(s))`);
  const ordered = [...skipCounts.entries()].sort((a, b) => b[1] - a[1]);
  if (ordered.length > 0) {
    console.log("\nSkips by reason:");
    // Reasons are templates; group on the leading clause so the summary is legible.
    for (const [reason, n] of ordered.slice(0, 25)) {
      console.log(`  ${String(n).padStart(5)}  ${reason.slice(0, 140)}`);
    }
  }
}

// ---------------------------------------------------------------------------
// People index
// ---------------------------------------------------------------------------

interface PersonLite {
  id: string;
  slug: string;
  fullName: string;
  bornYear: number | null;
  countryIso2: string | null;
  qids: Set<string>;
}

function normaliseName(name: string): string {
  return name.toLowerCase().replace(/\s+/g, " ").trim();
}

function parseAliases(raw: string | null): { qids: Set<string>; names: string[] } {
  const qids = new Set<string>();
  const names: string[] = [];
  if (!raw) return { qids, names };
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { qids, names }; // unparseable aliases are treated as absent, never guessed
  }
  const entries = Array.isArray(parsed) ? parsed : [parsed];
  for (const e of entries) {
    if (typeof e === "string") {
      if (/^Q\d+$/.test(e)) qids.add(e);
      else names.push(e);
    } else if (e && typeof e === "object") {
      const o = e as Record<string, unknown>;
      const qid = typeof o.wikidata === "string" ? o.wikidata : typeof o.qid === "string" ? o.qid : null;
      if (qid && /^Q\d+$/.test(qid)) qids.add(qid);
      if (typeof o.name === "string") names.push(o.name);
    }
  }
  return { qids, names };
}

type MatchRule = "qid_alias" | "name_birth_year" | "name_country";

interface MatchResult {
  person: PersonLite;
  rule: MatchRule;
}

function buildIndexes(rows: Array<{
  id: string; slug: string; full_name: string; born_year: number | null;
  country: string | null; aliases: string | null;
}>) {
  const byQid = new Map<string, PersonLite[]>();
  const byName = new Map<string, PersonLite[]>();

  const all: PersonLite[] = rows.map((r) => {
    const { qids } = parseAliases(r.aliases);
    const p: PersonLite = {
      id: r.id,
      slug: r.slug,
      fullName: r.full_name,
      bornYear: r.born_year,
      countryIso2: countryToIso2(r.country),
      qids,
    };
    for (const q of qids) {
      if (!byQid.has(q)) byQid.set(q, []);
      byQid.get(q)!.push(p);
    }
    const key = normaliseName(r.full_name);
    if (!byName.has(key)) byName.set(key, []);
    byName.get(key)!.push(p);
    return p;
  });

  return { all, byQid, byName };
}

/**
 * Try the three rules in order. Returns null (with a reason already logged)
 * when nothing matches unambiguously.
 */
function matchPerson(
  row: WikidataNetWorthRow,
  idx: ReturnType<typeof buildIndexes>
): MatchResult | null {
  // Rule 1 — QID already recorded in people.aliases. Strongest signal: it was
  // put there by a previous run of this loader after a name/year/country match.
  const byQid = idx.byQid.get(row.qid);
  if (byQid && byQid.length > 0) {
    if (byQid.length > 1) {
      skip(row, `ambiguous: QID ${row.qid} is recorded on ${byQid.length} people (${byQid.map((p) => p.slug).join(", ")})`);
      return null;
    }
    return { person: byQid[0], rule: "qid_alias" };
  }

  const nameKey = normaliseName(row.label);
  const candidates = idx.byName.get(nameKey);
  if (!candidates || candidates.length === 0) {
    skip(row, `no person in the roster is called "${row.label}" (names must match exactly)`);
    return null;
  }

  // Rule 2 — exact name AND same birth year.
  if (row.birthYear != null) {
    const hits = candidates.filter((p) => p.bornYear === row.birthYear);
    if (hits.length === 1) return { person: hits[0], rule: "name_birth_year" };
    if (hits.length > 1) {
      skip(row, `ambiguous: "${row.label}" born ${row.birthYear} matches ${hits.length} people (${hits.map((p) => p.slug).join(", ")})`);
      return null;
    }
  }

  // Rule 3 — exact name AND same country of citizenship.
  if (row.citizenshipIso2) {
    const hits = candidates.filter((p) => p.countryIso2 === row.citizenshipIso2);
    if (hits.length === 1) return { person: hits[0], rule: "name_country" };
    if (hits.length > 1) {
      skip(row, `ambiguous: "${row.label}" (${row.citizenshipIso2}) matches ${hits.length} people (${hits.map((p) => p.slug).join(", ")})`);
      return null;
    }
    skip(row, `no country match: "${row.label}" is recorded as ${row.citizenshipIso2} in Wikidata; roster has ${candidates.map((p) => p.countryIso2 ?? "unknown").join("/")}`);
    return null;
  }

  skip(row, `insufficient signal: name "${row.label}" matches ${candidates.length} person(s) but Wikidata gives no birth year and no citizenship`);
  return null;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  mkdirSync(LOG_DIR, { recursive: true });

  const sqlite = new Database(join(process.cwd(), "data", "app.db"));
  sqlite.pragma("foreign_keys = ON");
  sqlite.pragma("journal_mode = WAL");
  const db = drizzle(sqlite, { schema: { sources, people, baselineEstimates } });

  // 1. Source row ------------------------------------------------------------
  const now = new Date().toISOString();
  db.insert(sources)
    .values({
      id: SOURCE_ID,
      name: "Wikidata",
      url: "https://www.wikidata.org/wiki/Property:P2218",
      license: "CC0",
      attribution: "Wikidata (CC0)",
      createdAt: now,
    })
    .onConflictDoNothing()
    .run();
  sqlite
    .prepare("UPDATE sources SET name = ?, url = ?, license = ?, attribution = ? WHERE id = ?")
    .run("Wikidata", "https://www.wikidata.org/wiki/Property:P2218", "CC0", "Wikidata (CC0)", SOURCE_ID);
  console.log(`Source '${SOURCE_ID}' registered (CC0)`);

  // 2. Fetch ----------------------------------------------------------------
  const snapshot = await fetchWikidataNetWorth();
  verifyRawCapture(snapshot.rawPath);

  // 3. Index the roster -----------------------------------------------------
  const roster = sqlite
    .prepare("SELECT id, slug, full_name, born_year, country, aliases FROM people")
    .all() as Array<{
      id: string; slug: string; full_name: string; born_year: number | null;
      country: string | null; aliases: string | null;
    }>;
  const idx = buildIndexes(roster);
  console.log(`Roster: ${roster.length} people, ${idx.byQid.size} with a stored Wikidata QID`);

  // 4. Match, convert, gate, insert -----------------------------------------
  const fxStmt = sqlite.prepare(
    "SELECT rate, source_url, as_of FROM fx_rates WHERE base = ? AND quote = 'USD' AND as_of = ?"
  );
  const insertStmt = sqlite.prepare(
    `INSERT OR IGNORE INTO baseline_estimates
       (id, person_id, source_id, net_worth_cents, as_of, rank, raw_path, raw, source_url, created_at)
     VALUES (?, ?, ?, ?, ?, NULL, ?, ?, ?, ?)`
  );
  const updateAliases = sqlite.prepare("UPDATE people SET aliases = ?, updated_at = ? WHERE id = ?");

  let inserted = 0;
  let conflicts = 0;
  const rulesFired = new Map<MatchRule, number>();
  const matchedPeople = new Set<string>();

  for (const row of snapshot.rows) {
    // -- match first --
    // Resolved before the value gates on purpose: the useful audit question is
    // "for a person we track, why is there no second estimate?", not "why did
    // some stranger's Wikidata row not load". Both are logged, but this order
    // puts the roster-relevant reasons at the top of the skip log.
    const match = matchPerson(row, idx);
    if (!match) continue;
    const { person, rule } = match;

    // -- date: a claim we cannot date is a claim we cannot compare --
    if (!row.asOf) {
      skip(row, "no P585 point in time — an undated claim cannot be compared against a dated one");
      continue;
    }
    // P585 may legitimately be year- or month-precision ("2025", "2025-06"),
    // so a partial date is valid. What is not valid is asserting precision the
    // source does not have — the provider truncates, it never pads.
    if (!/^\d{4}(-\d{2}(-\d{2})?)?$/.test(row.asOf)) {
      skip(row, `unparseable point in time "${row.asOf}"`);
      continue;
    }
    const asOfMs = Date.parse(
      row.asOf.length === 4
        ? `${row.asOf}-01-01T00:00:00Z`
        : row.asOf.length === 7
        ? `${row.asOf}-01T00:00:00Z`
        : `${row.asOf}T00:00:00Z`
    );
    if (!Number.isFinite(asOfMs)) {
      skip(row, `point in time "${row.asOf}" is not a real calendar date`);
      continue;
    }
    if (asOfMs < EARLIEST_PLAUSIBLE_CLAIM) {
      skip(row, `point in time ${row.asOf} predates 1990 — corrupt P585, not corrected`);
      continue;
    }
    if (asOfMs > LATEST_PLAUSIBLE_CLAIM()) {
      skip(row, `point in time ${row.asOf} is in the future`);
      continue;
    }

    // -- currency: unknown unit is an error, never a silent USD --
    if (!row.currencyIso) {
      skip(row, `currency unit ${row.unitQid} has no ISO 4217 code in Wikidata — refusing to assume USD`);
      continue;
    }

    let cents: number;
    let fx: { base: string; quote: string; rate: number; asOf: string; sourceUrl: string } | null = null;

    if (row.currencyIso === "USD") {
      cents = Math.round(row.amount * 100);
    } else {
      const rate = fxStmt.get(row.currencyIso, row.asOf) as
        | { rate: number; source_url: string; as_of: string }
        | undefined;
      if (!rate) {
        skip(row, `no fx_rates row for ${row.currencyIso}→USD on ${row.asOf} — skipping rather than assuming a rate`);
        continue;
      }
      fx = {
        base: row.currencyIso,
        quote: "USD",
        rate: rate.rate,
        asOf: rate.as_of,
        sourceUrl: rate.source_url,
      };
      cents = Math.round(row.amount * rate.rate * 100);
    }

    if (!Number.isFinite(row.amount) || row.amount <= 0) {
      skip(row, `amount is not a positive number (${row.amount})`);
      continue;
    }

    // -- citation: a P2218 statement with no P854 reference is unsourced --
    const sourceUrl = row.referenceUrl;
    if (typeof sourceUrl !== "string" || !/^https?:\/\/\S+$/.test(sourceUrl)) {
      skip(row, "no P854 reference URL — Wikidata itself marks this claim unsourced, so it is not inserted");
      continue;
    }

    // -- sanity gate --
    const verdict = checkBaseline({
      personSlug: person.slug,
      netWorthCents: cents,
      currency: row.currencyIso,
      sourceUrl,
    });
    if (!verdict.ok) {
      skip(row, verdict.reason);
      continue;
    }

    const raw = JSON.stringify({
      qid: row.qid,
      wikidata_label: row.label,
      match_rule: rule,
      amount: row.amount,
      currency: row.currencyIso,
      currency_qid: row.unitQid,
      point_in_time: row.asOf,
      point_in_time_precision: row.timePrecision,
      reference_url: row.referenceUrl,
      wikidata_birth_year: row.birthYear,
      wikidata_citizenship: row.citizenshipIso2,
      fx,
      raw_path: snapshot.rawPath,
    });

    const res = insertStmt.run(
      createId(),
      person.id,
      SOURCE_ID,
      cents,
      row.asOf,
      snapshot.rawPath,
      raw,
      sourceUrl,
      now
    );
    if (res.changes > 0) {
      inserted++;
      matchedPeople.add(person.id);
      rulesFired.set(rule, (rulesFired.get(rule) ?? 0) + 1);
    } else {
      // Already present under this natural key — additive, but not silent.
      conflicts++;
      skip(row, `duplicate of an existing (person, source, as_of=${row.asOf}) row — ignored, not overwritten`);
    }

    // -- remember the QID so the next run uses rule 1 --
    if (!person.qids.has(row.qid)) {
      const current = sqlite
        .prepare("SELECT aliases FROM people WHERE id = ?")
        .get(person.id) as { aliases: string | null };
      const { names } = parseAliases(current.aliases);
      const nextAliases = JSON.stringify([
        ...names,
        ...(person.qids.size > 0 ? [...person.qids] : []),
        { wikidata: row.qid },
      ]);
      updateAliases.run(nextAliases, now, person.id);
      person.qids.add(row.qid);
      if (!idx.byQid.has(row.qid)) idx.byQid.set(row.qid, []);
      if (!idx.byQid.get(row.qid)!.some((p) => p.id === person.id)) {
        idx.byQid.get(row.qid)!.push(person);
      }
    }
  }

  // 5. Report ---------------------------------------------------------------
  flushSkipLog();

  console.log(`\nInserted ${inserted} Wikidata estimate(s) for ${matchedPeople.size} people`);
  console.log(`Already-present rows ignored: ${conflicts}`);
  // Counted per inserted row, so a fully idempotent run legitimately reports
  // nothing here. Say so rather than leaving a heading with no body.
  if (rulesFired.size === 0) {
    console.log("Match rules fired: none — every row was already present");
  } else {
    console.log("Match rules fired:");
    for (const [rule, n] of rulesFired) console.log(`  ${rule.padEnd(16)} ${n}`);
  }

  const twoPlus = sqlite
    .prepare(
      `SELECT COUNT(*) AS c FROM (
         SELECT person_id FROM baseline_estimates
          GROUP BY person_id HAVING COUNT(DISTINCT source_id) >= 2
       )`
    )
    .get() as { c: number };
  console.log(`\nPeople with 2+ independent sources: ${twoPlus.c}`);

  const perSource = sqlite
    .prepare("SELECT source_id, COUNT(*) AS n FROM baseline_estimates GROUP BY source_id")
    .all() as Array<{ source_id: string; n: number }>;
  for (const r of perSource) console.log(`  ${r.source_id}: ${r.n} estimate(s)`);

  sqlite.close();
}

main().catch((err) => {
  console.error("load_slice_wikidata FAILED:", err);
  if (skips.length > 0) {
    try {
      flushSkipLog();
    } catch {
      /* never mask the original error */
    }
  }
  process.exit(1);
});
