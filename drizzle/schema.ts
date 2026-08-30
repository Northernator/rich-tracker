import { sqliteTable, AnySQLiteColumn, uniqueIndex, text, integer, foreignKey, index, real, primaryKey, numeric } from "drizzle-orm/sqlite-core"
  import { sql } from "drizzle-orm"

export const people = sqliteTable("people", {
	id: text().primaryKey().notNull(),
	slug: text().notNull(),
	fullName: text("full_name").notNull(),
	aliases: text().default("[]"),
	country: text(),
	primaryOrg: text("primary_org"),
	bornYear: integer("born_year"),
	photoUrl: text("photo_url"),
	isPublicFigure: integer("is_public_figure").default(1).notNull(),
	createdAt: text("created_at").notNull(),
	updatedAt: text("updated_at").notNull(),
	filingCik: text("filing_cik"),
},
(table) => [
	uniqueIndex("people_slug_unique").on(table.slug),
]);

export const sources = sqliteTable("sources", {
	id: text().primaryKey().notNull(),
	name: text().notNull(),
	url: text(),
	license: text(),
	attribution: text().notNull(),
	createdAt: text("created_at").notNull(),
});

export const stockSnapshots = sqliteTable("stock_snapshots", {
	id: text().primaryKey().notNull(),
	ticker: text().notNull(),
	exchange: text().notNull(),
	priceCents: integer("price_cents").notNull(),
	asOf: text("as_of").notNull(),
	source: text(),
	createdAt: text("created_at").default("").notNull(),
	currency: text().default("USD").notNull(),
},
(table) => [
	uniqueIndex("idx_snap_ticker_date").on(table.ticker, table.asOf),
]);

export const baselineEstimates = sqliteTable("baseline_estimates", {
	id: text().primaryKey().notNull(),
	personId: text("person_id").notNull().references(() => people.id, { onDelete: "cascade" } ),
	sourceId: text("source_id").notNull().references(() => sources.id),
	netWorthCents: integer("net_worth_cents").notNull(),
	asOf: text("as_of").notNull(),
	rank: integer(),
	rawPath: text("raw_path"),
	raw: text(),
	createdAt: text("created_at").default("").notNull(),
});

export const events = sqliteTable("events", {
	id: text().primaryKey(),
	type: text().notNull(),
	title: text().notNull(),
	description: text(),
	lat: real(),
	lng: real(),
	occurredAt: text("occurred_at").notNull(),
	sourceId: text("source_id"),
	createdAt: text("created_at").default("sql`(strftime('%Y-%m-%dT%H:%M:%SZ','now'))`").notNull(),
	sourceUrl: text("source_url"),
},
(table) => [
	index("idx_events_occurred").on(table.occurredAt),
	index("idx_events_type").on(table.type),
]);

export const securities = sqliteTable("securities", {
	id: text().primaryKey(),
	ticker: text().notNull(),
	exchange: text().notNull(),
	name: text(),
	currency: text().notNull(),
	cik: text(),
	sourceUrl: text("source_url").notNull(),
	createdAt: text("created_at").default("sql`(strftime('%Y-%m-%dT%H:%M:%SZ','now'))`").notNull(),
	outstandingShares: integer("outstanding_shares"),
});

export const fxRates = sqliteTable("fx_rates", {
	base: text().notNull(),
	quote: text().default("USD").notNull(),
	asOf: text("as_of").notNull(),
	rate: real().notNull(),
	sourceUrl: text("source_url").notNull(),
	createdAt: text("created_at").default("sql`(strftime('%Y-%m-%dT%H:%M:%SZ','now'))`").notNull(),
},
(table) => [
	primaryKey({ columns: [table.base, table.quote, table.asOf], name: "fx_rates_base_quote_as_of_pk"})
]);

export const pledgeHoldings = sqliteTable("pledge_holdings", {
	id: text().primaryKey().notNull(),
	personId: text("person_id").notNull().references(() => people.id, { onDelete: "cascade" } ),
	ticker: text().notNull(),
	exchange: text().notNull(),
	sharesPledged: integer("shares_pledged").notNull(),
	asOf: text("as_of").notNull(),
	source: text(),
	sourceUrl: text("source_url").notNull(),
	evidenceText: text("evidence_text"),
	filingId: text("filing_id"),
	sourceType: text("source_type").default("unknown").notNull(),
	createdAt: text("created_at").default("").notNull(),
});

export const assets = sqliteTable("assets", {
	id: text().primaryKey().notNull(),
	name: text().notNull(),
	assetType: text("asset_type").notNull(),
	description: text(),
	location: text(),
	estimatedValueCents: integer("estimated_value_cents"),
	sourceId: text("source_id").references(() => sources.id),
	lat: real(),
	lng: real(),
	createdAt: text("created_at").default("").notNull(),
});

export const ownershipLinks = sqliteTable("ownership_links", {
	id: text().primaryKey().notNull(),
	assetId: text("asset_id").notNull().references(() => assets.id, { onDelete: "cascade" } ),
	personId: text("person_id").notNull().references(() => people.id, { onDelete: "cascade" } ),
	ownershipPct: real("ownership_pct"),
	confidence: text().notNull(),
	citation: text(),
	sourceId: text("source_id").references(() => sources.id),
	asOf: text("as_of"),
	createdAt: text("created_at").default("").notNull(),
});

export const equityHoldingsTemp = sqliteTable("equity_holdings_temp", {
	personId: text("person_id"),
	ticker: text(),
	asOf: numeric("as_of"),
});

export const equityHoldings = sqliteTable("equity_holdings", {
	id: text().primaryKey(),
	personId: text("person_id").notNull().references(() => people.id, { onDelete: "cascade" } ),
	ticker: text().notNull(),
	exchange: text().notNull(),
	shares: integer().notNull(),
	asOf: text("as_of").notNull(),
	estimated: integer().default(0).notNull(),
	source: text(),
	sourceUrl: text("source_url").notNull(),
	createdAt: text("created_at").default("").notNull(),
},
(table) => [
	uniqueIndex("idx_equity_person_ticker_asof").on(table.personId, table.ticker, table.asOf),
	index("idx_equity_ticker").on(table.ticker, table.asOf),
	index("idx_equity_person").on(table.personId, table.asOf),
]);

export const eventAssetLinks = sqliteTable("event_asset_links", {
	id: text().primaryKey(),
	eventId: text("event_id").notNull().references(() => events.id, { onDelete: "cascade" } ),
	assetId: text("asset_id").notNull().references(() => assets.id, { onDelete: "cascade" } ),
	distanceKm: real("distance_km").notNull(),
	createdAt: text("created_at").default("sql`(strftime('%Y-%m-%dT%H:%M:%SZ','now'))`").notNull(),
},
(table) => [
	index("idx_event_asset_asset").on(table.assetId),
	index("idx_event_asset_event").on(table.eventId),
]);

export const eventImpacts = sqliteTable("event_impacts", {
	id: text().primaryKey(),
	eventAssetLinkId: text("event_asset_link_id").notNull().references(() => eventAssetLinks.id, { onDelete: "cascade" } ),
	ticker: text(),
	marketDeltaPct: real("market_delta_pct"),
	indexDeltaPct: real("index_delta_pct"),
	excessPct: real("excess_pct"),
	impactNote: text("impact_note"),
	createdAt: text("created_at").default("sql`(strftime('%Y-%m-%dT%H:%M:%SZ','now'))`").notNull(),
},
(table) => [
	index("idx_event_impact_link").on(table.eventAssetLinkId),
]);

