-- 063_work_items — the SQLite half. Read the Postgres file for every decision: why `created_by` is
-- NOT NULL and why a scheduled item must not be allowed to loosen it, why `run_id` is nullable only
-- between insert and dispatch and is deliberately not a foreign key, why there is no cost, token or
-- duration column, why `deployment_id` is a hard FK to the deployment that actually ran, why the
-- input cap lives in the store rather than in a CHECK, and why `stopped_reporting` is not `failed`.
--
-- Same translation as every migration on this driver: uuid -> TEXT, timestamptz -> TEXT holding
-- ISO-8601 UTC. Ids that Postgres defaults with `gen_random_uuid()` are supplied by the store here,
-- and so are the timestamps, because SQLite has no `now()` that writes the same string shape the
-- rest of this schema stores.
--
-- `deployment_id` IS TEXT ON BOTH DRIVERS and that is not this driver flattening a type: it
-- references `deployments(id)`, which is `text` on Postgres too, from migration 002. Worth stating
-- because every other id in this table is a uuid over there, so a reader translating by habit would
-- make it one here and produce a column that cannot reference the parent on the other driver.
--
-- THE CHECKs ARE INLINE ON THE COLUMN, as 033, 034, 037, 043 and 050 already do, because SQLite has
-- no `ALTER TABLE ... ADD CONSTRAINT`.
--
-- NO RLS, on this driver, ever — see 009. The repository layer's WHERE is the whole of the
-- enforcement here, which is why every method on the work store takes a context first.

CREATE TABLE work_items (
  id            TEXT PRIMARY KEY,
  workspace_id  TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  agent_id      TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  deployment_id TEXT NOT NULL REFERENCES deployments(id),
  run_id        TEXT,
  created_by    TEXT NOT NULL REFERENCES users(id),
  input         TEXT NOT NULL,
  status        TEXT NOT NULL CHECK (status IN
                  ('queued','running','waiting','succeeded','failed','cancelled')),
  output        TEXT,
  error         TEXT,
  failure_kind  TEXT CHECK (failure_kind IN
                  ('unauthorised','agent_error','rejected','unreachable','stopped_reporting','busy')),
  created_at    TEXT NOT NULL,
  started_at    TEXT,
  -- What retention sweeps on. Never `created_at` — see the Postgres file.
  ended_at      TEXT,
  created_seq   INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX work_items_ws_created ON work_items (workspace_id, created_at DESC);
CREATE INDEX work_items_ws_status  ON work_items (workspace_id, status);
CREATE INDEX work_items_ws_agent   ON work_items (workspace_id, agent_id, created_at DESC);
CREATE INDEX work_items_ws_actor   ON work_items (workspace_id, created_by, created_at DESC);
