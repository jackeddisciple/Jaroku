-- 043_threads — the SQLite half. Read the Postgres file for why a build session is worth a table,
-- why `agent_id` is nullable at both ends of an agent's life, why the foreign key is one column
-- rather than the pair, and why `status` is a cache of a derivation and never an input.
--
-- Same translation as every migration on this driver: uuid -> TEXT, timestamptz -> TEXT ISO-8601,
-- boolean -> INTEGER 0/1. Ids that Postgres defaults with `gen_random_uuid()` are supplied here,
-- and so are the timestamps, because SQLite has no `now()` that writes the same string shape the
-- rest of the schema stores.
--
-- The CHECK that is a separate statement on Postgres is inline on the column, as 033, 034 and 037
-- already do, because SQLite has no `ALTER TABLE ... ADD CONSTRAINT`.
--
-- NO RLS, on this driver, ever — see 009. The repository layer's WHERE is the whole of the
-- enforcement here, which is why every method in the thread store takes a context first.

CREATE TABLE threads (
  id                  TEXT PRIMARY KEY,
  workspace_id        TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  agent_id            TEXT REFERENCES agents(id) ON DELETE SET NULL,
  agent_name_snapshot TEXT,
  title               TEXT NOT NULL,
  title_is_custom     INTEGER NOT NULL DEFAULT 0,
  created_by          TEXT REFERENCES users(id),
  created_at          TEXT NOT NULL,
  last_activity_at    TEXT NOT NULL,
  archived_at         TEXT,
  status              TEXT NOT NULL DEFAULT 'idle'
    CHECK (status IN ('needs_you', 'running', 'errored', 'idle', 'archived'))
);

CREATE INDEX threads_ws_archived_activity
  ON threads (workspace_id, archived_at, last_activity_at DESC);

CREATE INDEX threads_agent ON threads (workspace_id, agent_id);
