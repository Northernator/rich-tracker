/**
 * Slice 11 (R7): Real events from live feeds
 *
 * Replaces fabricated events with real data from:
 *  - USGS Earthquake Hazards Program: M5.0+ global seismic events
 *  - SEC EDGAR Form 4: insider transactions (personal CIK-based)
 *  - SEC Enforcement RSS: litigation releases
 *
 * Rules:
 *  - Never fabricate event data. If a feed returns nothing → no events inserted.
 *  - Every row has a verifiable source_url pointing to the original.
 *  - Impact notes describe only what the data shows — no causal overclaiming.
 */

import { db } from "@/lib/db";
import { events } from "@/lib/db/schema";
import { createId } from "@paralleldrive/cuid2";
import { politeFetch } from "@/lib/providers/http";

// ---------------------------------------------------------------------------
// Personal CIK map — the billionaire's own SEC filing CIK
// (Not the issuer's CIK — that returns all company insiders)
// ---------------------------------------------------------------------------

const FILERS = [
  {
    slug: "elon-musk",
    name: "Elon Musk",
    personalCik: "0001494730",
    ticker: "TSLA",
  },
  {
    slug: "jeff-bezos",
    name: "Jeff Bezos",
    personalCik: "0001043298",
    ticker: "AMZN",
  },
  {
    slug: "mark-zuckerberg",
    name: "Mark Zuckerberg",
    personalCik: "0001548760",
    ticker: "META",
  },
  {
    slug: "warren-buffett",
    name: "Warren Buffett",
    personalCik: "0001067983",
    ticker: "BRK.A",
  },
  {
    slug: "steve-ballmer",
    name: "Steve Ballmer",
    personalCik: "0001336528",
    ticker: "MSFT",
  },
  {
    slug: "larry-page",
    name: "Larry Page",
    personalCik: "0001738007", // agent/attorney filing on his behalf
    ticker: "GOOGL",
  },
];

// ---------------------------------------------------------------------------
// Fetch helpers
// ---------------------------------------------------------------------------

async function fetchJson<T>(url: string): Promise<T | null> {
  try {
    const r = await politeFetch(url, { signal: AbortSignal.timeout(15000) });
    return (await r.json()) as T;
  } catch {
    return null;
  }
}

async function fetchText(url: string): Promise<string | null> {
  try {
    const r = await politeFetch(url, { signal: AbortSignal.timeout(15000) });
    return await r.text();
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// USGS Earthquakes (M5.0+ monthly)
// ---------------------------------------------------------------------------

interface UsgsFeature {
  geometry: { coordinates: [number, number, number] };
  properties: { mag: number; place: string; time: number; url: string; type: string };
}

interface UsgsFeed {
  features: UsgsFeature[];
}

async function loadEarthquakes() {
  const data = await fetchJson<UsgsFeed>(
    "https://earthquake.usgs.gov/earthquakes/feed/v1.0/summary/4.5_month.geojson"
  );
  if (!data) return [];

  const quakes = data.features.filter(
    (f) => f.properties.type === "earthquake" && f.properties.mag >= 5.0
  );

  return quakes.map((f) => {
    const [lng, lat] = f.geometry.coordinates;
    const mag = f.properties.mag;
    return {
      type: "earthquake" as const,
      title: `M${mag.toFixed(1)} earthquake at ${f.properties.place}`,
      description: `USGS reports magnitude ${mag.toFixed(1)} at depth ${f.geometry.coordinates[2].toFixed(1)}km. Source: ${f.properties.url}`,
      lat,
      lng,
      occurredAt: new Date(f.properties.time).toISOString(),
      sourceId: "usgs",
      sourceUrl: f.properties.url,
    };
  });
}

// ---------------------------------------------------------------------------
// SEC Form 4 — filtered to personal CIK (billionaire only)
// ---------------------------------------------------------------------------

async function loadInsiderTransactions() {
  const results: Array<{
    type: "insider_sell" | "insider_buy" | "pledge";
    title: string;
    description: string;
    lat: number | null;
    lng: number | null;
    occurredAt: string;
    sourceId: string;
    sourceUrl: string;
  }> = [];

  for (const filer of FILERS) {
    const feedUrl = `https://www.sec.gov/cgi-bin/browse-edgar?action=getcompany&type=4&dateb=20250101&owner=include&count=10&search_text=&action=getcompany&CIK=${filer.personalCik}&output=atom`;
    const text = await fetchText(feedUrl);
    if (!text) continue;

    const entryMatches = text.match(/<entry>([\s\S]*?)<\/entry>/g) || [];

    for (const entryXml of entryMatches) {
      const hrefMatch = entryXml.match(/<filing-href>([^<]*)<\/filing-href>/);
      const dateMatch = entryXml.match(/<filing-date>([^<]*)<\/filing-date>/);
      const updatedMatch = entryXml.match(/<updated>([^<]*)<\/updated>/);

      if (!hrefMatch) continue;

      const txtUrl = hrefMatch[1].replace("-index.htm", ".txt");
      const filingText = await fetchText(txtUrl);
      if (!filingText) continue;

      const xmlMatch = filingText.match(/<TEXT>([\s\S]*)<\/TEXT>/);
      if (!xmlMatch) continue;

      let xml = xmlMatch[1]
        .replace(/&amp;/g, "&")
        .replace(/&lt;/g, "<")
        .replace(/&gt;/g, ">")
        .replace(/&quot;/g, '"');

      const ticker =
        xml.match(/<issuerTradingSymbol>([^<]*)<\/issuerTradingSymbol>/)?.[1] ||
        filer.ticker;
      const period =
        xml.match(/<periodOfReport>([^<]*)<\/periodOfReport>/)?.[1] ||
        dateMatch?.[1] ||
        "";
      const ownerName =
        xml.match(/<rptOwnerName>([^<]*)<\/rptOwnerName>/)?.[1] ||
        filer.name;

      // Only include if the reporter is the tracked billionaire or their estate/agent
      // Match by last name or first name in any order
      const ownerWords = (ownerName || "").toLowerCase().split(/\s+/);
      const nameWords = filer.name.toLowerCase().split(/\s+/);
      const isTracked =
        ownerWords.some((w) => nameWords.includes(w)) &&
        nameWords.some((w) => ownerWords.includes(w));

      if (!isTracked) continue;

      const allTxMatches = [
        ...xml.matchAll(
          /<nonDerivativeTransaction>([\s\S]*?)<\/nonDerivativeTransaction>/g
        ),
        ...xml.matchAll(
          /<derivativeTransaction>([\s\S]*?)<\/derivativeTransaction>/g
        ),
      ];

      for (const txMatch of allTxMatches) {
        const txXml = txMatch[1];
        const code =
          txXml.match(/<transactionCode>([^<]*)<\/transactionCode>/)?.[1] ||
          "";
        const sharesStr =
          txXml.match(
            /<transactionShares>\s*<value>([^<]*)<\/value>/
          )?.[1] || "";
        const priceStr =
          txXml.match(
            /<transactionPricePerShare>\s*<value>([^<]*)<\/value>/
          )?.[1] || "";
        const dateStr =
          txXml.match(/<transactionDate>\s*<value>([^<]*)<\/value>/)?.[1] ||
          period;

        if (!code || !dateStr) continue;

        const shares = sharesStr ? parseFloat(sharesStr) : 0;
        const price = priceStr ? parseFloat(priceStr) : 0;

        if (code === "S" && shares > 0) {
          const value = shares * price;
          results.push({
            type: "insider_sell",
            title: `${ownerName} sells ${shares.toLocaleString()} ${ticker} shares`,
            description: `Form 4 (filed ${updatedMatch?.[1] || period}): ${ownerName} sold ${shares.toLocaleString()} ${ticker} at $${price.toFixed(2)}/share (~$${(value / 1000).toFixed(0)}K).`,
            lat: null,
            lng: null,
            occurredAt: new Date(dateStr).toISOString(),
            sourceId: "sec-edgar",
            sourceUrl: hrefMatch[1],
          });
        } else if ((code === "P" || code === "A") && shares > 1000) {
          const value = shares * price;
          results.push({
            type: "insider_buy",
            title: `${ownerName} buys ${shares.toLocaleString()} ${ticker} shares`,
            description: `Form 4 (filed ${updatedMatch?.[1] || period}): ${ownerName} purchased ${shares.toLocaleString()} ${ticker} at $${price.toFixed(2)}/share (~$${(value / 1e6).toFixed(2)}M).`,
            lat: null,
            lng: null,
            occurredAt: new Date(dateStr).toISOString(),
            sourceId: "sec-edgar",
            sourceUrl: hrefMatch[1],
          });
        } else if (code === "G" && shares > 0) {
          results.push({
            type: "pledge",
            title: `${ownerName} pledges ${shares.toLocaleString()} ${ticker} shares`,
            description: `Form 4 (filed ${updatedMatch?.[1] || period}): ${ownerName} pledged ${shares.toLocaleString()} ${ticker} shares as collateral.`,
            lat: null,
            lng: null,
            occurredAt: new Date(dateStr).toISOString(),
            sourceId: "sec-edgar",
            sourceUrl: hrefMatch[1],
          });
        }
      }
    }
  }

  return results;
}

// ---------------------------------------------------------------------------
// SEC Enforcement Actions
// ---------------------------------------------------------------------------

async function loadEnforcement() {
  const text = await fetchText(
    "https://www.sec.gov/enforcement-litigation/litigation-releases/rss"
  );
  if (!text) return [];

  const itemMatches = text.match(/<item>([\s\S]*?)<\/item>/g) || [];
  const results: Array<{
    type: "sec_enforcement";
    title: string;
    description: string;
    lat: number | null;
    lng: number | null;
    occurredAt: string;
    sourceId: string;
    sourceUrl: string;
  }> = [];

  for (const itemXml of itemMatches) {
    const title = itemXml.match(/<title>([^<]*)<\/title>/)?.[1] || "";
    const link = itemXml.match(/<link>([^<]*)<\/link>/)?.[1] || "";
    const pubDate = itemXml.match(/<pubDate>([^<]*)<\/pubDate>/)?.[1] || "";

    if (!title || !link) continue;

    results.push({
      type: "sec_enforcement" as const,
      title: title
        .replace(/&amp;/g, "&")
        .replace(/&lt;/g, "<")
        .replace(/&gt;/g, ">"),
      description: "",
      lat: null,
      lng: null,
      occurredAt: pubDate ? new Date(pubDate).toISOString() : new Date().toISOString(),
      sourceId: "sec-edgar",
      sourceUrl: link,
    });
  }

  return results;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

export async function main() {
  console.log("R7: Loading real events from live feeds...\n");

  // 1. Delete existing events
  const deleted = await db.delete(events).returning({ id: events.id });
  console.log(`Deleted ${deleted.length} existing events`);

  // 2. Load from feeds
  console.log("Fetching USGS earthquakes (M5.0+)...");
  const earthquakes = await loadEarthquakes();
  console.log(`  Found ${earthquakes.length} earthquakes`);

  console.log("Fetching SEC Form 4 filings...");
  const insiderTxns = await loadInsiderTransactions();
  console.log(`  Found ${insiderTxns.length} insider transactions`);

  console.log("Fetching SEC enforcement RSS...");
  const enforcement = await loadEnforcement();
  console.log(`  Found ${enforcement.length} enforcement actions`);

  // 3. Sort by date desc, cap at 100 for focused demo
  const allEvents = [...earthquakes, ...insiderTxns, ...enforcement];
  allEvents.sort(
    (a, b) =>
      new Date(b.occurredAt).getTime() - new Date(a.occurredAt).getTime()
  );
  const recentEvents = allEvents.slice(0, 500);

  // 4. Insert
  const now = new Date().toISOString();
  for (const evt of recentEvents) {
    await db.insert(events).values({
      id: createId(),
      type: evt.type,
      title: evt.title,
      description: evt.description,
      lat: evt.lat,
      lng: evt.lng,
      occurredAt: evt.occurredAt,
      sourceId: evt.sourceId,
      sourceUrl: evt.sourceUrl || null,
      createdAt: now,
    });
  }

  console.log(`\nInserted ${recentEvents.length} real events:`);
  console.log(`  ${earthquakes.length} earthquakes`);
  console.log(`  ${insiderTxns.length} insider transactions`);
  console.log(`  ${enforcement.length} enforcement actions`);
  console.log("\nDone.");
}

if (require.main === module) {
  main().catch((err) => {
    console.error("Fatal:", err);
    process.exit(1);
  });
}
