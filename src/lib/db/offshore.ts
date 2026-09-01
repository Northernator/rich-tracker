/**
 * Chunk 11 — reading the resolved offshore graph back out of `offshore_edges`.
 *
 * The loader writes ONE HOP PER ROW. This module walks those hops into a path
 * with SQLite's WITH RECURSIVE, exactly as the chunk spec specifies, with two
 * guards the spec calls out:
 *
 *   - depth < 6  (cap recursion)
 *   - no node revisited (cycle guard) — a deliberately circular edge must NOT
 *     hang the query. The guard uses instr() on a comma-delimited visited list
 *     (not LIKE) so node ids containing `_` or `%` can't break it.
 *
 * Confidence MULTIPLIES along the path (same model as Chunk 10). A chain at or
 * above CHAIN_CONFIDENCE_FLOOR (0.5) is a sourced finding; below it renders as
 * a possible link, never as fact. That display rule lives here so no page can
 * quietly decide otherwise.
 */

import { sqlite } from "@/lib/db";
import { CHAIN_CONFIDENCE_FLOOR, people } from "./schema";
import { verdictFor, type ChainVerdict } from "./chains";
import { db } from "@/lib/db";

export interface OffshoreHop {
  edgeType: string;
  fromEntityType: string;
  fromEntityId: string;
  fromLabel: string;
  toEntityType: string;
  toEntityId: string;
  toLabel: string;
  /** The confidence of THIS hop (the edge that arrived at to_entity_id). */
  confidence: number;
  /** Cumulative confidence of the path up to and including this hop. */
  cumulative: number;
  sourceUrl: string;
}

export interface OffshoreChain {
  personId: string;
  personSlug: string | null;
  personName: string;
  hops: OffshoreHop[];
  /** Product of all hop confidences. */
  confidence: number;
  verdict: ChainVerdict;
  /** depth = number of hops = path length minus the person root. */
  depth: number;
  isMultiHop: boolean;
}

interface RawRow {
  person_id: string;
  depth: number;
  confidence: number; // cumulative at this node
  hop_conf: number; // the edge confidence that arrived here
  path: string; // ',personId,entity1,entity2,'
  visited: string;
  last_label: string;
  last_url: string;
}

/**
 * Seed from every officer_of_entity edge (person → entity), then walk
 * entity_relationship edges to depth 6, never revisiting a node.
 */
const RECURSIVE_SQL = `
WITH RECURSIVE chain(node_id, person_id, depth, confidence, hop_conf, path, visited, last_label, last_url) AS (
  SELECT
    oe.to_entity_id,
    p.id,
    1,
    oe.confidence,
    oe.confidence,
    ',' || p.id || ',' || oe.to_entity_id || ',',
    ',' || p.id || ',' || oe.to_entity_id || ',',
    oe.to_label,
    oe.source_url
  FROM offshore_edges oe
  JOIN people p ON p.id = oe.from_entity_id
  WHERE oe.edge_type = 'officer_of_entity'
    AND (:personId IS NULL OR p.id = :personId)
  UNION ALL
  SELECT
    e.to_entity_id,
    c.person_id,
    c.depth + 1,
    c.confidence * e.confidence,
    e.confidence,
    c.path || e.to_entity_id || ',',
    c.visited || e.to_entity_id || ',',
    e.to_label,
    e.source_url
  FROM chain c
  JOIN offshore_edges e ON e.from_entity_id = c.node_id
  WHERE e.edge_type = 'entity_relationship'
    AND c.depth < 6
    AND instr(c.visited, ',' || e.to_entity_id || ',') = 0
)
SELECT person_id, depth, confidence, hop_conf, path, visited, last_label, last_url
FROM chain
ORDER BY person_id, path, depth
`;

function buildChains(rows: RawRow[], personMeta: Map<string, { slug: string | null; name: string }>): OffshoreChain[] {
  // Group rows by path (path is unique per chain and includes the person root).
  const byPath = new Map<string, RawRow[]>();
  for (const r of rows) {
    const list = byPath.get(r.path);
    if (list) list.push(r);
    else byPath.set(r.path, [r]);
  }

  const chains: OffshoreChain[] = [];
  for (const group of byPath.values()) {
    group.sort((a, b) => a.depth - b.depth);
    const personId = group[0].person_id;
    const meta = personMeta.get(personId) ?? { slug: null, name: personId };
    // path = ',person,entity1,entity2,' → nodes without leading/trailing comma.
    const nodes = group[0].path.replace(/^,/, "").replace(/,$/, "").split(",");

    const hops: OffshoreHop[] = [];
    for (let i = 0; i < group.length; i++) {
      const r = group[i];
      const fromNode = nodes[i];
      const toNode = nodes[i + 1];
      hops.push({
        edgeType: i === 0 ? "officer_of_entity" : "entity_relationship",
        fromEntityType: i === 0 ? "person" : "entity",
        fromEntityId: fromNode,
        fromLabel: i === 0 ? meta.name : (i > 0 ? group[i - 1].last_label : fromNode),
        toEntityType: "entity",
        toEntityId: toNode,
        toLabel: r.last_label,
        confidence: r.hop_conf,
        cumulative: r.confidence,
        sourceUrl: r.last_url,
      });
    }
    const confidence = group[group.length - 1].confidence;
    const depth = group.length;
    chains.push({
      personId,
      personSlug: meta.slug,
      personName: meta.name,
      hops,
      confidence,
      verdict: verdictFor(confidence),
      depth,
      isMultiHop: depth >= 2,
    });
  }
  return chains;
}

async function personMetaMap(): Promise<Map<string, { slug: string | null; name: string }>> {
  const rows = (await db
    .select({ id: people.id, slug: people.slug, fullName: people.fullName })
    .from(people)
    .execute()) as Array<{ id: string; slug: string | null; fullName: string }>;
  const m = new Map<string, { slug: string | null; name: string }>();
  for (const r of rows) m.set(r.id, { slug: r.slug, name: r.fullName });
  return m;
}

/** All offshore chains for one person (depth ≥ 1). */
export async function resolveOffshoreChains(personId: string): Promise<OffshoreChain[]> {
  const meta = await personMetaMap();
  const rows = sqlite
    .prepare(RECURSIVE_SQL)
    .all({ personId }) as RawRow[];
  return buildChains(rows as RawRow[], meta);
}

/** All offshore chains across the roster, highest confidence first. */
export async function loadOffshoreChains(limit = 100): Promise<OffshoreChain[]> {
  const meta = await personMetaMap();
  const rows = sqlite.prepare(RECURSIVE_SQL).all({ personId: null }) as RawRow[];
  const chains = buildChains(rows as RawRow[], meta);
  chains.sort((a, b) => b.confidence - a.confidence);
  return limit > 0 ? chains.slice(0, limit) : chains;
}

/** Total resolved chains (depth ≥ 1). */
export async function countOffshoreChains(): Promise<number> {
  const rows = sqlite.prepare(RECURSIVE_SQL).all({ personId: null }) as RawRow[];
  const paths = new Set((rows as RawRow[]).map((r) => r.path));
  return paths.size;
}

/** Multi-hop chains (depth ≥ 2) — the chains the acceptance checklist counts. */
export async function countMultiHopChains(): Promise<number> {
  const rows = sqlite.prepare(RECURSIVE_SQL).all({ personId: null }) as RawRow[];
  const byPath = new Map<string, number>();
  for (const r of rows as RawRow[]) byPath.set(r.path, Math.max(byPath.get(r.path) ?? 0, r.depth));
  let n = 0;
  for (const d of byPath.values()) if (d >= 2) n++;
  return n;
}

/** Raw hop count, for headers. */
export async function countOffshoreHops(): Promise<number> {
  const r = sqlite.prepare("SELECT COUNT(*) AS c FROM offshore_edges").get() as { c: number };
  return r.c;
}

export { CHAIN_CONFIDENCE_FLOOR };
