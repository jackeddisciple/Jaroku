-- 004_trace_tenancy — workspace_id on runs and steps.
--
-- Read the Postgres version for what this is and why the frozen event schema is untouched by
-- it. This file differs in exactly one way, and it is worth stating rather than hiding.
--
-- SQLITE CANNOT DROP A DEFAULT. Postgres adds the column, backfills it, sets NOT NULL and
-- then drops the default, so a write that forgets its scope FAILS. SQLite has no ALTER
-- COLUMN: a NOT NULL column can only be added with a constant default, and that default is
-- permanent. Adding one that names the local workspace would mean an unscoped write silently
-- succeeding and landing in somebody's workspace — the exact failure the constraint exists
-- to prevent, made invisible.
--
-- So the default is the empty string, which is not a uuid and can never equal a workspace id.
-- A row that gets it is NOT NULL-satisfying and unreachable from every context, rather than
-- quietly belonging to one. The tenancy suite asserts no row carries it, which turns the
-- sentinel into a test failure instead of a leak.
--
-- The alternative is rebuilding both tables — create, copy, drop, rename — which SQLite's own
-- documentation prescribes and which would give an exact match. It is not worth it here:
-- this driver has no RLS either, so the real enforcement on this side is the repository layer
-- and the isolation suite, and both are unaffected by which of the two shapes the column has.

INSERT OR IGNORE INTO workspaces (id, slug, name, kind, plan, created_at)
VALUES (
  '00000000-0000-4000-8000-000000000001',
  'local',
  'Local',
  'personal',
  'free',
  strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
);

ALTER TABLE runs  ADD COLUMN workspace_id TEXT NOT NULL DEFAULT '';
ALTER TABLE steps ADD COLUMN workspace_id TEXT NOT NULL DEFAULT '';

UPDATE runs  SET workspace_id = '00000000-0000-4000-8000-000000000001' WHERE workspace_id = '';
UPDATE steps SET workspace_id = '00000000-0000-4000-8000-000000000001' WHERE workspace_id = '';

CREATE INDEX runs_ws_started  ON runs  (workspace_id, started_at DESC);
CREATE INDEX steps_ws_run_seq ON steps (workspace_id, run_id, seq);

DROP INDEX IF EXISTS idx_steps_run_seq;
