import { db } from "@/lib/db";
import { assets, ownershipLinks, people, sources } from "@/lib/db/schema";
import { eq, asc, sql, and } from "drizzle-orm";
import Database from "better-sqlite3";
import { join } from "path";
import { loadChains, type OwnershipChain } from "@/lib/db/chains";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type Confidence = "high" | "medium" | "low";

interface OwnerRow {
  personId: string;
  personSlug: string;
  fullName: string;
  primaryOrg: string | null;
  ownershipPct: number | null;
  confidence: Confidence;
  citation: string | null;
}

interface AssetRow {
  id: string;
  name: string;
  assetType: string;
  description: string | null;
  location: string | null;
  estimatedValueCents: number | null;
  owners: OwnerRow[];
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function formatB(cents: number): string {
  if (cents <= 0) return "—";
  const billions = cents / 100 / 1e9;
  if (billions >= 1) return `$${billions.toFixed(2)}B`;
  const millions = cents / 100 / 1e6;
  return `$${millions.toFixed(0)}M`;
}

function confidenceBadge(confidence: Confidence): string {
  const map = {
    high: { bg: "bg-success/10", text: "text-success", label: "HIGH" },
    medium: { bg: "bg-warning/10", text: "text-warning", label: "MED" },
    low: { bg: "bg-fg-muted/10", text: "text-fg-muted", label: "LOW" },
  };
  const c = map[confidence];
  return `<span class="inline-block px-2 py-0.5 rounded text-xs font-mono font-medium ${c.bg} ${c.text}">${c.label}</span>`;
}

function confidenceDot(confidence: Confidence): string {
  const map = { high: "bg-success", medium: "bg-warning", low: "bg-fg-muted" };
  return `<span class="inline-block w-2 h-2 rounded-full ${map[confidence]} mr-2"></span>`;
}

function assetTypeLabel(type: string): string {
  const map: Record<string, string> = {
    real_estate: "Real Estate",
    vessel: "Vessel",
    aircraft: "Aircraft",
    art: "Art",
    company: "Company",
    other: "Other",
  };
  return map[type] ?? type;
}

function assetTypeIcon(type: string): string {
  const map: Record<string, string> = {
    real_estate: "⌂",
    vessel: "⚓",
    aircraft: "✈",
    art: "◆",
    company: "◈",
    other: "•",
  };
  return map[type] ?? "•";
}

// ---------------------------------------------------------------------------
// Chunk 10 — ownership chain row
// ---------------------------------------------------------------------------

function chainConfidenceClass(c: number): string {
  if (c >= 0.8) return "text-success";
  if (c >= 0.5) return "text-warning";
  return "text-fg-muted";
}

interface ChainRowProps {
  index: string;
  label: string;
  name: string;
  sub?: string | null;
  /** Public-record URL this node/link was sourced from. */
  href: string;
  confidence: number;
  /** Roster profile URL, when this terminal node has one here. */
  personHref?: string | null;
  /** Draws the connector tail to the next row. */
  isLast?: boolean;
}

function ChainRow({
  index,
  label,
  name,
  sub,
  href,
  confidence,
  personHref,
  isLast,
}: ChainRowProps) {
  const dead = !href || href.startsWith("#");
  return (
    <div className="relative flex items-start gap-3">
      {!isLast && (
        <span
          className="absolute left-[11px] top-6 bottom-[-12px] w-px bg-border"
          aria-hidden
        />
      )}
      <div className="relative z-10 flex-shrink-0 w-6 h-6 rounded-full bg-surface border border-border flex items-center justify-center font-mono text-xs text-fg-muted">
        {index}
      </div>
      <div className="flex-1 min-w-0 pb-1">
        <div className="flex items-center gap-2">
          <span className="text-xs uppercase tracking-wide text-fg-faint">
            {label}
          </span>
          <span className={`font-mono text-xs ${chainConfidenceClass(confidence)}`}>
            {confidence.toFixed(2)}
          </span>
        </div>
        <div className="flex items-center gap-2 flex-wrap">
          {dead ? (
            <span className="font-medium text-fg">{name}</span>
          ) : (
            <a
              href={href}
              target="_blank"
              rel="noopener noreferrer"
              className="font-medium text-fg hover:text-accent transition-colors"
            >
              {name}
            </a>
          )}
          {personHref && (
            <a
              href={personHref}
              className="text-xs text-accent hover:text-fg transition-colors"
            >
              profile →
            </a>
          )}
        </div>
        {sub && <p className="text-xs text-fg-faint font-mono mt-0.5">{sub}</p>}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Data layer
// ---------------------------------------------------------------------------

// Build a people lookup by slug
const allPeople = (await db.select().from(people).where(eq(people.isPublicFigure, 1))) as Array<
  typeof people.$inferSelect
>;
const peopleBySlug = new Map<string, typeof allPeople[number]>();
for (const p of allPeople) {
  peopleBySlug.set(p.slug, p);
}

// Fetch assets with their owners
const assetRows = (await db
  .select({
    id: assets.id,
    name: assets.name,
    assetType: assets.assetType,
    description: assets.description,
    location: assets.location,
    estimatedValueCents: assets.estimatedValueCents,
    personId: ownershipLinks.personId,
    personSlug: people.slug,
    fullName: people.fullName,
    primaryOrg: people.primaryOrg,
    ownershipPct: ownershipLinks.ownershipPct,
    confidence: ownershipLinks.confidence,
    citation: ownershipLinks.citation,
  })
  .from(assets)
  .leftJoin(ownershipLinks, eq(assets.id, ownershipLinks.assetId))
  // GDPR gate: only surface owners who are public figures. A non-public-figure
  // owner must not appear on this page even if an ownership link exists.
  .leftJoin(people, and(eq(ownershipLinks.personId, people.id), eq(people.isPublicFigure, 1)))
  .orderBy(asc(assets.assetType), asc(assets.name))) as Array<{
  id: string;
  name: string;
  assetType: string;
  description: string | null;
  location: string | null;
  estimatedValueCents: number | null;
  personId: string | null;
  personSlug: string | null;
  fullName: string | null;
  primaryOrg: string | null;
  ownershipPct: number | null;
  confidence: string | null;
  citation: string | null;
}>;

// Group by asset
const assetMap = new Map<string, AssetRow>();
for (const row of assetRows) {
  if (!assetMap.has(row.id)) {
    assetMap.set(row.id, {
      id: row.id,
      name: row.name,
      assetType: row.assetType,
      description: row.description,
      location: row.location,
      estimatedValueCents: row.estimatedValueCents,
      owners: [],
    });
  }
  const asset = assetMap.get(row.id)!;
  if (row.personSlug) {
    asset.owners.push({
      personId: row.personId!,
      personSlug: row.personSlug,
      fullName: row.fullName!,
      primaryOrg: row.primaryOrg,
      ownershipPct: row.ownershipPct,
      confidence: (row.confidence ?? "low") as Confidence,
      citation: row.citation,
    });
  }
}

const assetList: AssetRow[] = [...assetMap.values()];
assetList.sort((a, b) => a.name.localeCompare(b.name));

// Group by type for display
const typeOrder = ["real_estate", "vessel", "aircraft", "art", "company", "other"];
const grouped = new Map<string, AssetRow[]>();
for (const t of typeOrder) {
  const items = assetList.filter((a) => a.assetType === t);
  if (items.length > 0) grouped.set(t, items);
}
// Catch-all for any types not in the order list
for (const item of assetList) {
  if (!grouped.has(item.assetType)) {
    grouped.set(item.assetType, [item]);
  }
}

// Stats
// Company stakes (whole-company valuations) and physical assets (houses,
// yachts, jets, art) are different orders of magnitude and different kinds of
// claim. Summing them into one "combined value" is meaningless — a $1.2T
// company valuation swamps every mansion on the list. Report them separately.
const PHYSICAL_TYPES = ["real_estate", "vessel", "aircraft", "art"];
const physicalValueCents = assetList
  .filter((a) => PHYSICAL_TYPES.includes(a.assetType))
  .reduce((s, a) => s + (a.estimatedValueCents ?? 0), 0);
const companyValueCents = assetList
  .filter((a) => !PHYSICAL_TYPES.includes(a.assetType))
  .reduce((s, a) => s + (a.estimatedValueCents ?? 0), 0);
const highConfCount = assetList.filter((a) =>
  a.owners.every((o) => o.confidence === "high")
).length;
const mediumConfCount = assetList.filter((a) =>
  a.owners.some((o) => o.confidence === "medium")
).length;
const lowConfCount = assetList.filter((a) =>
  a.owners.some((o) => o.confidence === "low")
).length;

// ---------------------------------------------------------------------------
// UI
// ---------------------------------------------------------------------------

export default async function OwnershipPage() {
  // Chunk 10: multi-hop beneficial-ownership chains. Loaded separately from the
  // Slice-6 asset graph because each chain carries per-hop confidence and a
  // clickable citation, which the older single-edge model could not.
  const chains = await loadChains(50);

  return (
    <div className="max-w-5xl mx-auto px-6 py-12">
      <div className="mb-12">
        <p className="text-xs uppercase tracking-widest text-fg-muted mb-2">
          Slice 6 — Asset→Owner Graph
        </p>
        <h1 className="font-serif text-4xl font-semibold tracking-tight text-fg mb-4">
          What They Own
        </h1>
        <p className="text-lg text-fg-muted leading-relaxed max-w-2xl">
          Every net-worth estimate is just a number until you can point to a
          physical thing and say &ldquo;this belongs to that person.&rdquo; This
          is the graph: assets resolved to humans with a confidence score and a
          citation you can verify.
        </p>
        <p className="text-sm text-fg-faint mt-3 max-w-2xl">
          The &ldquo;moat&rdquo; of Track the Rich: no other tracker grounds
          estimates in citable, physical ownership.
        </p>
      </div>

      {/* Chunk 10 — ownership chains */}
      {chains.length > 0 && (
        <section className="mb-12">
          <h2 className="font-serif text-2xl font-semibold text-fg mb-1 flex items-center gap-3">
            Ownership chains
            <span className="font-sans text-sm font-normal text-fg-faint">
              {chains.length}
            </span>
          </h2>
          <p className="text-sm text-fg-muted leading-relaxed max-w-2xl mb-5">
            Property → company → person, one hop per row. Each hop keeps its own
            confidence; the chain confidence is the product, and anything under
            0.5 renders as a possible link, never as fact. Every label links to
            the public record it came from.
          </p>

          <div className="space-y-4">
            {chains.map((chain, ci) => {
              const companyUrl = `https://find-and-update.company-information.service.gov.uk/company/${encodeURIComponent(
                chain.company.entityId.replace(/^ch:/, "")
              )}`;
              const isPossible = chain.verdict === "possible-link";
              return (
                <div
                  key={`${chain.property.entityId}-${chain.person.entityId}-${ci}`}
                  className={`border border-border rounded-md bg-white overflow-hidden ${
                    isPossible ? "opacity-90" : ""
                  }`}
                >
                  <div className="px-5 py-3 bg-surface border-b border-border flex items-center justify-between flex-wrap gap-3">
                    <div className="flex items-center gap-3">
                      <span
                        className={`inline-block px-2 py-0.5 rounded text-xs font-mono font-medium ${
                          isPossible
                            ? "bg-fg-muted/10 text-fg-muted"
                            : "bg-success/10 text-success"
                        }`}
                      >
                        {isPossible ? "POSSIBLE LINK" : "SOURCED"}
                      </span>
                      <span className="font-mono text-sm text-fg">
                        chain confidence {chain.confidence.toFixed(2)}
                      </span>
                    </div>
                    <span className="text-xs text-fg-faint">
                      weakest hop: {chain.weakestHop.fromLabel} → {chain.weakestHop.toLabel}{" "}
                      ({chain.weakestHop.confidence.toFixed(2)})
                    </span>
                  </div>

                  <div className="px-5 py-4 space-y-3">
                    {/* property */}
                    <ChainRow
                      index="1"
                      label="Property"
                      name={chain.property.label}
                      sub={chain.asset?.location ?? chain.property.entityId}
                      href={
                        chain.asset?.sourceUrl ?? `#${chain.property.entityId}`
                      }
                      confidence={chain.hops[0]?.confidence ?? 0}
                    />
                    {/* company */}
                    <ChainRow
                      index="2"
                      label="Company"
                      name={chain.company.label}
                      sub={chain.company.entityId}
                      href={companyUrl}
                      confidence={chain.hops[1]?.confidence ?? 0}
                    />
                    {/* person */}
                    <ChainRow
                      index="3"
                      label={chain.person.personSlug ? "Person" : "Beneficial owner"}
                      name={chain.person.label}
                      sub={
                        chain.person.personSlug
                          ? `/people/${chain.person.personSlug}`
                          : "register record (no profile here)"
                      }
                      href={chain.hops[1]?.sourceUrl ?? "#"}
                      confidence={chain.hops[1]?.confidence ?? 0}
                      personHref={
                        chain.person.personSlug
                          ? `/people/${chain.person.personSlug}`
                          : null
                      }
                    />
                  </div>
                </div>
              );
            })}
          </div>
        </section>
      )}

      {/* Summary bar */}
      <div className="border border-border rounded-md bg-surface px-6 py-5 mb-8 flex items-center gap-12 flex-wrap">
        <div>
          <p className="text-xs uppercase tracking-widest text-fg-muted mb-1">
            Assets tracked
          </p>
          <p className="font-mono text-2xl font-medium text-fg">
            {assetList.length}
          </p>
        </div>
        <div>
          <p className="text-xs uppercase tracking-widest text-fg-muted mb-1">
            Sourced chains
          </p>
          <p className="font-mono text-2xl font-medium text-fg">
            {chains.length}
          </p>
        </div>
        <div>
          <p className="text-xs uppercase tracking-widest text-fg-muted mb-1">
            Physical assets
          </p>
          <p className="font-mono text-2xl font-medium text-fg">
            {formatB(physicalValueCents)}
          </p>
        </div>
        <div>
          <p className="text-xs uppercase tracking-widest text-fg-muted mb-1">
            Company stakes
          </p>
          <p className="font-mono text-2xl font-medium text-fg">
            {formatB(companyValueCents)}
          </p>
        </div>
        <div className="flex gap-6 pl-8 border-l border-border">
          <div>
            <p className="text-xs uppercase tracking-widest text-fg-muted mb-1">
              High confidence
            </p>
            <p className="font-mono text-lg font-medium text-success">
              {highConfCount}
            </p>
          </div>
          <div>
            <p className="text-xs uppercase tracking-widest text-fg-muted mb-1">
              Medium
            </p>
            <p className="font-mono text-lg font-medium text-warning">
              {mediumConfCount}
            </p>
          </div>
          <div>
            <p className="text-xs uppercase tracking-widest text-fg-muted mb-1">
              Low
            </p>
            <p className="font-mono text-lg font-medium text-fg-muted">
              {lowConfCount}
            </p>
          </div>
        </div>
      </div>

      {/* Asset cards by type */}
      {Array.from(grouped.entries()).map(([type, items]) => (
        <section key={type} className="mb-12">
          <h2 className="font-serif text-xl font-semibold text-fg mb-4 flex items-center gap-3">
            <span className="text-2xl">{assetTypeIcon(type)}</span>
            {assetTypeLabel(type)}
            <span className="font-sans text-sm font-normal text-fg-faint">
              {items.length}
            </span>
          </h2>

          <div className="space-y-4">
            {items.map((asset) => (
              <div
                key={asset.id}
                className="border border-border rounded-md bg-white overflow-hidden"
              >
                <div className="px-5 py-4 flex items-start gap-4">
                  {/* Value */}
                  <div className="flex-shrink-0 w-24 text-right">
                    {asset.estimatedValueCents ? (
                      <>
                        <p className="font-mono text-lg font-medium text-fg">
                          {formatB(asset.estimatedValueCents)}
                        </p>
                        <p className="text-xs text-fg-faint mt-0.5">est.</p>
                      </>
                    ) : (
                      <p className="font-mono text-lg text-fg-faint">—</p>
                    )}
                  </div>

                  {/* Name & meta */}
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 mb-1">
                      <h3 className="font-medium text-fg text-base">
                        {asset.name}
                      </h3>
                      <span className="text-xs text-fg-faint font-mono">
                        {assetTypeLabel(asset.assetType)}
                      </span>
                    </div>
                    {asset.description && (
                      <p className="text-sm text-fg-muted leading-relaxed mb-1">
                        {asset.description}
                      </p>
                    )}
                    {asset.location && (
                      <p className="text-xs text-fg-faint">
                        {asset.location}
                      </p>
                    )}
                  </div>

                  {/* Owners */}
                  <div className="flex-shrink-0 w-56">
                    <div className="space-y-2">
                      {asset.owners.map((owner, i) => (
                        <div key={`${owner.personSlug}-${i}`} className="border-l-2 border-border pl-3 py-0.5">
                          <a
                            href={`/people/${owner.personSlug}`}
                            className="font-medium text-sm text-accent hover:text-fg transition-colors"
                          >
                            {owner.fullName}
                          </a>
                          {owner.primaryOrg && (
                            <span className="text-xs text-fg-faint ml-2">
                              {owner.primaryOrg}
                            </span>
                          )}
                          <div className="flex items-center gap-2 mt-1">
                            <span
                              className={`font-mono text-xs ${
                                owner.ownershipPct != null
                                  ? "text-fg"
                                  : "text-fg-faint"
                              }`}
                            >
                              {owner.ownershipPct != null
                                ? `${owner.ownershipPct.toFixed(1)}%`
                                : "unknown"}
                            </span>
                            <span
                              dangerouslySetInnerHTML={{
                                __html: confidenceBadge(owner.confidence),
                              }}
                            />
                          </div>
                          {i < asset.owners.length - 1 && (
                            <div className="border-t border-dashed border-border my-1" />
                          )}
                        </div>
                      ))}
                      {asset.owners.length === 0 && (
                        <p className="text-xs text-fg-faint italic">
                          No ownership data
                        </p>
                      )}
                    </div>
                  </div>
                </div>

                {/* Citation footer */}
                {asset.owners.some((o) => o.citation) && (
                  <div className="px-5 py-2.5 bg-surface border-t border-border">
                    <p className="text-xs text-fg-faint">
                      <span className="text-fg-muted font-medium">Citation:</span>{" "}
                      {asset.owners
                        .filter((o) => o.citation)
                        .map((o) => o.citation!)
                        .join(" · ")}
                    </p>
                  </div>
                )}
              </div>
            ))}
          </div>
        </section>
      ))}

      <div className="mt-8 text-xs text-fg-faint leading-relaxed">
        <p>
          Source: SEC EDGAR filings, FAA registry, USCG vessel database,
          auction house records, and public disclosures. Ownership chains draw
          on HM Land Registry open data (Price Paid / OCOD, OGL) and Companies
          House PSC registers (OGL). Confidence levels reflect whether the
          ownership is directly filed (high), inferred from public records
          (medium), or estimated (low).
        </p>
        <p className="mt-2">
          Assets with &ldquo;low&rdquo; confidence are flagged but not
          discarded — they signal where the paper trail is thin, which is
          often where the real wealth hides. Ownership chains below 0.5 chain
          confidence are shown as possible links, never as fact.
        </p>
      </div>
    </div>
  );
}
