import { sqliteTable, text, integer, real } from "drizzle-orm/sqlite-core";
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
  rank: integer("rank"),
  rawPath: text("raw_path"),
  raw: text("raw"), // JSON string
  createdAt: text("created_at").notNull().default(""),
});

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
  createdAt: text("created_at").notNull().default(""),
});

export const stockSnapshots = sqliteTable("stock_snapshots", {
  id: text("id").primaryKey(),
  ticker: text("ticker").notNull(),
  exchange: text("exchange").notNull(),
  priceCents: integer("price_cents").notNull(),
  asOf: text("as_of").notNull(),
  source: text("source"),
  createdAt: text("created_at").notNull().default(""),
});

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
  createdAt: text("created_at").notNull().default(""),
});

export type PledgeHolding = typeof pledgeHoldings.$inferSelect;
