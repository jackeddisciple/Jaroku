-- 004_trace_tenancy — workspace_id on runs and steps.
--
-- THE ONE DOCUMENTED EXCEPTION TO "DO NOT TOUCH THE FROZEN SCHEMA".
--
-- schema/events.md v1 is frozen and this migration does not change it. `workspace_id` is a
-- STORAGE column: it says which tenant a row belongs to, which is a property of the database
-- and not of the event. It must never appear in an emitted `run_start`, `step` or `run_end`,
-- and the repository's SELECTs name their columns explicitly so it cannot — a `SELECT *`
-- would put it straight into the payload the client receives, which is how this exception
-- would quietly stop being one.
--
-- THE DEFAULT WORKSPACE. Existing rows have to go somewhere, and there is exactly one honest
-- answer for a single-user install being upgraded in place: they are all that person's. So a
-- workspace with a fixed, recognisable id is created here, existing rows are backfilled into
-- it, and only then does the column become NOT NULL. Doing it in this order is what lets an
-- existing jaroku.db keep every trace it has rather than starting empty.
--
-- It has no members, and that is correct rather than an oversight: nobody has signed in yet.
-- Session 2's first-sight provisioning is what gives a workspace an owner, and until then
-- this is the workspace the dev context points at.
--
-- INDEX ORDER. workspace_id leads every hot index, never trails. A trailing tenant column
-- means the planner scans an index built for a different question and filters afterwards,
-- which at one workspace is invisible and at six thousand is the whole cost of the query.
-- Getting this right now is free; changing it later means rebuilding the biggest table.

INSERT INTO workspaces (id, slug, name, kind, plan, created_at)
VALUES (
  '00000000-0000-4000-8000-000000000001',
  'local',
  'Local',
  'personal',
  'free',
  now()
)
ON CONFLICT (id) DO NOTHING;

ALTER TABLE runs  ADD COLUMN workspace_id uuid REFERENCES workspaces(id);
ALTER TABLE steps ADD COLUMN workspace_id uuid REFERENCES workspaces(id);

UPDATE runs  SET workspace_id = '00000000-0000-4000-8000-000000000001' WHERE workspace_id IS NULL;
UPDATE steps SET workspace_id = '00000000-0000-4000-8000-000000000001' WHERE workspace_id IS NULL;

ALTER TABLE runs  ALTER COLUMN workspace_id SET NOT NULL;
ALTER TABLE steps ALTER COLUMN workspace_id SET NOT NULL;

-- No DEFAULT is left behind on purpose. A default would make a write that forgot its scope
-- succeed quietly and land in somebody's workspace; without one it fails, loudly, at the
-- insert. That is the entire value of the constraint.

CREATE INDEX runs_ws_started  ON runs  (workspace_id, started_at DESC);
CREATE INDEX steps_ws_run_seq ON steps (workspace_id, run_id, seq);

-- The old un-scoped index is now a prefix of a worse plan than the one above, and the
-- planner will not choose it for any query the repository issues.
DROP INDEX IF EXISTS idx_steps_run_seq;
