/**
 * Geocode loader — fill NULL asset coordinates from UK postcodes.
 *
 *   assets (real_estate, UK Land Registry rows, lat IS NULL)
 *     └─ Postcodes.io bulk lookup ─→ postcode_coords (cache)
 *          └─ UPDATE assets SET lat/lng WHERE lat IS NULL
 *
 * What this loader will NOT do
 *   - Never overwrite a coordinate. The UPDATE is guarded by
 *     `lat IS NULL`, so a surveyed or registry coordinate always wins over
 *     a postcode centroid.
 *   - Never geocode a non-postcode. Three independent guards, because FAA
 *     N-numbers alias to real postcodes: N194PJ (an aircraft tail number in
 *     this database) normalises to "N19 4PJ", a genuine London postcode.
 *     Geocoding it would pin a jet to Archway. So a location is treated as
 *     a postcode ONLY if (1) the asset is UK Land Registry real estate
 *     (OCOD rows carry the register's postcode by construction), AND (2) the
 *     first location segment contains a space (N-numbers never do), AND (3)
 *     it matches the UK postcode pattern. Anything else is skipped, counted,
 *     and left unmapped.
 *   - Never invent precision: a postcode centroid is what it is. The asset
 *     keeps its own source_url; the coordinate's citation lives in
 *     `postcode_coords.source_url` per postcode.
 *
 * Cost: one bulk request per 100 unknown postcodes, keyless, inside the
 * politeFetch 2/sec default bucket.
 *
 * Run: pnpm exec tsx src/lib/db/load_postcode_coords.ts [-- --dry-run]
 */

import { db } from "@/lib/db";
import { assets, postcodeCoords } from "./schema";
import { and, eq, isNull } from "drizzle-orm";
import { lookupPostcodes, postcodeSourceUrl } from "@/lib/providers/geocode/postcodes";
import { loadLocalEnv } from "@/lib/providers/uk/env";
import { formatRateLimitReport, rateLimitStats } from "@/lib/providers/http";

const MAX_ASSETS = Number(process.env.GEOCODE_MAX_ASSETS ?? 200);

// Only OCOD rows carry a Land Registry postcode in `location` by
// construction (load_uk_property.ts builds it as [postcode, district…]).
const UK_REGISTRY_SOURCE = "uk-land-registry";

// Normalised (no spaces, uppercase) for the cache key; the API accepts both.
const UK_POSTCODE = /^[A-Z]{1,2}\d[A-Z\d]?\d[A-Z]{2}$/;

function normalisePostcode(raw: string): string | null {
  const compact = raw.toUpperCase().replace(/\s+/g, "");
  return UK_POSTCODE.test(compact) ? compact : null;
}

function displayPostcode(compact: string): string {
  // Re-insert the space for the API query ("SW1A1AA" → "SW1A 1AA").
  return `${compact.slice(0, -3)} ${compact.slice(-3)}`;
}

async function main() {
  const dryRun = process.argv.includes("--dry-run");
  loadLocalEnv();

  console.log("=== Geocode: UK postcodes → asset coordinates ===");
  if (dryRun) console.log("(dry run — no writes)\n");

  const rows = await db
    .select({
      id: assets.id,
      name: assets.name,
      location: assets.location,
      sourceId: assets.sourceId,
    })
    .from(assets)
    .where(and(eq(assets.assetType, "real_estate"), isNull(assets.lat)))
    .limit(MAX_ASSETS)
    .execute();

  const withPostcode = new Map<string, { id: string; name: string }[]>();
  let skippedNotUkRegistry = 0;
  let skippedNoPostcode = 0;
  for (const r of rows) {
    // Guard 1: only UK Land Registry rows carry a postcode by construction.
    if (r.sourceId !== UK_REGISTRY_SOURCE) {
      skippedNotUkRegistry++;
      continue;
    }
    const first = (r.location ?? "").split(",")[0].trim();
    // Guard 2: a genuine postcode in our locations carries its space
    // ("SW1A 1AA"); an N-number never does ("N628TS").
    if (!first.includes(" ")) {
      skippedNoPostcode++;
      continue;
    }
    // Guard 3: the pattern itself.
    const pc = normalisePostcode(first);
    if (!pc) {
      skippedNoPostcode++;
      continue;
    }
    const list = withPostcode.get(pc);
    if (list) list.push({ id: r.id, name: r.name });
    else withPostcode.set(pc, [{ id: r.id, name: r.name }]);
  }
  console.log(
    `UK real-estate assets with NULL coords scanned: ${rows.length} · distinct ` +
      `postcodes: ${withPostcode.size} · skipped (not UK-registry): ` +
      `${skippedNotUkRegistry} · skipped (no postcode): ${skippedNoPostcode}`
  );

  if (dryRun) {
    for (const [pc, list] of [...withPostcode.entries()].slice(0, 20)) {
      console.log(`  ${displayPostcode(pc)} ← ${list.length} asset(s): ${list[0].name.slice(0, 60)}`);
    }
    return;
  }

  // Cache first: anything already resolved costs zero requests.
  const cached = await db.select().from(postcodeCoords).execute();
  const cache = new Map(cached.map((c) => [c.postcode, c]));
  const missing = [...withPostcode.keys()].filter((pc) => !cache.has(pc));
  console.log(`cache hits: ${withPostcode.size - missing.length} · to look up: ${missing.length}`);

  let lookedUp = 0;
  let unknownCount = 0;
  if (missing.length > 0) {
    const found = await lookupPostcodes(missing.map(displayPostcode));
    for (const [compact, list] of withPostcode) {
      if (cache.has(compact)) continue;
      const coord = found.get(displayPostcode(compact));
      lookedUp++;
      if (!coord) {
        unknownCount++;
        console.warn(`  ! ${displayPostcode(compact)}: unknown to Postcodes.io — left unmapped`);
        continue;
      }
      const sourceUrl = postcodeSourceUrl(coord.postcode);
      await db
        .insert(postcodeCoords)
        .values({
          postcode: compact,
          lat: coord.lat,
          lng: coord.lng,
          sourceUrl,
          createdAt: new Date().toISOString(),
        })
        .onConflictDoNothing()
        .run();
      cache.set(compact, {
        postcode: compact,
        lat: coord.lat,
        lng: coord.lng,
        sourceUrl,
        createdAt: "",
      });
      console.log(
        `  + ${coord.postcode} → (${coord.lat}, ${coord.lng}) · ${list.length} asset(s)`
      );
    }
  }

  // Fill NULLs only — the WHERE clause is the guarantee, not a comment.
  let filled = 0;
  for (const [compact, list] of withPostcode) {
    const coord = cache.get(compact);
    if (!coord) continue;
    for (const a of list) {
      const res = await db
        .update(assets)
        .set({ lat: coord.lat, lng: coord.lng })
        .where(and(eq(assets.id, a.id), isNull(assets.lat)))
        .run();
      filled += Number(res.changes ?? 0);
    }
  }

  const breached = rateLimitStats().filter((s) => s.breached);
  console.log("\n" + formatRateLimitReport());
  console.log(
    `\n=== Geocode summary ===\n` +
      `  distinct postcodes: ${withPostcode.size}\n` +
      `  postcodes looked up / unknown: ${lookedUp} / ${unknownCount}\n` +
      `  asset rows filled:  ${filled}\n` +
      `  skipped (not UK-registry): ${skippedNotUkRegistry}\n` +
      `  skipped (no postcode in location): ${skippedNoPostcode}`
  );
  if (breached.length > 0) {
    throw new Error(
      `Rate limit breached for: ${breached.map((b) => `${b.host} (${b.maxObservedInWindow}/${b.limit})`).join(", ")}`
    );
  }
}

main().catch((err) => {
  console.error("\nGeocode loader failed:", err);
  process.exit(1);
});
