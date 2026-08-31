import { db } from "@/lib/db";
import { people, baselineEstimates, assets, ownershipLinks, events } from "@/lib/db/schema";
import { sql, eq, desc } from "drizzle-orm";
import type { Metadata } from "next";
import GlobePageClient from "./GlobePageClient";

export const metadata: Metadata = {
  title: "Track the Rich — Global Distribution",
  description: "Where the world's billionaires live. Interactive globe view.",
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
  lat: number;
  lng: number;
  name: string;
  valueB: number;
  owner: string;
  slug: string;
  assetType: string;
  confidence: string;
  ownershipPct: number;
  location: string;
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

interface GlobeData {
  countries: CountryData[];
  assets: AssetPoint[];
  arcs: ArcRoute[];
  events: EventPoint[];
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

  // Assets with geolocation and owner links
  const assetRows = await db
    .select({
      assetId: assets.id,
      assetName: assets.name,
      lat: assets.lat,
      lng: assets.lng,
      valueCents: assets.estimatedValueCents,
      assetType: assets.assetType,
      location: assets.location,
      ownerName: people.fullName,
      ownerSlug: people.slug,
      ownershipPct: ownershipLinks.ownershipPct,
      confidence: ownershipLinks.confidence,
    })
    .from(assets)
    .innerJoin(ownershipLinks, eq(ownershipLinks.assetId, assets.id))
    .innerJoin(people, eq(people.id, ownershipLinks.personId))
    .where(sql`${assets.lat} IS NOT NULL AND ${assets.lng} IS NOT NULL`)
    .orderBy(desc(assets.estimatedValueCents));

  const assetsList: AssetPoint[] = assetRows.map((r) => ({
    lat: r.lat!,
    lng: r.lng!,
    name: r.assetName,
    valueB: (r.valueCents ?? 0) / 100 / 1e9,
    owner: r.ownerName ?? "Unknown",
    slug: r.ownerSlug ?? "",
    assetType: r.assetType ?? "unknown",
    confidence: r.confidence ?? "unknown",
    ownershipPct: r.ownershipPct ?? 0,
    location: r.location ?? "",
  }));

  // Arc routes: from asset location to owner's country center
  const arcRows = await db
    .select({
      assetName: assets.name,
      assetLat: assets.lat,
      assetLng: assets.lng,
      ownerName: people.fullName,
      ownerSlug: people.slug,
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

  // Events with coordinates
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

  const countries = [...byCountry.values()].sort((a, b) => b.totalWealthB - a.totalWealthB);

  return { countries, assets: assetsList, arcs: arcData, events: eventsList, people: peopleList };
}

export default async function GlobePage() {
  const data = await fetchGlobeData();
  return <GlobePageClient {...data} />;
}
