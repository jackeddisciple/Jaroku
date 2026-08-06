-- 002_baseline — today's schema, in Postgres.
--
-- Everything the four stores declare for themselves on SQLite. On that driver the tables are
-- still created by the store constructors, which is where they have always been created and
-- where a database that predates the migration runner already has them; there, this version
-- is a comment. Here there are no constructors and the schema comes from migrations all the
-- way down, which is what makes a hosted deploy's schema a reviewable artifact rather than a
-- side effect of whichever code path ran first.
--
-- NOT in this file: workspace_id. It arrives in 004 and after, applied to both dialects
-- together, so the tenancy migrations read identically on either driver and there is exactly
-- one place that says which tables are tenant-scoped.
--
-- TYPE CHOICES, and the two that are deliberate:
--
--   * JSON columns are `json`, NOT `jsonb`, and this one was decided by a failing test.
--
--     jsonb is the usual advice and it is the wrong advice here. jsonb does not store the
--     document it was given: it stores a parsed form, which drops whitespace, collapses
--     duplicate keys, and REORDERS object keys into its own canonical order. Round-trip a
--     step payload through it and {"messages": ..., "n": ...} comes back as {"n": ...,
--     "messages": ...}. Nothing breaks, because consumers read by key — but the trace
--     store's promise is that a step replayed from history is identical to the one that
--     streamed live, and after jsonb it is not: open the same step from the timeline and
--     from history and the JSON viewer shows the keys in two different orders. That is the
--     store altering the user's data, which is the one thing a trace may not do.
--
--     What jsonb buys is containment operators and GIN indexes on the payload. Not one query
--     in this codebase looks inside a JSON column — every one is selected whole and parsed
--     in TypeScript — so that price is being paid for nothing. `json` keeps the text exactly
--     as written, and node-postgres parses it with JSON.parse, which preserves key order.
--
--     The hydration is still told which driver it is reading from rather than guessing from
--     the value, because that trap is separate and remains: a payload that IS the JSON string
--     "123" arrives from Postgres as the JS string `123`, and a parser that re-parsed every
--     string it saw would hand the consumer the number.
--
--   * Money is double precision, not numeric. Costs are computed as floats from token counts
--     and rates, rounded by the shared pricing code, and compared against a bill in that
--     form. numeric arrives back from node-postgres as a string, so storing it that way
--     would mean parsing it again and inventing a way for the two drivers to disagree about
--     a number the product is careful about. REAL and double precision are the same type.
--     A real ledger, if Session 6 wants one, should introduce numeric deliberately with a
--     reader that knows it is a string.

-- --- the frozen trace schema (schema/events.md v1) ---------------------------------------

CREATE TABLE IF NOT EXISTS runs (
  id              text PRIMARY KEY,
  agent_id        text NOT NULL,
  provider        text NOT NULL,
  model           text NOT NULL,
  status          text NOT NULL,
  started_at      text NOT NULL,
  ended_at        text,
  cost            double precision NOT NULL DEFAULT 0,
  tokens          bigint NOT NULL DEFAULT 0,
  error           text,
  -- Control-plane columns beside the frozen schema, never emitted in an event.
  parent_run_id   text,
  branch_from_seq integer
);

CREATE TABLE IF NOT EXISTS steps (
  id             text PRIMARY KEY,
  run_id         text NOT NULL REFERENCES runs(id),
  seq            integer NOT NULL,
  type           text NOT NULL,
  name           text NOT NULL,
  input          json,
  output         json,
  state_before   json,
  state_after    json,
  tokens         bigint,
  cost           double precision,
  latency_ms     double precision NOT NULL DEFAULT 0,
  error          text,
  parent_step_id text,
  started_at     text NOT NULL,
  checkpoint_id  text
);

CREATE INDEX IF NOT EXISTS idx_steps_run_seq ON steps (run_id, seq);

-- --- the eval control plane ---------------------------------------------------------------

CREATE TABLE IF NOT EXISTS datasets (
  id         text PRIMARY KEY,
  agent_id   text NOT NULL,
  name       text NOT NULL,
  created_at text NOT NULL,
  updated_at text NOT NULL
);

CREATE TABLE IF NOT EXISTS dataset_examples (
  id         text PRIMARY KEY,
  dataset_id text NOT NULL REFERENCES datasets(id),
  input      text NOT NULL,
  expected   text,
  notes      text,
  position   integer NOT NULL DEFAULT 0,
  created_at text NOT NULL
);

CREATE TABLE IF NOT EXISTS rubrics (
  id         text PRIMARY KEY,
  dataset_id text,
  name       text NOT NULL,
  criteria   json NOT NULL,
  created_at text NOT NULL,
  updated_at text NOT NULL
);

CREATE TABLE IF NOT EXISTS eval_runs (
  id             text PRIMARY KEY,
  dataset_id     text NOT NULL,
  agent_id       text NOT NULL,
  rubric_id      text NOT NULL,
  status         text NOT NULL,
  targets        json NOT NULL,
  budget_usd     double precision,
  judge_cost_usd double precision NOT NULL DEFAULT 0,
  started_at     text NOT NULL,
  ended_at       text,
  error          text
);

CREATE TABLE IF NOT EXISTS eval_jobs (
  id               text PRIMARY KEY,
  eval_id          text NOT NULL REFERENCES eval_runs(id),
  example_id       text NOT NULL,
  provider         text NOT NULL,
  model            text NOT NULL,
  status           text NOT NULL,
  attempt          integer NOT NULL DEFAULT 0,
  run_id           text,
  cost_usd         double precision,
  tokens           bigint,
  latency_ms       double precision,
  cost_complete    integer NOT NULL DEFAULT 1,
  error            text,
  started_at       text,
  ended_at         text,
  retry_not_before text,
  -- Cumulative spend across every attempt. cost_usd is the final attempt's, which is the
  -- comparison figure and the wrong number for a bill.
  spent_usd        double precision NOT NULL DEFAULT 0,
  -- Insertion order. On SQLite this was `rowid`, which Postgres has no stable equivalent for.
  position         integer NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS eval_scores (
  id             text PRIMARY KEY,
  job_id         text NOT NULL UNIQUE REFERENCES eval_jobs(id),
  score          double precision,
  per_criterion  json,
  rationale      text,
  judge_model    text,
  judge_cost_usd double precision,
  error          text,
  created_at     text NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_examples_dataset ON dataset_examples (dataset_id, position);
CREATE INDEX IF NOT EXISTS idx_datasets_agent   ON datasets (agent_id);
CREATE INDEX IF NOT EXISTS idx_jobs_eval        ON eval_jobs (eval_id, status);
CREATE INDEX IF NOT EXISTS idx_jobs_run         ON eval_jobs (run_id);
CREATE INDEX IF NOT EXISTS idx_rubrics_dataset  ON rubrics (dataset_id);

-- --- the MCP registry ----------------------------------------------------------------------
-- Stores the NAME of the env var a server's credential lives under. Never a value; there is
-- no column one would fit in.

CREATE TABLE IF NOT EXISTS mcp_servers (
  id               text PRIMARY KEY,
  label            text NOT NULL,
  endpoint         text NOT NULL,
  transport        text NOT NULL,
  auth_env_key     text,
  server_name      text,
  server_version   text,
  protocol_version text,
  status           text NOT NULL,
  last_error       text,
  discovered_at    text,
  created_at       text NOT NULL
);

CREATE TABLE IF NOT EXISTS mcp_tools (
  id                   text PRIMARY KEY,
  server_id            text NOT NULL REFERENCES mcp_servers(id),
  name                 text NOT NULL,
  description          text,
  input_schema         json NOT NULL,
  schema_hash          text NOT NULL,
  impact               text NOT NULL,
  impact_reason        text NOT NULL,
  impact_override      text,
  override_schema_hash text,
  annotations          json,
  discovered_at        text NOT NULL,
  UNIQUE (server_id, name)
);

CREATE INDEX IF NOT EXISTS idx_mcp_tools_server ON mcp_tools (server_id, name);

-- --- deploy records --------------------------------------------------------------------------
-- env_keys is a json array of variable NAMES. Same rule as above: there is no column a
-- credential would fit in.

CREATE TABLE IF NOT EXISTS deployments (
  id                     text PRIMARY KEY,
  agent_id               text NOT NULL,
  target                 text NOT NULL,
  status                 text NOT NULL,
  url                    text,
  provider               text NOT NULL,
  model                  text NOT NULL,
  env_keys               json NOT NULL DEFAULT '[]'::json,
  railway_project_id     text,
  railway_service_id     text,
  railway_environment_id text,
  railway_deployment_id  text,
  error                  text,
  created_at             text NOT NULL,
  updated_at             text NOT NULL,
  ended_at               text,
  -- Insertion order, breaking the created_at tie. Two deploys in the same millisecond made
  -- "the current deployment" a coin flip, and that is the row the sidebar shows.
  created_seq            integer NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS deployment_logs (
  deployment_id text NOT NULL REFERENCES deployments(id),
  seq           integer NOT NULL,
  ts            text NOT NULL,
  stage         text NOT NULL,
  stream        text NOT NULL,
  text          text NOT NULL,
  PRIMARY KEY (deployment_id, seq)
);

CREATE INDEX IF NOT EXISTS idx_deployments_agent  ON deployments (agent_id, created_at);
CREATE INDEX IF NOT EXISTS idx_deployments_status ON deployments (status);
