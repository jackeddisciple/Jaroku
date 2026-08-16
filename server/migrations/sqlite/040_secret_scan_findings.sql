-- 040_secret_scan_findings — the SQLite half. Read the Postgres file for why the findings are not
-- `github_events` rows, why NO MATCHED VALUE IS EVER STORED, and why the override is a column here
-- rather than a table of its own.
--
-- Same translation as everywhere else: uuid -> TEXT, timestamptz -> TEXT ISO-8601, boolean ->
-- INTEGER 0/1. Ids that Postgres defaults with `gen_random_uuid()` are supplied by the application.
--
-- The kind CHECK is inline on the column, because SQLite has no `ALTER TABLE ... ADD CONSTRAINT`.
-- The composite FK to `agents (workspace_id, id)` points at the unique index 018 created for it.
--
-- The partial index on overridden rows is spelled the same way here: SQLite supports partial
-- indexes, and the predicate is written as `overridden = 1` because the boolean is an integer on
-- this driver.
--
-- NO RLS, on this driver, ever — see 009.

CREATE TABLE secret_scan_findings (
  id            TEXT PRIMARY KEY,
  workspace_id  TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  agent_id      TEXT NOT NULL,
  link_id       TEXT REFERENCES github_links(id) ON DELETE SET NULL,
  event_id      TEXT REFERENCES github_events(id) ON DELETE SET NULL,
  path          TEXT NOT NULL,
  rule          TEXT NOT NULL,
  kind          TEXT NOT NULL DEFAULT 'secret' CHECK (kind IN ('secret', 'artifact')),
  line          INTEGER,
  overridden    INTEGER NOT NULL DEFAULT 0,
  overridden_by TEXT REFERENCES users(id) ON DELETE SET NULL,
  overridden_at TEXT,
  created_at    TEXT NOT NULL,
  FOREIGN KEY (workspace_id, agent_id) REFERENCES agents (workspace_id, id) ON DELETE CASCADE
);

CREATE INDEX secret_scan_findings_agent
  ON secret_scan_findings (workspace_id, agent_id, created_at DESC);

CREATE INDEX secret_scan_findings_overridden
  ON secret_scan_findings (workspace_id, created_at DESC)
  WHERE overridden = 1;
