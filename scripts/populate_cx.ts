import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { text, real, integer } from "drizzle-orm/sqlite-core";
import { createId } from "@paralleldrive/cuid2";
import { eq } from "drizzle-orm";
import { readFileSync, existsSync } from "fs";
import { join } from "path";

const sqlite = new Database(join(process.cwd(), "data", "app.db"));
const db = drizzle(sqlite);

const securities = {
  id: text("id").primaryKey(),
  ticker: text("ticker").notNull(),
  exchange: text("exchange").notNull(),
  name: text("name"),
  currency: text("currency").notNull(),
  cik: text("cik"),
  sourceUrl: text("source_url").notNull(),
  createdAt: text("created_at").notNull(),
};

const fxRates = {
  base: text("base").notNull(),
  quote: text("quote").notNull().default("USD"),
  asOf: text("as_of").notNull(),
  rate: real("rate").notNull(),
  sourceUrl: text("source_url").notNull(),
  createdAt: text("created_at").notNull(),
};

// Currency mapping by exchange
const EXCHANGE_CURRENCY: Record<string, string> = {
  NYSE: "USD",
  NASDAQ: "USD",
  EPA: "EUR",
  BME: "EUR",
  NSE: "INR",
  LSE: "GBP",
};

async function loadSecurities() {
  const filePath = join(process.cwd(), "data", "curated", "securities.csv");
  if (!existsSync(filePath)) {
    console.error("Missing securities.csv");
    return;
  }
  const lines = readFileSync(filePath, "utf8").trim().split("\n");
  const headers = lines[0].split(",").map(h => h.trim());
  const rows = lines.slice(1).map(line => {
    const vals = line.split(",").map(v => v.trim());
    const obj: Record<string, string> = {};
    headers.forEach((h, i) => (obj[h] = vals[i] ?? ""));
    return obj;
  });

  for (const row of rows) {
    const [existing] = await db.select().from(securities as any).where(eq((securities as any).ticker, row.ticker)).limit(1);
    if (existing) continue;
    const currency = row.currency?.trim() || EXCHANGE_CURRENCY[row.exchange] || "USD";
    await db.insert(securities as any).values({
      id: createId(),
      ticker: row.ticker,
      exchange: row.exchange,
      name: row.name?.trim() || null,
      currency,
      cik: (row.cik?.trim() && row.cik?.trim() !== "NA") ? row.cik.trim() : null,
      sourceUrl: row.source_url?.trim() || "",
      createdAt: new Date().toISOString(),
    });
  }
  console.log(`Securities loaded: ${rows.length} rows`);
}

async function loadFxRates() {
  const url = "https://api.frankfurter.app/latest?symbols=INR,EUR,GBP";
  let rates: Record<string, number> = {};
  try {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json() as { rates: Record<string, number> };
    rates = data.rates;
  } catch (e) {
    console.warn("FX fetch failed — using defaults", e);
    rates = { EUR: 1.08, INR: 0.012, GBP: 1.27 };
  }

  const today = new Date().toISOString().slice(0, 10);
  for (const [currency, rate] of Object.entries(rates)) {
    if (currency === "USD") continue;
    const [existing] = await db.select().from(fxRates as any).where(eq((fxRates as any).base, currency)).limit(1);
    if (!existing) {
      await db.insert(fxRates as any).values({
        base: currency,
        quote: "USD",
        asOf: today,
        rate,
        sourceUrl: url,
        createdAt: new Date().toISOString(),
      });
    }
  }
  console.log("FX rates loaded:", Object.keys(rates).filter(c => c !== "USD").join(", "));
}

await loadSecurities();
await loadFxRates();
sqlite.close();
console.log("Done.");
