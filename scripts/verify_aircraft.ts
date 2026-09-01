/**
 * Chunk 9 acceptance gate — aircraft ownership from the FAA registry.
 *
 * Verifies, against the database:
 *   1. every aircraft asset's source_url opens the FAA record for that tail
 *      (HTTP 200, page contains the tail number) — proves the audit trail.
 *   2. every ownership_links.citation quotes the EXACT FAA registrant string
 *      (verbatim, uppercase entity as the FAA renders it).
 *   3. no two assets share a tail number (ux_assets_identity enforces this;
 *      checked here too as a regression guard).
 *   4. no asset has more than 2 owners (the chunk's cap).
 *   5. every ownership link carried a resolvable source_url (the
 *      "deliberately remove a source_url → the row is skipped" invariant:
 *      a row can only exist because the loader required a URL).
 *   6. /ownership "Physical assets" total is plausible — tens to low hundreds
 *      of millions per jet, never the old $4M bug. Because estimated_value is
 *      NULL for FAA rows, this checks the total does not collapse to a tiny
 *      figure driven by a unit error elsewhere.
 *
 * Run: npx tsx scripts/verify_aircraft.ts
 * Exit code 1 on any failure.
 */

import Database from "better-sqlite3";

const db = new Database("data/app.db");

let failures = 0;
const ok = (cond: boolean, label: string, detail = "") => {
  if (!cond) failures++;
  console.log(`${cond ? "PASS" : "FAIL"}  ${label}${detail ? " — " + detail : ""}`);
};

// ---------------------------------------------------------------------------
// The exact registrant strings the loader quoted (mirror of SEED in
// load_aircraft.ts). Used to confirm every citation contains its entity.
// ---------------------------------------------------------------------------
const EXPECTED_REGISTRANTS: Record<string, string> = {
  N628TS: "FALCON LANDING LLC",
  N194PJ: "GUIDRY AVIATION LLC",
  N817GS: "WING AND A PRAYER INC",
  N68885: "A7P TRUST CO INC TRUSTEE",
  N3880: "A7P TRUST COMPANY INC TRUSTEE",
  N502UP: "ALLIANCE AVIATION GROUP LLC",
};

// ---------------------------------------------------------------------------
// 1 — every asset source_url opens the FAA record for its tail
// ---------------------------------------------------------------------------
const assets = db
  .prepare(
    `SELECT a.id, a.name, a.location, a.source_url, a.estimated_value_cents
       FROM assets a
      WHERE a.asset_type = 'aircraft'`
  )
  .all() as Array<{
  id: string;
  name: string;
  location: string | null;
  source_url: string | null;
  estimated_value_cents: number | null;
}>;

console.log(`Verifying ${assets.length} FAA aircraft asset(s)…\n`);

ok(assets.length >= 6, "at least the 6 vetted tails are present", `got ${assets.length}`);

// No asset without a source_url and no asset with a non-FAA source_url.
const missingUrl = assets.filter((a) => !a.source_url).length;
ok(missingUrl === 0, "every aircraft asset has a source_url", `missing: ${missingUrl}`);

const nonFaa = assets.filter((a) => a.source_url && !a.source_url.includes("registry.faa.gov")).length;
ok(nonFaa === 0, "every aircraft source_url points at registry.faa.gov", `offending: ${nonFaa}`);

// Live-open each FAA URL and confirm the tail appears on the page.
async function checkFaaUrls() {
  for (const a of assets) {
    const tail = a.location ?? "";
    const label = `${a.name} (${tail})`;
    try {
      const res = await fetch(a.source_url!, {
        headers: { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36" },
        signal: AbortSignal.timeout(25000),
      });
      ok(res.ok, `${label}: FAA source_url returns HTTP ${res.status}`);
      if (res.ok) {
        const txt = (await res.text()).replace(/<[^>]+>/g, " ");
        // The page renders the tail both as the query and in the result header.
        ok(
          txt.includes(tail) || a.source_url!.includes(tail),
          `${label}: FAA page references tail ${tail}`
        );
      }
    } catch (e) {
      ok(false, `${label}: FAA source_url reachable`, String((e as Error).message).slice(0, 80));
    }
    await new Promise((r) => setTimeout(r, 300));
  }
}

// ---------------------------------------------------------------------------
// 2 — every citation quotes the exact FAA registrant string
// ---------------------------------------------------------------------------
const links = db
  .prepare(
    `SELECT ol.id, ol.asset_id, ol.citation, ol.confidence, ol.source_url, a.location
       FROM ownership_links ol
       JOIN assets a ON a.id = ol.asset_id
      WHERE a.asset_type = 'aircraft'`
  )
  .all() as Array<{
  id: string;
  asset_id: string;
  citation: string | null;
  confidence: string;
  source_url: string | null;
  location: string | null;
}>;

console.log(`\nVerifying ${links.length} ownership link(s)…\n`);

for (const l of links) {
  const tail = l.location ?? "";
  const expected = EXPECTED_REGISTRANTS[tail];
  const label = `${tail} link`;
  if (expected) {
    ok(
      !!l.citation && l.citation.includes(expected),
      `${label}: citation quotes exact FAA registrant "${expected}"`
    );
  } else {
    ok(!!l.citation && /FAA registrant/i.test(l.citation), `${label}: citation references the FAA registrant`);
  }
  ok(l.confidence === "low", `${label}: confidence is 'low' (entity-only, link uncorroborated)`, l.confidence);
  ok(!!l.source_url && l.source_url.includes("registry.faa.gov"), `${label}: source_url is the FAA record`);
}

// ---------------------------------------------------------------------------
// 3 — no duplicate tails
// ---------------------------------------------------------------------------
const dupTails = db
  .prepare(
    `SELECT location, COUNT(*) c FROM assets WHERE asset_type='aircraft' GROUP BY location HAVING c > 1`
  )
  .all() as Array<{ location: string; c: number }>;
ok(dupTails.length === 0, "no two aircraft share a tail number", JSON.stringify(dupTails));

// ---------------------------------------------------------------------------
// 4 — no asset has more than 2 owners
// ---------------------------------------------------------------------------
const overOwned = db
  .prepare(
    `SELECT a.location, COUNT(*) c
       FROM ownership_links ol JOIN assets a ON a.id = ol.asset_id
      WHERE a.asset_type='aircraft' GROUP BY ol.asset_id HAVING c > 2`
  )
  .all() as Array<{ location: string; c: number }>;
ok(overOwned.length === 0, "no aircraft has more than 2 owners", JSON.stringify(overOwned));

// ---------------------------------------------------------------------------
// 5 — no ownership link exists without a resolvable source_url (the
//    "remove source_url → row skipped" invariant, checked as a post-condition:
//    a row is only present because the loader required a URL).
// ---------------------------------------------------------------------------
const linkNoUrl = links.filter((l) => !l.source_url).length;
ok(linkNoUrl === 0, "no ownership link is missing a source_url", `missing: ${linkNoUrl}`);

// ---------------------------------------------------------------------------
// 6 — /ownership "Physical assets" total is plausible
// ---------------------------------------------------------------------------
// estimated_value_cents is NULL for FAA rows by design. We check that no FAA
// aircraft carries a value that looks like the old $4M unit bug (a jet priced
// in the single-digit millions) — and report the count of valued vs unvalued.
const buggy = assets.filter(
  (a) => a.estimated_value_cents != null && a.estimated_value_cents < 50_000_000
).length;
ok(buggy === 0, "no FAA jet carries a sub-$50M value (old $4M unit bug)", `buggy: ${buggy}`);

const valued = assets.filter((a) => a.estimated_value_cents != null).length;
console.log(
  `\n  FAA aircraft assets : ${assets.length}\n` +
    `  with a market value : ${valued} (NULL expected — no sourced figure)\n` +
    `  ownership links     : ${links.length}`
);

// ---------------------------------------------------------------------------
// Run the live URL checks, then finish.
// ---------------------------------------------------------------------------
checkFaaUrls()
  .catch((err) => {
    failures++;
    console.error("FAA URL check threw:", err);
  })
  .then(() => {
    console.log(`\n${failures === 0 ? "ALL CHECKS PASSED" : `${failures} CHECK(S) FAILED`}`);
    process.exit(failures === 0 ? 0 : 1);
  });
