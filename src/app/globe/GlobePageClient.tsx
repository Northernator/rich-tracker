"use client";

import dynamic from "next/dynamic";
import Link from "next/link";

const GlobeView = dynamic(() => import("@/components/GlobeView"), { ssr: false });

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

interface GlobePageClientProps {
  countries: CountryData[];
  assets: AssetPoint[];
  arcs: ArcRoute[];
  events: EventPoint[];
  assetCount: number;
  owners: OwnerCard[];
  eventTypes: string[];
}

export default function GlobePageClient({
  countries,
  assets,
  arcs,
  events,
  assetCount,
  owners,
  eventTypes,
}: GlobePageClientProps) {
  const totalBillionaires = countries.reduce((s, c) => s + c.count, 0);
  const totalWealthB = countries.reduce((s, c) => s + c.totalWealthB, 0);

  return (
    <>
      <div className="max-w-7xl mx-auto px-6 py-4 flex items-center justify-between border-b border-white/10">
        <div>
          <h1 className="font-serif text-2xl font-semibold tracking-tight">Global Distribution</h1>
          <p className="text-sm text-white/40 mt-0.5">
            {totalBillionaires} billionaires · ${totalWealthB.toFixed(0)}B total · {assetCount} tracked assets
          </p>
        </div>
        <Link href="/" className="text-sm text-white/40 hover:text-white transition-colors">
          ← Rankings
        </Link>
      </div>
      <GlobeView
        countries={countries}
        assets={assets}
        arcs={arcs}
        events={events}
        assetCount={assetCount}
        owners={owners}
        eventTypes={eventTypes}
      />
    </>
  );
}
