"use client";

import { useEffect, useRef, useState } from "react";
import Globe from "globe.gl";
import type { GlobeInstance } from "globe.gl";
import { getCountryCenter } from "@/lib/geo/country-centers";

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

// ---------------------------------------------------------------------------
// Color palette
// ---------------------------------------------------------------------------

const OWNER_COLORS: Record<string, string> = {
  "elon-musk": "#00c9a7",
  "jeff-bezos": "#4d9de0",
  "bernard-arnault": "#d4a017",
  "bill-gates": "#e8c547",
  "mark-zuckerberg": "#7c3aed",
  "larry-page": "#ef4444",
  "sergey-brin": "#f97316",
  "warren-buffett": "#22c55e",
  "larry-ellison": "#06b6d4",
  "steve-ballmer": "#8b5cf6",
};

function getOwnerColor(slug: string): string {
  return OWNER_COLORS[slug] ?? "#94a3b8";
}

function eventTypeColor(type: string): string {
  const map: Record<string, string> = {
    earthquake: "#f97316",
    insider_sell: "#38bdf8",
    sec_enforcement: "#ef4444",
    pledge: "#eab308",
    regulation: "#f59e0b",
    lawsuit: "#ec4899",
    product_launch: "#22c55e",
    market_crash: "#ef4444",
  };
  return map[type] ?? "#94a3b8";
}

function confidenceColor(confidence: string): string {
  const map: Record<string, string> = { high: "#22c55e", medium: "#f59e0b", low: "#ef4444" };
  return map[confidence] ?? "#94a3b8";
}

function assetTypeColor(type: string): string {
  const map: Record<string, string> = {
    real_estate: "#d4a017",
    vessel: "#4d9de0",
    aircraft: "#e8c547",
    art: "#7c3aed",
    company: "#22c55e",
    other: "#94a3b8",
  };
  return map[type] ?? "#94a3b8";
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function formatB(cents: number): string {
  return `$${(cents / 100 / 1e9).toFixed(1)}B`;
}

function formatBShort(cents: number): string {
  const b = cents / 100 / 1e9;
  return b >= 100 ? `$${b.toFixed(0)}B` : `$${b.toFixed(1)}B`;
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

interface GlobeViewProps {
  countries: CountryData[];
  assets: AssetPoint[];
  arcs: ArcRoute[];
  events: EventPoint[];
}

export default function GlobeView({ countries, assets, arcs, events }: GlobeViewProps) {
  const canvasRef = useRef<HTMLDivElement>(null);
  const globeRef = useRef<GlobeInstance | null>(null);
  const [selected, setSelected] = useState<{ type: string; data: any } | null>(null);
  const [hovered, setHovered] = useState<{ type: string; data: any } | null>(null);
  const [timeFilter, setTimeFilter] = useState<string>("all");
  const [showArcs, setShowArcs] = useState(true);
  const [showAssets, setShowAssets] = useState(true);
  const [showEvents, setShowEvents] = useState(true);
  const [showPeople, setShowPeople] = useState(true);

  const totalWealth = countries.reduce((s, c) => s + c.totalWealthB, 0);
  const totalCount = countries.reduce((s, c) => s + c.count, 0);

  // Filter events by time
  const filteredEvents = events.filter((e) => {
    if (timeFilter === "all") return true;
    const date = new Date(e.occurredAt);
    if (timeFilter === "6m") return date > new Date(Date.now() - 180 * 86400000);
    if (timeFilter === "1y") return date > new Date(Date.now() - 365 * 86400000);
    return true;
  });

  // Build arcs from assets if none provided
  const computedArcs: ArcRoute[] = arcs.length > 0
    ? arcs
    : (assets
        .map((a) => {
          const ownerCenter = getCountryCenter(
            countries.find((c) => c.people.some((p) => p.name === a.owner))?.country ?? null
          );
          if (!ownerCenter || a.lat == null || a.lng == null) return null;
          return {
            sourceLat: a.lat,
            sourceLng: a.lng,
            targetLat: ownerCenter.lat,
            targetLng: ownerCenter.lng,
            sourceOwner: a.owner,
            assetName: a.name,
            valueB: a.valueB,
            confidence: a.confidence,
          };
        })
        .filter((a): a is NonNullable<typeof a> => a !== null));

  // Build data arrays
  const countryPoints = countries
    .map((c) => {
      const center = getCountryCenter(c.country);
      if (!center) return null;
      return {
        lat: center.lat,
        lng: center.lng,
        count: c.count,
        totalWealthB: c.totalWealthB,
        country: c.country,
        color:
          c.totalWealthB >= 5000
            ? "#d4a017"
            : c.totalWealthB >= 1000
            ? "#e8c547"
            : c.totalWealthB >= 500
            ? "#4d9de0"
            : "#666666",
        radius: Math.max(0.5, Math.min(3, 0.4 + (c.count * 0.5 + c.totalWealthB / 1000 * 0.5) * 0.03)),
      };
    })
    .filter(Boolean);

  const assetBubbles = assets.map((a) => ({
    lat: a.lat,
    lng: a.lng,
    name: a.name,
    valueB: a.valueB,
    owner: a.owner,
    slug: a.slug,
    assetType: a.assetType,
    confidence: a.confidence,
    ownershipPct: a.ownershipPct,
    location: a.location,
    color: assetTypeColor(a.assetType),
    ownerColor: getOwnerColor(a.slug),
    radius: Math.max(1, Math.min(6, Math.sqrt(a.valueB) * 0.3)),
  }));

  const eventPoints = filteredEvents.map((e) => ({
    lat: e.lat,
    lng: e.lng,
    title: e.title,
    type: e.type,
    occurredAt: e.occurredAt,
    color: eventTypeColor(e.type),
    radius: 2,
  }));

  const arcData = computedArcs.map((a) => ({
    startLat: a.sourceLat,
    startLng: a.sourceLng,
    endLat: a.targetLat,
    endLng: a.targetLng,
    sourceOwner: a.sourceOwner,
    assetName: a.assetName,
    valueB: a.valueB,
    confidence: a.confidence,
    color: getOwnerColor(
      a.sourceOwner.toLowerCase().replace(/\s+/g, "-")
    ),
  }));

  useEffect(() => {
    if (!canvasRef.current) return;

    // Cast Globe to any for the constructor since types are tricky
    const GlobeClass = Globe as unknown as new (
      container: HTMLElement,
      config?: { waitForGlobeReady?: boolean; animateIn?: boolean }
    ) => GlobeInstance;

    const globe = new GlobeClass(canvasRef.current, {});

    // Set globe image after construction
    (globe as any)
      .globeImageUrl("/textures/earth-night.jpg")
      .bumpImageUrl("/textures/earth-topology.png")
      .showGraticules(true)
      .backgroundColor("rgba(0,0,0,0)");

    // Apply layers
    (globe as any)
      .pointsData(showPeople ? countryPoints : [])
      .pointColor((d: any) => d.color)
      .pointRadius((d: any) => d.radius)
      .pointAltitude((d: any) => d.radius * 0.1)
      .pointLabel((d: any) => `
        <div style="font-size:11px;color:#fff;font-family:monospace;">
          <strong>${d.country}</strong><br/>
          <span style="color:#f59e0b;">$${d.totalWealthB.toFixed(0)}B</span> · ${d.count} billionaire${d.count === 1 ? "" : "s"}
        </div>
      `)
      .onPointHover((point: any) => {
        if (point) setHovered({ type: "country", data: point });
        else setHovered(null);
      })
      .onPointClick((point: any) => {
        if (point) setSelected({ type: "country", data: point });
      });

    (globe as any)
      .arcsData(showArcs ? arcData : [])
      .arcColor((d: any) => d.color)
      .arcDashLength(0.4)
      .arcDashGap(0.6)
      .arcStroke(1.5)
      .arcLabel((d: any) => `
        <div style="font-size:11px;color:#fff;font-family:monospace;">
          <strong>${d.assetName}</strong><br/>
          ${d.sourceOwner} · ${d.valueB.toFixed(1)}B<br/>
          <span style="color:${confidenceColor(d.confidence)}">${d.confidence}</span>
        </div>
      `)
      .onArcHover((d: any) => {
        if (d) setHovered({ type: "arc", data: d });
        else setHovered(null);
      });

    (globe as any)
      .pointsData(showAssets ? assetBubbles : [])
      .pointColor((d: any) => d.color)
      .pointRadius((d: any) => d.radius)
      .pointAltitude((d: any) => 0.02)
      .pointLabel((d: any) => `
        <div style="font-size:11px;color:#fff;font-family:monospace;">
          <strong>${d.name}</strong><br/>
          ${d.owner}<br/>
          <span style="color:${d.ownerColor}">${formatBShort(d.valueB * 100 * 1e9)}</span><br/>
          ${d.assetType} · ${d.confidence}
        </div>
      `)
      .onPointHover((d: any) => {
        if (d) setHovered({ type: "asset", data: d });
        else setHovered(null);
      })
      .onPointClick((d: any) => {
        if (d) setSelected({ type: "asset", data: d });
      });

    (globe as any)
      .ringsData(showEvents ? eventPoints : [])
      .ringLat((d: any) => d.lat)
      .ringLng((d: any) => d.lng)
      .ringColor((d: any) => d.color)
      .ringRepeatPeriod(0)
      .ringMaxRadius(8)
      .ringPropagationSpeed(1);

    // Controls
    const controls = globe.controls();
    if (controls) {
      controls.autoRotate = true;
      controls.autoRotateSpeed = 0.3;
      controls.enableZoom = true;
      controls.enablePan = true;
    }

    globeRef.current = globe;

    // Resize handler
    const handleResize = () => {
      if (canvasRef.current && globeRef.current) {
        globeRef.current.width(canvasRef.current.clientWidth);
        globeRef.current.height(canvasRef.current.clientHeight);
      }
    };
    window.addEventListener("resize", handleResize);

    return () => {
      window.removeEventListener("resize", handleResize);
      if (globeRef.current) {
        globeRef.current._destructor();
      }
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Update layers when toggles change
  useEffect(() => {
    const g = globeRef.current;
    if (!g) return;

    (g as any)
      .pointsData(showPeople ? countryPoints : [])
      .arcsData(showArcs ? arcData : [])
      .pointsData(showAssets ? assetBubbles : [])
      .ringsData(showEvents ? eventPoints : []);
  }, [showArcs, showAssets, showEvents, showPeople]);

  return (
    <div className="flex h-[calc(100vh-65px)] bg-[#0a0a0a]">
      {/* Globe canvas */}
      <div ref={canvasRef} className="flex-1 relative" />

      {/* Sidebar */}
      <div className="w-80 border-l border-white/10 bg-black/40 backdrop-blur-md overflow-y-auto flex-shrink-0">
        {/* Header */}
        <div className="p-4 border-b border-white/10">
          <div className="text-xs uppercase tracking-widest text-white/40 mb-2">Global View</div>
          <div className="font-mono text-2xl text-amber-400">${totalWealth.toFixed(0)}B</div>
          <div className="text-xs text-white/40 mt-1">
            {totalCount} billionaire{totalCount === 1 ? "" : "s"} · {countries.length} countries · {assets.length} tracked asset{assets.length === 1 ? "" : "s"}
          </div>
        </div>

        {/* Layer toggles */}
        <div className="p-3 border-b border-white/10">
          <div className="text-xs uppercase tracking-widest text-white/40 mb-2">Layers</div>
          <div className="space-y-1.5">
            {[
              { key: "showPeople", label: "Country Clusters", count: countries.length },
              { key: "showAssets", label: "Tracked Assets", count: assets.length },
              { key: "showArcs", label: "Ownership Arcs", count: computedArcs.length },
              { key: "showEvents", label: "Events", count: filteredEvents.length },
            ].map(({ key, label, count }) => {
              const isActive =
                key === "showPeople"
                  ? showPeople
                  : key === "showAssets"
                  ? showAssets
                  : key === "showArcs"
                  ? showArcs
                  : showEvents;
              return (
                <button
                  key={key}
                  onClick={() => {
                    if (key === "showPeople") setShowPeople(!showPeople);
                    else if (key === "showAssets") setShowAssets(!showAssets);
                    else if (key === "showArcs") setShowArcs(!showArcs);
                    else setShowEvents(!showEvents);
                  }}
                  id={`layer-${key}`}
                  className={`w-full text-left px-3 py-1.5 rounded text-xs transition-colors flex items-center justify-between ${
                    isActive ? "bg-white/10" : "hover:bg-white/5"
                  }`}
                >
                  <span className="text-white/70">{label}</span>
                  <span className="font-mono text-white/40">{count}</span>
                </button>
              );
            })}
          </div>
        </div>

        {/* Time filter for events */}
        {events.length > 0 && (
          <div className="p-3 border-b border-white/10">
            <div className="text-xs uppercase tracking-widest text-white/40 mb-2">Events</div>
            <div className="flex gap-1">
              {(["all", "1y", "6m"] as const).map((t) => (
                <button
                  key={t}
                  onClick={() => setTimeFilter(t)}
                  className={`px-2 py-1 text-xs rounded ${
                    timeFilter === t
                      ? "bg-white/15 text-white"
                      : "text-white/40 hover:text-white/70"
                  }`}
                >
                  {t === "all" ? "All" : t === "1y" ? "1Y" : "6M"}
                </button>
              ))}
            </div>
          </div>
        )}

        {/* Selected / hovered detail */}
        {(selected || hovered) && (
          <div className="m-3 p-3 bg-white/5 rounded-lg border border-white/10">
            <div className="text-xs uppercase tracking-widest text-white/40 mb-2">
              {selected ? selected.type : hovered?.type}
            </div>
            {selected?.type === "country" && (
              <>
                <div className="font-mono text-lg text-amber-400 mb-2">
                  ${selected.data.totalWealthB.toFixed(0)}B
                </div>
                <div className="text-xs text-white/60 mb-2">{selected.data.country}</div>
                <div className="text-xs text-white/40">{selected.data.count} billionaire{selected.data.count === 1 ? "" : "s"}</div>
              </>
            )}
            {selected?.type === "asset" && (
              <>
                <div className="font-mono text-base text-amber-400 mb-1">
                  {formatBShort(selected.data.valueB * 100 * 1e9)}
                </div>
                <div className="text-xs text-white/80 mb-1">{selected.data.name}</div>
                <div className="text-xs text-white/50">{selected.data.owner}</div>
                <div className="text-xs text-white/40 mt-1">
                  {selected.data.assetType} · {selected.data.confidence}
                </div>
                <div className="text-xs text-white/30 mt-0.5">{selected.data.location}</div>
              </>
            )}
            {selected?.type === "event" && (
              <>
                <div className="font-mono text-base text-white mb-1">{selected.data.title}</div>
                <div className="text-xs" style={{ color: selected.data.color }}>
                  {selected.data.type}
                </div>
                <div className="text-xs text-white/40 mt-1">
                  {new Date(selected.data.occurredAt).toLocaleDateString()}
                </div>
              </>
            )}
            {hovered?.type === "arc" && (
              <>
                <div className="font-mono text-sm text-white mb-1">{hovered.data.assetName}</div>
                <div className="text-xs text-white/60">{hovered.data.sourceOwner}</div>
                <div className="text-xs text-white/40">
                  {formatBShort(hovered.data.valueB * 100 * 1e9)}
                </div>
                <div
                  className="text-xs mt-1"
                  style={{ color: confidenceColor(hovered.data.confidence) }}
                >
                  {hovered.data.confidence} confidence
                </div>
              </>
            )}
          </div>
        )}

        {/* Country list */}
        <div className="p-3">
          <div className="text-xs uppercase tracking-widest text-white/40 mb-2">Countries</div>
          <div className="space-y-0.5">
            {countries.map((c) => (
              <button
                key={c.country}
                onClick={() => {
                  const center = getCountryCenter(c.country);
                  if (center && globeRef.current) {
                    (globeRef.current as any).pointOfView(
                      { lat: center.lat, lng: center.lng, altitude: 2.5 },
                      800
                    );
                  }
                  setSelected({ type: "country", data: c });
                }}
                onMouseEnter={() => {
                  const center = getCountryCenter(c.country);
                  if (center) setHovered({ type: "country", data: { ...c, lat: center.lat, lng: center.lng } });
                }}
                onMouseLeave={() => setHovered(null)}
                className={`w-full text-left px-3 py-1.5 rounded transition-colors ${
                  selected?.type === "country" && selected.data?.country === c.country
                    ? "bg-white/15"
                    : "hover:bg-white/5"
                }`}
              >
                <div className="flex items-center justify-between">
                  <span className="text-sm text-white/80">{c.country}</span>
                  <span
                    className="font-mono text-xs"
                    style={{
                      color:
                        c.totalWealthB >= 5000
                          ? "#d4a017"
                          : c.totalWealthB >= 1000
                          ? "#e8c547"
                          : c.totalWealthB >= 500
                          ? "#4d9de0"
                          : "#666666",
                    }}
                  >
                    ${c.totalWealthB.toFixed(0)}B
                  </span>
                </div>
                <div className="text-xs text-white/40 mt-0.5">{c.count} billionaire{c.count === 1 ? "" : "s"}</div>
              </button>
            ))}
          </div>
        </div>

        {/* Legend */}
        <div className="p-3 border-t border-white/10 mt-auto">
          <div className="text-xs uppercase tracking-widest text-white/40 mb-2">Legend</div>
          <div className="space-y-1 text-xs text-white/50">
            <div className="flex items-center gap-2">
              <span className="w-2 h-2 rounded-full bg-amber-500 inline-block"></span>
              <span>Country cluster (wealth)</span>
            </div>
            <div className="flex items-center gap-2">
              <span className="w-2 h-2 rounded-full bg-amber-400 inline-block"></span>
              <span>Asset (real estate)</span>
            </div>
            <div className="flex items-center gap-2">
              <span className="w-2 h-2 rounded-full bg-blue-400 inline-block"></span>
              <span>Asset (vessel)</span>
            </div>
            <div className="flex items-center gap-2">
              <span className="w-2 h-2 rounded-full bg-purple-500 inline-block"></span>
              <span>Asset (art)</span>
            </div>
            <div className="flex items-center gap-2">
              <span
                className="w-2 h-2 rounded-full inline-block"
                style={{ backgroundColor: "#f97316" }}
              ></span>
              <span>Event (earthquake)</span>
            </div>
            <div className="flex items-center gap-2">
              <span
                className="w-2 h-2 rounded-full inline-block"
                style={{ backgroundColor: "#38bdf8" }}
              ></span>
              <span>Event (insider sell)</span>
            </div>
            <div className="flex items-center gap-2">
              <span
                className="w-2 h-2 rounded-full inline-block"
                style={{ backgroundColor: "#ef4444" }}
              ></span>
              <span>Event (SEC enforcement)</span>
            </div>
            <div className="mt-2 text-white/30 text-xs">
              Click a country to fly there · Hover for details
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
