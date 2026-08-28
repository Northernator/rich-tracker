import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { sqliteTable, text, integer, real } from "drizzle-orm/sqlite-core";
import { createId } from "@paralleldrive/cuid2";
import { join } from "path";

const schema = {
  billionaires: sqliteTable("billionaires", {
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
  }),
};

const sqlite = new Database(join(process.cwd(), "data", "app.db"));
const db = drizzle(sqlite, { schema });

const seedData = [
  {
    name: "Elon Musk",
    rank: 1,
    prevRank: 1,
    source: "Forbes",
    industry: "Technology",
    country: "USA",
    estimatedWealth: 251.4,
    confirmedWealth: 189.2,
    liquidityPct: 75.3,
    lastUpdated: "2026-08-27T12:00:00Z",
  },
  {
    name: "Jeff Bezos",
    rank: 2,
    prevRank: 2,
    source: "Forbes",
    industry: "Technology",
    country: "USA",
    estimatedWealth: 212.8,
    confirmedWealth: 156.4,
    liquidityPct: 73.5,
    lastUpdated: "2026-08-27T12:00:00Z",
  },
  {
    name: "Bernard Arnault",
    rank: 3,
    prevRank: 3,
    source: "Forbes",
    industry: "Luxury Goods",
    country: "France",
    estimatedWealth: 198.2,
    confirmedWealth: 142.1,
    liquidityPct: 71.7,
    lastUpdated: "2026-08-27T12:00:00Z",
  },
  {
    name: "Mark Zuckerberg",
    rank: 4,
    prevRank: 5,
    source: "Forbes",
    industry: "Technology",
    country: "USA",
    estimatedWealth: 187.5,
    confirmedWealth: 134.8,
    liquidityPct: 72.0,
    lastUpdated: "2026-08-27T12:00:00Z",
  },
  {
    name: "Larry Ellison",
    rank: 5,
    prevRank: 4,
    source: "Forbes",
    industry: "Technology",
    country: "USA",
    estimatedWealth: 182.3,
    confirmedWealth: 128.9,
    liquidityPct: 70.7,
    lastUpdated: "2026-08-27T12:00:00Z",
  },
  {
    name: "Warren Buffett",
    rank: 6,
    prevRank: 6,
    source: "Forbes",
    industry: "Finance & Investments",
    country: "USA",
    estimatedWealth: 146.8,
    confirmedWealth: 98.2,
    liquidityPct: 66.9,
    lastUpdated: "2026-08-27T12:00:00Z",
  },
  {
    name: "Bill Gates",
    rank: 7,
    prevRank: 7,
    source: "Forbes",
    industry: "Technology",
    country: "USA",
    estimatedWealth: 142.1,
    confirmedWealth: 89.4,
    liquidityPct: 62.9,
    lastUpdated: "2026-08-27T12:00:00Z",
  },
  {
    name: "Larry Page",
    rank: 8,
    prevRank: 8,
    source: "Forbes",
    industry: "Technology",
    country: "USA",
    estimatedWealth: 138.4,
    confirmedWealth: 87.2,
    liquidityPct: 63.0,
    lastUpdated: "2026-08-27T12:00:00Z",
  },
  {
    name: "Sergey Brin",
    rank: 9,
    prevRank: 9,
    source: "Forbes",
    industry: "Technology",
    country: "USA",
    estimatedWealth: 131.2,
    confirmedWealth: 82.4,
    liquidityPct: 62.8,
    lastUpdated: "2026-08-27T12:00:00Z",
  },
  {
    name: "Mukesh Ambani",
    rank: 10,
    prevRank: 11,
    source: "Forbes",
    industry: "Diversified",
    country: "India",
    estimatedWealth: 127.8,
    confirmedWealth: 78.2,
    liquidityPct: 61.2,
    lastUpdated: "2026-08-27T12:00:00Z",
  },
];

const existing = db.select().from(schema.billionaires).all();
if (existing.length > 0) {
  console.log("Database already seeded with", existing.length, "records. Skipping.");
  process.exit(0);
}

for (const person of seedData) {
  db.insert(schema.billionaires).values(person).run();
}

console.log("Seeded", seedData.length, "billionaires");
