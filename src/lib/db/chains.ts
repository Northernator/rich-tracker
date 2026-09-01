/**
 * Chunk 10 — reading ownership chains back out of `entity_edges`.
 *
 * The loader writes ONE ROW PER HOP. This is the module that walks those hops
 * into a path and, crucially, does the arithmetic the old `ownership_links`
 * table could not:
 *
 *   property → company → person
 *
 *   chain confidence = hop1 × hop2
 *
 * A single three-valued `confidence` ('high'|'medium'|'low') cannot express
 * "the title entry is solid and the name match is weak" — it forces the worst
 * hop's uncertainty onto the whole path and hides where the weakness is. Here
 * every hop keeps its own number, the product is the chain's confidence, and
 * the weakest hop is identified so the UI can point at it.
 *
 * Anything at or above CHAIN_CONFIDENCE_FLOOR (0.5) is a sourced finding.
 * Anything below is a POSSIBLE LINK and must be rendered as a possibility —
 * never as fact. That is a display rule, and it lives here so no page can
 * quietly decide otherwise.
 */

import { db } from "@/lib/db";
import { assets, entityEdges, people, CHAIN_CONFIDENCE_FLOOR } from "./schema";
import { inArray } from "drizzle-orm";

export type ChainVerdict = "sourced" | "possible-link";

export interface ChainHop {
  edgeId: string;
  edgeType: string;
  fromEntityType: string;
  fromEntityId: string;
  fromLabel: string;
  toEntityType: string;
  toEntityId: string;
  toLabel: string;
  confidence: number;
  sourceUrl: string;
  asOf: string | null;
  /** Registry-specific facts (nature of control, tenure, notified date…). */
  detail: Record<string, unknown> | null;
}

export interface ChainNode {
  entityType: string;
  entityId: string;
  label: string;
}

export interface OwnershipChain {
  property: ChainNode;
  company: ChainNode;
  person: ChainNode & { personSlug: string | null };
  hops: ChainHop[];
  /** Product of the hop confidences. */
  confidence: number;
  verdict: ChainVerdict;
  /** The hop holding the chain back — what a reviewer should check first. */
  weakestHop: ChainHop;
  /** Asset row this chain's property resolves to, when one exists. */
  asset: {
    id: string;
    name: string;
    location: string | null;
    estimatedValueCents: number | null;
    sourceUrl: string;
    externalRef: string | null;
  } | null;
}

export function verdictFor(confidence: number): ChainVerdict {
  return confidence >= CHAIN_CONFIDENCE_FLOOR ? "sourced" : "possible-link";
}

/** Rounded for display only — the stored number is never rounded. */
export function formatConfidence(confidence: number): string {
  return confidence.toFixed(2);
}

function parseDetail(raw: string | null): Record<string, unknown> | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
    return null;
  } catch {
    return null;
  }
}

type EdgeRow = typeof entityEdges.$inferSelect;

function toHop(e: EdgeRow): ChainHop {
  return {
    edgeId: e.id,
    edgeType: e.edgeType,
    fromEntityType: e.fromEntityType,
    fromEntityId: e.fromEntityId,
    fromLabel: e.fromLabel,
    toEntityType: e.toEntityType,
    toEntityId: e.toEntityId,
    toLabel: e.toLabel,
    confidence: e.confidence,
    sourceUrl: e.sourceUrl,
    asOf: e.asOf,
    detail: parseDetail(e.detail),
  };
}

/**
 * Build every property → company → person chain present in the database.
 *
 * A chain exists only when BOTH hops do. A company with a title but no
 * beneficial owner on the register is not a chain — it is where the register
 * runs out, and reporting it as an ownership would be the exact false
 * confidence this schema exists to prevent.
 */
export async function loadChains(limit = 100): Promise<OwnershipChain[]> {
  const edges = (await db.select().from(entityEdges).execute()) as EdgeRow[];

  const propertyEdges = edges.filter((e) => e.edgeType === "company_owns_property");
  const personEdges = edges.filter((e) => e.edgeType === "person_controls_company");
  if (propertyEdges.length === 0 || personEdges.length === 0) return [];

  const byCompany = new Map<string, EdgeRow[]>();
  for (const e of personEdges) {
    const key = e.toEntityId; // …controls company <id>
    const list = byCompany.get(key);
    if (list) list.push(e);
    else byCompany.set(key, [e]);
  }

  // Property assets, keyed by "title:XXXX" — the same id the edge points at.
  const titleRefs = [...new Set(propertyEdges.map((e) => e.toEntityId))];
  const assetRows = titleRefs.length
    ? ((await db
        .select()
        .from(assets)
        .where(inArray(assets.externalRef, titleRefs))
        .execute()) as Array<typeof assets.$inferSelect>)
    : [];
  const assetByRef = new Map<string, typeof assets.$inferSelect>();
  for (const a of assetRows) {
    if (a.externalRef) assetByRef.set(a.externalRef, a);
  }

  // Only roster people have a profile page; PSC-only terminal nodes do not.
  const personIds = [...new Set(personEdges.map((e) => e.fromEntityId))];
  const personRows = personIds.length
    ? ((await db
        .select({ id: people.id, slug: people.slug })
        .from(people)
        .where(inArray(people.id, personIds))
        .execute()) as Array<{ id: string; slug: string }>)
    : [];
  const slugById = new Map<string, string>();
  for (const p of personRows) slugById.set(p.id, p.slug);

  const chains: OwnershipChain[] = [];
  for (const propEdge of propertyEdges) {
    const controlEdges = byCompany.get(propEdge.fromEntityId);
    if (!controlEdges) continue;

    for (const controlEdge of controlEdges) {
      const propertyHop = toHop(propEdge);
      const personHop = toHop(controlEdge);
      const confidence = propertyHop.confidence * personHop.confidence;
      const weakestHop =
        propertyHop.confidence <= personHop.confidence ? propertyHop : personHop;

      chains.push({
        property: {
          entityType: propEdge.toEntityType,
          entityId: propEdge.toEntityId,
          label: propEdge.toLabel,
        },
        company: {
          entityType: propEdge.fromEntityType,
          entityId: propEdge.fromEntityId,
          label: propEdge.fromLabel,
        },
        person: {
          entityType: controlEdge.fromEntityType,
          entityId: controlEdge.fromEntityId,
          label: controlEdge.fromLabel,
          personSlug: slugById.get(controlEdge.fromEntityId) ?? null,
        },
        hops: [propertyHop, personHop],
        confidence,
        verdict: verdictFor(confidence),
        weakestHop,
        asset: (() => {
          const a = assetByRef.get(propEdge.toEntityId);
          if (!a) return null;
          return {
            id: a.id,
            name: a.name,
            location: a.location,
            estimatedValueCents: a.estimatedValueCents,
            sourceUrl: a.sourceUrl,
            externalRef: a.externalRef,
          };
        })(),
      });
    }
  }

  chains.sort((a, b) => b.confidence - a.confidence);
  return limit > 0 ? chains.slice(0, limit) : chains;
}

/** Every property hop whose company has no beneficial owner on the register. */
export async function countDanglingPropertyHops(): Promise<number> {
  const edges = (await db.select().from(entityEdges).execute()) as EdgeRow[];
  const withPerson = new Set(
    edges.filter((e) => e.edgeType === "person_controls_company").map((e) => e.toEntityId)
  );
  return edges.filter(
    (e) => e.edgeType === "company_owns_property" && !withPerson.has(e.fromEntityId)
  ).length;
}

/** Total hops, for the /ownership header. */
export async function countHops(): Promise<number> {
  const rows = (await db
    .select({ id: entityEdges.id })
    .from(entityEdges)
    .execute()) as Array<{ id: string }>;
  return rows.length;
}

/** Asset rows keyed by external_ref, for pages that need the property side. */
export async function assetsByExternalRef(
  refs: string[]
): Promise<Map<string, typeof assets.$inferSelect>> {
  if (refs.length === 0) return new Map();
  const rows = (await db
    .select()
    .from(assets)
    .where(inArray(assets.externalRef, refs))
    .execute()) as Array<typeof assets.$inferSelect>;
  const map = new Map<string, typeof assets.$inferSelect>();
  for (const r of rows) if (r.externalRef) map.set(r.externalRef, r);
  return map;
}
