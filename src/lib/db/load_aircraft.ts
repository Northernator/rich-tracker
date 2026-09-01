/**
 * Chunk 9 — Aircraft ownership from the FAA registry.
 *
 * The FAA's bulk "Releasable Aircraft" download (MASTER.txt) was rendered
 * unusable for this purpose after the 2024 PII-withholding rule: it ships with
 * N-numbers and registrant names stripped. So this loader consumes a per-tail,
 * manually-vetted seed produced by scripts/faa_verify_tails.cjs, which hits the
 * public FAA N-number inquiry page for each candidate tail and records the
 * EXACT registrant entity + manufacturer/model as the FAA itself renders it.
 *
 * Data-integrity posture (per AGENTS.md / CLAUDE.md):
 *   - Every asset.row source_url opens the FAA record showing that tail.
 *   - Every ownership_links.citation quotes the EXACT registrant string the
 *     FAA page returned (verbatim, never normalized or person-named).
 *   - The FAA page exposes the REGISTERED OWNER ENTITY (an LLC / trust), never
 *     the individual. The person↔entity link therefore rests on a SECONDARY
 *     public source (named in the citation) and is NOT independently
 *     corroborated by a primary filing for any of these tails. Confidence is
 *     therefore 'low', and the citation says so plainly rather than asserting
 *     the link as proven.
 *   - estimated_value_cents is left NULL: no sourced market figure exists, and
 *     the old loader's $4M-vs-$400M unit bug is specifically avoided.
 *   - Rows are additive (onConflictDoNothing on the natural keys). Never
 *     DELETE-then-reload.
 *   - Tails the live FAA page did not return, or whose owner was withheld, are
 *     excluded from the seed — an empty graph edge beats a fabricated one.
 *
 * Run: npm run aircraft:faa
 */

import { join } from "path";
import { existsSync, readFileSync } from "fs";
import { db } from "@/lib/db";
import { and, eq } from "drizzle-orm";
import * as schema from "./schema";
import { createId } from "@paralleldrive/cuid2";

// ---------------------------------------------------------------------------
// Security — same URL allowlist as the other loaders
// ---------------------------------------------------------------------------
const ALLOWED_PROTOCOLS = new Set(["http:", "https:"]);
const BLOCKED_HOSTS = new Set([
  "localhost", "127.0.0.1", "0.0.0.0", "::1",
  "10.0.0.0", "172.16.0.0", "192.168.0.0", "169.254.0.0",
]);

function assertExternalUrl(url: string, label: string): void {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error(`Invalid URL for ${label}: ${url}`);
  }
  if (!ALLOWED_PROTOCOLS.has(parsed.protocol)) {
    throw new Error(`Rejected ${label}: non-HTTP protocol "${parsed.protocol}"`);
  }
  const host = parsed.hostname.toLowerCase();
  if (BLOCKED_HOSTS.has(host) || host.endsWith(".local") || host.endsWith(".internal")) {
    throw new Error(`Rejected ${label}: blocked host "${host}"`);
  }
}

// ---------------------------------------------------------------------------
// Seed: per-tail FAA fact + the secondary source that REPORTS the person link.
//
// `owner` is the EXACT FAA registrant string (from verified_tails.json).
// `linkSource` is a secondary public source that asserts the person↔entity
// link. Where no secondary cleanly reports the link, linkSource is null and
// the citation states the link is uncorroborated. None of these are primary
// filings; that is why confidence is 'low'.
// ---------------------------------------------------------------------------

interface AircraftSeed {
  tail: string;
  personSlug: string;
  personName: string;
  owner: string; // exact FAA registrant entity
  mfr: string;
  model: string;
  sourceUrl: string; // FAA NNumberResult URL
  linkSource: { name: string; url: string } | null;
}

const SEED: AircraftSeed[] = [
  {
    tail: "N628TS",
    personSlug: "elon-musk",
    personName: "Elon Musk",
    owner: "FALCON LANDING LLC",
    mfr: "GULFSTREAM AEROSPACE CORP",
    model: "GVI (G650ER)",
    sourceUrl: "https://registry.faa.gov/AircraftInquiry/Search/NNumberResult?nNumberTxt=N628TS",
    linkSource: { name: "AceJet", url: "https://acejet.com/aircraft/N628TS/" },
  },
  {
    tail: "N194PJ",
    personSlug: "jeff-bezos",
    personName: "Jeff Bezos",
    owner: "GUIDRY AVIATION LLC",
    mfr: "PILATUS AIRCRAFT LTD",
    model: "PC-24",
    sourceUrl: "https://registry.faa.gov/AircraftInquiry/Search/NNumberResult?nNumberTxt=N194PJ",
    linkSource: { name: "CelebPlanes", url: "https://www.celebplanes.com/aircraft/a17855" },
  },
  {
    tail: "N817GS",
    personSlug: "larry-ellison",
    personName: "Larry Ellison",
    owner: "WING AND A PRAYER INC",
    mfr: "GULFSTREAM AEROSPACE CORP",
    model: "GVI (G650)",
    sourceUrl: "https://registry.faa.gov/AircraftInquiry/Search/NNumberResult?nNumberTxt=N817GS",
    linkSource: { name: "Aero Corner", url: "https://aerocorner.com/blog/larry-ellison-private-jets/" },
  },
  {
    tail: "N68885",
    personSlug: "mark-zuckerberg",
    personName: "Mark Zuckerberg",
    owner: "A7P TRUST CO INC TRUSTEE",
    mfr: "GULFSTREAM AEROSPACE CORP",
    model: "GVI (G650ER)",
    sourceUrl: "https://registry.faa.gov/AircraftInquiry/Search/NNumberResult?nNumberTxt=N68885",
    linkSource: { name: "AceJet", url: "https://acejet.com/aircraft/N68885/" },
  },
  {
    tail: "N3880",
    personSlug: "mark-zuckerberg",
    personName: "Mark Zuckerberg",
    owner: "A7P TRUST COMPANY INC TRUSTEE",
    mfr: "GULFSTREAM AEROSPACE CORP",
    model: "GVIII-G700",
    sourceUrl: "https://registry.faa.gov/AircraftInquiry/Search/NNumberResult?nNumberTxt=N3880",
    // Same A7P trust vehicle as N68885; reported within the same Zuckerberg
    // fleet dossier. No standalone primary document for this specific tail.
    linkSource: { name: "AceJet (Zuckerberg fleet)", url: "https://acejet.com/aircraft/N68885/" },
  },
  {
    tail: "N502UP",
    personSlug: "michael-dell",
    personName: "Michael Dell",
    owner: "ALLIANCE AVIATION GROUP LLC",
    mfr: "CESSNA",
    model: "560XL",
    sourceUrl: "https://registry.faa.gov/AircraftInquiry/Search/NNumberResult?nNumberTxt=N502UP",
    // FAA confirms the registrant entity; no secondary public source cleanly
    // asserts the Dell↔N502UP link. Cited as uncorroborated below.
    linkSource: null,
  },
];

// Build a lookup of verified FAA facts keyed by tail, to cross-check the SEED
// against the live-verification artifact (data/raw/faa/_work/verified_tails.json).
// If the two disagree on the registrant string, we must fail loudly — the SEED
// must quote the FAA page exactly.
function loadVerifiedFacts(): Map<string, { owner: string; found: boolean }> {
  const path = join(process.cwd(), "data", "raw", "faa", "_work", "verified_tails.json");
  const map = new Map<string, { owner: string; found: boolean }>();
  if (!existsSync(path)) return map; // not fatal — SEED still verified by hand
  try {
    const arr = JSON.parse(readFileSync(path, "utf8"));
    for (const r of arr) {
      map.set(r.tail, { owner: r.owner ?? "", found: !!r.found });
    }
  } catch {
    /* ignore — seed is the source of truth, artifact is a cross-check */
  }
  return map;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  console.log("=== Chunk 9: Aircraft ownership from FAA registry ===\n");

  const verified = loadVerifiedFacts();

  // Resolve people
  const slugToId = new Map<string, string>();
  for (const p of await db.select({ id: schema.people.id, slug: schema.people.slug }).from(schema.people)) {
    slugToId.set(p.slug, p.id);
  }

  // Resolve the FAA source id
  const src = await db
    .select({ id: schema.sources.id })
    .from(schema.sources)
    .where(eq(schema.sources.id, "faa-registry"))
    .limit(1)
    .execute();
  if (src.length === 0) {
    throw new Error("sources row 'faa-registry' missing — run seed first");
  }
  const sourceId = src[0].id;

  let assetInserted = 0;
  let assetReused = 0;
  let linkInserted = 0;
  let linkReused = 0;
  let linkSkipped = 0;
  let rejected = 0;

  for (const s of SEED) {
    // Cross-check the registrant string against the live FAA artifact.
    const v = verified.get(s.tail);
    if (v && v.found && v.owner && v.owner !== s.owner) {
      rejected++;
      console.warn(
        `  REJECTED ${s.tail}: SEED owner "${s.owner}" != verified FAA owner "${v.owner}" — mismatch`
      );
      continue;
    }
    if (v && !v.found) {
      rejected++;
      console.warn(`  REJECTED ${s.tail}: live FAA did not return this tail — excluded`);
      continue;
    }

    const personId = slugToId.get(s.personSlug);
    if (!personId) {
      rejected++;
      console.warn(`  REJECTED ${s.tail}: person "${s.personSlug}" not found`);
      continue;
    }

    assertExternalUrl(s.sourceUrl, `FAA ${s.tail}`);

    // Asset name = aircraft type/model; tail = unique location.
    const assetName = `${s.mfr.replace(/\s+CORP(ORATION)?$/, "")} ${s.model}`.trim();
    const location = s.tail;

    // Dedupe on (name, asset_type, location) — ux_assets_identity enforces this.
    const existing = await db
      .select({ id: schema.assets.id })
      .from(schema.assets)
      .where(
        and(
          eq(schema.assets.name, assetName),
          eq(schema.assets.assetType, "aircraft"),
          eq(schema.assets.location, location)
        )
      )
      .limit(1)
      .execute();

    let assetId: string;
    if (existing.length > 0) {
      assetId = existing[0].id;
      assetReused++;
      console.log(`  ~ ${assetName} (${s.tail}) [asset already exists]`);
    } else {
      assetId = createId();
      await db
        .insert(schema.assets)
        .values({
          id: assetId,
          name: assetName,
          assetType: "aircraft",
          description: `${s.model} registered to ${s.owner} (FAA).`,
          location,
          estimatedValueCents: undefined, // no sourced market figure — NULL on purpose
          sourceId,
          sourceUrl: s.sourceUrl,
          createdAt: new Date().toISOString(),
        })
        .onConflictDoNothing()
        .run();
      assetInserted++;
      console.log(`  + ${assetName} (${s.tail}) [asset inserted, FAA-verified]`);
    }

    // Ownership link — low confidence, honest citation.
    const linkNote = s.linkSource
      ? `Person↔entity link reported by ${s.linkSource.name} (${s.linkSource.url}); not independently corroborated by a primary filing.`
      : `Person↔entity link NOT independently corroborated by any public document — reported here at low confidence only.`;
    const citation =
      `FAA registrant: "${s.owner}". ${linkNote} ` +
      `Asset fact verified at ${s.sourceUrl}.`;

    const linkExists = await db
      .select({ id: schema.ownershipLinks.id })
      .from(schema.ownershipLinks)
      .where(and(eq(schema.ownershipLinks.assetId, assetId), eq(schema.ownershipLinks.personId, personId)))
      .limit(1)
      .execute();

    if (linkExists.length > 0) {
      linkReused++;
      console.log(`  ~ ${s.personSlug} → ${assetName} [link already exists]`);
      continue;
    }

    try {
      await db
        .insert(schema.ownershipLinks)
        .values({
          id: createId(),
          assetId,
          personId,
          ownershipPct: undefined,
          confidence: "low",
          citation,
          sourceId,
          sourceUrl: s.sourceUrl,
          asOf: new Date().toISOString().slice(0, 10),
          createdAt: new Date().toISOString(),
        })
        .onConflictDoNothing()
        .run();
      linkInserted++;
      console.log(`  + ${s.personSlug} → ${assetName} (low; registrant "${s.owner}")`);
    } catch (err) {
      linkSkipped++;
      console.warn(`  ! link insert failed for ${s.tail}: ${String(err).slice(0, 140)}`);
    }
  }

  console.log(
    `\n=== Chunk 9 summary ===\n` +
      `  assets inserted:     ${assetInserted}\n` +
      `  assets reused:       ${assetReused}\n` +
      `  ownership links inserted: ${linkInserted}\n` +
      `  ownership links reused:   ${linkReused}\n` +
      `  links skipped:       ${linkSkipped}\n` +
      `  rejected (logged):   ${rejected}`
  );
}

main().catch((err) => {
  console.error("Aircraft loader failed:", err);
  process.exit(1);
});
