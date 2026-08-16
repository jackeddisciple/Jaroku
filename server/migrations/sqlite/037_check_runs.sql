-- 037_check_runs — the SQLite half. Read the Postgres file for why three identifier spaces meet
-- in one table, why this is not two nullable columns on `eval_runs`, why `eval_run_id` is nullable
-- during the window a check is visible but not yet dispatched, and why the deltas are nullable
-- rather than defaulting to zero.
--
-- Same translation as everywhere else: uuid -> TEXT, timestamptz -> TEXT ISO-8601, json -> TEXT,
-- double precision -> REAL. Ids that Postgres defaults with `gen_random_uuid()` are supplied here.
--
-- The CHECKs that are separate statements on Postgres are inline on the column, as 033 and 034
-- already do, because SQLite has no `ALTER TABLE ... ADD CONSTRAINT`. The composite FK to
-- `agents (workspace_id, id)` points at the unique index 018 created for it.
--
-- NO RLS, on this driver, ever — see 009.

CREATE TABLE check_runs (
  id                  TEXT PRIMARY KEY,
  workspace_id        TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  agent_id            TEXT NOT NULL,
  link_id             TEXT REFERENCES github_links(id) ON DELETE SET NULL,
  pr_number           INTEGER NOT NULL,
  head_sha            TEXT NOT NULL,
  github_check_run_id TEXT,
  eval_run_id         TEXT REFERENCES eval_runs(id) ON DELETE SET NULL,
  status              TEXT NOT NULL DEFAULT 'queued'
    CHECK (status IN ('queued', 'in_progress', 'completed')),
  conclusion          TEXT
    CHECK (conclusion IS NULL OR conclusion IN ('success', 'failure', 'neutral', 'cancelled', 'timed_out')),
  provider_mode       TEXT NOT NULL DEFAULT 'dry_run'
    CHECK (provider_mode IN ('dry_run', 'paid')),
  pass_rate           REAL,
  cost_per_run_usd    REAL,
  latency_p50_ms      INTEGER,
  pass_rate_delta     REAL,
  cost_delta          REAL,
  latency_delta       INTEGER,
  baseline_check_id   TEXT REFERENCES check_runs(id) ON DELETE SET NULL,
  created_at          TEXT NOT NULL,
  completed_at        TEXT,
  FOREIGN KEY (workspace_id, agent_id) REFERENCES agents (workspace_id, id) ON DELETE CASCADE
);

CREATE INDEX check_runs_pr ON check_runs (workspace_id, agent_id, pr_number, created_at DESC);

CREATE INDEX check_runs_head ON check_runs (workspace_id, agent_id, head_sha, created_at DESC);
