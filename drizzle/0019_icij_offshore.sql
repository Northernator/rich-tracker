-- 0019: Chunk 11 — the offshore layer (ICIJ Offshore Leaks, ODbL).
--
-- The "moat": link a shell company to an entity to an offshore entity to a
-- person, resolved with one hop per row so confidence multiplies along the
-- path (exactly the Chunk 10 model, applied to ICIJ's property graph).
--
--   person (matched ICIJ officer)
--      └─ OFFICER_OF → entity (shell company)
--           └─ RELATED_ENTITY → entity (another offshore entity)
--                └─ … (depth capped at 6)
--
-- Design choice: this does NOT reuse `entity_edges`. That table is locked down
-- by chunk 10 with CHECK constraints on edge_type and entity_type that forbid
-- the ICIJ vocabulary ('officer_of_entity', 'entity', …). Rather than rebuild a
-- table that other chunks depend on, Chunk 11 gets its own graph. The two
-- graphs are siblings, not one table wearing two hats.
--
-- Staging tables hold the RAW ICIJ nodes/relationships, verbatim, so the audit
-- trail survives a reload. The resolved `offshore_edges` graph is built from
-- them by the loader and is additive (INSERT OR IGNORE on a natural key).
--
-- EVERY row here is real ICIJ data or a strict match of it. The loader throws
-- if the raw capture is missing — it never substitutes invented rows. An empty
-- table is a valid, honest result; shipping zero rows beats shipping invented.

-- ---------------------------------------------------------------------------
-- Staging: raw ICIJ nodes (entities)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS icij_entities (
  node_id                TEXT PRIMARY KEY,
  name                   TEXT,
  jurisdiction           TEXT,
  jurisdiction_description TEXT,
  company_type           TEXT,
  address                TEXT,
  source_id              TEXT,          -- leak name: 'Panama Papers' / 'Paradise Papers' / …
  valid_until            TEXT,
  country_codes          TEXT,
  status                 TEXT,
  note                   TEXT,
  raw                    TEXT,          -- full source row, JSON
  loaded_at              TEXT NOT NULL DEFAULT ''
);

-- ---------------------------------------------------------------------------
-- Staging: raw ICIJ nodes (officers)
-- ICIJ officers carry name + country_codes + sourceID. They do NOT carry a
-- birth year, so the strict chunk-3 matching rule ("identifier, then name +
-- birth year, then skip") can only ever reach the name-only branch here — which
-- the loader treats as a weak (0.5) match, i.e. a possible link, never a finding.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS icij_officers (
  node_id                TEXT PRIMARY KEY,
  name                   TEXT,
  country_codes          TEXT,
  jurisdiction           TEXT,
  jurisdiction_description TEXT,
  source_id              TEXT,
  valid_until            TEXT,
  status                 TEXT,
  note                   TEXT,
  raw                    TEXT,
  loaded_at              TEXT NOT NULL DEFAULT ''
);

-- ---------------------------------------------------------------------------
-- Staging: raw ICIJ relationships (edges)
-- start_id / end_id reference node_id values in the node tables above.
-- rel_type is the ICIJ relationship type (OFFICER_OF, RELATED_ENTITY,
-- INTERMEDIARY_OF, UNDERLYING, REGISTERED_ADDRESS, NOMINEE_*, …).
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS icij_relationships (
  start_id               TEXT NOT NULL,
  end_id                 TEXT NOT NULL,
  rel_type               TEXT NOT NULL,
  source_id              TEXT,
  valid_until            TEXT,
  status                 TEXT,
  note                   TEXT,
  raw                    TEXT,
  loaded_at              TEXT NOT NULL DEFAULT '',
  UNIQUE (start_id, end_id, rel_type, source_id)
);

-- ---------------------------------------------------------------------------
-- Officer → person matches (the strict resolution, recorded separately)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS icij_officer_matches (
  officer_node_id        TEXT PRIMARY KEY,
  person_id              TEXT NOT NULL REFERENCES people(id) ON DELETE CASCADE,
  basis                  TEXT NOT NULL,   -- 'identifier' | 'name+birth-year' | 'name-only'
  confidence             REAL NOT NULL,
  matched_name           TEXT,
  created_at             TEXT NOT NULL DEFAULT ''
);

-- ---------------------------------------------------------------------------
-- Resolved offshore graph: one hop per row.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS offshore_edges (
  id               TEXT PRIMARY KEY,

  edge_type        TEXT NOT NULL,   -- 'officer_of_entity' | 'entity_relationship'

  from_entity_type TEXT NOT NULL,
  from_entity_id   TEXT NOT NULL,
  from_label       TEXT NOT NULL,

  to_entity_type   TEXT NOT NULL,
  to_entity_id     TEXT NOT NULL,
  to_label         TEXT NOT NULL,

  -- 0..1, multiplies along a path.
  confidence       REAL NOT NULL,

  source_id        TEXT REFERENCES sources(id),
  -- No hop without a resolvable citation. ICIJ node pages are the document.
  source_url       TEXT NOT NULL CHECK (source_url LIKE 'http%'),

  detail           TEXT,
  as_of            TEXT,
  created_at       TEXT NOT NULL DEFAULT '',

  CHECK (edge_type IN ('officer_of_entity', 'entity_relationship')),
  CHECK (from_entity_type IN ('person', 'entity', 'officer')),
  CHECK (to_entity_type IN ('person', 'entity', 'officer')),
  CHECK (confidence >= 0 AND confidence <= 1),
  CHECK (from_entity_id <> '' AND to_entity_id <> '')
);

-- Natural key: loaders are additive. The cuid PK never collides, so without
-- this a re-run silently doubles the table.
CREATE UNIQUE INDEX IF NOT EXISTS ux_offshore_edge ON offshore_edges (
  edge_type, from_entity_type, from_entity_id, to_entity_type, to_entity_id, source_url
);

-- Traversal: walk person → entity → entity.
CREATE INDEX IF NOT EXISTS ix_offshore_from ON offshore_edges (from_entity_type, from_entity_id);
CREATE INDEX IF NOT EXISTS ix_offshore_to   ON offshore_edges (to_entity_type, to_entity_id);

-- Source attribution for every ICIJ-sourced row.
INSERT OR IGNORE INTO sources (id, name, url, license, attribution, created_at)
VALUES (
  'icij-offshore-leaks',
  'ICIJ Offshore Leaks Database',
  'https://www.icij.org/investigations/offshore-leaks/',
  'Open Database License (ODbL) — attribution and share-alike required',
  'Data from the ICIJ Offshore Leaks Database, made available under the Open Database License (ODbL). ' ||
  'Any rights in individual contents of the database are licensed under ODbL by the International ' ||
  'Consortium of Investigative Journalists. The presence of a person or entity here reflects only ' ||
  'what ICIJ published; it does not imply wrongdoing.',
  ''
);
