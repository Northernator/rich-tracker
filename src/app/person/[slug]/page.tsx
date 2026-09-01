import { notFound } from "next/navigation";
import type { Metadata } from "next";
import Link from "next/link";
import { db } from "@/lib/db";
import {
  people,
  baselineEstimates,
  valuationSnapshots,
  assets,
  ownershipLinks,
} from "@/lib/db/schema";
import { eq, desc } from "drizzle-orm";

export async function generateMetadata({
  params,
}: {
  params: Promise<{ slug: string }>;
}): Promise<Metadata> {
  const { slug } = await params;
  const person = await db
    .select({ fullName: people.fullName })
    .from(people)
    .where(eq(people.slug, slug))
    .get();
  if (!person) return { title: "Profile not found — Track the Rich" };
  return {
    title: `${person.fullName} — Track the Rich`,
    description: `Tracked assets and net-worth provenance for ${person.fullName}.`,
  };
}

function formatCents(cents: number): string {
  const d = cents / 100;
  if (d >= 1e9) return `$${(d / 1e9).toFixed(1)}B`;
  if (d >= 1e6) return `$${(d / 1e6).toFixed(0)}M`;
  return `$${Math.round(d).toLocaleString()}`;
}

function formatPct(pct: number | null): string {
  if (pct == null) return "n/a";
  return `${pct.toFixed(1)}%`;
}

const CONFIDENCE_COLOR: Record<string, string> = {
  high: "text-success",
  medium: "text-warning",
  low: "text-danger",
};

export default async function PersonProfilePage({
  params,
}: {
  params: Promise<{ slug: string }>;
}) {
  const { slug } = await params;

  const person = await db
    .select()
    .from(people)
    .where(eq(people.slug, slug))
    .get();

  if (!person) notFound();

  // UK GDPR gate: this site only publishes data about public figures. A person
  // marked is_public_figure = 0 (a private individual) must never be reachable
  // through a profile URL, even with a guessed slug.
  if (person.isPublicFigure !== 1) notFound();

  const baselines = await db
    .select()
    .from(baselineEstimates)
    .where(eq(baselineEstimates.personId, person.id))
    .orderBy(desc(baselineEstimates.asOf));

  const baseline = baselines[0] ?? null;

  const valuation = await db
    .select()
    .from(valuationSnapshots)
    .where(eq(valuationSnapshots.personId, person.id))
    .orderBy(desc(valuationSnapshots.ts))
    .get();

  const ownedAssets = await db
    .select({
      id: assets.id,
      name: assets.name,
      assetType: assets.assetType,
      estimatedValueCents: assets.estimatedValueCents,
      location: assets.location,
      sourceUrl: assets.sourceUrl,
      confidence: ownershipLinks.confidence,
      ownershipPct: ownershipLinks.ownershipPct,
    })
    .from(assets)
    .innerJoin(ownershipLinks, eq(ownershipLinks.assetId, assets.id))
    .where(eq(ownershipLinks.personId, person.id))
    .orderBy(desc(assets.estimatedValueCents));

  const netWorthCents = baseline?.netWorthCents ?? valuation?.baselineCents ?? null;
  const pledgePct =
    valuation && valuation.baselineCents > 0
      ? (valuation.pledgedCents / valuation.baselineCents) * 100
      : null;
  const verifiability = valuation?.verifiability ?? null;

  return (
    <div className="max-w-4xl mx-auto px-6 py-10">
      <Link
        href="/globe"
        className="text-sm text-fg-muted hover:text-fg transition-colors"
      >
        ← Globe
      </Link>

      <header className="mt-4 border-b border-border pb-6">
        <h1 className="font-serif text-4xl font-semibold tracking-tight text-fg">
          {person.fullName}
        </h1>
        <div className="text-sm text-fg-muted mt-1">
          {[person.primaryOrg, person.country].filter(Boolean).join(" · ")}
          {person.bornYear ? ` · b. ${person.bornYear}` : ""}
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-3 gap-4 mt-6">
          <div className="bg-surface border border-border rounded-md p-4">
            <div className="text-xs uppercase tracking-wide text-fg-muted">Net worth</div>
            <div className="font-mono text-2xl font-medium mt-1 text-fg">
              {netWorthCents != null ? formatCents(netWorthCents) : "—"}
            </div>
            {baseline?.asOf && (
              <div className="text-xs text-fg-faint mt-1">as of {baseline.asOf}</div>
            )}
          </div>
          <div className="bg-surface border border-border rounded-md p-4">
            <div className="text-xs uppercase tracking-wide text-fg-muted">Verifiability</div>
            <div className="font-mono text-2xl font-medium mt-1 text-fg">
              {verifiability != null ? formatPct(verifiability * 100) : "—"}
            </div>
            <div className="text-xs text-fg-faint mt-1">verified ÷ baseline</div>
          </div>
          <div className="bg-surface border border-border rounded-md p-4">
            <div className="text-xs uppercase tracking-wide text-fg-muted">Pledged</div>
            <div className="font-mono text-2xl font-medium mt-1 text-fg">
              {formatPct(pledgePct)}
            </div>
            <div className="text-xs text-fg-faint mt-1">of net worth</div>
          </div>
        </div>
      </header>

      <section className="mt-8">
        <h2 className="font-serif text-2xl font-semibold text-fg">
          Physical assets
        </h2>
        <p className="text-sm text-fg-muted mt-1">
          {ownedAssets.length} tracked, sourced from public registries.
        </p>

        {ownedAssets.length === 0 ? (
          <p className="text-sm text-fg-faint mt-4">
            No physical assets are currently linked to this person.
          </p>
        ) : (
          <ul className="mt-4 divide-y divide-border border border-border rounded-md">
            {ownedAssets.map((a) => (
              <li key={a.id} className="p-4 flex items-start justify-between gap-4">
                <div className="min-w-0">
                  <div className="font-medium text-fg">{a.name}</div>
                  <div className="text-xs text-fg-muted mt-0.5 capitalize">
                    {a.assetType.replace("_", " ")}
                    {a.location ? ` · ${a.location}` : ""}
                    {a.ownershipPct != null ? ` · ${a.ownershipPct}% owned` : ""}
                  </div>
                  {a.sourceUrl && (
                    <a
                      href={a.sourceUrl}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="text-xs text-accent hover:underline mt-1 inline-block"
                    >
                      Source ↗
                    </a>
                  )}
                </div>
                <div className="text-right flex-shrink-0">
                  <div className="font-mono text-sm text-fg">
                    {a.estimatedValueCents != null
                      ? formatCents(a.estimatedValueCents)
                      : "value unknown"}
                  </div>
                  <div
                    className={`text-xs mt-0.5 ${
                      CONFIDENCE_COLOR[a.confidence ?? "low"] ?? "text-fg-muted"
                    }`}
                  >
                    {a.confidence} confidence
                  </div>
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>

      {baseline?.sourceUrl && (
        <p className="text-xs text-fg-faint mt-8">
          Net-worth figure sourced from{" "}
          <a
            href={baseline.sourceUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="text-fg-muted hover:underline"
          >
            {baseline.sourceUrl}
          </a>
          . Estimates are compiled from third-party sources and are not authoritative.
        </p>
      )}

      <p className="text-xs text-fg-faint mt-6">
        Think a figure here is wrong?{" "}
        <Link
          href={`/dispute?slug=${encodeURIComponent(person.slug)}`}
          className="text-fg-muted hover:text-accent transition-colors underline"
        >
          Dispute this figure →
        </Link>
      </p>
    </div>
  );
}
