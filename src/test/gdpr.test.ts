/**
 * GDPR gate test — Chunk 14 acceptance criterion:
 *   "a query for a non-public-figure returns nothing."
 *
 * We insert a TEMPORARY private individual (is_public_figure = 0) wired into the
 * ownership chain, the offshore graph, and a valuation snapshot — exactly the
 * shape of data that would, if the gate were broken, surface on a public page.
 * We then assert every person-facing loader and the canonical public-figure
 * query exclude it. All test rows are deleted on the way out, success or
 * failure, so this never leaves residue in data/app.db.
 *
 * Run with:  npx tsx src/test/gdpr.test.ts
 */

import { db } from "@/lib/db";
import {
  people,
  assets,
  ownershipLinks,
  entityEdges,
  offshoreEdges,
  valuationSnapshots,
} from "@/lib/db/schema";
import { eq } from "drizzle-orm";
import { loadChains } from "@/lib/db/chains";
import { loadOffshoreChains } from "@/lib/db/offshore";

const PID = "gdpr-test-person-1";
const SLUG = "zzz-gdpr-test-private";
const ASSET_ID = "gdpr-test-asset-1";
const COMPANY_ID = "gdpr-test-company";
const PROP_REF = "title:gdpr-test-prop";
const OFFSHORE_ENTITY = "gdpr-test-offshore-entity";
const SRC = "https://example.com/gdpr-test";

let failures = 0;
function assert(cond: boolean, msg: string): void {
  if (cond) {
    console.log(`  ✓ ${msg}`);
  } else {
    failures++;
    console.error(`  ✗ ${msg}`);
  }
}

function cleanup(): void {
  // Delete child rows first (no FK to people), then the person row which
  // cascades to ownership_links and valuation_snapshots.
  db.delete(entityEdges).where(eq(entityEdges.id, "gdpr-test-edge-1")).execute();
  db.delete(entityEdges).where(eq(entityEdges.id, "gdpr-test-edge-2")).execute();
  db.delete(offshoreEdges).where(eq(offshoreEdges.id, "gdpr-test-offshore-1")).execute();
  db.delete(ownershipLinks).where(eq(ownershipLinks.id, "gdpr-test-own-1")).execute();
  db.delete(assets).where(eq(assets.id, ASSET_ID)).execute();
  db.delete(valuationSnapshots).where(eq(valuationSnapshots.id, "gdpr-test-val-1")).execute();
  db.delete(people).where(eq(people.id, PID)).execute();
}

async function main(): Promise<void> {
  console.log("GDPR gate test — private individual must never surface\n");

  // 1. Insert the private individual plus the edges that would surface them.
  await db.insert(people).values({
    id: PID,
    slug: SLUG,
    fullName: "GDPR Test Private Individual",
    isPublicFigure: 0,
  });

  await db.insert(assets).values({
    id: ASSET_ID,
    name: "GDPR Test Property",
    assetType: "real_estate",
    sourceUrl: SRC,
    externalRef: PROP_REF,
  });

  await db.insert(ownershipLinks).values({
    id: "gdpr-test-own-1",
    assetId: ASSET_ID,
    personId: PID,
    confidence: "high",
    sourceUrl: SRC,
  });

  await db.insert(entityEdges).values([
    {
      id: "gdpr-test-edge-1",
      edgeType: "company_owns_property",
      fromEntityType: "company",
      fromEntityId: COMPANY_ID,
      fromLabel: "GDPR Test Co",
      toEntityType: "property",
      toEntityId: PROP_REF,
      toLabel: "GDPR Test Property",
      confidence: 0.9,
      sourceUrl: SRC,
    },
    {
      id: "gdpr-test-edge-2",
      edgeType: "person_controls_company",
      fromEntityType: "person",
      fromEntityId: PID,
      fromLabel: "GDPR Test Private Individual",
      toEntityType: "company",
      toEntityId: COMPANY_ID,
      toLabel: "GDPR Test Co",
      confidence: 0.9,
      sourceUrl: SRC,
    },
  ]);

  await db.insert(offshoreEdges).values({
    id: "gdpr-test-offshore-1",
    edgeType: "officer_of_entity",
    fromEntityType: "person",
    fromEntityId: PID,
    fromLabel: "GDPR Test Private Individual",
    toEntityType: "entity",
    toEntityId: OFFSHORE_ENTITY,
    toLabel: "GDPR Test Entity",
    confidence: 0.9,
    sourceUrl: SRC,
  });

  await db.insert(valuationSnapshots).values({
    id: "gdpr-test-val-1",
    personId: PID,
    ts: "2030-01-01T00:00:00Z",
    liquidCents: 0,
    baselineCents: 0,
    pledgedCents: 0,
    methodVersion: "v-test",
    inputs: "{}",
  });

  try {
    // 2. Canonical public-figure query — the basis of every person-facing list.
    const pub = await db.select().from(people).where(eq(people.isPublicFigure, 1));
    assert(
      !pub.some((p) => p.id === PID),
      "canonical public-figure query excludes the private individual"
    );

    // 3. loadChains must not surface the private individual as a terminal node,
    //    even though a complete property→company→person path now exists.
    const chains = await loadChains(50);
    assert(
      !chains.some((c) => c.person.entityId === PID),
      "loadChains excludes the private individual"
    );

    // 4. loadOffshoreChains must not seed a chain from the private individual.
    const offshore = await loadOffshoreChains(50);
    assert(
      !offshore.some((c) => c.personId === PID),
      "loadOffshoreChains excludes the private individual"
    );

    // 5. Sanity: the row really is in the DB (so the gate — not absence of
    //    data — is what keeps it out). The profile page relies on exactly this.
    const direct = await db.select().from(people).where(eq(people.slug, SLUG));
    assert(
      direct.length === 1 && direct[0].isPublicFigure !== 1,
      "private individual exists in DB (gate is what must catch it)"
    );
  } finally {
    cleanup();
  }

  if (failures > 0) {
    console.error(`\nGDPR gate test FAILED (${failures} assertion(s)).`);
    process.exit(1);
  }
  console.log("\nGDPR gate test PASSED.");
  process.exit(0);
}

main().catch((err) => {
  console.error("GDPR gate test errored:", err);
  cleanup();
  process.exit(1);
});
