-- 022_usage_quantity — the SQLite half. Read the Postgres file for why tokens are not
-- expressed this way and why the unit is stored rather than derived from the kind.
--
-- Same translation as every migration before it: numeric -> REAL.
ALTER TABLE usage_events ADD COLUMN quantity REAL;
ALTER TABLE usage_events ADD COLUMN unit TEXT;
