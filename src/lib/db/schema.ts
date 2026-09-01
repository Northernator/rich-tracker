import { sqliteTable, text, integer, real, uniqueIndex, index } from "drizzle-orm/sqlite-core";
import { createId } from "@paralleldrive/cuid2";

// Legacy table — kept for backwards compatibility
export const billionaires = sqliteTable("billionaires", {
  id: text("id").primaryKey().$defaultFn(() => createId()),
  name: text("name").notNull(),
  rank: integer("rank").notNull(),
  prevRank: integer("prev_rank"),
  source: text("source").notNull(),
  industry: text("industry").notNull(),
  country: text("country").notNull(),
  estimatedWealth: real("estimated_wealth").notNull(),
  confirmedWealth: real("confirmed_wealth").notNull(),
  liquidityPct: real("liquidity_pct").notNull(),
  lastUpdated: text("last_updated").notNull(),
});

// Slice 1: Core schema
export const sources = sqliteTable("sources", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  url: text("url"),
  license: text("license"),
  attribution: text("attribution").notNull(),
  createdAt: text("created_at").notNull().default(""),
});

export const people = sqliteTable("people", {
  id: text("id").primaryKey(),
  slug: text("slug").notNull().unique(),
  fullName: text("full_name").notNull(),
  aliases: text("aliases").default('[]'),
  country: text("country"),
  primaryOrg: text("primary_org"),
  bornYear: integer("born_year"),
  photoUrl: text("photo_url"),
  isPublicFigure: integer("is_public_figure").notNull().default(1),
  filingCik: text("filing_cik"), // SEC EDGAR CIK for 13F / Form 4 filings
  createdAt: text("created_at").notNull().default(""),
  updatedAt: text("updated_at").notNull().default(""),
});

export const baselineEstimates = sqliteTable("baseline_estimates", {
  id: text("id").primaryKey(),
  personId: text("person_id").notNull().references(() => people.id, { onDelete: "cascade" }),
  sourceId: text("source_id").notNull().references(() => sources.id),
  netWorthCents: integer("net_worth_cents").notNull(),
  asOf: text("as_of").notNull(),
  /**
   * The document that supports THIS claim, not the source in general.
   * A `sources` row tells you who published the list; this resolves to the
   * page or file where the individual figure can be checked. Nullable only
   * because rows loaded before this column existed have to be backfilled from
   * their raw capture — see scripts/backfill_baseline_source_url.ts.
   */
  sourceUrl: text("source_url"),
  rank: integer("rank"),
  rawPath: text("raw_path"),
  raw: text("raw"), // JSON string
  createdAt: text("created_at").notNull().default(""),
}, (t) => ({
  /**
   * The natural key. Without it `onConflictDoNothing` is a no-op (the PK is a
   * cuid that can never collide) and re-running a loader silently doubles the
   * table. With it, "loaders are additive" is enforced by the database.
   */
  uniqPersonSourceAsOf: uniqueIndex("ux_baseline_person_source_asof").on(
    t.personId,
    t.sourceId,
    t.asOf
  ),
  idxSource: index("idx_baseline_source").on(t.sourceId),
}));

export type Source = typeof sources.$inferSelect;
export type Person = typeof people.$inferSelect;
export type BaselineEstimate = typeof baselineEstimates.$inferSelect;

// Slice 2: Liquid equity tracking
export const equityHoldings = sqliteTable("equity_holdings", {
  id: text("id").primaryKey(),
  personId: text("person_id").notNull().references(() => people.id, { onDelete: "cascade" }),
  ticker: text("ticker").notNull(),
  exchange: text("exchange").notNull(),
  shares: integer("shares").notNull(),
  asOf: text("as_of").notNull(),
  estimated: integer("estimated").notNull().default(0),
  source: text("source"),
  sourceUrl: text("source_url").notNull(),
  createdAt: text("created_at").notNull().default(""),
});

export const stockSnapshots = sqliteTable("stock_snapshots", {
  id: text("id").primaryKey(),
  ticker: text("ticker").notNull(),
  exchange: text("exchange").notNull(),
  priceCents: integer("price_cents").notNull(),
  asOf: text("as_of").notNull(),
  source: text("source"),
  /**
   * The provider name that produced this row. Persists a row's provenance past
   * a provider switch: after migrating from yahoo to finnhub the old rows must
   * still be attributable to yahoo.
   */
  currency: text("currency").notNull().default("USD"),
  /**
   * Mirrors the adapter's `licence` at insert time. Same purpose as `source`:
   * a row's legal footing survives a provider swap, and the public-safety check
   * ("may this price be displayed?") reads this column, not live config.
   */
  licence: text("licence").notNull().default("unlicensed"),
  createdAt: text("created_at").notNull().default(""),
}, (t) => ({
  /**
   * The natural key. `onConflictDoNothing()` is a no-op against the cuid PK, so
   * without this a re-run silently doubles the table. With it, "loaders are
   * additive" is enforced by the database. The live table already carries
   * idx_snap_ticker_date; declaring it here keeps the schema and the DB in
   * agreement so future migrations generate cleanly.
   */
  uniqTickerAsOf: uniqueIndex("ux_stock_ticker_asof").on(t.ticker, t.asOf),
  idxTickerDate: index("idx_snap_ticker_date").on(t.ticker, t.asOf),
}));

export type EquityHolding = typeof equityHoldings.$inferSelect;
export type StockSnapshot = typeof stockSnapshots.$inferSelect;

// Slice 5: Pledged shares — the leverage blind spot
// When billionaires pledge shares as collateral, those holdings can be
// liquidated in a margin call. Shows up in 13F as reduced reported ownership
// but the economic risk is real.
export const pledgeHoldings = sqliteTable("pledge_holdings", {
  id: text("id").primaryKey(),
  personId: text("person_id").notNull().references(() => people.id, { onDelete: "cascade" }),
  ticker: text("ticker").notNull(),
  exchange: text("exchange").notNull(),
  sharesPledged: integer("shares_pledged").notNull(),
  asOf: text("as_of").notNull(),
  source: text("source"), // e.g. "SEC 13F", "Form 4", "Bloomberg"
  sourceUrl: text("source_url").notNull(),
  evidenceText: text("evidence_text"),
  filingId: text("filing_id"),
  sourceType: text("source_type").notNull().default("unknown"), // "verified" | "estimated" | "unverified"
  createdAt: text("created_at").notNull().default(""),
});

export type PledgeHolding = typeof pledgeHoldings.$inferSelect;

// Slice 2b: Securities registry — anchor for ticker/exchange/currency lookups
export const securities = sqliteTable("securities", {
  id: text("id").primaryKey(),
  ticker: text("ticker").notNull(),
  exchange: text("exchange").notNull(),
  name: text("name"),
  currency: text("currency").notNull(), // ISO 4217: USD, EUR, INR, GBP, …
  cik: text("cik"), // SEC EDGAR CIK for US-listed securities
  sourceUrl: text("source_url").notNull(),
  createdAt: text("created_at").notNull().default(""),
});

// Slice 2b: FX rates — frankfurter.app / ECB daily rates
// Allows converting a holding's local-currency value to USD at the date of the snapshot.
export const fxRates = sqliteTable("fx_rates", {
  base: text("base").notNull(),        // ISO 4217, e.g. "INR"
  quote: text("quote").notNull().default("USD"),
  asOf: text("as_of").notNull(),       // YYYY-MM-DD
  rate: real("rate").notNull(),        // 1 base = rate quote
  sourceUrl: text("source_url").notNull(),
  createdAt: text("created_at").notNull().default(""),
}, (t) => ({
  /**
   * One row per currency per day. Without it `onConflictDoNothing` is a no-op
   * against the cuid-less natural key and a re-run doubles the table. Also the
   * structural guarantee behind "historical snapshots convert at the rate that
   * applied then": the (base, quote, as_of) triple must be unique or a date
   * can silently hold two conflicting rates.
   */
  uxFxBaseQuoteDate: uniqueIndex("ux_fx_base_quote_date").on(t.base, t.quote, t.asOf),
}));

// Slice 6: Asset→owner graph
// Physical assets (real estate, vessels, aircraft, art) owned by people.
// Company stakes are tracked separately in equity_holdings — do NOT use
// asset_type='company' here. This separation is critical: a company's
// market value is derived from share price × shares, while a mansion's
// value is assessed. Mixing them distorts every total.
export const assets = sqliteTable("assets", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  assetType: text("asset_type").notNull(), // 'real_estate' | 'vessel' | 'aircraft' | 'art' | 'other'
  description: text("description"),
  location: text("location"),
  estimatedValueCents: integer("estimated_value_cents"),
  sourceId: text("source_id").references(() => sources.id),
  // Structural guarantee, not advice: an asset cannot exist without a
  // resolvable citation. The loader already required this — the column was
  // missing, so 36 fabricated rows landed with no provenance at all.
  sourceUrl: text("source_url").notNull(),
  /**
   * The registry's own identifier for this asset — HM Land Registry title
   * number for UK property, FAA N-number for aircraft, IMO for vessels. Added
   * in migration 0018 so an ownership chain can name a property by the
   * identifier the Land Register uses, instead of by a display string that
   * differs between monthly releases.
   */
  externalRef: text("external_ref"),
  lat: real("lat"),
  lng: real("lng"),
  createdAt: text("created_at").notNull().default(""),
});

export const ownershipLinks = sqliteTable("ownership_links", {
  id: text("id").primaryKey(),
  assetId: text("asset_id").notNull().references(() => assets.id, { onDelete: "cascade" }),
  personId: text("person_id").notNull().references(() => people.id, { onDelete: "cascade" }),
  ownershipPct: real("ownership_pct"), // 0–100, nullable for unclear splits
  confidence: text("confidence").notNull(), // 'high' | 'medium' | 'low'
  citation: text("citation"), // human-readable note ABOUT the source, not the source
  sourceId: text("source_id").references(() => sources.id),
  sourceUrl: text("source_url").notNull(),
  asOf: text("as_of"),
  createdAt: text("created_at").notNull().default(""),
}, (t) => ({
  // One person owns a given asset once. 35 duplicate pairs existed before this.
  uniqAssetPerson: uniqueIndex("ux_ownership_asset_person").on(t.assetId, t.personId),
}));

export type Asset = typeof assets.$inferSelect;
export type OwnershipLink = typeof ownershipLinks.$inferSelect;

/**
 * Chunk 10 — one hop of an ownership chain, never a whole claim.
 *
 *   property (Land Registry title) → company (Companies House) → person (PSC)
 *
 * `ownership_links` collapses that into a single asset↔person row with a
 * three-valued confidence, which cannot express "this hop is solid and that
 * hop is weak". Here each hop is its own row with its own citation and a
 * numeric confidence, so confidence multiplies along the path and the weak
 * hop is identifiable.
 *
 * Node ids are the registry's identifiers, not cuids:
 *   person → people.id · company → "ch:12345678" · property → "title:BLG69408"
 */
export const entityEdges = sqliteTable("entity_edges", {
  id: text("id").primaryKey().$defaultFn(() => createId()),
  edgeType: text("edge_type").notNull(), // 'company_owns_property' | 'person_controls_company'
  fromEntityType: text("from_entity_type").notNull(), // 'person' | 'company' | 'property'
  fromEntityId: text("from_entity_id").notNull(),
  fromLabel: text("from_label").notNull(),
  toEntityType: text("to_entity_type").notNull(),
  toEntityId: text("to_entity_id").notNull(),
  toLabel: text("to_label").notNull(),
  /** 0..1. Multiplies along a path; anything under 0.5 renders as "possible link". */
  confidence: real("confidence").notNull(),
  sourceId: text("source_id").references(() => sources.id),
  sourceUrl: text("source_url").notNull(),
  /** JSON — registry-specific facts (nature of control, tenure, notified date). */
  detail: text("detail"),
  asOf: text("as_of"),
  createdAt: text("created_at").notNull().default(""),
});

export type EntityEdge = typeof entityEdges.$inferSelect;

/** The threshold below which a chain is a possibility, not a finding. */
export const CHAIN_CONFIDENCE_FLOOR = 0.5;

// Slice 8: Events — real-world events near owned assets
export const events = sqliteTable("events", {
  id: text("id").primaryKey(),
  type: text("type").notNull(),
  title: text("title").notNull(),
  description: text("description"),
  lat: real("lat"),
  lng: real("lng"),
  occurredAt: text("occurred_at").notNull(),
  sourceId: text("source_id").references(() => sources.id),
  sourceUrl: text("source_url"),
  createdAt: text("created_at").notNull().default(""),
});

export type Event = typeof events.$inferSelect;

// Slice 14: Event-Asset spatial links (R-tree bounding box + haversine)
// Links earthquakes (lat/lng events) to nearby physical assets within range.
export const eventAssetLinks = sqliteTable("event_asset_links", {
  id: text("id").primaryKey(),
  eventId: text("event_id").notNull().references(() => events.id, { onDelete: "cascade" }),
  assetId: text("asset_id").notNull().references(() => assets.id, { onDelete: "cascade" }),
  distanceKm: real("distance_km").notNull(),
  createdAt: text("created_at").notNull().default(""),
});

// Slice 14: Event Impact — benchmark-adjusted market moves
// For each event-asset-link, captures the stock's return vs a market benchmark
// on the event date. excess_pct = market_delta_pct - index_delta_pct.
// Null results are explicit: no stock data, no benchmark data, or event outside range.
export const eventImpacts = sqliteTable("event_impacts", {
  id: text("id").primaryKey(),
  eventAssetLinkId: text("event_asset_link_id").notNull().references(() => eventAssetLinks.id, { onDelete: "cascade" }),
  ticker: text("ticker"), // the stock that moved (may be null for non-market events)
  marketDeltaPct: real("market_delta_pct"), // stock return % on event date
  indexDeltaPct: real("index_delta_pct"), // benchmark return % on event date
  excessPct: real("excess_pct"), // market_delta_pct - index_delta_pct
  impactNote: text("impact_note"), // human-readable summary
  createdAt: text("created_at").notNull().default(""),
});

export type EventAssetLink = typeof eventAssetLinks.$inferSelect;
export type EventImpact = typeof eventImpacts.$inferSelect;

// Slice 15: Persisted valuation snapshots — "the honest number", frozen.
// One row per person per run. The `inputs` JSON records every number that
// produced liquid_cents (each holding's security_id, share count, price_cents,
// as_of, FX rate, and the baseline row id) so the figure can be reproduced
// exactly from the stored inputs. method_version starts at 'v1' and only ever
// moves forward — old rows are never recomputed under a new version, new rows
// are inserted alongside them.
export const valuationSnapshots = sqliteTable("valuation_snapshots", {
  id: text("id").primaryKey(),
  personId: text("person_id").notNull().references(() => people.id, { onDelete: "cascade" }),
  ts: text("ts").notNull(), // ISO instant, truncated to the minute
  liquidCents: integer("liquid_cents").notNull(),
  baselineCents: integer("baseline_cents").notNull(),
  pledgedCents: integer("pledged_cents").notNull().default(0),
  verifiability: real("verifiability"), // liquid / baseline, deliberately NOT clamped to <= 1
  methodVersion: text("method_version").notNull(),
  inputs: text("inputs").notNull(), // JSON — the full audit trail for this row
  createdAt: text("created_at").notNull().default(""),
}, (t) => ({
  ixSnapPersonTs: index("ix_snap_person_ts").on(t.personId, t.ts),
  /**
   * Anti-duplicate guarantee. ts is minute-truncated, so a second run within
   * the same minute produces the same (person_id, ts, method_version) and
   * `onConflictDoNothing()` inserts nothing — running `npm run snapshot`
   * twice in a minute never doubles the table.
   */
  uxSnapPersonTsMethod: uniqueIndex("ux_snap_person_ts_method").on(
    t.personId,
    t.ts,
    t.methodVersion
  ),
}));

export type ValuationSnapshot = typeof valuationSnapshots.$inferSelect;
