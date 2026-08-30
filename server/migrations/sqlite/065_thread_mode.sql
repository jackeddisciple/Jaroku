-- 065_thread_mode — the SQLite half. Read the Postgres file for why a mode is a column on this
-- table rather than a second table, why every existing row is a build thread without a backfill,
-- and why there is no index on it.
--
-- Same translation as every migration on this driver: the CHECK that is a separate statement on
-- Postgres is inline on the column, as 033, 034, 037, 043 and 063 already do, because SQLite has no
-- `ALTER TABLE ... ADD CONSTRAINT`.
--
-- THIS IS THE ONE IN-PLACE OPERATION THIS DRIVER PERFORMS, and it is available here for a reason
-- worth stating beside 066, which cannot use it: `ADD COLUMN` may carry a CHECK on the NEW column,
-- because the constraint is part of the column definition being added and no existing row has to be
-- re-examined — the default satisfies it by construction. What `ADD COLUMN` cannot do is widen a
-- CHECK that is already on the table, which is what 066 needs and why 066 rebuilds.
--
-- NO RLS, on this driver, ever — see 009.

ALTER TABLE threads ADD COLUMN mode TEXT NOT NULL DEFAULT 'build'
  CHECK (mode IN ('build', 'operate'));
