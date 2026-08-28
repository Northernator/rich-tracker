-- Slice 5: Pledged shares and SEC filing CIK
-- The leverage blind spot: billionaires pledge shares as collateral.
-- These can be liquidated in margin calls, hiding real risk from 13F-only views.

CREATE TABLE IF NOT EXISTS pledge_holdings (
  id             TEXT PRIMARY KEY,
  person_id      TEXT NOT NULL REFERENCES people(id) ON DELETE CASCADE,
  ticker         TEXT NOT NULL,
  exchange       TEXT NOT NULL,
  shares_pledged INTEGER NOT NULL,
  as_of          TEXT NOT NULL,
  source         TEXT,
  created_at     TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
);

CREATE INDEX IF NOT EXISTS idx_pledge_person
  ON pledge_holdings (person_id, as_of DESC);

CREATE INDEX IF NOT EXISTS idx_pledge_ticker
  ON pledge_holdings (ticker, as_of DESC);

-- Add filing_cik to people for EDGAR lookups
ALTER TABLE people ADD COLUMN filing_cik TEXT;
