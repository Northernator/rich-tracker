"use client";

/* eslint-disable @typescript-eslint/no-explicit-any -- globe.gl's fluent API
   is dynamically typed; its accessor callbacks receive opaque datum objects. */
import { useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import Globe from "globe.gl";
import type { GlobeInstance } from "globe.gl";
import { getCountryCenter } from "@/lib/geo/country-centers";

// Fixed once at module load and used only for the coarse event time filters
// (6m / 1y). Kept out of render so we never call an impure function per paint.
const NOW_MS = Date.now();

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

/** Apply an alpha to a #rrggbb hex string. Returns rgba(). */
function hexToRgba(hex: string, alpha: number): string {
  const m = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hex);
  if (!m) return hex;
  const r = parseInt(m[1], 16);
  const g = parseInt(m[2], 16);
  const b = parseInt(m[3], 16);
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

const EVENT_TYPE_COLORS: Record<string, string> = {
  earthquake: "#f97316",
  insider_sell: "#38bdf8",
  sec_enforcement: "#ef4444",
  pledge: "#eab308",
  regulation: "#f59e0b",
  lawsuit: "#ec4899",
  product_launch: "#22c55e",
  market_crash: "#ef4444",
};

const EVENT_TYPE_LABELS: Record<string, string> = {
  earthquake: "Earthquake",
  insider_sell: "Insider sell",
  sec_enforcement: "SEC enforcement",
  pledge: "Pledge",
  regulation: "Regulation",
  lawsuit: "Lawsuit",
  product_launch: "Product launch",
  market_crash: "Market crash",
};

function eventTypeColor(type: string): string {
  return EVENT_TYPE_COLORS[type] ?? "#94a3b8";
}

function eventTypeLabel(type: string): string {
  return EVENT_TYPE_LABELS[type] ?? type;
}

function confidenceColor(confidence: string): string {
  const map: Record<string, string> = { high: "#22c55e", medium: "#f59e0b", low: "#ef4444" };
  return map[confidence] ?? "#94a3b8";
}

// Fixed radius for assets whose value is unknown (NULL). Never guess a size.
const NULL_VALUE_RADIUS = 1.2;

function assetRadius(valueCents: number | null): number {
  if (valueCents == null) return NULL_VALUE_RADIUS;
  const valueUsd = valueCents / 100;
  // sqrt scaling keeps a $65M jet visible and a $10B estate from swallowing the globe
  const r = Math.sqrt(valueUsd / 1e9) * 3 + 0.5;
  return Math.max(1, Math.min(6, r));
}

// ---------------------------------------------------------------------------
// Formatting helpers
// ---------------------------------------------------------------------------

function formatCents(cents: number): string {
  const d = cents / 100;
  if (d >= 1e9) return `$${(d / 1e9).toFixed(1)}B`;
  if (d >= 1e6) return `$${(d / 1e6).toFixed(0)}M`;
  return `$${Math.round(d).toLocaleString()}`;
}

function formatVerifiability(v: number | null): string {
  if (v == null) return "n/a";
  const pct = v * 100;
  const warn = pct > 100 ? " ⚠" : "";
  return `${pct.toFixed(1)}%${warn}`;
}

function formatPledge(pct: number | null): string {
  if (pct == null) return "n/a";
  return `${pct.toFixed(1)}%`;
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

interface GlobeViewProps {
  countries: CountryData[];
  assets: AssetPoint[];
  arcs: ArcRoute[];
  events: EventPoint[];
  assetCount: number;
  owners: OwnerCard[];
  eventTypes: string[];
}

export default function GlobeView({
  countries,
  assets,
  arcs,
  events,
  assetCount,
  owners,
  eventTypes,
}: GlobeViewProps) {
  const router = useRouter();
  const canvasRef = useRef<HTMLDivElement>(null);
  const globeRef = useRef<GlobeInstance | null>(null);
  const [selected, setSelected] = useState<{ type: string; data: any } | null>(null);
  const [hovered, setHovered] = useState<{ type: string; data: any } | null>(null);
  const [timeFilter, setTimeFilter] = useState<string>("all");
  const [showArcs, setShowArcs] = useState(true);
  const [showAssets, setShowAssets] = useState(true);
  const [showEvents, setShowEvents] = useState(true);
  const [showPeople, setShowPeople] = useState(true);
  const [followMoney, setFollowMoney] = useState(false);

  const ownerMap = useMemo(() => {
    const m = new Map<string, OwnerCard>();
    for (const o of owners) m.set(o.slug, o);
    return m;
  }, [owners]);

  const totalWealth = countries.reduce((s, c) => s + c.totalWealthB, 0);
  const totalCount = countries.reduce((s, c) => s + c.count, 0);

  // Filter events by time
  const filteredEvents = events.filter((e) => {
    if (timeFilter === "all") return true;
    const date = new Date(e.occurredAt);
    if (timeFilter === "6m") return date > new Date(NOW_MS - 180 * 86400000);
    if (timeFilter === "1y") return date > new Date(NOW_MS - 365 * 86400000);
    return true;
  });

  // Only assets with real coordinates can be plotted. Assets without coords
  // (e.g. FAA aircraft, which carry a tail number not a lat/lng) are listed in
  // the sidebar but are never placed on the globe — we do not geocode them.
  const plottableAssets = useMemo(
    () => assets.filter((a) => a.lat != null && a.lng != null),
    [assets],
  );

  // Build arcs from assets if none provided
  const computedArcs: ArcRoute[] = arcs.length > 0
    ? arcs
    : (plottableAssets
        .map((a) => {
          const ownerCenter = getCountryCenter(
            countries.find((c) => c.people.some((p) => p.name === a.ownerName))?.country ?? null,
          );
          if (!ownerCenter || a.lat == null || a.lng == null) return null;
          return {
            sourceLat: a.lat,
            sourceLng: a.lng,
            targetLat: ownerCenter.lat,
            targetLng: ownerCenter.lng,
            sourceOwner: a.ownerName,
            assetName: a.name,
            valueB: a.valueCents ? a.valueCents / 100 / 1e9 : 0,
            confidence: a.confidence,
          };
        })
        .filter((a): a is NonNullable<typeof a> => a !== null));

  // Country points (country cluster layer)
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

  // Asset points — coloured by OWNER, sized by value (NULL value → fixed small)
  const assetBubbles = plottableAssets.map((a) => ({
    lat: a.lat!,
    lng: a.lng!,
    name: a.name,
    valueCents: a.valueCents,
    ownerName: a.ownerName,
    ownerSlug: a.ownerSlug,
    assetType: a.assetType,
    confidence: a.confidence,
    ownershipPct: a.ownershipPct,
    location: a.location,
    radius: assetRadius(a.valueCents),
    ownerColor: getOwnerColor(a.ownerSlug || ""),
  }));

  // Event rings — only the event types actually present in the data
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
      a.sourceOwner.toLowerCase().replace(/\s+/g, "-"),
    ),
  }));

  // ---- globe.gl layer application (factored so toggles can re-apply) ---------
  function applyLayers(g: GlobeInstance) {
    // Country clusters
    (g as any)
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

    // Ownership arcs
    (g as any)
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

    // Asset points — owner colour, value-sized, dimmed when "follow the money"
    // is on and the asset is not linked to a tracked person.
    (g as any)
      .pointsData(showAssets ? assetBubbles : [])
      .pointColor((d: any) => {
        const tracked = !!d.ownerSlug;
        if (followMoney && !tracked) return hexToRgba(d.ownerColor, 0.12);
        return d.ownerColor;
      })
      .pointRadius((d: any) => d.radius)
      .pointAltitude((d: any) => {
        const tracked = !!d.ownerSlug;
        if (followMoney && !tracked) return 0.005;
        return 0.02;
      })
      .pointLabel((d: any) => {
        const owner = ownerMap.get(d.ownerSlug);
        const valueStr = d.valueCents == null
          ? "value unknown"
          : formatCents(d.valueCents);
        const ownerBlock = owner
          ? `
            <div style="margin-top:4px;border-top:1px solid #444;padding-top:4px;">
              <span style="color:#94a3b8;">Owner:</span> <strong>${owner.name}</strong><br/>
              <span style="color:#94a3b8;">Live total:</span> ${formatCents(owner.liveTotalCents)}<br/>
              <span style="color:#94a3b8;">Verifiability:</span> ${formatVerifiability(owner.verifiability)}<br/>
              <span style="color:#94a3b8;">Pledged:</span> ${formatPledge(owner.pledgePct)}
            </div>`
          : "";
        return `
          <div style="font-size:11px;color:#fff;font-family:monospace;">
            <strong>${d.name}</strong><br/>
            ${d.ownerName} · <span style="color:${d.ownerColor}">${valueStr}</span><br/>
            ${d.assetType} · ${d.confidence}
            ${ownerBlock}
          </div>
        `;
      })
      .onPointHover((d: any) => {
        if (d) setHovered({ type: "asset", data: d });
        else setHovered(null);
      })
      .onPointClick((d: any) => {
        if (d && d.ownerSlug) {
          router.push(`/person/${d.ownerSlug}`);
        }
      });

    // Event rings
    (g as any)
      .ringsData(showEvents ? eventPoints : [])
      .ringLat((d: any) => d.lat)
      .ringLng((d: any) => d.lng)
      .ringColor((d: any) => d.color)
      .ringRepeatPeriod(0)
      .ringMaxRadius(8)
      .ringPropagationSpeed(1);
  }

  useEffect(() => {
    if (!canvasRef.current) return;

    const GlobeClass = Globe as unknown as new (
      container: HTMLElement,
      config?: { waitForGlobeReady?: boolean; animateIn?: boolean },
    ) => GlobeInstance;

    const globe = new GlobeClass(canvasRef.current, {});

    // Local textures only — never a CDN. Keeps the app offline-capable and
    // free of third-party runtime dependencies.
    (globe as any)
      .globeImageUrl("/textures/earth-night.jpg")
      .bumpImageUrl("/textures/earth-topology.png")
      .showGraticules(true)
      .backgroundColor("rgba(0,0,0,0)");

    globeRef.current = globe;
    applyLayers(globe);

    // Controls
    const controls = globe.controls();
    if (controls) {
      controls.autoRotate = true;
      controls.autoRotateSpeed = 0.3;
      controls.enableZoom = true;
      controls.enablePan = true;
    }

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
        globeRef.current = null;
      }
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Re-apply layers when toggles change
  useEffect(() => {
    const g = globeRef.current;
    if (!g) return;
    applyLayers(g);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [showArcs, showAssets, showEvents, showPeople, followMoney, timeFilter]);

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
            {totalCount} billionaire{totalCount === 1 ? "" : "s"} · {countries.length} countries · {assetCount} tracked asset{assetCount === 1 ? "" : "s"}
          </div>
          {plottableAssets.length < assetCount && (
            <div className="text-[11px] text-white/30 mt-1">
              {plottableAssets.length} with coordinates · {assetCount - plottableAssets.length} unmapped
            </div>
          )}
        </div>

        {/* Layer toggles */}
        <div className="p-3 border-b border-white/10">
          <div className="text-xs uppercase tracking-widest text-white/40 mb-2">Layers</div>
          <div className="space-y-1.5">
            {[
              { key: "showPeople", label: "Country Clusters", count: countries.length },
              { key: "showAssets", label: "Tracked Assets", count: assetCount },
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

          {/* Follow the money */}
          <button
            onClick={() => setFollowMoney(!followMoney)}
            className={`w-full mt-2 text-left px-3 py-1.5 rounded text-xs transition-colors flex items-center justify-between ${
              followMoney ? "bg-amber-500/20 text-amber-200" : "hover:bg-white/5 text-white/70"
            }`}
          >
            <span>Follow the money</span>
            <span
              className={`w-8 h-4 rounded-full relative flex-shrink-0 ${followMoney ? "bg-amber-400" : "bg-white/20"}`}
            >
              <span
                className={`absolute top-0.5 w-3 h-3 rounded-full bg-white transition-transform ${
                  followMoney ? "translate-x-4" : "translate-x-0.5"
                }`}
              />
            </span>
          </button>
          <div className="text-[11px] text-white/30 mt-1">
            Dims assets not linked to a tracked person.
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
                  {selected.data.valueCents == null ? "value unknown" : formatCents(selected.data.valueCents)}
                </div>
                <div className="text-xs text-white/80 mb-1">{selected.data.name}</div>
                <div className="text-xs text-white/50">{selected.data.ownerName}</div>
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
                  {formatCents((hovered.data.valueB ?? 0) * 100 * 1e9)}
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

        {/* Assets list — every real asset, clickable to its owner's profile.
            Assets without coordinates are unmapped but still listed honestly. */}
        {assets.length > 0 && (
          <div className="p-3 border-t border-white/10">
            <div className="text-xs uppercase tracking-widest text-white/40 mb-2">Assets</div>
            <div className="space-y-1">
              {assets.map((a) => {
                return (
                  <button
                    key={a.assetId}
                    onClick={() => a.ownerSlug && router.push(`/person/${a.ownerSlug}`)}
                    className="w-full text-left px-2 py-1.5 rounded hover:bg-white/5 transition-colors flex items-start gap-2"
                  >
                    <span
                      className="w-2 h-2 rounded-full mt-1 flex-shrink-0"
                      style={{ backgroundColor: getOwnerColor(a.ownerSlug || "") }}
                    />
                    <span className="min-w-0">
                      <span className="block text-xs text-white/80 truncate">{a.name}</span>
                      <span className="block text-[11px] text-white/40 truncate">
                        {a.ownerName}
                        {a.lat == null || a.lng == null ? " · unmapped" : ""}
                      </span>
                    </span>
                  </button>
                );
              })}
            </div>
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
                      800,
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

        {/* Legend — only event types present in the data */}
        <div className="p-3 border-t border-white/10 mt-auto">
          <div className="text-xs uppercase tracking-widest text-white/40 mb-2">Legend</div>
          <div className="space-y-1 text-xs text-white/50">
            {eventTypes.map((t) => (
              <div key={t} className="flex items-center gap-2">
                <span
                  className="w-2 h-2 rounded-full inline-block"
                  style={{ backgroundColor: eventTypeColor(t) }}
                />
                <span>{eventTypeLabel(t)}</span>
              </div>
            ))}
            {eventTypes.length === 0 && (
              <div className="text-white/30">No mapped events</div>
            )}
            <div className="flex items-center gap-2 mt-2">
              <span className="w-2 h-2 rounded-full inline-block bg-white/60" />
              <span>Assets coloured by owner</span>
            </div>
            <div className="mt-2 text-white/30 text-xs">
              Click an asset to open its owner · Hover for details
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
