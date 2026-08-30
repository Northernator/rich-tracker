/**
 * Slice 6 (D5): Physical Asset Graph from Real Registries
 *
 * Seeds the assets + ownership_links tables from curated CSV data sourced
 * from public registries:
 *   - FAA Aircraft Registry (n-number lookups)
 *   - UK Register of Overseas Entities
 *   - UK Land Registry / County Assessor portals
 *   - ICIJ Offshore Leaks (Pandora Papers, Paradise Papers)
 *
 * Rules:
 *   - Never fabricate an asset or ownership claim. If it's not in the CSV,
 *     it doesn't exist in the graph.
 *   - Every asset has a source_url pointing to the registry or report.
 *   - Every ownership link has a citation explaining the evidence.
 *   - Company stakes live in equity_holdings (not assets). This loader
 *     rejects asset_type='company'.
 *   - INSERT OR IGNORE on (name, asset_type, location) for assets.
 *   - INSERT OR IGNORE on (asset_id, person_id) for ownership_links.
 *
 * Schema note: assets = physical things only. equity_holdings = company stakes.
 */

import { join } from "path";
import { existsSync, readFileSync } from "fs";
import { db } from "@/lib/db";
import { eq, and } from "drizzle-orm";
import * as schema from "./schema";
import { createId } from "@paralleldrive/cuid2";

// ---------------------------------------------------------------------------
// Security — same allowlist as slice10/slice13
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
// CSV parsing (quote-aware)
// ---------------------------------------------------------------------------

function readCsv<T extends Record<string, string>>(filePath: string): T[] {
  if (!existsSync(filePath)) throw new Error(`Missing required CSV: ${filePath}`);
  const lines = readFileSync(filePath, "utf8").trim().split("\n");
  // Skip comment lines (starting with #) and blank lines to find the header
  let headerIdx = 0;
  while (headerIdx < lines.length && (lines[headerIdx].startsWith("#") || lines[headerIdx].trim() === "")) {
    headerIdx++;
  }
  if (headerIdx >= lines.length) throw new Error(`No header found in CSV: ${filePath}`);
  const headers = parseCsvLine(lines[headerIdx]);
  return lines.slice(headerIdx + 1).map((line) => {
    if (line.startsWith("#") || line.trim() === "") return null as unknown as T;
    const vals = parseCsvLine(line);
    const obj: Record<string, string> = {};
    headers.forEach((h, i) => (obj[h] = vals[i] ?? ""));
    return obj as unknown as T;
  }).filter((row): row is T => row !== null);
}

function parseCsvLine(line: string): string[] {
  const result: string[] = [];
  let current = "";
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') {
      inQuotes = !inQuotes;
    } else if (ch === "," && !inQuotes) {
      result.push(current.trim());
      current = "";
    } else {
      current += ch;
    }
  }
  result.push(current.trim());
  return result;
}

// ---------------------------------------------------------------------------
// Schema validation
// ---------------------------------------------------------------------------

// Company stakes belong in equity_holdings, NOT assets. This loader rejects
// 'company' type to keep the two models separate.
const VALID_ASSET_TYPES = new Set(["real_estate", "vessel", "aircraft", "art"]);
const VALID_CONFIDENCE = new Set(["high", "medium", "low"]);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  console.log("Slice 6 (D5): Physical asset graph from real registries");

  // 1. Resolve person IDs
  const slugToId = new Map<string, string>();
  for (const p of await db.select({ id: schema.people.id, slug: schema.people.slug }).from(schema.people)) {
    slugToId.set(p.slug, p.id);
  }
  console.log(`  Resolved ${slugToId.size} people`);

  // 2. Resolve source IDs
  const sourceByName = new Map<string, string>();
  for (const s of await db.select({ id: schema.sources.id, name: schema.sources.name }).from(schema.sources)) {
    sourceByName.set(s.name, s.id);
  }
  console.log(`  Resolved ${sourceByName.size} sources`);

  // 3. Load assets from CSV
  const csvPath = join(process.cwd(), "data", "curated", "assets.csv");
  const assetRows = readCsv<Record<string, string>>(csvPath);
  console.log(`  Loaded ${assetRows.length} asset rows from CSV`);

  let assetInserted = 0;
  let assetSkipped = 0;
  const nameToId = new Map<string, string>(); // asset name → DB id

  for (const row of assetRows) {
    const personSlug = row.person_slug?.trim() ?? "";
    const assetType = row.asset_type?.trim() ?? "";
    const name = row.name?.trim() ?? "";
    const description = row.description?.trim() ?? null;
    const location = row.location?.trim() ?? null;
    const lat = row.lat ? parseFloat(row.lat) : null;
    const lng = row.lng ? parseFloat(row.lng) : null;
    // The CSV column holds DOLLARS. The DB column is cents. Previously the
    // CSV header said "_cents" while carrying dollars, so a Boeing 747-8
    // was stored as $4M instead of $400M.
    const valueUsd = row.estimated_value_usd ? parseInt(row.estimated_value_usd, 10) : null;
    const valueCents = valueUsd != null && Number.isFinite(valueUsd) ? valueUsd * 100 : null;
    const sourceUrl = row.source_url?.trim() ?? "";
    const sourceName = row.source_name?.trim() ?? "";
    const confidence = row.confidence?.trim() ?? "low";
    const asOf = row.as_of?.trim() ?? null;

    // Validate
    if (!VALID_ASSET_TYPES.has(assetType)) {
      console.warn(`  ✗ Skipped ${name}: invalid asset_type "${assetType}" — company stakes go in equity_holdings`);
      assetSkipped++;
      continue;
    }
    if (!VALID_CONFIDENCE.has(confidence)) {
      console.warn(`  ✗ Skipped ${name}: invalid confidence "${confidence}"`);
      assetSkipped++;
      continue;
    }
    if (!sourceUrl) {
      console.warn(`  ✗ Skipped ${name}: no source_url`);
      assetSkipped++;
      continue;
    }

    assertExternalUrl(sourceUrl, `asset ${name}`);

    // Check person exists
    const personId = slugToId.get(personSlug);
    if (!personId) {
      console.warn(`  ✗ Skipped ${name}: person "${personSlug}" not found`);
      assetSkipped++;
      continue;
    }

    // Check source exists (or skip if not)
    const sourceId = sourceByName.get(sourceName);

    // Dedupe: find existing asset with same (name, asset_type, location)
    const existing = await db
      .select({ id: schema.assets.id })
      .from(schema.assets)
      .where(and(
        eq(schema.assets.name, name),
        eq(schema.assets.assetType, assetType),
        eq(schema.assets.location, location ?? ""),
      ))
      .limit(1)
      .execute();

    let assetId: string;
    if (existing.length > 0) {
      assetId = existing[0].id;
      console.log(`  → ${name} (${assetType}, ${confidence}) [reused]`);
    } else {
      assetId = createId();
      try {
        await db
          .insert(schema.assets)
          .values({
            id: assetId,
            name,
            assetType,
            description,
            location,
            lat: lat ?? undefined,
            lng: lng ?? undefined,
            estimatedValueCents: valueCents ?? undefined,
            sourceId: sourceId ?? undefined,
            sourceUrl,
            createdAt: new Date().toISOString(),
          })
          .onConflictDoNothing()
          .run();
        assetInserted++;
        console.log(`  ✓ ${name} (${assetType}, ${confidence})`);
      } catch (err) {
        console.warn(`  ✗ Insert failed for ${name}: ${err}`);
        assetSkipped++;
      }
    }
    nameToId.set(`${personSlug}|${name}|${assetType}`, assetId);
    await sleep(50);
  }

  // 4. Load ownership links from CSV
  const ownPath = join(process.cwd(), "data", "curated", "ownership.csv");
  const ownRows = readCsv<Record<string, string>>(ownPath);
  console.log(`\n  Loaded ${ownRows.length} ownership rows from CSV`);

  let ownInserted = 0;
  let ownSkipped = 0;

  for (const row of ownRows) {
    const personSlug = row.person_slug?.trim() ?? "";
    const assetName = row.asset_name?.trim() ?? "";
    const ownershipPct = row.ownership_pct ? parseFloat(row.ownership_pct) : null;
    const confidence = row.confidence?.trim() ?? "low";
    const citation = row.citation?.trim() ?? null;
    const sourceUrl = row.source_url?.trim() ?? "";
    const sourceName = row.source_name?.trim() ?? "";
    const asOf = row.as_of?.trim() ?? null;

    if (!VALID_CONFIDENCE.has(confidence)) {
      console.warn(`  ✗ Skipped ${personSlug}/${assetName}: invalid confidence "${confidence}"`);
      ownSkipped++;
      continue;
    }
    if (!sourceUrl) {
      console.warn(`  ✗ Skipped ${personSlug}/${assetName}: no source_url`);
      ownSkipped++;
      continue;
    }

    assertExternalUrl(sourceUrl, `ownership ${assetName}`);

    const personId = slugToId.get(personSlug);
    if (!personId) {
      console.warn(`  ✗ Skipped ${personSlug}/${assetName}: person not found`);
      ownSkipped++;
      continue;
    }

    // Match on (person, asset name). The previous version fell back to
    // substring matching and took the first hit, which attached 17 different
    // billionaires to "Bel Air Estate". No exact match now means skip.
    let assetId: string | null = null;
    for (const [key, aid] of nameToId) {
      const [kslug, kname] = key.split("|");
      if (kslug === personSlug && kname === assetName) {
        assetId = aid;
        break;
      }
    }

    if (!assetId) {
      console.warn(`  \u2717 Skipped ${personSlug}/${assetName}: no asset owned by ${personSlug} with that exact name`);
      ownSkipped++;
      continue;
    }

    const sourceId = sourceByName.get(sourceName);

    try {
      await db
        .insert(schema.ownershipLinks)
        .values({
          id: createId(),
          assetId,
          personId,
          ownershipPct: ownershipPct ?? undefined,
          confidence,
          citation,
          sourceId: sourceId ?? undefined,
          sourceUrl,
          asOf: asOf ?? undefined,
          createdAt: new Date().toISOString(),
        })
        .onConflictDoNothing()
        .run();
      ownInserted++;
      console.log(`  ✓ ${personSlug} → ${assetName} (${confidence}${ownershipPct ? ` ${ownershipPct}%` : ""})`);
    } catch (err) {
      // Duplicate — same asset+person already linked
      const exists = await db
        .select({ id: schema.ownershipLinks.id })
        .from(schema.ownershipLinks)
        .where(and(eq(schema.ownershipLinks.assetId, assetId), eq(schema.ownershipLinks.personId, personId)))
        .limit(1)
        .execute();
      if (exists.length === 0) {
        console.warn(`  ✗ Insert failed for ${personSlug}/${assetName}: ${err}`);
        ownSkipped++;
      } else {
        console.log(`  ~ ${personSlug} → ${assetName} [already exists]`);
      }
    }
    await sleep(50);
  }

  // 5. Summary
  console.log(`\n— Summary —`);
  console.log(`  Assets inserted: ${assetInserted}`);
  console.log(`  Assets skipped:  ${assetSkipped}`);
  console.log(`  Ownership links inserted: ${ownInserted}`);
  console.log(`  Ownership links skipped:  ${ownSkipped}`);

  const assetCount = await db.$count(schema.assets);
  const ownCount = await db.$count(schema.ownershipLinks);
  console.log(`  Assets in DB:    ${assetCount}`);
  console.log(`  Ownership links: ${ownCount}`);
  console.log("\nDone.");
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
