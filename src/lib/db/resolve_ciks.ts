/**
 * Step 1 of the provenance chunk: populate people.filing_cik.
 *
 * Resolution rule — EXACT matches only. For each tracked person we query the
 * EDGAR full-text search (Form 4 filings), collect candidate CIKs from the
 * display_names of the hits, and accept a candidate only when the EDGAR
 * entity name matches the person's name exactly (token-set equality, both
 * name orders). Every candidate is then verified against the submissions
 * JSON: the entity's registered name must match AND the CIK must be a filer
 * of ownership forms. Anything else is logged as an ambiguity and left for
 * manual review — a wrong CIK would fabricate a holding downstream.
 *
 * Non-US billionaires (Arnault, Ambani, Ortega, Bettencourt) have no SEC
 * presence; they resolve to nothing, which is the honest result.
 *
 * Run: npm run ciks:resolve
 */

import { db } from "@/lib/db";
import { people } from "@/lib/db/schema";
import { eq } from "drizzle-orm";
import { politeFetch } from "@/lib/providers/http";
import { fetchSubmissions } from "@/lib/providers/sec/edgar";

/** slug → acceptable EDGAR name variants (owner-name order and natural order). */
const TARGETS: Record<string, string[]> = {
  "elon-musk": ["ELON MUSK", "MUSK ELON"],
  "jeff-bezos": ["JEFFREY P BEZOS", "BEZOS JEFFREY P"],
  "mark-zuckerberg": ["MARK ZUCKERBERG", "ZUCKERBERG MARK E", "ZUCKERBERG MARK"],
  "bill-gates": ["WILLIAM H GATES", "GATES WILLIAM H", "WILLIAM H GATES III", "GATES WILLIAM H III"],
  "steve-ballmer": ["STEVEN A BALLMER", "BALLMER STEVEN A"],
  "warren-buffett": ["WARREN E BUFFETT", "BUFFETT WARREN E"],
  "larry-ellison": ["LAWRENCE J ELLISON", "ELLISON LAWRENCE J", "ELLISON LAWRENCE JOSEPH", "LAWRENCE JOSEPH ELLISON"],
  "larry-page": ["LAWRENCE E PAGE", "PAGE LAWRENCE E", "LAWRENCE EDWARD PAGE", "PAGE LAWRENCE EDWARD", "LAWRENCE PAGE"],
  "sergey-brin": ["SERGEY BRIN", "BRIN SERGEY M", "SERGEY M BRIN"],
  "jim-walton": ["JAMES C WALTON", "WALTON JAMES C", "JIM C WALTON", "WALTON JIM C", "JAMES WALTON"],
  "alice-walton": ["ALICE L WALTON", "WALTON ALICE L"],
  "rob-walton": ["SAMUEL R WALTON", "WALTON SAMUEL R", "SAMUEL ROBSON WALTON", "WALTON SAMUEL ROBSON", "S ROBSON WALTON", "WALTON S ROBSON"],
};

function nameTokens(name: string): string[] {
  return name
    .toUpperCase()
    .replace(/[.,]/g, " ")
    .split(/\s+/)
    .filter(Boolean)
    .sort();
}

function tokenSetsEqual(a: string[], b: string[]): boolean {
  return a.length === b.length && a.every((t, i) => t === b[i]);
}

async function searchCandidates(variants: string[]): Promise<Map<string, string[]>> {
  // CIK → EDGAR names seen for it
  const ciks = new Map<string, string[]>();
  for (const variant of variants) {
    const url = `https://efts.sec.gov/LATEST/search-index?q=${encodeURIComponent(`"${variant}"`)}&forms=4`;
    try {
      const res = await politeFetch(url);
      const json = (await res.json()) as {
        hits?: {
          hits?: Array<{ _source?: { display_names?: string[]; ciks?: string[] } }>;
        };
      };
      for (const h of json.hits?.hits ?? []) {
        const src = h._source ?? {};
        const names = src.display_names ?? [];
        const hitCiks = src.ciks ?? [];
        for (const dn of names) {
          const m = dn.match(/^(.+?)\s*\(CIK\s*(\d+)\)$/);
          if (!m) continue;
          const edgarName = m[1].replace(/\s+/g, " ").trim().toUpperCase();
          // A display name is only evidence if its CIK is one of the hit's CIKs.
          if (hitCiks.includes(m[2])) {
            const list = ciks.get(m[2]) ?? [];
            if (!list.includes(edgarName)) list.push(edgarName);
            ciks.set(m[2], list);
          }
        }
      }
    } catch (err) {
      console.warn(`  search failed for "${variant}": ${(err as Error).message}`);
    }
  }
  return ciks;
}

async function main() {
  console.log("Resolving SEC filing CIKs (exact matches only)\n");

  for (const [slug, variants] of Object.entries(TARGETS)) {
    const person = (await db.select().from(people).where(eq(people.slug, slug)).limit(1))[0];
    if (!person) {
      console.log(`${slug}: not in people table — skipping`);
      continue;
    }
    if (person.filingCik) {
      console.log(`${slug}: already has filing_cik=${person.filingCik} — keeping`);
      continue;
    }

    const variantTokens = variants.map(nameTokens);
    const nameMatches = (edgarName: string) =>
      variantTokens.some((vt) => tokenSetsEqual(vt, nameTokens(edgarName)));

    const candidates = await searchCandidates(variants);

    // Filter to candidates whose EDGAR name exactly matches a variant.
    const exact = new Map<string, string[]>();
    for (const [cik, names] of candidates) {
      const matching = names.filter(nameMatches);
      if (matching.length > 0) exact.set(cik, matching);
    }

    if (exact.size === 0) {
      console.log(`${slug}: NO exact match (${candidates.size} fuzzy candidates discarded) — filing_cik stays empty`);
      continue;
    }

    // Verify each exact candidate via submissions JSON (must be the person,
    // must be an ownership-form filer).
    const verified: string[] = [];
    for (const [cik] of exact) {
      try {
        const sub = await fetchSubmissions(cik);
        const nameOk = nameMatches(sub.name);
        const formsOk = sub.recent.some((f) => ["3", "4", "5"].includes(f.form));
        if (nameOk && formsOk) verified.push(cik);
        else
          console.log(
            `  candidate CIK ${cik} rejected: name-match=${nameOk} (${sub.name}), ownership-forms=${formsOk}`
          );
      } catch (err) {
        console.log(`  candidate CIK ${cik} failed verification: ${(err as Error).message}`);
      }
    }

    if (verified.length === 1) {
      await db.update(people).set({ filingCik: verified[0] }).where(eq(people.slug, slug));
      console.log(`${slug}: filing_cik = ${verified[0]} (EDGAR name: "${exact.get(verified[0])?.join('", "')}")`);
    } else if (verified.length === 0) {
      console.log(`${slug}: no candidate survived verification — filing_cik stays empty`);
    } else {
      console.log(
        `${slug}: AMBIGUOUS — ${verified.length} verified CIKs (${verified.join(", ")}) — logged for manual review, not stored`
      );
    }
  }

  console.log("\nDone. Re-run is a no-op for resolved people.");
}

main().catch((err) => {
  console.error("CIK resolution failed:", err);
  process.exit(1);
});
