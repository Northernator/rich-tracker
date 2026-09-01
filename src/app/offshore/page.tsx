import { ChainRow } from "@/components/ChainRow";
import { OffshoreAttribution } from "@/components/OffshoreAttribution";
import { loadOffshoreChains, countOffshoreHops, type OffshoreChain } from "@/lib/db/offshore";

export const metadata = {
  title: "The Offshore Layer — Track the Rich",
  description:
    "Entity resolution across the ICIJ Offshore Leaks graph: shell company → entity → offshore entity → person, with per-hop confidence and a resolvable citation on every hop.",
};

function weakestHop(c: OffshoreChain): { label: string; confidence: number } {
  let w = c.hops[0];
  for (const h of c.hops) if (h.confidence < w.confidence) w = h;
  return { label: w.toLabel, confidence: w.confidence };
}

export default async function OffshorePage() {
  const chains = await loadOffshoreChains(50);
  const hops = await countOffshoreHops();
  const multiHop = chains.filter((c) => c.isMultiHop).length;

  return (
    <div className="max-w-5xl mx-auto px-6 py-12">
      <div className="mb-10">
        <p className="text-xs uppercase tracking-widest text-fg-muted mb-2">
          Chunk 11 — The Offshore Layer
        </p>
        <h1 className="font-serif text-4xl font-semibold tracking-tight text-fg mb-4">
          The moat
        </h1>
        <p className="text-lg text-fg-muted leading-relaxed max-w-2xl">
          The deepest link in the graph: a person resolved through an ICIJ officer
          node to an offshore entity, then onward through related entities. Every
          hop keeps its own confidence; the chain confidence is the product, and
          anything under 0.5 renders as a possible link, never as fact.
        </p>
        <p className="text-sm text-fg-faint mt-3 max-w-2xl">
          Data from the ICIJ Offshore Leaks Database (ODbL). Attribution and the
          no-wrongdoing note are required wherever this data appears.
        </p>
      </div>

      <div className="mb-8">
        <OffshoreAttribution />
      </div>

      {/* Summary bar */}
      <div className="border border-border rounded-md bg-surface px-6 py-5 mb-8 flex items-center gap-12 flex-wrap">
        <div>
          <p className="text-xs uppercase tracking-widest text-fg-muted mb-1">Chains</p>
          <p className="font-mono text-2xl font-medium text-fg">{chains.length}</p>
        </div>
        <div>
          <p className="text-xs uppercase tracking-widest text-fg-muted mb-1">Multi-hop</p>
          <p className="font-mono text-2xl font-medium text-fg">{multiHop}</p>
        </div>
        <div>
          <p className="text-xs uppercase tracking-widest text-fg-muted mb-1">Resolved hops</p>
          <p className="font-mono text-2xl font-medium text-fg">{hops}</p>
        </div>
      </div>

      {chains.length === 0 ? (
        <div className="border border-dashed border-border rounded-md px-6 py-10 text-center">
          <p className="font-mono text-sm text-fg-muted">No offshore chains resolved yet.</p>
          <p className="text-sm text-fg-faint mt-2 max-w-xl mx-auto leading-relaxed">
            Drop the official ICIJ ODbL CSVs into{" "}
            <span className="font-mono">data/raw/icij/</span> (nodes-entities.csv,
            nodes-officers.csv, relationships.csv) and run{" "}
            <span className="font-mono">npm run offshore:icij</span>. The loader matches
            ICIJ officers to the roster strictly and resolves the graph additively. An
            empty table is a valid, honest result — it never substitutes invented rows.
          </p>
        </div>
      ) : (
        <div className="space-y-4">
          {chains.map((chain, ci) => {
            const isPossible = chain.verdict === "possible-link";
            const w = weakestHop(chain);
            return (
              <div
                key={`${chain.personId}-${ci}`}
                className={`border border-border rounded-md bg-white overflow-hidden ${
                  isPossible ? "opacity-90" : ""
                }`}
              >
                <div className="px-5 py-3 bg-surface border-b border-border flex items-center justify-between flex-wrap gap-3">
                  <div className="flex items-center gap-3">
                    <span
                      className={`inline-block px-2 py-0.5 rounded text-xs font-mono font-medium ${
                        isPossible ? "bg-fg-muted/10 text-fg-muted" : "bg-success/10 text-success"
                      }`}
                    >
                      {isPossible ? "POSSIBLE LINK" : "SOURCED"}
                    </span>
                    <span className="font-mono text-sm text-fg">
                      chain confidence {chain.confidence.toFixed(2)}
                    </span>
                  </div>
                  <span className="text-xs text-fg-faint">
                    depth {chain.depth} · weakest hop: {w.label} ({w.confidence.toFixed(2)})
                  </span>
                </div>

                <div className="px-5 py-4 space-y-3">
                  {/* person root */}
                  <ChainRow
                    index="1"
                    label="Person"
                    name={chain.personName}
                    sub={chain.personSlug ? `/people/${chain.personSlug}` : "roster person"}
                    href={chain.personSlug ? `/people/${chain.personSlug}` : "#"}
                    confidence={1}
                    personHref={chain.personSlug ? `/people/${chain.personSlug}` : null}
                  />
                  {chain.hops.map((h, hi) => (
                    <ChainRow
                      key={hi}
                      index={String(hi + 2)}
                      label={h.edgeType === "officer_of_entity" ? "Officer of" : "Linked entity"}
                      name={h.toLabel}
                      sub={h.toEntityId}
                      href={h.sourceUrl}
                      confidence={h.confidence}
                      isLast={hi === chain.hops.length - 1}
                    />
                  ))}
                </div>
              </div>
            );
          })}
        </div>
      )}

      <div className="mt-8">
        <OffshoreAttribution compact />
      </div>
    </div>
  );
}
