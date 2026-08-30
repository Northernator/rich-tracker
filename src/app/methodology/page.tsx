import { db } from "@/lib/db";
import { sources } from "@/lib/db/schema";
import { METHOD_VERSION } from "@/lib/valuation";
import { asc } from "drizzle-orm";

export const metadata = {
  title: "Methodology — Track the Rich",
  description:
    "How every number on Track the Rich is produced: the exact formula, the inputs behind each figure, and the sources that contribute to it.",
};

/**
 * Version history of the valuation formula. Each entry documents what changed
 * and why the old rows are still honest. method_version only moves forward —
 * historical valuation_snapshots are never recomputed under a newer version.
 */
const VERSION_HISTORY = [
  {
    version: "v1",
    released: "2026-08-30",
    status: "current" as const,
    changes: [
      "First frozen formula. Liquid = Σ (latest price × share count) per holding, converted to USD at the ECB/frankfurter rate on or before the price date.",
      "Liquid is compared against the most recent baseline net-worth estimate (the row id is recorded in inputs).",
      "Every figure is stored with a full inputs JSON so the number can be reproduced exactly from the stored inputs alone.",
    ],
  },
];

export default async function MethodologyPage() {
  const sourceRows = await db
    .select({
      id: sources.id,
      name: sources.name,
      url: sources.url,
      license: sources.license,
      attribution: sources.attribution,
    })
    .from(sources)
    .orderBy(asc(sources.name));

  return (
    <div className="max-w-6xl mx-auto px-6 py-12">
      <div className="mb-12">
        <p className="font-mono text-xs uppercase tracking-widest text-accent mb-3">
          Methodology · method {METHOD_VERSION}
        </p>
        <h1 className="font-serif text-4xl font-semibold tracking-tight text-fg">
          How a number is produced
        </h1>
        <p className="mt-4 text-fg-muted max-w-2xl">
          Every figure on this site is a number you can open up. Each valuation
          snapshot stores the exact inputs that produced it — every security, share
          count, price, date, FX rate, and the baseline row it is compared against.
          Take the stored inputs and a calculator and you get the same liquid
          figure we show, to the cent.
        </p>
      </div>

      {/* The formula */}
      <section className="border border-border rounded-md mb-10">
        <h2 className="font-serif text-2xl font-semibold px-6 py-4 border-b border-border">
          The formula
        </h2>
        <div className="p-6 space-y-5 text-sm">
          <div className="font-mono text-fg text-base leading-relaxed">
            liquid = Σ<sub>holdings</sub> ( latest_price_cents × shares × fx_to_usd )
          </div>
          <ul className="space-y-3 text-fg-muted">
            <li>
              <span className="font-mono text-fg">latest_price_cents</span> — the most
              recent stock snapshot&apos;s price for that security, in its local
              currency (e.g. EUR for MC.PA, INR for RELIANCE.NS).
            </li>
            <li>
              <span className="font-mono text-fg">fx_to_usd</span> — the ECB rate
              (frankfurter.app) for the price&apos;s currency as of the price date,
              or the most recent rate on or before it. A missing rate is an error:
              the holding is flagged, never silently priced as USD.
            </li>
            <li>
              <span className="font-mono text-fg">verifiability = liquid / baseline</span>{" "}
              — liquid verified equity as a share of the baseline net worth. It is
              stored unclamped; a value above 1.0 is rendered in red (e.g. 122%⚠)
              because an impossible ratio means a share count or baseline is wrong.
            </li>
          </ul>
          <p className="text-fg-faint">
            All money columns are integer USD cents. No silent unit or currency
            assumptions — an unknown currency is an error, not USD.
          </p>
        </div>
      </section>

      {/* Version history */}
      <section className="border border-border rounded-md mb-10">
        <h2 className="font-serif text-2xl font-semibold px-6 py-4 border-b border-border">
          Version history
        </h2>
        <div className="divide-y divide-border">
          {VERSION_HISTORY.map((v) => (
            <div key={v.version} className="p-6 flex gap-6">
              <div className="w-24 shrink-0">
                <span
                  className={`inline-flex items-center px-2 py-0.5 rounded text-xs font-mono ${
                    v.status === "current"
                      ? "bg-success/10 text-success"
                      : "bg-surface text-fg-muted"
                  }`}
                >
                  {v.version}
                  {v.status === "current" ? " · current" : ""}
                </span>
                <div className="font-mono text-[10px] text-fg-faint mt-2">{v.released}</div>
              </div>
              <ul className="space-y-2 text-fg-muted text-sm">
                {v.changes.map((c, i) => (
                  <li key={i} className="flex gap-2">
                    <span className="text-accent">—</span>
                    <span>{c}</span>
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>
        <p className="px-6 py-4 text-xs text-fg-faint border-t border-border">
          Historical snapshots are never recomputed under a newer version. When the
          formula changes, new rows are inserted under the new method_version and
          old rows remain exactly as they were recorded — that is the point of a
          frozen snapshot.
        </p>
      </section>

      {/* Sources */}
      <section className="border border-border rounded-md">
        <h2 className="font-serif text-2xl font-semibold px-6 py-4 border-b border-border">
          What each source contributes
        </h2>
        <table className="w-full text-sm">
          <thead>
            <tr className="bg-surface border-b border-border">
              <th className="text-left px-6 py-3 text-xs uppercase tracking-widest text-fg-muted font-medium">
                Source
              </th>
              <th className="text-left px-6 py-3 text-xs uppercase tracking-widest text-fg-muted font-medium">
                License
              </th>
              <th className="text-left px-6 py-3 text-xs uppercase tracking-widest text-fg-muted font-medium">
                Attribution
              </th>
            </tr>
          </thead>
          <tbody>
            {sourceRows.map((s, i) => (
              <tr key={s.id} className={`border-b border-border last:border-0 ${i % 2 === 1 ? "bg-surface" : "bg-bg"}`}>
                <td className="px-6 py-3">
                  {s.url ? (
                    <a
                      href={s.url}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="font-mono text-accent hover:underline"
                    >
                      {s.name}
                    </a>
                  ) : (
                    <span className="font-mono text-fg">{s.name}</span>
                  )}
                </td>
                <td className="px-6 py-3 font-mono text-fg-muted">{s.license ?? "—"}</td>
                <td className="px-6 py-3 text-fg-muted">{s.attribution}</td>
              </tr>
            ))}
          </tbody>
        </table>
        <p className="px-6 py-4 text-xs text-fg-faint border-t border-border">
          Baselines come from the <span className="font-mono">komed3/rtb-api</span>{" "}
          and <span className="font-mono">Wikidata</span> net-worth estimates; prices come
          from market price providers; holdings, pledges and assets carry their own
          resolvable <span className="font-mono">source_url</span> to the document that
          supports them. Rows are loaded additively and never deleted.
        </p>
      </section>
    </div>
  );
}
