-- 0020: Chunk 12 — free-API integrations (Postcodes.io, OpenFIGI, GNews, FRED).
--
-- Three additive changes, no rewrites of existing rows:
--
--   1. `securities` gains nullable FIGI columns. The OpenFIGI loader fills
--      them where NULL; it never invents a security and never overwrites a
--      FIGI that is already there. A FIGI is evidence the ticker+exchange
--      pair names the instrument we think it does.
--   2. `postcode_coords` caches one (lat, lng) per normalised UK postcode so
--      the geocode loader costs ~1 bulk request per run and never re-asks.
--      `assets.lat/lng` are filled from it only where currently NULL.
--   3. `macro_observations` holds a handful of FRED benchmark series
--      (CPI, policy rate, long rate) with (series_id, as_of) uniqueness, so a
--      re-run inserts nothing.
--
-- Every row carries a resolvable source_url. An empty table after a loader run
-- is a valid, honest result; the loaders throw rather than substitute data.

ALTER TABLE securities ADD COLUMN figi TEXT;
ALTER TABLE securities ADD COLUMN share_class_figi TEXT;
ALTER TABLE securities ADD COLUMN figi_source_url TEXT;

CREATE TABLE IF NOT EXISTS postcode_coords (
  postcode         TEXT PRIMARY KEY,
  lat              REAL NOT NULL CHECK (lat >= -90 AND lat <= 90),
  lng              REAL NOT NULL CHECK (lng >= -180 AND lng <= 180),
  source_url       TEXT NOT NULL CHECK (source_url LIKE 'http%'),
  created_at       TEXT NOT NULL DEFAULT ''
);

CREATE TABLE IF NOT EXISTS macro_observations (
  series_id        TEXT NOT NULL,
  as_of            TEXT NOT NULL,
  value            REAL NOT NULL,
  unit             TEXT,
  source_url       TEXT NOT NULL CHECK (source_url LIKE 'http%'),
  created_at       TEXT NOT NULL DEFAULT ''
);

-- Natural key: loaders are additive. Without this a re-run doubles the table.
CREATE UNIQUE INDEX IF NOT EXISTS ux_macro_series_date ON macro_observations (series_id, as_of);

-- Source attribution for every row these loaders write. Licences are
-- deliberately "not yet confirmed": none of the four providers' display terms
-- have been read and recorded, so all four sit at "unlicensed" in
-- src/lib/providers/licences.ts until they are.
INSERT OR IGNORE INTO sources (id, name, url, license, attribution, created_at)
VALUES
  (
    'postcodes-io',
    'Postcodes.io — UK postcode geocoding (ONS open postcode data)',
    'https://api.postcodes.io/',
    'Licence not yet confirmed — internal use only until recorded in src/lib/providers/licences.ts',
    'Coordinates derived from UK open postcode data via the Postcodes.io API.',
    ''
  ),
  (
    'openfigi',
    'OpenFIGI — Bloomberg Open Symbology identifier mapping',
    'https://www.openfigi.com/api/documentation',
    'Licence not yet confirmed — internal use only until recorded in src/lib/providers/licences.ts',
    'Security identifiers cross-checked against the OpenFIGI mapping API.',
    ''
  ),
  (
    'gnews',
    'GNews API — news discovery (articles cited to their publishers)',
    'https://gnews.io/docs/v4',
    'Licence not yet confirmed — internal use only until recorded in src/lib/providers/licences.ts',
    'Events discovered via the GNews API; each row cites the publisher article URL, not GNews.',
    ''
  ),
  (
    'fred',
    'FRED — Federal Reserve Bank of St. Louis economic data',
    'https://fred.stlouisfed.org/docs/api/fred/',
    'Licence not yet confirmed — internal use only until recorded in src/lib/providers/licences.ts',
    'Macro observations from the FRED API, cited per series page.',
    ''
  );
