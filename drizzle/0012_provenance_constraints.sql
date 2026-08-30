-- 0012: make provenance structural.
--
-- assets and ownership_links had no source_url column at all, so 36 assets and
-- 99 links landed with source_id NULL and nothing objected. SQLite cannot add a
-- NOT NULL column to a populated table, and every existing row is unsourced, so
-- these are rebuilt empty.

DROP TABLE IF EXISTS ownership_links;
DROP TABLE IF EXISTS assets;
DROP TABLE IF EXISTS billionaires;

CREATE TABLE assets (
  id                    TEXT PRIMARY KEY,
  name                  TEXT NOT NULL,
  asset_type            TEXT NOT NULL,
  description           TEXT,
  location              TEXT,
  estimated_value_cents INTEGER,
  source_id             TEXT REFERENCES sources(id),
  source_url            TEXT NOT NULL CHECK (source_url LIKE 'http%'),
  lat                   REAL,
  lng                   REAL,
  created_at            TEXT NOT NULL DEFAULT '',
  CHECK (asset_type IN ('real_estate','vessel','aircraft','art','other'))
);
CREATE UNIQUE INDEX ux_assets_identity ON assets (name, asset_type, COALESCE(location,''));

CREATE TABLE ownership_links (
  id            TEXT PRIMARY KEY,
  asset_id      TEXT NOT NULL REFERENCES assets(id) ON DELETE CASCADE,
  person_id     TEXT NOT NULL REFERENCES people(id) ON DELETE CASCADE,
  ownership_pct REAL,
  confidence    TEXT NOT NULL CHECK (confidence IN ('high','medium','low')),
  citation      TEXT,
  source_id     TEXT REFERENCES sources(id),
  source_url    TEXT NOT NULL CHECK (source_url LIKE 'http%'),
  as_of         TEXT,
  created_at    TEXT NOT NULL DEFAULT ''
);
CREATE UNIQUE INDEX ux_ownership_asset_person ON ownership_links (asset_id, person_id);

-- fx_rates rows were stored with the wrong currency pairs: the loader called
-- frankfurter.app without a base, which defaults to EUR, then labelled every
-- result "<currency> -> USD". EUR->INR (111.06) was stored as INR->USD.
DELETE FROM fx_rates;
