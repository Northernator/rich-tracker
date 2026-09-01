import { db } from "@/lib/db";
import {
  events,
  assets,
  ownershipLinks,
  people,
  equityHoldings,
  stockSnapshots,
  eventAssetLinks,
  eventImpacts,
} from "@/lib/db/schema";
import { asc, eq, inArray } from "drizzle-orm";
import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Track the Rich — Events",
  description: "Real-world events near billionaire assets. See how market moves connect to balance sheets.",
};

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type EventType =
  | "market_crash"
  | "regulation"
  | "lawsuit"
  | "earthquake"
  | "product_launch"
  | "merger"
  | "scandal"
  | "earnings"
  | "other"
  | "insider_sell"
  | "insider_buy"
  | "pledge"
  | "sec_enforcement";

interface OwnerInfo {
  personSlug: string;
  fullName: string;
  primaryOrg: string | null;
  tickers: Array<{ ticker: string; shares: number; estimated: number }>;
}

interface EventImpact {
  marketDeltaPct: number | null;
  indexDeltaPct: number | null;
  excessPct: number | null;
  impactNote: string | null;
}

interface NearbyAsset {
  id: string;
  name: string;
  assetType: string;
  estimatedValueCents: number | null;
  distanceKm: number;
  owners: OwnerInfo[];
  impacts: EventImpact[];
}

interface FilingGroup {
  count: number;
  ticker?: string;
  totalShares: number;
  personName: string;
  filedAt: string;
}

interface EventRow {
  id: string;
  type: EventType;
  title: string;
  description: string | null;
  lat: number | null;
  lng: number | null;
  occurredAt: string;
  impactNote?: string | null;
  sourceId: string | null;
  sourceUrl: string | null;
  nearbyAssets: NearbyAsset[];
  /** Present when several insider_sell rows share one SEC filing (source_url). */
  filingGroup?: FilingGroup;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function haversineKm(
  lat1: number,
  lng1: number,
  lat2: number,
  lng2: number
): number {
  const R = 6371;
  const dLat = ((lat2 - lat1) * Math.PI) / 180;
  const dLng = ((lng2 - lng1) * Math.PI) / 180;
  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos((lat1 * Math.PI) / 180) *
      Math.cos((lat2 * Math.PI) / 180) *
      Math.sin(dLng / 2) *
      Math.sin(dLng / 2);
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function formatB(cents: number): string {
  if (cents <= 0) return "—";
  const billions = cents / 100 / 1e9;
  if (billions >= 1) return `$${billions.toFixed(1)}B`;
  const millions = cents / 100 / 1e6;
  return `$${millions.toFixed(0)}M`;
}

/**
 * Collapse multiple insider_sell rows that belong to the same SEC Form 4 filing
 * (sharing a source_url) into a single card. The rows are near-identical
 * transaction lines from one filing day; rendering them individually produces
 * hundreds of duplicate cards. Earthquakes, SEC enforcement actions and pledges
 * each carry distinct source_urls, so they are left as individual cards.
 */
const INSIDER_SHARE_RE = /^(.+?) sells ([\d,]+) (\w+) shares$/;

function groupInsiderFilings(rows: EventRow[]): EventRow[] {
  const byFiling = new Map<string, EventRow[]>();
  const others: EventRow[] = [];

  for (const r of rows) {
    if (r.type === "insider_sell" && r.sourceUrl) {
      const arr = byFiling.get(r.sourceUrl);
      if (arr) arr.push(r);
      else byFiling.set(r.sourceUrl, [r]);
    } else {
      others.push(r);
    }
  }

  const grouped: EventRow[] = [];
  for (const [url, members] of byFiling) {
    if (members.length === 1) {
      others.push(members[0]);
      continue;
    }

    let personName = members[0].title;
    let ticker: string | undefined;
    let totalShares = 0;
    let minDate = members[0].occurredAt;
    for (const m of members) {
      if (m.occurredAt < minDate) minDate = m.occurredAt;
      const mm = m.title.match(INSIDER_SHARE_RE);
      if (mm) {
        personName = mm[1];
        ticker = mm[3];
        totalShares += parseInt(mm[2].replace(/,/g, ""), 10);
      }
    }

    const rep = members[0];
    grouped.push({
      ...rep,
      id: `filing:${url}`,
      title: ticker ? `${personName} — ${ticker} insider sales` : `${personName} insider sales`,
      description:
        `Form 4 insider filing · ${members.length} transactions` +
        (ticker ? ` · ${ticker}` : "") +
        (totalShares > 0 ? ` · ${totalShares.toLocaleString("en-US")} shares total` : ""),
      occurredAt: minDate,
      filingGroup: { count: members.length, ticker, totalShares, personName, filedAt: minDate },
      nearbyAssets: [],
    });
  }

  const out = [...others, ...grouped];
  out.sort((a, b) => a.occurredAt.localeCompare(b.occurredAt));
  return out;
}

function typeLabel(type: EventType): string {
  const map: Record<EventType, string> = {
    market_crash: "Market Crash",
    regulation: "Regulation",
    lawsuit: "Lawsuit",
    earthquake: "Earthquake",
    product_launch: "Product Launch",
    merger: "Merger",
    scandal: "Scandal",
    earnings: "Earnings",
    other: "Other",
    insider_sell: "Insider Sale",
    insider_buy: "Insider Purchase",
    pledge: "Share Pledge",
    sec_enforcement: "SEC Action",
  };
  return map[type];
}

function typeColor(type: EventType): string {
  const map: Record<EventType, string> = {
    market_crash: "text-danger",
    regulation: "text-warning",
    lawsuit: "text-warning",
    earthquake: "text-danger",
    product_launch: "text-success",
    merger: "text-accent",
    scandal: "text-danger",
    earnings: "text-success",
    other: "text-fg-muted",
    insider_sell: "text-warning",
    insider_buy: "text-success",
    pledge: "text-accent",
    sec_enforcement: "text-danger",
  };
  return map[type];
}

function typeBg(type: EventType): string {
  const map: Record<EventType, string> = {
    market_crash: "bg-danger/10",
    regulation: "bg-warning/10",
    lawsuit: "bg-warning/10",
    earthquake: "bg-danger/10",
    product_launch: "bg-success/10",
    merger: "bg-accent/10",
    scandal: "bg-danger/10",
    earnings: "bg-success/10",
    other: "bg-fg-muted/10",
    insider_sell: "bg-warning/10",
    insider_buy: "bg-success/10",
    pledge: "bg-accent/10",
    sec_enforcement: "bg-danger/10",
  };
  return map[type];
}

const ASSET_TYPE_ICON: Record<string, string> = {
  real_estate: "⌂",
  vessel: "⚓",
  aircraft: "✈",
  art: "◆",
  company: "◈",
  other: "•",
};

// ---------------------------------------------------------------------------
// Data layer
// ---------------------------------------------------------------------------

const PROXIMITY_RADIUS_KM = 500;

async function fetchEvents(): Promise<EventRow[]> {
  const allEvents = await db
    .select()
    .from(events)
    .orderBy(asc(events.occurredAt));

  // Explicit column list: `select()` would also request source_url, which only
  // exists after migration 0012 (npm run fix:data2).
  const allAssets = await db
    .select({
      id: assets.id,
      name: assets.name,
      assetType: assets.assetType,
      description: assets.description,
      location: assets.location,
      estimatedValueCents: assets.estimatedValueCents,
      lat: assets.lat,
      lng: assets.lng,
    })
    .from(assets)
    .orderBy(asc(assets.id));
  const assetsWithCoords = allAssets.filter((a) => a.lat != null && a.lng != null);

  // Latest stock prices
  const latestPrices = (await db
    .select({ ticker: stockSnapshots.ticker, priceCents: stockSnapshots.priceCents })
    .from(stockSnapshots)
    .orderBy(asc(stockSnapshots.asOf))) as Array<{ ticker: string; priceCents: number }>;
  const priceByTicker = new Map<string, number>();
  for (const s of latestPrices) {
    priceByTicker.set(s.ticker, s.priceCents);
  }

  // All equity holdings
  const allHoldings = await db
    .select()
    .from(equityHoldings)
    .orderBy(asc(equityHoldings.id));
  const holdingsByPerson = new Map<string, typeof allHoldings[number][]>();
  for (const h of allHoldings) {
    if (!holdingsByPerson.has(h.personId)) holdingsByPerson.set(h.personId, []);
    holdingsByPerson.get(h.personId)!.push(h);
  }

  // People lookup
  const allPeople = await db.select().from(people).where(eq(people.isPublicFigure, 1));
  const peopleById = new Map<string, typeof allPeople[number]>();
  for (const p of allPeople) {
    peopleById.set(p.id, p);
  }

  // Ownership lookup by asset
  const ownershipByAsset = new Map<string, Array<{ personId: string; confidence: string }>>();
  const ownershipRows = await db
    .select({
      assetId: ownershipLinks.assetId,
      personId: ownershipLinks.personId,
      ownershipPct: ownershipLinks.ownershipPct,
      confidence: ownershipLinks.confidence,
      citation: ownershipLinks.citation,
    })
    .from(ownershipLinks);
  for (const link of ownershipRows) {
    if (!ownershipByAsset.has(link.assetId)) ownershipByAsset.set(link.assetId, []);
    ownershipByAsset.get(link.assetId)!.push({ personId: link.personId, confidence: link.confidence });
  }

  const result: EventRow[] = [];

  for (const evt of allEvents) {
    if (evt.lat == null || evt.lng == null) {
      result.push({ ...evt, type: evt.type as EventType, nearbyAssets: [] });
      continue;
    }

    const nearby: NearbyAsset[] = [];
    for (const asset of assetsWithCoords) {
      const dist = haversineKm(evt.lat!, evt.lng!, asset.lat!, asset.lng!);
      if (dist > PROXIMITY_RADIUS_KM) continue;

      const links = ownershipByAsset.get(asset.id) ?? [];
      const owners: OwnerInfo[] = [];
      for (const link of links) {
        const person = peopleById.get(link.personId);
        if (!person) continue;
        const holdings = holdingsByPerson.get(link.personId) ?? [];
        owners.push({
          personSlug: person.slug,
          fullName: person.fullName,
          primaryOrg: person.primaryOrg,
          tickers: holdings.map((h) => ({
            ticker: h.ticker,
            shares: h.shares,
            estimated: h.estimated,
          })),
        });
      }

      nearby.push({
        id: asset.id,
        name: asset.name,
        assetType: asset.assetType,
        estimatedValueCents: asset.estimatedValueCents,
        distanceKm: Math.round(dist),
        owners,
        impacts: [],
      });
    }

    // Attach pre-computed impacts from event_impacts table
    const linkIds = new Map<string, string>();
    const linkIdToAssetId = new Map<string, string>();
    for (const link of await db
      .select()
      .from(eventAssetLinks)
      .where(eq(eventAssetLinks.eventId, evt.id))) {
      linkIds.set(link.assetId, link.id);
      linkIdToAssetId.set(link.id, link.assetId);
    }
    const impactRows = await db
      .select()
      .from(eventImpacts)
      .where(inArray(eventImpacts.eventAssetLinkId, [...linkIds.values()]));
    for (const imp of impactRows) {
      const assetId = linkIdToAssetId.get(imp.eventAssetLinkId);
      const asset = nearby.find((a) => a.id === assetId);
      if (asset) asset.impacts.push(imp);
    }

    nearby.sort((a, b) => a.distanceKm - b.distanceKm);
    result.push({ ...evt, type: evt.type as EventType, nearbyAssets: nearby });
  }

  return groupInsiderFilings(result);
}

// ---------------------------------------------------------------------------
// UI
// ---------------------------------------------------------------------------

export default async function EventsPage() {
  const eventRows = await fetchEvents();

  return (
    <div className="max-w-5xl mx-auto px-6 py-12">
      <div className="mb-12">
        <p className="text-xs uppercase tracking-widest text-fg-muted mb-2">
          Slice 8 — Event Impact Correlation
        </p>
        <h1 className="font-serif text-4xl font-semibold tracking-tight text-fg mb-4">
          Events &amp; Impact
        </h1>
        <p className="text-lg text-fg-muted leading-relaxed max-w-2xl">
          When a real-world event fires near a billionaire&rsquo;s asset, the
          impact doesn&rsquo;t stay abstract. The owner&rsquo;s ticker lights up
          beside it — connecting market noise to balance-sheet reality.
        </p>
        <p className="text-sm text-fg-faint mt-3">
          Events within <span className="font-mono">{PROXIMITY_RADIUS_KM} km</span> of an owned asset
          are linked. Tickers are highlighted when the event is within range.
        </p>
      </div>

      {eventRows.length === 0 && (
        <div className="text-center py-20 text-fg-faint">
          <p className="font-serif text-xl">No events yet.</p>
          <p className="text-sm mt-2">Run the seed script to populate demo events.</p>
        </div>
      )}

      <div className="space-y-8">
        {eventRows.map((evt) => (
          <article
            key={evt.id}
            className="border border-border rounded-md bg-white overflow-hidden"
          >
            {/* Event header */}
            <div className="px-5 py-4 flex items-start gap-4">
              <div className="flex-shrink-0 w-28">
                <span
                  className={`inline-block px-2 py-1 rounded text-xs font-mono font-medium ${typeBg(evt.type)} ${typeColor(evt.type)}`}
                >
                  {typeLabel(evt.type)}
                </span>
                <p className="text-xs text-fg-faint font-mono mt-2">
                  {new Date(evt.occurredAt).toLocaleDateString("en-US", {
                    year: "numeric",
                    month: "short",
                    day: "numeric",
                  })}
                </p>
                {evt.filingGroup && (
                  <p className="text-xs text-fg-faint font-mono mt-2">
                    Form 4 · {evt.filingGroup.count} txns
                    {evt.filingGroup.ticker ? ` · ${evt.filingGroup.ticker}` : ""}
                  </p>
                )}
              </div>

              <div className="flex-1 min-w-0">
                <h2 className="font-medium text-fg text-lg leading-snug">
                  {evt.title}
                </h2>
                {evt.description && (
                  <p className="text-sm text-fg-muted leading-relaxed mt-1">
                    {evt.description}
                  </p>
                )}
                {evt.impactNote && (
                  <p className="text-sm text-fg-muted leading-relaxed mt-1 italic">
                    Impact: {evt.impactNote}
                  </p>
                )}
                {evt.lat != null && evt.lng != null && (
                  <p className="text-xs text-fg-faint font-mono mt-1">
                    {evt.lat.toFixed(4)}°, {evt.lng.toFixed(4)}°
                  </p>
                )}
                {evt.sourceUrl && (
                  <a
                    href={evt.sourceUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-xs text-fg-faint font-mono mt-1 inline-block hover:text-fg-muted"
                  >
                    Source ↗
                  </a>
                )}
              </div>
            </div>

            {/* Nearby asset owners */}
            {evt.nearbyAssets.length > 0 && (
              <div className="border-t border-border bg-surface">
                <div className="px-5 py-3 flex items-center gap-3">
                  <span className="text-xs uppercase tracking-widest text-fg-muted font-medium">
                    Nearby Assets
                  </span>
                  <span className="text-xs text-fg-faint">
                    {evt.nearbyAssets.length} within {PROXIMITY_RADIUS_KM} km
                  </span>
                </div>

                <div className="px-5 pb-4 space-y-3">
                  {evt.nearbyAssets.map((asset) => (
                    <div
                      key={asset.id}
                      className="border border-border rounded-md bg-white overflow-hidden"
                    >
                      <div className="px-4 py-3 flex items-center gap-3">
                        <span className="text-lg">
                          {ASSET_TYPE_ICON[asset.assetType] ?? "•"}
                        </span>
                        <div className="flex-1 min-w-0">
                          <p className="font-medium text-sm text-fg truncate">
                            {asset.name}
                          </p>
                          <p className="text-xs text-fg-faint font-mono">
                            {asset.distanceKm} km away
                            {asset.estimatedValueCents != null &&
                              ` · ${formatB(asset.estimatedValueCents)}`}
                          </p>
                        </div>
                      </div>

                      {asset.owners.length > 0 && (
                        <div className="border-t border-border px-4 py-3">
                          <div className="space-y-2">
                            {asset.owners.map((owner, oi) => (
                              <div key={`${owner.personSlug}-${oi}`}>
                                <div className="flex items-center gap-2 mb-1.5">
                                  <a
                                    href={`/people/${owner.personSlug}`}
                                    className="text-sm font-medium text-accent hover:text-fg transition-colors"
                                  >
                                    {owner.fullName}
                                  </a>
                                  {owner.primaryOrg && (
                                    <span className="text-xs text-fg-faint">
                                      {owner.primaryOrg}
                                    </span>
                                  )}
                                </div>
                                <div className="flex flex-wrap gap-1.5">
                                  {owner.tickers.map((t) => (
                                    <span
                                      key={t.ticker}
                                      className="inline-flex items-center gap-1 px-2 py-0.5 rounded bg-accent/10 text-accent font-mono text-xs font-medium"
                                    >
                                      {t.ticker}
                                      <span className="text-accent/60">
                                        {t.estimated ? "est." : ""}
                                      </span>
                                    </span>
                                  ))}
                                  {owner.tickers.length === 0 && (
                                    <span className="text-xs text-fg-faint italic">
                                      No equity holdings recorded
                                    </span>
                                  )}
                                </div>
                              </div>
                            ))}
                          </div>
                        </div>
                      )}

                      {asset.owners.length === 0 && (
                        <div className="border-t border-border px-4 py-2.5">
                          <p className="text-xs text-fg-faint italic">
                            No ownership data linked
                          </p>
                        </div>
                      )}

                      {asset.impacts.length > 0 && (
                        <div className="border-t border-border px-4 py-3 bg-surface/50">
                          <p className="text-xs uppercase tracking-widest text-fg-muted font-medium mb-2">
                            Impact
                          </p>
                          <div className="space-y-2">
                            {asset.impacts.map((imp, i) => (
                              <div key={i}>
                                {imp.impactNote && (
                                  <p className="text-xs text-fg leading-relaxed">
                                    {imp.impactNote}
                                  </p>
                                )}
                                {(imp.marketDeltaPct != null ||
                                  imp.indexDeltaPct != null ||
                                  imp.excessPct != null) && (
                                  <div className="mt-1.5 flex flex-wrap gap-2">
                                    {imp.marketDeltaPct != null && (
                                      <span className={`text-xs font-mono font-medium ${imp.marketDeltaPct >= 0 ? "text-success" : "text-danger"}`}>
                                        {imp.marketDeltaPct >= 0 ? "+" : ""}{imp.marketDeltaPct.toFixed(1)}%
                                      </span>
                                    )}
                                    {imp.indexDeltaPct != null && (
                                      <span className="text-xs text-fg-muted font-mono">
                                        index {imp.indexDeltaPct >= 0 ? "+" : ""}{imp.indexDeltaPct.toFixed(1)}%
                                      </span>
                                    )}
                                    {imp.excessPct != null && (
                                      <span className={`text-xs font-mono font-medium ${imp.excessPct >= 0 ? "text-success" : "text-danger"}`}>
                                        excess {imp.excessPct >= 0 ? "+" : ""}{imp.excessPct.toFixed(1)}%
                                      </span>
                                    )}
                                  </div>
                                )}
                              </div>
                            ))}
                          </div>
                        </div>
                      )}
                    </div>
                  ))}
                </div>
              </div>
            )}

            {evt.lat != null && evt.lng != null && evt.nearbyAssets.length === 0 && (
              <div className="border-t border-border px-5 py-3">
                <p className="text-xs text-fg-faint">
                  No owned assets within {PROXIMITY_RADIUS_KM} km — no detectable market effect.
                </p>
              </div>
            )}
          </article>
        ))}
      </div>

      <div className="mt-8 text-xs text-fg-faint leading-relaxed">
        <p>
          Event locations are approximate. Proximity is calculated using the
          haversine formula. Tickers are highlighted in accent color when an
          event fires near one of the owner&rsquo;s assets. When no owned asset
          lies within range, the event is reported as having no detectable
          market effect — co-occurrence only, never causation.
        </p>
      </div>
    </div>
  );
}
