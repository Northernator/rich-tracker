/**
 * Chunk 11 — ICIJ Offshore Leaks: the moat.
 *
 *   person (matched ICIJ officer)
 *      └─ OFFICER_OF → entity (shell company)
 *           └─ RELATED_ENTITY → entity (another offshore entity)
 *                └─ … (depth capped at 6 by the recursive resolver)
 *
 * Reads the RAW ICIJ CSV export (ODbL) into staging tables verbatim, then
 * resolves a person-centric ownership graph into `offshore_edges`, one hop per
 * row so confidence MULTIPLIES along the path (the Chunk 10 model).
 *
 * Honesty rules (non-negotiable):
 *   - Never fabricate. If no real capture is present and --download is not (or
 *     fails), this loader THROWS — it does not invent rows. An empty table is
 *     a valid, honest result; shipping zero rows beats shipping invented ones.
 *   - Loaders are additive. Every insert is onConflictDoNothing on a natural
 *     key. A re-run changes nothing.
 *   - Every `offshore_edges` row carries a resolvable source_url to the ICIJ
 *     node page that evidences the specific hop.
 *   - Officer→person matching is STRICT: identifier first, then name + birth
 *     year, then skip. ICIJ officers carry no birth year and no shared
 *     identifier with our roster, so the only branch that can fire is name-only
 *     — recorded at 0.5, which lands the chain below the 0.5 floor and renders
 *     as a possible link, never as a finding.
 *
 * Run:
 *   npm run offshore:icij [-- --dir=data/raw/icij]
 *   npm run offshore:icij -- --download          # fetch the official ODbL CSVs
 */

import { db } from "@/lib/db";
import {
  icijEntities,
  icijOfficers,
  icijRelationships,
  icijOfficerMatches,
  offshoreEdges,
  sources,
  people,
} from "./schema";
import { createId } from "@paralleldrive/cuid2";
import { join } from "node:path";
import {
  ICIJ_SOURCE_ID,
  discoverCapture,
  readCaptureCsv,
  headerOf,
  readEntityRow,
  readOfficerRow,
  readRelationshipRow,
  nodeUrl,
  downloadIfRequested,
  type IcijCapture,
} from "@/lib/providers/icij";
import { eq } from "drizzle-orm";

const MAX_MATCHED_OFFICERS = 200;
const MAX_SEED_ENTITIES = 5000;
const MAX_EDGES = 200_000;
const BATCH = 500;

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

interface Cli {
  dir?: string;
  download: boolean;
  dryRun: boolean;
  maxOfficers: number;
  maxEntities: number;
  maxEdges: number;
}

function parseCli(argv: string[]): Cli {
  const cli: Cli = {
    download: false,
    dryRun: false,
    maxOfficers: Number(process.env.ICIJ_MAX_OFFICERS ?? MAX_MATCHED_OFFICERS),
    maxEntities: Number(process.env.ICIJ_MAX_ENTITIES ?? MAX_SEED_ENTITIES),
    maxEdges: Number(process.env.ICIJ_MAX_EDGES ?? MAX_EDGES),
  };
  for (const arg of argv) {
    if (arg.startsWith("--dir=")) cli.dir = arg.slice("--dir=".length);
    else if (arg === "--download") cli.download = true;
    else if (arg === "--dry-run") cli.dryRun = true;
    else if (arg.startsWith("--max-officers=")) cli.maxOfficers = Number(arg.split("=")[1]);
    else if (arg.startsWith("--max-entities=")) cli.maxEntities = Number(arg.split("=")[1]);
    else if (arg.startsWith("--max-edges=")) cli.maxEdges = Number(arg.split("=")[1]);
  }
  if (!Number.isFinite(cli.maxOfficers) || cli.maxOfficers <= 0) cli.maxOfficers = MAX_MATCHED_OFFICERS;
  if (!Number.isFinite(cli.maxEntities) || cli.maxEntities <= 0) cli.maxEntities = MAX_SEED_ENTITIES;
  if (!Number.isFinite(cli.maxEdges) || cli.maxEdges <= 0) cli.maxEdges = MAX_EDGES;
  return cli;
}

// ---------------------------------------------------------------------------
// Name matching (mirrors chunk 10's normalisation)
// ---------------------------------------------------------------------------

const TITLES = /\b(mr|mrs|ms|miss|dr|sir|lord|lady|prof|hon|capt|col|rev)\b\.?/g;
function normaliseName(s: string): string {
  return s
    .toLowerCase()
    .replace(TITLES, " ")
    .replace(/[^a-z0-9 ]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}
function nameKey(s: string): string {
  return normaliseName(s)
    .split(" ")
    .filter(Boolean)
    .sort()
    .join(" ");
}

// ---------------------------------------------------------------------------
// Edge confidence by ICIJ relationship type
// ---------------------------------------------------------------------------

/** 0 means "not a person-chain hop" — e.g. REGISTERED_ADDRESS points at an
 * address leaf and is not followed. */
function relConfidence(relType: string): number {
  switch (relType) {
    case "OFFICER_OF":
      return 0.8; // an entity acting as officer of another entity
    case "RELATED_ENTITY":
      return 0.7;
    case "INTERMEDIARY_OF":
      return 0.7;
    case "SHAREHOLDER_OF":
      return 0.8;
    case "BENEFICIARY_OF":
      return 0.8;
    case "UNDERLYING":
      return 0.6;
    case "REGISTERED_ADDRESS":
      return 0; // address leaf — not a chain hop
    default:
      if (relType.startsWith("NOMINEE_")) return 0.6;
      return 0.6;
  }
}

// ---------------------------------------------------------------------------
// Sources row (ODbL + no-wrongdoing). Migration seeds it; this fills gaps.
// ---------------------------------------------------------------------------

async function ensureSources(): Promise<void> {
  const existing = await db
    .select({ id: sources.id, attribution: sources.attribution, license: sources.license })
    .from(sources)
    .where(eq(sources.id, ICIJ_SOURCE_ID))
    .limit(1)
    .execute();
  if (existing.length === 0) {
    await db
      .insert(sources)
      .values({
        id: ICIJ_SOURCE_ID,
        name: "ICIJ Offshore Leaks Database",
        url: "https://www.icij.org/investigations/offshore-leaks/",
        license: "Open Database License (ODbL) — attribution and share-alike required",
        attribution:
          "Data from the ICIJ Offshore Leaks Database, made available under the Open Database " +
          "License (ODbL). Any rights in individual contents of the database are licensed under " +
          "ODbL by the International Consortium of Investigative Journalists. The presence of a " +
          "person or entity here reflects only what ICIJ published; it does not imply wrongdoing.",
        createdAt: new Date().toISOString(),
      })
      .onConflictDoNothing()
      .run();
  } else if (!existing[0].attribution || !existing[0].license) {
    await db
      .update(sources)
      .set({
        attribution:
          "Data from the ICIJ Offshore Leaks Database, made available under the Open Database " +
          "License (ODbL). The presence of a person or entity here reflects only what ICIJ " +
          "published; it does not imply wrongdoing.",
        license: "Open Database License (ODbL) — attribution and share-alike required",
      })
      .where(eq(sources.id, ICIJ_SOURCE_ID))
      .run();
  }
}

// ---------------------------------------------------------------------------
// Staging load (raw, additive)
// ---------------------------------------------------------------------------

async function insertBatched<T>(rows: T[], insert: (vals: T[]) => unknown): Promise<void> {
  for (let i = 0; i < rows.length; i += BATCH) {
    await insert(rows.slice(i, i + BATCH));
  }
}

interface LoadStagingResult {
  entityCount: number;
  officerCount: number;
  relationshipCount: number;
  /** node_id → display name, for building edge labels without re-querying. */
  entityName: Map<string, string>;
}

async function loadStaging(capture: IcijCapture): Promise<LoadStagingResult> {
  const entityName = new Map<string, string>();
  let entityCount = 0;
  let officerCount = 0;
  let relationshipCount = 0;

  // --- Entities -----------------------------------------------------------
  if (capture.entities) {
    console.log(`  staging entities from ${capture.entities} …`);
    const gen = readCaptureCsv(capture.entities);
    const h = headerOf(gen);
    const rows: (typeof icijEntities.$inferInsert)[] = [];
    for (const cells of gen) {
      const r = readEntityRow(h, cells);
      if (!r) continue;
      entityName.set(r.nodeId, r.name ?? r.nodeId);
      rows.push({
        nodeId: r.nodeId,
        name: r.name,
        jurisdiction: r.jurisdiction,
        jurisdictionDescription: r.jurisdictionDescription,
        companyType: r.companyType,
        address: r.address,
        sourceId: r.sourceId,
        validUntil: r.validUntil,
        countryCodes: r.countryCodes,
        status: r.status,
        note: r.note,
        raw: JSON.stringify(r),
        loadedAt: new Date().toISOString(),
      });
      entityCount++;
      if (rows.length >= BATCH) {
        await db.insert(icijEntities).values(rows).onConflictDoNothing().run();
        rows.length = 0;
      }
    }
    if (rows.length) await db.insert(icijEntities).values(rows).onConflictDoNothing().run();
    console.log(`    entities: ${entityCount}`);
  }

  // --- Officers (and match against roster as we go) ----------------------
  if (capture.officers) {
    console.log(`  staging officers from ${capture.officers} …`);
    const gen = readCaptureCsv(capture.officers);
    const h = headerOf(gen);
    const rows: (typeof icijOfficers.$inferInsert)[] = [];
    for (const cells of gen) {
      const r = readOfficerRow(h, cells);
      if (!r) continue;
      rows.push({
        nodeId: r.nodeId,
        name: r.name,
        countryCodes: r.countryCodes,
        jurisdiction: r.jurisdiction,
        jurisdictionDescription: r.jurisdictionDescription,
        sourceId: r.sourceId,
        validUntil: r.validUntil,
        status: r.status,
        note: r.note,
        raw: JSON.stringify(r),
        loadedAt: new Date().toISOString(),
      });
      officerCount++;
      if (rows.length >= BATCH) {
        await db.insert(icijOfficers).values(rows).onConflictDoNothing().run();
        rows.length = 0;
      }
    }
    if (rows.length) await db.insert(icijOfficers).values(rows).onConflictDoNothing().run();
    console.log(`    officers: ${officerCount}`);
  }

  // --- Relationships ------------------------------------------------------
  if (capture.relationships) {
    console.log(`  staging relationships from ${capture.relationships} …`);
    const gen = readCaptureCsv(capture.relationships);
    const h = headerOf(gen);
    const rows: (typeof icijRelationships.$inferInsert)[] = [];
    for (const cells of gen) {
      const r = readRelationshipRow(h, cells);
      if (!r) continue;
      rows.push({
        startId: r.startId,
        endId: r.endId,
        relType: r.relType,
        sourceId: r.sourceId,
        validUntil: r.validUntil,
        status: r.status,
        note: r.note,
        raw: JSON.stringify(r),
        loadedAt: new Date().toISOString(),
      });
      relationshipCount++;
      if (rows.length >= BATCH) {
        await db.insert(icijRelationships).values(rows).onConflictDoNothing().run();
        rows.length = 0;
      }
    }
    if (rows.length) await db.insert(icijRelationships).values(rows).onConflictDoNothing().run();
    console.log(`    relationships: ${relationshipCount}`);
  }

  return { entityCount, officerCount, relationshipCount, entityName };
}

// ---------------------------------------------------------------------------
// Officer → person matching (strict)
// ---------------------------------------------------------------------------

interface MatchRecord {
  personId: string;
  personName: string;
  slug: string;
  confidence: number;
  basis: string;
}

async function matchOfficers(
  cli: Cli
): Promise<{ matches: Map<string, MatchRecord>; inserted: number }> {
  const rosterRows = (await db
    .select({ id: people.id, slug: people.slug, fullName: people.fullName, bornYear: people.bornYear })
    .from(people)
    .execute()) as Array<{ id: string; slug: string; fullName: string; bornYear: number | null }>;

  const roster = new Map<string, Array<{ id: string; slug: string; fullName: string; bornYear: number | null }>>();
  for (const p of rosterRows) {
    const key = nameKey(p.fullName);
    if (!key) continue;
    const list = roster.get(key);
    if (list) list.push(p);
    else roster.set(key, [p]);
  }
  console.log(`  roster indexed: ${rosterRows.length} people\n`);

  const officers = (await db
    .select({ nodeId: icijOfficers.nodeId, name: icijOfficers.name })
    .from(icijOfficers)
    .execute()) as Array<{ nodeId: string; name: string | null }>;

  const matches = new Map<string, MatchRecord>();
  const toInsert: (typeof icijOfficerMatches.$inferInsert)[] = [];
  let skipped = 0;

  for (const o of officers) {
    if (!o.name) {
      skipped++;
      continue;
    }
    const candidates = roster.get(nameKey(o.name));
    if (!candidates || candidates.length === 0) {
      skipped++;
      continue;
    }
    // Strict order: identifier → name + birth year → name-only.
    // ICIJ officers carry neither a shared identifier nor a birth year, so the
    // only reachable branch is name-only, recorded at 0.5 (possible link).
    const match = candidates[0];
    const basis = "name-only";
    const confidence = 0.5;
    matches.set(o.nodeId, {
      personId: match.id,
      personName: match.fullName,
      slug: match.slug,
      confidence,
      basis,
    });
    toInsert.push({
      officerNodeId: o.nodeId,
      personId: match.id,
      basis,
      confidence,
      matchedName: o.name,
      createdAt: new Date().toISOString(),
    });
    if (matches.size >= cli.maxOfficers) break;
  }

  if (!cli.dryRun) {
    await insertBatched(toInsert, (vals) =>
      db.insert(icijOfficerMatches).values(vals).onConflictDoNothing().run()
    );
  }
  console.log(
    `  officer→person matches: ${matches.size} (inserted ${toInsert.length}, skipped ${skipped})\n`
  );
  for (const [nodeId, m] of [...matches.entries()].slice(0, 20)) {
    console.log(`    ${nodeId} → ${m.personName} [${m.slug}] (${m.basis}, ${m.confidence})`);
  }
  if (matches.size > 20) console.log(`    … and ${matches.size - 20} more`);

  return { matches, inserted: toInsert.length };
}

// ---------------------------------------------------------------------------
// Build the resolved offshore graph
// ---------------------------------------------------------------------------

interface BuildResult {
  officerEdges: number;
  entityEdges: number;
  seedEntities: number;
}

async function buildEdges(
  matches: Map<string, MatchRecord>,
  entityName: Map<string, string>,
  cli: Cli,
  capture: IcijCapture
): Promise<BuildResult> {
  let officerEdges = 0;
  let entityEdges = 0;
  const seedEntities = new Set<string>();
  const edgeRows: (typeof offshoreEdges.$inferInsert)[] = [];

  if (!capture.relationships) {
    return { officerEdges, entityEdges, seedEntities: 0 };
  }

  const gen = readCaptureCsv(capture.relationships);
  const h = headerOf(gen);

  for (const cells of gen) {
    const r = readRelationshipRow(h, cells);
    if (!r) continue;

    // Hop 1: matched officer → entity
    if (r.relType === "OFFICER_OF" && matches.has(r.startId)) {
      const m = matches.get(r.startId)!;
      const entityLabel = entityName.get(r.endId) ?? r.endId;
      edgeRows.push({
        id: createId(),
        edgeType: "officer_of_entity",
        fromEntityType: "person",
        fromEntityId: m.personId,
        fromLabel: m.personName,
        toEntityType: "entity",
        toEntityId: r.endId,
        toLabel: entityLabel,
        confidence: m.confidence,
        sourceId: ICIJ_SOURCE_ID,
        sourceUrl: nodeUrl(r.startId),
        detail: JSON.stringify({ relType: r.relType, leak: r.sourceId, officerNodeId: r.startId }),
        asOf: r.validUntil ?? null,
        createdAt: new Date().toISOString(),
      });
      seedEntities.add(r.endId);
      officerEdges++;
      if (seedEntities.size >= cli.maxEntities) break;
    }
  }

  // Hop 2+: entity → entity (full subgraph among known entities, capped)
  if (seedEntities.size > 0 && entityEdges + officerEdges < cli.maxEdges) {
    const gen2 = readCaptureCsv(capture.relationships);
    const h2 = headerOf(gen2);
    for (const cells of gen2) {
      const r = readRelationshipRow(h2, cells);
      if (!r) continue;
      const conf = relConfidence(r.relType);
      if (conf <= 0) continue; // REGISTERED_ADDRESS etc. — not a chain hop
      const startName = entityName.get(r.startId);
      const endName = entityName.get(r.endId);
      if (!startName || !endName) continue; // both ends must be real entities
      // Bound the graph to components touching a matched person's entity.
      if (!seedEntities.has(r.startId) && !seedEntities.has(r.endId)) continue;
      edgeRows.push({
        id: createId(),
        edgeType: "entity_relationship",
        fromEntityType: "entity",
        fromEntityId: r.startId,
        fromLabel: startName,
        toEntityType: "entity",
        toEntityId: r.endId,
        toLabel: endName,
        confidence: conf,
        sourceId: ICIJ_SOURCE_ID,
        sourceUrl: nodeUrl(r.startId),
        detail: JSON.stringify({ relType: r.relType, leak: r.sourceId }),
        asOf: r.validUntil ?? null,
        createdAt: new Date().toISOString(),
      });
      entityEdges++;
      if (officerEdges + entityEdges >= cli.maxEdges) break;
    }
  }

  if (!cli.dryRun) {
    await insertBatched(edgeRows, (vals) =>
      db.insert(offshoreEdges).values(vals).onConflictDoNothing().run()
    );
  } else {
    console.log("  (dry run — no offshore_edges written)");
  }

  return { officerEdges, entityEdges, seedEntities: seedEntities.size };
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  const cli = parseCli(process.argv.slice(2));

  console.log("=== Chunk 11: ICIJ Offshore Leaks — entity resolution ===");
  console.log(
    `caps: max-officers=${cli.maxOfficers} max-entities=${cli.maxEntities} ` +
      `max-edges=${cli.maxEdges}${cli.dryRun ? " (dry run)" : ""}\n`
  );

  // Acquire a REAL capture. No capture + no download = throw, never fabricate.
  let capture = cli.dir ? discoverCapture(cli.dir) : discoverCapture();
  if (!capture && cli.download) {
    console.log("  no local capture — attempting download (ODbL) …");
    capture = await downloadIfRequested(cli.dir ?? join(process.cwd(), "data", "raw", "icij"));
  }
  if (!capture) {
    throw new Error(
      "No ICIJ raw capture found in data/raw/icij/ and --download not used (or it failed). " +
        "Place the official ODbL CSVs there — nodes-entities.csv, nodes-officers.csv, " +
        "relationships.csv — or run with --download. Leaving staging empty: not fabricating."
    );
  }
  console.log(
    `capture: ${capture.dir}\n` +
      `  entities:     ${capture.entities ?? "(none)"}\n` +
      `  officers:     ${capture.officers ?? "(none)"}\n` +
      `  relationships: ${capture.relationships ?? "(none)"}\n`
  );

  await ensureSources();

  if (cli.dryRun) {
    const staged = await loadStaging(capture);
    console.log(
      `\nDRY RUN: staged ${staged.entityCount} entities, ${staged.officerCount} officers, ` +
        `${staged.relationshipCount} relationships.`
    );
    const { matches } = await matchOfficers(cli);
    console.log(`  would resolve ${matches.size} officer→person matches.`);
    return;
  }

  const staged = await loadStaging(capture);
  const { matches } = await matchOfficers(cli);
  const built = await buildEdges(matches, staged.entityName, cli, capture);

  console.log(
    `\n=== Chunk 11 summary ===\n` +
      `  staged entities / officers / relationships: ${staged.entityCount} / ${staged.officerCount} / ${staged.relationshipCount}\n` +
      `  officer→person matches:                     ${matches.size}\n` +
      `  seed entities (from matched officers):      ${built.seedEntities}\n` +
      `  offshore_edges: officer_of_entity =         ${built.officerEdges}\n` +
      `  offshore_edges: entity_relationship =       ${built.entityEdges}\n` +
      `  total resolved hops:                        ${built.officerEdges + built.entityEdges}`
  );
  if (matches.size === 0) {
    console.log(
      "\n  NOTE: no ICIJ officer matched a roster person by name. With no shared identifier and no " +
        "birth year in the ICIJ officer data, that is the expected strict outcome — the table is " +
        "honestly empty. Shipping zero rows beats shipping invented ones."
    );
  }
}

main().catch((err) => {
  console.error("\nICIJ offshore loader failed:", err.message);
  process.exit(1);
});
