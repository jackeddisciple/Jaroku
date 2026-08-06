-- 002_baseline — today's schema, in SQLite.
--
-- The same tables the Postgres migration of this number creates, in this dialect's types.
-- Read that file for what any of them are for; this one exists so the migrations own the
-- schema on BOTH drivers rather than one.
--
-- WHY THIS IS NOT A COMMENT-ONLY FILE ANY MORE. It was, on the argument that the store
-- constructors have always created these tables on this driver and an existing jaroku.db
-- already has them. That argument held right up until migration 004 needed to ALTER `runs`:
-- constructors run when a store is built, migrations run at boot, and the two orderings that
-- satisfy both — declare-then-migrate on a fresh database, migrate-then-declare in a test —
-- cannot both be right. One source of truth per dialect removes the question.
--
-- Every statement is CREATE TABLE IF NOT EXISTS, so a database that already has these tables
-- is untouched. The store `init()` methods keep their additive ALTERs, which are now purely
-- for databases that predate a given column and have no row saying so.
--
-- The columns here are the CURRENT shape, additive migrations included: steps.checkpoint_id,
-- runs.parent_run_id and runs.branch_from_seq from branching; eval_jobs.retry_not_before and
-- spent_usd from retries; eval_jobs.position and deployments.created_seq, which replaced
-- SQLite's rowid when it turned out Postgres has no equivalent.

-- --- the frozen trace schema (schema/events.md v1) ---------------------------------------

CREATE TABLE IF NOT EXISTS runs (
  id              TEXT PRIMARY KEY,
  agent_id        TEXT NOT NULL,
  provider        TEXT NOT NULL,
  model           TEXT NOT NULL,
  status          TEXT NOT NULL,
  started_at      TEXT NOT NULL,
  ended_at        TEXT,
  cost            REAL NOT NULL DEFAULT 0,
  tokens          INTEGER NOT NULL DEFAULT 0,
  error           TEXT,
  parent_run_id   TEXT,
  branch_from_seq INTEGER
);

CREATE TABLE IF NOT EXISTS steps (
  id             TEXT PRIMARY KEY,
  run_id         TEXT NOT NULL,
  seq            INTEGER NOT NULL,
  type           TEXT NOT NULL,
  name           TEXT NOT NULL,
  input          TEXT,
  output         TEXT,
  state_before   TEXT,
  state_after    TEXT,
  tokens         INTEGER,
  cost           REAL,
  latency_ms     REAL NOT NULL DEFAULT 0,
  error          TEXT,
  parent_step_id TEXT,
  started_at     TEXT NOT NULL,
  checkpoint_id  TEXT,
  FOREIGN KEY (run_id) REFERENCES runs(id)
);

CREATE INDEX IF NOT EXISTS idx_steps_run_seq ON steps(run_id, seq);

-- --- the eval control plane ---------------------------------------------------------------

CREATE TABLE IF NOT EXISTS datasets (
  id         TEXT PRIMARY KEY,
  agent_id   TEXT NOT NULL,
  name       TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS dataset_examples (
  id         TEXT PRIMARY KEY,
  dataset_id TEXT NOT NULL,
  input      TEXT NOT NULL,
  expected   TEXT,
  notes      TEXT,
  position   INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  FOREIGN KEY (dataset_id) REFERENCES datasets(id)
);

CREATE TABLE IF NOT EXISTS rubrics (
  id         TEXT PRIMARY KEY,
  dataset_id TEXT,
  name       TEXT NOT NULL,
  criteria   TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS eval_runs (
  id             TEXT PRIMARY KEY,
  dataset_id     TEXT NOT NULL,
  agent_id       TEXT NOT NULL,
  rubric_id      TEXT NOT NULL,
  status         TEXT NOT NULL,
  targets        TEXT NOT NULL,
  budget_usd     REAL,
  judge_cost_usd REAL NOT NULL DEFAULT 0,
  started_at     TEXT NOT NULL,
  ended_at       TEXT,
  error          TEXT
);

CREATE TABLE IF NOT EXISTS eval_jobs (
  id               TEXT PRIMARY KEY,
  eval_id          TEXT NOT NULL,
  example_id       TEXT NOT NULL,
  provider         TEXT NOT NULL,
  model            TEXT NOT NULL,
  status           TEXT NOT NULL,
  attempt          INTEGER NOT NULL DEFAULT 0,
  run_id           TEXT,
  cost_usd         REAL,
  tokens           INTEGER,
  latency_ms       REAL,
  cost_complete    INTEGER NOT NULL DEFAULT 1,
  error            TEXT,
  started_at       TEXT,
  ended_at         TEXT,
  retry_not_before TEXT,
  spent_usd        REAL NOT NULL DEFAULT 0,
  position         INTEGER NOT NULL DEFAULT 0,
  FOREIGN KEY (eval_id) REFERENCES eval_runs(id),
  FOREIGN KEY (example_id) REFERENCES dataset_examples(id)
);

CREATE TABLE IF NOT EXISTS eval_scores (
  id             TEXT PRIMARY KEY,
  job_id         TEXT NOT NULL UNIQUE,
  score          REAL,
  per_criterion  TEXT,
  rationale      TEXT,
  judge_model    TEXT,
  judge_cost_usd REAL,
  error          TEXT,
  created_at     TEXT NOT NULL,
  FOREIGN KEY (job_id) REFERENCES eval_jobs(id)
);

CREATE INDEX IF NOT EXISTS idx_examples_dataset ON dataset_examples(dataset_id, position);
CREATE INDEX IF NOT EXISTS idx_datasets_agent   ON datasets(agent_id);
CREATE INDEX IF NOT EXISTS idx_jobs_eval        ON eval_jobs(eval_id, status);
CREATE INDEX IF NOT EXISTS idx_jobs_run         ON eval_jobs(run_id);
CREATE INDEX IF NOT EXISTS idx_rubrics_dataset  ON rubrics(dataset_id);

-- --- the MCP registry ----------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS mcp_servers (
  id               TEXT PRIMARY KEY,
  label            TEXT NOT NULL,
  endpoint         TEXT NOT NULL,
  transport        TEXT NOT NULL,
  auth_env_key     TEXT,
  server_name      TEXT,
  server_version   TEXT,
  protocol_version TEXT,
  status           TEXT NOT NULL,
  last_error       TEXT,
  discovered_at    TEXT,
  created_at       TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS mcp_tools (
  id                   TEXT PRIMARY KEY,
  server_id            TEXT NOT NULL,
  name                 TEXT NOT NULL,
  description          TEXT,
  input_schema         TEXT NOT NULL,
  schema_hash          TEXT NOT NULL,
  impact               TEXT NOT NULL,
  impact_reason        TEXT NOT NULL,
  impact_override      TEXT,
  override_schema_hash TEXT,
  annotations          TEXT,
  discovered_at        TEXT NOT NULL,
  UNIQUE (server_id, name),
  FOREIGN KEY (server_id) REFERENCES mcp_servers(id)
);

CREATE INDEX IF NOT EXISTS idx_mcp_tools_server ON mcp_tools(server_id, name);

-- --- deploy records --------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS deployments (
  id                     TEXT PRIMARY KEY,
  agent_id               TEXT NOT NULL,
  target                 TEXT NOT NULL,
  status                 TEXT NOT NULL,
  url                    TEXT,
  provider               TEXT NOT NULL,
  model                  TEXT NOT NULL,
  env_keys               TEXT NOT NULL DEFAULT '[]',
  railway_project_id     TEXT,
  railway_service_id     TEXT,
  railway_environment_id TEXT,
  railway_deployment_id  TEXT,
  error                  TEXT,
  created_at             TEXT NOT NULL,
  updated_at             TEXT NOT NULL,
  ended_at               TEXT,
  created_seq            INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS deployment_logs (
  deployment_id TEXT NOT NULL,
  seq           INTEGER NOT NULL,
  ts            TEXT NOT NULL,
  stage         TEXT NOT NULL,
  stream        TEXT NOT NULL,
  text          TEXT NOT NULL,
  PRIMARY KEY (deployment_id, seq),
  FOREIGN KEY (deployment_id) REFERENCES deployments(id)
);

CREATE INDEX IF NOT EXISTS idx_deployments_agent  ON deployments(agent_id, created_at);
CREATE INDEX IF NOT EXISTS idx_deployments_status ON deployments(status);
