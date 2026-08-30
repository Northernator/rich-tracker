-- 0013: baseline_estimates gains a real citation and a real natural key.
--
-- Two structural holes in the table that holds every net-worth claim:
--
-- 1. There was nowhere to record WHICH document supports an individual claim.
--    `sources` says who published the list; it does not say where the number
--    can be checked. Wikidata P2218 statements carry their own reference
--    (P854), and a statement without one is an unsourced claim — those rows
--    must never be inserted at all. The column is nullable only because rows
--    loaded before it existed have to be backfilled from their raw capture
--    (scripts/backfill_baseline_source_url.ts) rather than invented.
--
-- 2. There was no unique index, so `onConflictDoNothing()` could never fire:
--    the primary key is a cuid that cannot collide. Re-running a loader
--    silently duplicated the table. The natural key is
--    (person_id, source_id, as_of) — one figure per person per source per
--    instant — which is what makes "loaders are additive" enforceable by the
--    database instead of by discipline.

ALTER TABLE baseline_estimates ADD COLUMN source_url TEXT;

CREATE UNIQUE INDEX ux_baseline_person_source_asof
  ON baseline_estimates (person_id, source_id, as_of);

CREATE INDEX idx_baseline_source ON baseline_estimates (source_id);
