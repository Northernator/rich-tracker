/**
 * Compute event_asset_links (R-tree bounding box + haversine) and
 * event_impacts (market_delta_pct, index_delta_pct, excess_pct).
 *
 * Synthetic market index = equal-weighted average daily return of all USD
 * securities in stock_snapshots.  Null results are stored explicitly so the
 * UI can say "no detectable effect" instead of hiding the row.
 */

import Database from "better-sqlite3";
import { createId } from "@paralleldrive/cuid2";

const db = Database("data/app.db");
db.pragma("foreign_keys = ON");
db.pragma("journal_mode = WAL");

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

function dateStr(iso: string): string {
  return iso.slice(0, 10);
}

function priorTradingDay(date: string): string | null {
  const d = new Date(date + "T00:00:00Z");
  for (let i = 1; i <= 7; i++) {
    const cand = new Date(d);
    cand.setDate(cand.getDate() - i);
    const candStr = cand.toISOString().slice(0, 10);
    const row = db
      .prepare(
        "SELECT 1 FROM stock_snapshots WHERE ticker = 'AAPL' AND as_of = ? LIMIT 1"
      )
      .get(candStr);
    if (row) return candStr;
  }
  return null;
}

// ---------------------------------------------------------------------------
// 1. Drop and recreate links / impacts so the script is idempotent
// ---------------------------------------------------------------------------

db.exec("DELETE FROM event_impacts");
db.exec("DELETE FROM event_asset_links");

// ---------------------------------------------------------------------------
// 2. Build event_asset_links (R-tree bbox pre-filter, then haversine)
// ---------------------------------------------------------------------------

const events = db
  .prepare(
    "SELECT id, type, title, lat, lng, occurred_at FROM events WHERE lat IS NOT NULL AND lng IS NOT NULL"
  )
  .all() as Array<{
    id: string;
    type: string;
    title: string;
    lat: number;
    lng: number;
    occurred_at: string;
  }>;

const assets = db
  .prepare(
    "SELECT id, name, asset_type, lat, lng FROM assets WHERE lat IS NOT NULL AND lng IS NOT NULL"
  )
  .all() as Array<{
    id: string;
    name: string;
    asset_type: string;
    lat: number;
    lng: number;
  }>;

const insertLink = db.prepare(
  "INSERT INTO event_asset_links (id, event_id, asset_id, distance_km, created_at) VALUES (?, ?, ?, ?, ?)"
);

const links: Array<{
  eventAssetLinkId: string;
  eventId: string;
  assetId: string;
  distanceKm: number;
  eventType: string;
  eventTitle: string;
  occurredAt: string;
  assetName: string;
}> = [];

const BBOX_KM = 500;
const insertBatch = db.transaction((rows: typeof links) => {
  for (const r of rows) insertLink.run(r.eventAssetLinkId, r.eventId, r.assetId, r.distanceKm, new Date().toISOString());
});

for (const evt of events) {
  // R-tree style bounding-box pre-filter: ±(range/earth_radius) in radians
  const latRad = (BBOX_KM / 6371) * (180 / Math.PI);
  const lngRad = latRad / Math.cos((evt.lat * Math.PI) / 180);
  const nearbyAssets = assets.filter(
    (a) =>
      Math.abs(a.lat - evt.lat) <= latRad &&
      Math.abs(a.lng - evt.lng) <= lngRad
  );

  for (const asset of nearbyAssets) {
    const dist = haversineKm(evt.lat, evt.lng, asset.lat, asset.lng);
    if (dist > BBOX_KM) continue;

    const id = createId();
    links.push({
      eventAssetLinkId: id,
      eventId: evt.id,
      assetId: asset.id,
      distanceKm: Math.round(dist * 10) / 10,
      eventType: evt.type,
      eventTitle: evt.title,
      occurredAt: evt.occurred_at,
      assetName: asset.name,
    });
  }
}

insertBatch(links);
console.log(`event_asset_links: ${links.length} rows inserted`);

// ---------------------------------------------------------------------------
// 3. Build synthetic market index returns
// ---------------------------------------------------------------------------

const priceRows = db
  .prepare(
    "SELECT as_of, ticker, price_cents FROM stock_snapshots WHERE currency = 'USD' ORDER BY as_of, ticker"
  )
  .all();

const byDate = new Map<string, Map<string, number>>();
for (const r of priceRows) {
  let m = byDate.get(r.as_of);
  if (!m) {
    m = new Map();
    byDate.set(r.as_of, m);
  }
  m.set(r.ticker, r.price_cents);
}

const tradingDays = [...byDate.keys()].sort();

// marketIndexReturns[date] = equal-weighted avg pct change vs prior trading day
const marketIndexReturns = new Map<string, number>();
for (let i = 1; i < tradingDays.length; i++) {
  const prevMap = byDate.get(tradingDays[i - 1])!;
  const currMap = byDate.get(tradingDays[i])!;
  let sum = 0;
  let count = 0;
  for (const [ticker, prev] of prevMap) {
    const curr = currMap.get(ticker);
    if (curr != null) {
      sum += ((curr - prev) / prev) * 100;
      count++;
    }
  }
  if (count > 0) marketIndexReturns.set(tradingDays[i], sum / count);
}

// ---------------------------------------------------------------------------
// 4. Compute event_impacts
// ---------------------------------------------------------------------------

// Owner -> equity holdings (ticker -> shares)
const ownerHoldings = new Map<
  string,
  Array<{ ticker: string; shares: number }>
>();
for (const oh of db
  .prepare(
    "SELECT person_id, ticker, shares FROM equity_holdings WHERE as_of = (SELECT MAX(as_of) FROM equity_holdings eh2 WHERE eh2.person_id = equity_holdings.person_id)"
  )
  .all() as Array<{ person_id: string; ticker: string; shares: number }>
) {
  let arr = ownerHoldings.get(oh.person_id);
  if (!arr) {
    arr = [];
    ownerHoldings.set(oh.person_id, arr);
  }
  arr.push({ ticker: oh.ticker, shares: oh.shares });
}

// Asset -> owners
const assetOwners = new Map<
  string,
  Array<{ personId: string; fullName: string; slug: string }>
>();
for (const ol of db
  .prepare(
    "SELECT asset_id, person_id FROM ownership_links"
  )
  .all() as Array<{ asset_id: string; person_id: string }>
) {
  let arr = assetOwners.get(ol.asset_id);
  if (!arr) {
    arr = [];
    assetOwners.set(ol.asset_id, arr);
  }
}

// Build a fast person lookup
const personRows = db.prepare("SELECT id, full_name, slug FROM people").all();
const personById = new Map<string, { full_name: string; slug: string }>();
for (const p of personRows) personById.set(p.id, p);

// Fill assetOwners with person data
for (const ol of db
  .prepare(
    "SELECT asset_id, person_id FROM ownership_links"
  )
  .all() as Array<{ asset_id: string; person_id: string }>
) {
  const arr = assetOwners.get(ol.asset_id)!;
  const person = personById.get(ol.person_id);
  if (person) arr.push({ personId: ol.person_id, fullName: person.full_name, slug: person.slug });
}

const insertImpact = db.prepare(
  `INSERT INTO event_impacts
   (id, event_asset_link_id, ticker, market_delta_pct, index_delta_pct, excess_pct, impact_note, created_at)
   VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
);

const insertBatchImpacts = db.transaction((rows: Parameters<typeof insertImpact.run>[0][]) => {
  for (const r of rows) insertImpact.run(...r);
});

for (const link of links) {
  const evtDate = dateStr(link.occurredAt);
  const priorDay = priorTradingDay(evtDate);
  const indexDelta = priorDay ? marketIndexReturns.get(priorDay) ?? null : null;

  // Get asset owners
  const owners = assetOwners.get(link.assetId) ?? [];

  // If no owners or owners have no holdings → single null impact row
  if (owners.length === 0) {
    const id = createId();
    insertImpact.run(
      id,
      link.eventAssetLinkId,
      null,
      null,
      indexDelta,
      null,
      `${link.eventType === "earthquake" ? "M" + link.eventTitle.match(/M([\d.]+)/)?.[1] ?? "?" : link.eventType}, ${link.distanceKm}km from nearby asset. No owner detected — no detectable market effect.`,
      new Date().toISOString()
    );
    continue;
  }

  let ownerImpactRows: Parameters<typeof insertImpact.run>[0][] = [];

  for (const owner of owners) {
    const holdings = ownerHoldings.get(owner.personId);
    if (!holdings || holdings.length === 0) {
      // Owner exists but has no public equity — explicit null
      const id = createId();
      ownerImpactRows.push([
        id,
        link.eventAssetLinkId,
        null,
        null,
        indexDelta,
        null,
        `${link.eventType === "earthquake" ? "M" + link.eventTitle.match(/M([\d.]+)/)?.[1] ?? "?" : link.eventType}, ${link.distanceKm}km from ${link.eventTitle.match(/from (.+?)\./)?.[1] ?? link.assetName}. Owner (${owner.slug}) has no public equity holdings. No detectable effect.`,
        new Date().toISOString(),
      ]);
      continue;
    }

    // Compute owner's market delta
    let mDeltaSum = 0;
    let mDeltaCount = 0;
    // `ticker` is a ticker column: it holds tickers. The annotated
    // "GOOGL-0.1%" form belongs in the note — it was being written into the
    // ticker field, producing rows like ticker = "GOOGL-0.1%".
    const tickers: string[] = [];
    const tickerMoves: string[] = [];
    for (const h of holdings) {
      const prevPrice = priorDay ? byDate.get(priorDay)?.get(h.ticker) : null;
      const currPrice = byDate.get(evtDate)?.get(h.ticker);
      if (prevPrice != null && currPrice != null && prevPrice > 0) {
        const pct = ((currPrice - prevPrice) / prevPrice) * 100;
        mDeltaSum += pct;
        mDeltaCount++;
        tickers.push(h.ticker);
        tickerMoves.push(`${h.ticker} ${pct >= 0 ? "+" : ""}${pct.toFixed(1)}%`);
      }
    }
    const marketDelta = mDeltaCount > 0 ? mDeltaSum / mDeltaCount : null;
    const excess = marketDelta != null && indexDelta != null ? marketDelta - indexDelta : null;

    const id = createId();
    ownerImpactRows.push([
      id,
      link.eventAssetLinkId,
      tickers.length > 0 ? tickers.join(", ") : null,
      marketDelta,
      indexDelta,
      excess,
      `${link.eventType === "earthquake" ? "M" + link.eventTitle.match(/M([\d.]+)/)?.[1] ?? "?" : link.eventType}, ${link.distanceKm}km from ${link.eventTitle.match(/from (.+?)\./)?.[1] ?? link.assetName}. Owner (${owner.slug}) ${marketDelta != null ? (marketDelta >= 0 ? "+" : "") + marketDelta.toFixed(1) + "%" : "no data"} vs index ${indexDelta != null ? (indexDelta >= 0 ? "+" : "") + indexDelta.toFixed(1) + "%" : "N/A"} over 24h. ${excess != null ? (excess >= 0 ? "+" : "") + excess.toFixed(1) + "% excess" : "no excess computed"}.${tickerMoves.length > 0 ? " [" + tickerMoves.join(", ") + "]" : ""}`,
      new Date().toISOString(),
    ]);
  }

  insertBatchImpacts(ownerImpactRows);
}

console.log(`event_impacts: ${links.length > 0 ? "computed" : "none"} — check DB for details`);

// ---------------------------------------------------------------------------
// 5. Summary
// ---------------------------------------------------------------------------

const linkCount = db.prepare("SELECT COUNT(*) as c FROM event_asset_links").get() as { c: number };
const impactCount = db.prepare("SELECT COUNT(*) as c FROM event_impacts").get() as { c: number };
console.log(`event_asset_links total: ${linkCount.c}`);
console.log(`event_impacts total: ${impactCount.c}`);

const nullImpacts = db
  .prepare("SELECT COUNT(*) as c FROM event_impacts WHERE market_delta_pct IS NULL AND index_delta_pct IS NULL")
  .get() as { c: number };
console.log(`fully-null impacts (no data): ${nullImpacts.c}`);

const explicitNulls = db
  .prepare("SELECT COUNT(*) as c FROM event_impacts WHERE market_delta_pct IS NULL AND index_delta_pct IS NOT NULL")
  .get() as { c: number };
console.log(`owner-null impacts (index available): ${explicitNulls.c}`);

db.close();
console.log("done");
