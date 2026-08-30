-- ============================================================
-- Baseline: full schema for a fresh clone.
-- Produced by squashing migrations 0000–0012.
-- Run: drizzle-kit migrate
-- ============================================================

-- Legacy table — kept for backwards compatibility with seed.ts
CREATE TABLE IF NOT EXISTS billionaires (
  id                 TEXT PRIMARY KEY,
  name               TEXT NOT NULL,
  rank               INTEGER NOT NULL,
  prev_rank          INTEGER,
  source             TEXT NOT NULL,
  industry           TEXT NOT NULL,
  country            TEXT NOT NULL,
  estimated_wealth   REAL NOT NULL,
  confirmed_wealth   REAL NOT NULL,
  liquidity_pct      REAL NOT NULL,
  last_updated       TEXT NOT NULL
);

-- Slice 1: Core — sources, people, baseline estimates
CREATE TABLE IF NOT EXISTS sources (
  id           TEXT PRIMARY KEY,
  name         TEXT NOT NULL,
  url          TEXT,
  license      TEXT,
  attribution  TEXT NOT NULL,
  created_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
);

CREATE TABLE IF NOT EXISTS people (
  id                 TEXT PRIMARY KEY,
  slug               TEXT NOT NULL UNIQUE,
  full_name          TEXT NOT NULL,
  aliases            TEXT DEFAULT '[]' CHECK (json_valid(aliases)),
  country            TEXT,
  primary_org        TEXT,
  born_year          INTEGER,
  photo_url          TEXT,
  is_public_figure   INTEGER NOT NULL DEFAULT 1,
  filing_cik         TEXT,
  created_at         TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
  updated_at         TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
);

CREATE TABLE IF NOT EXISTS baseline_estimates (
  id                TEXT PRIMARY KEY,
  person_id         TEXT NOT NULL REFERENCES people(id) ON DELETE CASCADE,
  source_id         TEXT NOT NULL REFERENCES sources(id),
  net_worth_cents   INTEGER NOT NULL,
  as_of             TEXT NOT NULL,
  rank              INTEGER,
  raw_path          TEXT,
  raw               TEXT CHECK (raw IS NULL OR json_valid(raw)),
  created_at        TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
  UNIQUE (person_id, source_id, as_of)
);

CREATE INDEX IF NOT EXISTS idx_baseline_person_time
  ON baseline_estimates (person_id, as_of DESC);

-- Slice 2: Liquid equity — holdings × price snapshots
CREATE TABLE IF NOT EXISTS equity_holdings (
  id          TEXT PRIMARY KEY,
  person_id   TEXT NOT NULL REFERENCES people(id) ON DELETE CASCADE,
  ticker      TEXT NOT NULL,
  exchange    TEXT NOT NULL,
  shares      INTEGER NOT NULL,
  as_of       TEXT NOT NULL,
  estimated   INTEGER NOT NULL DEFAULT 0,
  source      TEXT,
  source_url  TEXT NOT NULL DEFAULT '',
  created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
);

CREATE INDEX IF NOT EXISTS idx_equity_person
  ON equity_holdings (person_id, as_of DESC);

CREATE INDEX IF NOT EXISTS idx_equity_ticker
  ON equity_holdings (ticker, as_of DESC);

CREATE TABLE IF NOT EXISTS stock_snapshots (
  id          TEXT PRIMARY KEY,
  ticker      TEXT NOT NULL,
  exchange    TEXT NOT NULL,
  price_cents INTEGER NOT NULL,
  as_of       TEXT NOT NULL,
  source      TEXT,
  currency    TEXT NOT NULL DEFAULT 'USD',
  created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
);

CREATE INDEX IF NOT EXISTS idx_snap_ticker_time
  ON stock_snapshots (ticker, as_of DESC);

CREATE UNIQUE INDEX IF NOT EXISTS idx_snap_ticker_date
  ON stock_snapshots (ticker, as_of);

-- Slice 2b: Securities registry + FX rates
CREATE TABLE IF NOT EXISTS securities (
  id          TEXT PRIMARY KEY,
  ticker      TEXT NOT NULL,
  exchange    TEXT NOT NULL,
  name        TEXT,
  currency    TEXT NOT NULL,
  cik         TEXT,
  source_url  TEXT NOT NULL,
  created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
  UNIQUE (ticker, exchange)
);

CREATE TABLE IF NOT EXISTS fx_rates (
  base        TEXT NOT NULL,
  quote       TEXT NOT NULL DEFAULT 'USD',
  as_of       TEXT NOT NULL,
  rate        REAL NOT NULL,
  source_url  TEXT NOT NULL,
  created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
  PRIMARY KEY (base, quote, as_of)
) WITHOUT ROWID;

-- Slice 5: Pledged shares
CREATE TABLE IF NOT EXISTS pledge_holdings (
  id             TEXT PRIMARY KEY,
  person_id      TEXT NOT NULL REFERENCES people(id) ON DELETE CASCADE,
  ticker         TEXT NOT NULL,
  exchange       TEXT NOT NULL,
  shares_pledged INTEGER NOT NULL,
  as_of          TEXT NOT NULL,
  source         TEXT,
  source_url     TEXT NOT NULL DEFAULT '',
  evidence_text  TEXT,
  filing_id      TEXT,
  source_type    TEXT NOT NULL DEFAULT 'unknown',
  created_at     TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
);

CREATE INDEX IF NOT EXISTS idx_pledge_person
  ON pledge_holdings (person_id, as_of DESC);

CREATE INDEX IF NOT EXISTS idx_pledge_ticker
  ON pledge_holdings (ticker, as_of DESC);

-- Slice 6: Asset → owner graph
CREATE TABLE IF NOT EXISTS assets (
  id                      TEXT PRIMARY KEY,
  name                    TEXT NOT NULL,
  asset_type              TEXT NOT NULL,
  description             TEXT,
  location                TEXT,
  estimated_value_cents   INTEGER,
  source_id               TEXT REFERENCES sources(id),
  lat                     REAL,
  lng                     REAL,
  created_at              TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
);

CREATE TABLE IF NOT EXISTS ownership_links (
  id              TEXT PRIMARY KEY,
  asset_id        TEXT NOT NULL REFERENCES assets(id) ON DELETE CASCADE,
  person_id       TEXT NOT NULL REFERENCES people(id) ON DELETE CASCADE,
  ownership_pct   REAL,
  confidence      TEXT NOT NULL,
  citation        TEXT,
  source_id       TEXT REFERENCES sources(id),
  as_of           TEXT,
  created_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
);

CREATE INDEX IF NOT EXISTS idx_ownership_asset
  ON ownership_links (asset_id, confidence DESC);

CREATE INDEX IF NOT EXISTS idx_ownership_person
  ON ownership_links (person_id, confidence DESC);

CREATE INDEX IF NOT EXISTS idx_assets_type
  ON assets (asset_type);

CREATE INDEX IF NOT EXISTS idx_assets_location
  ON assets (lat, lng);

-- Slice 8: Events
CREATE TABLE IF NOT EXISTS events (
  id            TEXT PRIMARY KEY,
  type          TEXT NOT NULL,
  title         TEXT NOT NULL,
  description   TEXT,
  lat           REAL,
  lng           REAL,
  occurred_at   TEXT NOT NULL,
  impact_note   TEXT,
  source_id     TEXT REFERENCES sources(id),
  source_url    TEXT,
  created_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
);

CREATE INDEX IF NOT EXISTS idx_events_type
  ON events (type);

CREATE INDEX IF NOT EXISTS idx_events_occurred
  ON events (occurred_at DESC);

-- Slice 14: Event-Asset spatial links + impact
CREATE TABLE IF NOT EXISTS event_asset_links (
  id               TEXT PRIMARY KEY,
  event_id         TEXT NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  asset_id         TEXT NOT NULL REFERENCES assets(id) ON DELETE CASCADE,
  distance_km      REAL NOT NULL,
  created_at       TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
);

CREATE TABLE IF NOT EXISTS event_impacts (
  id                    TEXT PRIMARY KEY,
  event_asset_link_id   TEXT NOT NULL REFERENCES event_asset_links(id) ON DELETE CASCADE,
  ticker                TEXT,
  market_delta_pct      REAL,
  index_delta_pct       REAL,
  excess_pct            REAL,
  impact_note           TEXT,
  created_at            TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
);
