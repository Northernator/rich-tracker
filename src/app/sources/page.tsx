import { db } from "@/lib/db";
import { sources } from "@/lib/db/schema";
import { asc } from "drizzle-orm";

export const metadata = {
  title: "Sources — Track the Rich",
  description: "Every external source Track the Rich draws on, with its licence and required attribution.",
};

export default async function SourcesPage() {
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
    <div className="max-w-5xl mx-auto px-6 py-12">
      <div className="mb-10">
        <p className="text-xs uppercase tracking-widest text-fg-muted mb-2">Provenance</p>
        <h1 className="font-serif text-4xl font-semibold tracking-tight text-fg mb-4">
          Sources
        </h1>
        <p className="text-lg text-fg-muted leading-relaxed max-w-2xl">
          Every figure on this site traces to one of these sources. Each carries its
          licence; where a licence requires attribution or share-alike (notably the
          ICIJ Offshore Leaks Database under ODbL), that attribution appears wherever
          the data is shown.
        </p>
      </div>

      <div className="border border-border rounded-md">
        <table className="w-full text-sm">
          <thead>
            <tr className="bg-surface border-b border-border">
              <th className="text-left px-6 py-3 text-xs uppercase tracking-widest text-fg-muted font-medium">
                Source
              </th>
              <th className="text-left px-6 py-3 text-xs uppercase tracking-widest text-fg-muted font-medium">
                Licence
              </th>
              <th className="text-left px-6 py-3 text-xs uppercase tracking-widest text-fg-muted font-medium">
                Attribution
              </th>
            </tr>
          </thead>
          <tbody>
            {sourceRows.map((s, i) => (
              <tr
                key={s.id}
                className={`border-b border-border last:border-0 ${i % 2 === 1 ? "bg-surface" : "bg-bg"}`}
              >
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
          Rows are loaded additively and never deleted. A missing licence or attribution
          on a source row is filled in by the loader that owns it, never by inventing one.
        </p>
      </div>
    </div>
  );
}
