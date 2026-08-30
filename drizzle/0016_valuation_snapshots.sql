-- 0016: valuation_snapshots — the persisted "honest number".
--
-- The table the whole "show your working" thesis depends on: one row per
-- person per run, storing the liquid/baseline/pledged figures together with
-- the full `inputs` JSON so anyone with a calculator can reproduce
-- liquid_cents exactly from the numbers that produced it.
--
-- Naming note: the chunk brief called this "0013_valuation_snapshots", but
-- 0013 is taken by 0013_baseline_source_url.sql, so this migration uses the
-- next free number to keep drizzle/ strictly ordered.
--
-- ux_snap_person_ts_method is the anti-duplicate guarantee: (person_id, ts,
-- method_version) must be unique, and ts is truncated to the minute, so
-- running `npm run snapshot` twice within the same minute inserts nothing.

CREATE TABLE valuation_snapshots (
  id                TEXT PRIMARY KEY,
  person_id         TEXT NOT NULL REFERENCES people(id) ON DELETE CASCADE,
  ts                TEXT NOT NULL,
  liquid_cents      INTEGER NOT NULL,
  baseline_cents    INTEGER NOT NULL,
  pledged_cents     INTEGER NOT NULL DEFAULT 0,
  verifiability     REAL,
  method_version    TEXT NOT NULL,
  inputs            TEXT NOT NULL CHECK (json_valid(inputs)),
  created_at        TEXT NOT NULL
);
CREATE INDEX ix_snap_person_ts ON valuation_snapshots (person_id, ts DESC);
CREATE UNIQUE INDEX ux_snap_person_ts_method ON valuation_snapshots (person_id, ts, method_version);
