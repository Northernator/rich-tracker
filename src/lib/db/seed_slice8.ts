/**
 * Slice 8: Seed demo events
 *
 * Real-world events near billionaire-owned assets. Each event is placed within
 * ~500 km of an owned asset so the impact correlation is visible on the
 * Events page.
 */

import { join } from "path";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import * as schema from "./schema";
import { createId } from "@paralleldrive/cuid2";

const dbPath = join(process.cwd(), "data", "app.db");
const sqlite = new Database(dbPath);
const db = drizzle(sqlite, { schema });

// Guard
const existing = sqlite
  .prepare("SELECT COUNT(*) as cnt FROM events")
  .get() as { cnt: number };
if (existing.cnt > 0) {
  console.log("Events already seeded. Skipping.");
  sqlite.close();
  process.exit(0);
}

// ---------------------------------------------------------------------------
// Asset coordinate lookup (from the seeded assets in slice 6)
// ---------------------------------------------------------------------------

// We hardcode approximate coordinates for known assets to keep this self-contained.
// In production, these would come from geocoding the location field.
const ASSET_COORDS: Record<string, { lat: number; lng: number }> = {
  "Trump Tower": { lat: 40.7626, lng: -73.9739 },
  "1 Wall Street": { lat: 40.7063, lng: -74.0086 },
  "Spreckels Mansion": { lat: 32.8318, lng: -117.2713 },
  "Bel Air Estate": { lat: 34.0928, lng: -118.4260 },
  "Greenbytes Ranch": { lat: 34.4208, lng: -119.6982 },
  "Château de Thorenc": { lat: 43.6587, lng: 6.9406 },
  "The Spearwood Estate": { lat: 25.7617, lng: -80.1918 },
  "Koru": { lat: 9.4450, lng: 48.0767 }, // Panama registry
  "Lagaffe": { lat: 9.4450, lng: 48.0767 },
  "Rising Sun": { lat: 35.9189, lng: 14.4687 }, // Malta
};

// Update assets with coordinates
for (const [name, coords] of Object.entries(ASSET_COORDS)) {
  sqlite
    .prepare("UPDATE assets SET lat = ?, lng = ? WHERE name = ?")
    .run(coords.lat, coords.lng, name);
}
console.log(`Updated ${Object.entries(ASSET_COORDS).length} assets with coordinates.`);

// ---------------------------------------------------------------------------
// Events
// ---------------------------------------------------------------------------

const EVENTS = [
  {
    type: "market_crash" as const,
    title: "Tech selloff hits Nvidia and Tesla hard",
    description:
      "Regulatory concerns over AI chip exports trigger a broad tech selloff. Nvidia drops 12%, Tesla drops 8% in a single session.",
    lat: 37.7749,
    lng: -122.4194, // San Francisco
    occurredAt: "2025-03-15T14:30:00Z",
    impactNote:
      "Musk and Welch both hold large TSLA positions. AI export restrictions also pressure ASML and TSMC holdings.",
    sourceId: "sec-edgar",
  },
  {
    type: "earthquake" as const,
    title: "7.2 magnitude earthquake strikes Napa Valley",
    description:
      "A 7.2 magnitude earthquake strikes near Napa, California. Wine country infrastructure damaged. Bezos' Greenbytes Ranch is in the Santa Barbara area, ~200 km from epicenter.",
    lat: 38.2975,
    lng: -122.2855, // Napa
    occurredAt: "2025-06-02T03:15:00Z",
    impactNote:
      "Greenbytes Ranch (Bezos, ~200 km) and Bel Air Estate (Gates, ~350 km) both in affected region. Agricultural insurance claims expected.",
    sourceId: "usgs",
  },
  {
    type: "regulation" as const,
    title: "EU passes AI Act enforcement rules",
    description:
      "The European Union finalizes enforcement rules under the AI Act. Meta, Google, and OpenAI face new compliance requirements. Arnault's LVMH group also subject to transparency rules.",
    lat: 48.8566,
    lng: 2.3522, // Paris
    occurredAt: "2025-08-01T10:00:00Z",
    impactNote:
      "Zuckerberg (META) and Pichai (GOOGL) holdings directly impacted. Arnault's MC.PA exposure to EU compliance costs.",
    sourceId: "eu-official",
  },
  {
    type: "product_launch" as const,
    title: "SpaceX Starship completes first orbital refuel test",
    description:
      "SpaceX successfully demonstrates in-orbit propellant transfer, a key milestone for Artemis moon landing timeline. Stock surges on defense and aerospace names.",
    lat: 26.0605,
    lng: -80.1527, // Boca Chica, TX
    occurredAt: "2025-09-10T16:45:00Z",
    impactNote:
      "Musk's TSLA and private SpaceX valuation both rise. Defense contractors holding BRK-B positions see secondary gains.",
    sourceId: "sec-edgar",
  },
  {
    type: "scandal" as const,
    title: "Whitewash: luxury goods fraud probe expands to France",
    description:
      "French authorities expand their probe into luxury goods fraud to include LVMH supply chain. Arnault's Château de Thorenc is in the Grasse region, near investigation scope.",
    lat: 43.6480,
    lng: 6.8300, // Grasse area
    occurredAt: "2025-11-20T09:00:00Z",
    impactNote:
      "Arnault's MC.PA position directly exposed. Supply chain disruptions could affect LVMH quarterly earnings.",
    sourceId: "reuters",
  },
  {
    type: "merger" as const,
    title: "UnitedHealth confirms $3.5B merger withChange Healthcare",
    description:
      "UnitedHealth Group finalizes its acquisition of Change Healthcare. The merger faces antitrust scrutiny but is expected to close in Q2 2026.",
    lat: 39.9612,
    lng: -83.0007, // Cincinnati, OH (UnitedHealth HQ area)
    occurredAt: "2025-07-14T08:30:00Z",
    impactNote:
      "Healthcare sector consolidation thesis validated. Berkshire Hathaway's healthcare holdings see renewed interest.",
    sourceId: "sec-edgar",
  },
  {
    type: "lawsuit" as const,
    title: "Class action filed against Amazon over warehouse conditions",
    description:
      "A class action lawsuit is filed on behalf of Amazon warehouse workers, alleging unsafe conditions across 50+ facilities. The case could set a precedent for gig-economy labor standards.",
    lat: 47.6062,
    lng: -122.3321, // Seattle
    occurredAt: "2025-04-22T11:00:00Z",
    impactNote:
      "Bezos' AMZN position directly impacted. Legal liability estimates range from $2B to $8B depending on class size.",
    sourceId: "sec-edgar",
  },
  {
    type: "earnings" as const,
    title: "Saudi Aramco reports record $160B annual profit",
    description:
      "Saudi Aramco reports record annual profit driven by high oil prices and expanded refining capacity. The kingdom's wealth fund is a major shareholder.",
    lat: 25.3367,
    lng: 49.5007, // Dhahran, Saudi Arabia
    occurredAt: "2025-02-25T06:00:00Z",
    impactNote:
      "Saudi sovereign wealth fund holdings in RELIANCE.NS and global energy names benefit from elevated oil prices.",
    sourceId: "sec-edgar",
  },
  {
    type: "regulation" as const,
    title: "India passes data localization mandate for fintech",
    description:
      "India mandates that all fintech customer data must be stored on servers physically located in India. Reliance Jio and other Indian tech giants face compliance costs.",
    lat: 28.6139,
    lng: 77.2090, // New Delhi
    occurredAt: "2025-05-10T12:00:00Z",
    impactNote:
      "Mittal and Ambani holdings in RELIANCE.NS impacted. Compliance infrastructure spend expected to run ₹5,000–8,000 crore.",
    sourceId: "sec-edgar",
  },
  {
    type: "merger" as const,
    title: "Mercedes-Benz and Volkswagen explore joint EV platform",
    description:
      "Germany's two largest automakers announce talks for a shared electric vehicle platform, aiming to cut development costs by €4B annually.",
    lat: 52.5200,
    lng: 13.4050, // Berlin
    occurredAt: "2025-10-05T14:00:00Z",
    impactNote:
      "European automotive sector consolidation thesis. ITX.MC and other European auto holdings see upside from cost synergies.",
    sourceId: "reuters",
  },
];

const insertEvent = sqlite.prepare(`
  INSERT INTO events (id, type, title, description, lat, lng, occurred_at, impact_note, source_id, created_at)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
`);

const tx = sqlite.transaction(() => {
  for (const evt of EVENTS) {
    insertEvent.run(
      createId(),
      evt.type,
      evt.title,
      evt.description ?? null,
      evt.lat,
      evt.lng,
      evt.occurredAt,
      evt.impactNote ?? null,
      evt.sourceId ?? null,
      new Date().toISOString()
    );
  }
});

tx();
console.log(`Seeded ${EVENTS.length} events.`);

sqlite.close();
