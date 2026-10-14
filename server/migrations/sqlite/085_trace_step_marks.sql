-- 085_trace_step_marks — a person's marks on a trace's steps: viewed, and pinned.
--
-- The Postgres migration of the same number says why; this is the same table in SQLite's types,
-- without the policy SQLite has no way to hold (migration 009) — the store's WHERE is the boundary.

CREATE TABLE trace_step_marks (
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  run_id       TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  step_id      TEXT NOT NULL,
  user_id      TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  viewed_at    TEXT,
  pinned_at    TEXT,

  PRIMARY KEY (workspace_id, run_id, step_id, user_id)
);

CREATE INDEX trace_step_marks_run ON trace_step_marks (workspace_id, run_id, user_id);
