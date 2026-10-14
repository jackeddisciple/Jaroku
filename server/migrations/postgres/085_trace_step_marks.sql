-- 085_trace_step_marks — a person's marks on a trace's steps: viewed, and pinned.
--
-- WHAT IT IS FOR. Reviewing a run is reading its steps one at a time, and a long one is read across
-- sittings: "Viewed" ticks off the steps somebody has been through, as a code review ticks off files,
-- and a pin keeps the two or three steps that matter a press away (the trace panel's feature list,
-- 2026-10-14). Both are one person's, the product owner's call that day: two people reviewing the
-- same run have each read different steps, and a teammate's ticks would mark yours as read.
--
-- SO THE PERSON IS IN THE PRIMARY KEY, as `turn_pins` keeps it (migration 058): a mark visible to
-- somebody else is a constraint violation rather than a WHERE somebody forgot. RLS scopes the rows
-- to the workspace; the user is the repository's and the key's to keep, for the reason 058 gives.
--
-- ONE ROW FOR BOTH MARKS, each a timestamp: when it was viewed, when it was pinned, null for not.
-- A row with neither is deleted rather than kept, so "unmarked" is one state, not two.
--
-- THE RUN CASCADES. A run swept by retention, or deleted with its workspace, takes its marks with it
-- — `runs.id` is the one-column key the trace has always had, and `steps` (partitioned, migration
-- 029) can be the target of no foreign key, so a step is named by its id without one. The store
-- checks the run is this workspace's before it writes.

CREATE TABLE trace_step_marks (
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  run_id       text NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  step_id      text NOT NULL,
  user_id      uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  viewed_at    timestamptz,
  pinned_at    timestamptz,

  PRIMARY KEY (workspace_id, run_id, step_id, user_id)
);

-- The trace's read: one person's marks on one run.
CREATE INDEX trace_step_marks_run ON trace_step_marks (workspace_id, run_id, user_id);

ALTER TABLE trace_step_marks ENABLE ROW LEVEL SECURITY;
ALTER TABLE trace_step_marks FORCE  ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON trace_step_marks;
CREATE POLICY tenant_isolation ON trace_step_marks
  USING      (workspace_id = NULLIF(current_setting('app.workspace_id', true), '')::uuid)
  WITH CHECK (workspace_id = NULLIF(current_setting('app.workspace_id', true), '')::uuid);
