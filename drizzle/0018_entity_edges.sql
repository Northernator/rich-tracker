-- 0018: multi-hop beneficial-ownership chains (UK Land Registry + Companies House).
--
-- Chunk 10 builds a chain, not a single claim:
--
--   property (Land Registry title)
--      └─ owned by → company (Companies House number)
--           └─ PSC → person
--
-- The previous schema could not express this. `ownership_links` is a single
-- asset↔person edge with a three-valued `confidence` ('high'|'medium'|'low'),
-- so a two-hop chain had to be collapsed into one row — which forces the worst
-- hop's uncertainty onto the whole path and hides which hop is weak.
--
-- `entity_edges` stores ONE HOP PER ROW, each with:
--   - its own source_url (CHECKed, like assets/ownership_links)
--   - a NUMERIC confidence in [0,1], because the point of storing hops
--     separately is that confidence MULTIPLIES along a path. A 0.95 title
--     entry chained through a 0.6 PSC match is 0.57 — a different claim from
--     either hop alone, and one 'medium' cannot represent.
--
-- Node identity is deliberately the REGISTRY's identifier, not our cuid:
--   person   → people.id
--   company  → 'ch:' || Companies House number
--   property → 'title:' || HM Land Registry title number
-- Using cuids here would make every edge unresolvable after any rebuild of
-- assets, and the title number is the only identifier that can be checked
-- against the Land Register itself.
--
-- An edge below 0.5 total path confidence renders as "possible link". That
-- threshold is enforced in the query layer (src/lib/db/chains.ts), not here —
-- the database stores the number, the UI decides what it means.

-- The registry's own identifier for an asset: Land Registry title number for UK
-- property, N-number for aircraft (chunk 9), IMO number for vessels. Nullable —
-- assets loaded before this column existed have no ref, and that is not an error.
ALTER TABLE assets ADD COLUMN external_ref TEXT;

-- A real natural key. assets previously deduped on (name, asset_type, location),
-- which is a display string, not an identity: two different titles can share an
-- address, and one title's address is rendered inconsistently across monthly
-- OCOD releases. SQLite treats NULLs as distinct, so legacy rows are unaffected.
CREATE UNIQUE INDEX ux_assets_external_ref ON assets (source_id, external_ref)
  WHERE external_ref IS NOT NULL;

CREATE TABLE entity_edges (
  id               TEXT PRIMARY KEY,

  edge_type        TEXT NOT NULL,

  from_entity_type TEXT NOT NULL,
  from_entity_id   TEXT NOT NULL,
  from_label       TEXT NOT NULL,

  to_entity_type   TEXT NOT NULL,
  to_entity_id     TEXT NOT NULL,
  to_label         TEXT NOT NULL,

  -- 0..1. Multiplies along a path. Not free-form: the CHECK is what makes
  -- "confidence" a number you can multiply rather than an adjective.
  confidence       REAL NOT NULL,

  source_id        TEXT REFERENCES sources(id),
  -- Structural guarantee, same as assets: a hop cannot exist without a
  -- resolvable citation. Every link on /ownership is clickable because the
  -- database refuses to store one that is not.
  source_url       TEXT NOT NULL CHECK (source_url LIKE 'http%'),

  -- JSON: the registry-specific facts behind this hop (nature of control,
  -- notified date, tenure, date proprietor added). Kept out of `citation`
  -- because it is machine-readable, and out of columns because it varies by
  -- edge_type.
  detail           TEXT,
  as_of            TEXT,
  created_at       TEXT NOT NULL DEFAULT '',

  CHECK (edge_type IN ('company_owns_property', 'person_controls_company')),
  CHECK (from_entity_type IN ('person', 'company', 'property')),
  CHECK (to_entity_type IN ('person', 'company', 'property')),
  CHECK (confidence >= 0 AND confidence <= 1),
  CHECK (from_entity_id <> '' AND to_entity_id <> '')
);

-- The natural key. Loaders are additive (INSERT OR IGNORE / onConflictDoNothing)
-- and the PK is a cuid that can never collide, so without this a second run
-- silently doubles the table. Same failure mode that produced 35 duplicate
-- ownership pairs before 0012.
CREATE UNIQUE INDEX ux_entity_edge ON entity_edges (
  edge_type, from_entity_type, from_entity_id, to_entity_type, to_entity_id, source_url
);

-- Chain traversal reads edges by the node they start from, then by the node
-- they point at, to walk company → property and person → company.
CREATE INDEX ix_edge_from ON entity_edges (from_entity_type, from_entity_id);
CREATE INDEX ix_edge_to ON entity_edges (to_entity_type, to_entity_id);
