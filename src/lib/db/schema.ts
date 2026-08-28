import { sqliteTable, text, integer, real } from "drizzle-orm/sqlite-core";
import { createId } from "@paralleldrive/cuid2";

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

export type Billionaire = typeof billionaires.$inferSelect;
