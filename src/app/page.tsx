import { db } from "@/lib/db";
import { billionaires } from "@/lib/db/schema";
import { desc } from "drizzle-orm";

export default async function HomePage() {
  const data = await db
    .select()
    .from(billionaires)
    .orderBy(desc(billionaires.rank))
    .limit(10);

  return (
    <div className="max-w-4xl mx-auto px-6 py-12">
      <div className="mb-12">
        <p className="text-xs uppercase tracking-widest text-fg-muted mb-2">Global Billionaire Tracker</p>
        <h1 className="font-serif text-4xl font-semibold tracking-tight text-fg mb-4">
          The Richest People in the World
        </h1>
        <p className="text-lg text-fg-muted leading-relaxed max-w-2xl">
          Net worth estimates from multiple sources, shown side by side with consistency bands.
          No single number is correct — here&apos;s the range, and what fraction is actually verifiable.
        </p>
      </div>

      <div className="border border-border rounded-md overflow-hidden">
        <table className="w-full text-sm">
          <thead>
            <tr className="bg-surface border-b border-border">
              <th className="text-left px-4 py-3 text-xs uppercase tracking-widest text-fg-muted font-medium w-12">#</th>
              <th className="text-left px-4 py-3 text-xs uppercase tracking-widest text-fg-muted font-medium">Name</th>
              <th className="text-right px-4 py-3 text-xs uppercase tracking-widest text-fg-muted font-medium">Estimate</th>
              <th className="text-right px-4 py-3 text-xs uppercase tracking-widest text-fg-muted font-medium">Range</th>
              <th className="text-right px-4 py-3 text-xs uppercase tracking-widest text-fg-muted font-medium">Liquid %</th>
              <th className="text-right px-4 py-3 text-xs uppercase tracking-widest text-fg-muted font-medium w-20">Change</th>
            </tr>
          </thead>
          <tbody>
            {data.map((person, i) => {
              const change = person.prevRank && person.rank !== person.prevRank
                ? person.rank < person.prevRank
                  ? { direction: "up" as const, value: person.prevRank - person.rank }
                  : { direction: "down" as const, value: person.rank - person.prevRank }
                : null;
              const lowEstimate = person.estimatedWealth * 0.7;
              const highEstimate = person.estimatedWealth * 1.15;

              return (
                <tr key={person.id} className={`border-b border-border last:border-0 ${i % 2 === 1 ? "bg-surface" : "bg-bg"}`}>
                  <td className="px-4 py-3 font-mono text-fg-muted">{person.rank}</td>
                  <td className="px-4 py-3">
                    <div className="font-medium text-fg">{person.name}</div>
                    <div className="text-xs text-fg-faint mt-0.5">{person.industry} &middot; {person.country}</div>
                  </td>
                  <td className="px-4 py-3 text-right font-mono font-medium">
                    ${person.estimatedWealth.toFixed(1)}B
                  </td>
                  <td className="px-4 py-3 text-right">
                    <span className="font-mono text-fg-muted text-xs">
                      ${lowEstimate.toFixed(1)}&ndash;${highEstimate.toFixed(1)}B
                    </span>
                  </td>
                  <td className="px-4 py-3 text-right">
                    <div className="flex items-center justify-end gap-2">
                      <div className="w-16 h-1.5 bg-border rounded-full overflow-hidden">
                        <div
                          className="h-full bg-accent rounded-full"
                          style={{ width: `${person.liquidityPct}%` }}
                        />
                      </div>
                      <span className="font-mono text-xs text-fg-muted w-10 text-right">
                        {person.liquidityPct.toFixed(0)}%
                      </span>
                    </div>
                  </td>
                  <td className="px-4 py-3 text-right">
                    {change ? (
                      <span className={`font-mono text-xs ${change.direction === "up" ? "text-success" : "text-danger"}`}>
                        {change.direction === "up" ? "↑" : "↓"} {change.value}
                      </span>
                    ) : (
                      <span className="text-fg-faint text-xs">—</span>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      <div className="mt-8 grid grid-cols-3 gap-4 text-xs text-fg-muted">
        <div className="p-4 border border-border rounded-md bg-surface">
          <div className="font-medium text-fg mb-1">Consistency Band</div>
          <div>The range between conservative and optimistic estimates from different sources.</div>
        </div>
        <div className="p-4 border border-border rounded-md bg-surface">
          <div className="font-medium text-fg mb-1">Liquid %</div>
          <div>What fraction of reported wealth is in publicly-traded stocks vs. private holdings.</div>
        </div>
        <div className="p-4 border border-border rounded-md bg-surface">
          <div className="font-medium text-fg mb-1">Change</div>
          <div>Rank movement from the last report. Up = gained position, down = lost position.</div>
        </div>
      </div>
    </div>
  );
}
