-- 0015: fx_rates gains its natural-key unique index.
--
-- fx_rates holds one row per currency per day — the rate that converts a
-- historical snapshot at the value that applied then. Without a unique
-- constraint on (base, quote, as_of), `onConflictDoNothing()` is a no-op and
-- a re-run of the FX loader would silently double the table (or, worse, a
-- second source could write a conflicting rate for the same day). The index
-- makes "loaders are additive" enforceable by the database.
--
-- The live table was originally created with a composite PRIMARY KEY on the
-- same triple, so this index is belt-and-braces for any table built before
-- that constraint existed — `IF NOT EXISTS` makes it a no-op where the
-- constraint is already in force.

CREATE UNIQUE INDEX IF NOT EXISTS ux_fx_base_quote_date
  ON fx_rates (base, quote, as_of);
