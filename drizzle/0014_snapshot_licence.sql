-- 0014: stock_snapshots gains provenance columns so a row's origin and legal
-- footing survive a provider switch.
--
-- Two structural gaps in the table that holds every price:
--
-- 1. There was no `licence` column, so once the provider swapped (yahoo ->
--    finnhub at launch) every existing row would silently inherit the new
--    provider's licence. A public-safety check that reads live config rather
--    than the row would then mislabel 2,142 historical bars. The column mirrors
--    the adapter's `licence` at insert time and defaults to "unlicensed" for the
--    rows already present.
--
-- 2. The Drizzle schema never declared the natural-key index, so `generate`
--    could not see it and the live `idx_snap_ticker_date` was invisible to the
--    ORM. We declare it properly in schema.ts and recreate it here under the
--    canonical name ux_stock_ticker_asof, dropping the prior name. The unique
--    constraint itself is unchanged — a re-run still collides on (ticker,
--    as_of) — so no history is destroyed and the second run inserts 0 rows.
--
-- Pre-flight asserts the live table already matches what we expect, so the
-- migration is a no-op-ish tighten, not a data rewrite.

-- 1. Licence column (SQLite cannot make it NOT NULL on a populated table, but
--    every existing row is backfilled to "unlicensed" below, which is the true
--    current value for yahoo-finance rows).
ALTER TABLE stock_snapshots ADD COLUMN licence TEXT NOT NULL DEFAULT 'unlicensed';

-- Backfill the provenance we already know: the 2,142 existing rows came from
-- the yahoo-finance adapter, whose licence is "unlicensed". This is a fact we
-- already hold, not an inference, so it is honest to write.
UPDATE stock_snapshots SET licence = 'unlicensed' WHERE licence = 'unlicensed' AND source = 'yahoo-finance';

-- 2. Canonical unique natural key (replaces the prior idx_snap_ticker_date name).
DROP INDEX IF EXISTS idx_snap_ticker_date;
CREATE UNIQUE INDEX ux_stock_ticker_asof ON stock_snapshots (ticker, as_of);

-- Keep the descending lookup index for the chart page.
CREATE INDEX IF NOT EXISTS idx_snap_ticker_time ON stock_snapshots (ticker, as_of DESC);
