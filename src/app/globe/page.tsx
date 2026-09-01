import { db } from "@/lib/db";
import {
  people,
  baselineEstimates,
  assets,
  ownershipLinks,
  events,
  valuationSnapshots,
} from "@/lib/db/schema";
import { sql, eq, desc } from "drizzle-orm";
import type { Metadata } from "next";
import GlobePageClient from "./GlobePageClient";

export const metadata: Metadata = {
  title: "Track the Rich — Global Distribution",
  description: "Where the world's billionaires live and what they own. Interactive globe view.",
};

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface CountryData {
  country: string;
  count: number;
  totalWealthB: number;
  people: Array<{ name: string; wealthB: number }>;
}

interface AssetPoint {
  assetId: string;
  lat: number | null;
  lng: number | null;
  name: string;
  valueCents: number | null;
  ownerName: string;
  ownerSlug: string;
  assetType: string;
  confidence: string;
  ownershipPct: number | null;
  location: string;
  sourceUrl: string;
}

interface ArcRoute {
  sourceLat: number;
  sourceLng: number;
  targetLat: number;
  targetLng: number;
  sourceOwner: string;
  assetName: string;
  valueB: number;
  confidence: string;
}

interface EventPoint {
  lat: number;
  lng: number;
  title: string;
  type: string;
  occurredAt: string;
  sourceId: string;
}

interface OwnerCard {
  slug: string;
  name: string;
  liveTotalCents: number;
  verifiability: number | null;
  pledgePct: number | null;
}

interface GlobeData {
  countries: CountryData[];
  assets: AssetPoint[];
  arcs: ArcRoute[];
  events: EventPoint[];
  assetCount: number;
  owners: OwnerCard[];
  eventTypes: string[];
  people: Array<{ name: string; country: string; wealthB: number }>;
}

// ---------------------------------------------------------------------------
// Data fetch
// ---------------------------------------------------------------------------

// Server-side country centers lookup (imported once)
import { COUNTRY_CENTERS } from "@/lib/geo/country-centers";

async function fetchGlobeData(): Promise<GlobeData> {
  // Latest estimate per person
  const rows = await db
    .select({
      country: people.country,
      name: people.fullName,
      wealthCents: baselineEstimates.netWorthCents,
      slug: people.slug,
    })
    .from(people)
    .innerJoin(baselineEstimates, eq(baselineEstimates.personId, people.id))
    .where(
      sql`
        ${people.isPublicFigure} = 1 AND
        ${baselineEstimates.asOf} = (
          SELECT MAX(be2.as_of) FROM ${baselineEstimates} be2
          WHERE be2.person_id = ${people.id}
        )
      `,
    )
    .orderBy(desc(baselineEstimates.netWorthCents));

  // Aggregate per country
  const byCountry = new Map<string, CountryData>();
  const peopleList: GlobeData["people"] = [];
  for (const row of rows) {
    const country = row.country ?? "Unknown";
    const wealthB = (row.wealthCents ?? 0) / 100 / 1e9;
    peopleList.push({ name: row.name, country, wealthB });
    if (!byCountry.has(country)) {
      byCountry.set(country, { country, count: 0, totalWealthB: 0, people: [] });
    }
    const c = byCountry.get(country)!;
    c.count++;
    c.totalWealthB += wealthB;
    c.people.push({ name: row.name, wealthB });
  }

  // True asset count — every row in the assets table, regardless of whether it
  // has coordinates or an ownership link. This is what the header must show.
  const assetCountRow = await db
    .select({ c: sql<number>`count(*)` })
    .from(assets);
  const assetCount = Number(assetCountRow[0]?.c ?? 0);

  // Assets with an ownership link. Coordinates and values may legitimately be
  // NULL (FAA aircraft carry a tail number, not a lat/lng; values are not
  // guessed). We return the whole linked set and let the client decide what is
  // plottable — never invent coordinates or values to make a point appear.
  const assetRows = await db
    .select({
      assetId: assets.id,
      assetName: assets.name,
      lat: assets.lat,
      lng: assets.lng,
      valueCents: assets.estimatedValueCents,
      assetType: assets.assetType,
      location: assets.location,
      sourceUrl: assets.sourceUrl,
      ownerName: people.fullName,
      ownerSlug: people.slug,
      confidence: ownershipLinks.confidence,
      ownershipPct: ownershipLinks.ownershipPct,
    })
    .from(assets)
    .innerJoin(ownershipLinks, eq(ownershipLinks.assetId, assets.id))
    .innerJoin(people, eq(people.id, ownershipLinks.personId))
    .orderBy(desc(assets.estimatedValueCents));

  const assetsList: AssetPoint[] = assetRows.map((r) => ({
    assetId: r.assetId,
    lat: r.lat,
    lng: r.lng,
    name: r.assetName,
    valueCents: r.valueCents,
    ownerName: r.ownerName ?? "Unknown",
    ownerSlug: r.ownerSlug ?? "",
    assetType: r.assetType ?? "unknown",
    confidence: r.confidence ?? "unknown",
    ownershipPct: r.ownershipPct ?? null,
    location: r.location ?? "",
    sourceUrl: r.sourceUrl ?? "",
  }));

  // Per-owner aggregates for the hover card. Sourced from valuation_snapshots
  // (the "honest number": baseline net worth, verifiability, pledged cents).
  const ownerSnapRows = await db
    .select({
      slug: people.slug,
      name: people.fullName,
      baselineCents: valuationSnapshots.baselineCents,
      verifiability: valuationSnapshots.verifiability,
      pledgedCents: valuationSnapshots.pledgedCents,
      ts: valuationSnapshots.ts,
    })
    .from(valuationSnapshots)
    .innerJoin(people, eq(people.id, valuationSnapshots.personId))
    .where(
      sql`${valuationSnapshots.personId} IN (SELECT person_id FROM ${ownershipLinks})`,
    )
    .orderBy(valuationSnapshots.personId, desc(valuationSnapshots.ts));

  // First row per slug is the latest snapshot (ordered ts DESC within person).
  const latestBySlug = new Map<
    string,
    { name: string; baselineCents: number; verifiability: number | null; pledgedCents: number }
  >();
  for (const r of ownerSnapRows) {
    if (!latestBySlug.has(r.slug)) latestBySlug.set(r.slug, r);
  }

  const owners: OwnerCard[] = [...latestBySlug.entries()].map(([slug, r]) => ({
    slug,
    name: r.name,
    liveTotalCents: r.baselineCents,
    verifiability: r.verifiability,
    pledgePct:
      r.baselineCents > 0 ? (r.pledgedCents / r.baselineCents) * 100 : null,
  }));

  // Arc routes: from asset location to owner's country center. Only assets
  // with coordinates can originate an arc.
  const arcRows = await db
    .select({
      assetName: assets.name,
      assetLat: assets.lat,
      assetLng: assets.lng,
      ownerName: people.fullName,
      ownershipPct: ownershipLinks.ownershipPct,
      confidence: ownershipLinks.confidence,
      country: people.country,
    })
    .from(ownershipLinks)
    .innerJoin(people, eq(people.id, ownershipLinks.personId))
    .innerJoin(assets, eq(assets.id, ownershipLinks.assetId))
    .where(sql`${assets.lat} IS NOT NULL AND ${assets.lng} IS NOT NULL`)
    .orderBy(desc(ownershipLinks.ownershipPct));

  const arcData: ArcRoute[] = arcRows
    .map((r) => {
      const target = COUNTRY_CENTERS[r.country ?? ""];
      if (!target || r.assetLat == null || r.assetLng == null) return null;
      return {
        sourceLat: r.assetLat,
        sourceLng: r.assetLng,
        targetLat: target.lat,
        targetLng: target.lng,
        sourceOwner: r.ownerName ?? "Unknown",
        assetName: r.assetName ?? "",
        valueB: (r.ownershipPct ?? 0) / 100,
        confidence: r.confidence ?? "unknown",
      };
    })
    .filter(Boolean) as ArcRoute[];

  // Events with coordinates — these are the only events that can be plotted.
  const eventRows = await db
    .select({
      id: events.id,
      title: events.title,
      type: events.type,
      lat: events.lat,
      lng: events.lng,
      occurredAt: events.occurredAt,
      sourceId: events.sourceId,
    })
    .from(events)
    .where(sql`${events.lat} IS NOT NULL AND ${events.lng} IS NOT NULL`)
    .orderBy(desc(events.occurredAt));

  const eventsList: EventPoint[] = eventRows.map((r) => ({
    lat: r.lat!,
    lng: r.lng!,
    title: r.title ?? "",
    type: r.type ?? "unknown",
    occurredAt: r.occurredAt ?? "",
    sourceId: r.sourceId ?? "",
  }));

  // Legend must list only event types that are actually present on the globe.
  const eventTypes = [...new Set(eventsList.map((e) => e.type))];

  const countries = [...byCountry.values()].sort((a, b) => b.totalWealthB - a.totalWealthB);

  return {
    countries,
    assets: assetsList,
    arcs: arcData,
    events: eventsList,
    assetCount,
    owners,
    eventTypes,
    people: peopleList,
  };
}

export default async function GlobePage() {
  const data = await fetchGlobeData();
  return <GlobePageClient {...data} />;
}
