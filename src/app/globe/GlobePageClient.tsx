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

interface GlobePageClientProps {
  countries: CountryData[];
  assets: AssetPoint[];
  arcs: ArcRoute[];
  events: EventPoint[];
}

export default function GlobePageClient({ countries, assets, arcs, events }: GlobePageClientProps) {
  return (
    <>
      <div className="max-w-7xl mx-auto px-6 py-4 flex items-center justify-between border-b border-white/10">
        <div>
          <h1 className="font-serif text-2xl font-semibold tracking-tight">Global Distribution</h1>
          <p className="text-sm text-white/40 mt-0.5">
            {countries.reduce((s, c) => s + c.count, 0)} billionaires · ${countries.reduce((s, c) => s + c.totalWealthB, 0).toFixed(0)}B total · {assets.length} tracked assets
          </p>
        </div>
        <Link href="/" className="text-sm text-white/40 hover:text-white transition-colors">
          ← Rankings
        </Link>
      </div>
      <GlobeView countries={countries} assets={assets} arcs={arcs} events={events} />
    </>
  );
}
