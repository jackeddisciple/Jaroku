-- 016_secret_refs — the SQLite half. Read the Postgres file for why the names live in a table
-- of their own, why there is no value column, and why `configured` is a column rather than
-- "the row exists".
--
-- Same translation as everywhere else: uuid -> TEXT, timestamptz -> TEXT ISO-8601, boolean ->
-- INTEGER 0/1. The scope/agent CHECK is written inline here because SQLite has no
-- ADD CONSTRAINT — the same rule, spelled the way this dialect spells it.

CREATE TABLE secret_refs (
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  name         TEXT NOT NULL,
  provider     TEXT,
  scope        TEXT NOT NULL DEFAULT 'workspace' CHECK (scope IN ('workspace', 'agent')),
  agent_id     TEXT REFERENCES agents(id) ON DELETE CASCADE,
  configured   INTEGER NOT NULL DEFAULT 0,
  created_at   TEXT NOT NULL,
  updated_at   TEXT NOT NULL,
  last_used_at TEXT,
  PRIMARY KEY (workspace_id, name),
  CHECK ((scope = 'agent' AND agent_id IS NOT NULL) OR (scope = 'workspace' AND agent_id IS NULL))
);

CREATE INDEX secret_refs_ws_configured ON secret_refs (workspace_id, configured, name);

-- The same two columns 015 gave workspace_secrets, removed for the same reason: they are
-- store-agnostic facts and now live above, and two copies of one fact is how they disagree.
ALTER TABLE workspace_secrets DROP COLUMN provider;
ALTER TABLE workspace_secrets DROP COLUMN last_used_at;
