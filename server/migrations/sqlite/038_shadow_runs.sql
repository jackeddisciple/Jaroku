-- 038_shadow_runs — the SQLite half. Read the Postgres file for why a run defined as disposable
-- still gets a row, why the row is beside the frozen trace schema rather than a column inside it,
-- why the sweep marks rather than deletes, and why nothing here points at `agent_versions`.
--
-- Same translation as everywhere else: uuid -> TEXT, timestamptz -> TEXT ISO-8601. `run_id` is
-- text on both drivers because the frozen schema's `runs.id` is. Ids that Postgres defaults with
-- `gen_random_uuid()` are supplied by the application here.
--
-- The status CHECK is inline on the column rather than a separate statement, because SQLite has no
-- `ALTER TABLE ... ADD CONSTRAINT`. The composite FK to `agents (workspace_id, id)` points at the
-- unique index 018 created for it.
--
-- NO RLS, on this driver, ever — see 009.

CREATE TABLE shadow_runs (
  id            TEXT PRIMARY KEY,
  workspace_id  TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  agent_id      TEXT NOT NULL,
  link_id       TEXT REFERENCES github_links(id) ON DELETE SET NULL,
  ref           TEXT NOT NULL,
  head_sha      TEXT NOT NULL,
  run_id        TEXT,
  staging_key   TEXT,
  status        TEXT NOT NULL DEFAULT 'staging'
    CHECK (status IN ('staging', 'running', 'completed', 'error', 'cancelled')),
  error         TEXT,
  created_by    TEXT REFERENCES users(id) ON DELETE SET NULL,
  created_at    TEXT NOT NULL,
  ended_at      TEXT,
  swept_at      TEXT,
  FOREIGN KEY (workspace_id, agent_id) REFERENCES agents (workspace_id, id) ON DELETE CASCADE
);

CREATE INDEX shadow_runs_agent ON shadow_runs (workspace_id, agent_id, created_at DESC);

CREATE INDEX shadow_runs_sweep ON shadow_runs (workspace_id, swept_at, ended_at);
