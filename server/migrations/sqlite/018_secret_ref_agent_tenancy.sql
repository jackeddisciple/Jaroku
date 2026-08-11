-- 018_secret_ref_agent_tenancy — the SQLite half. Read the Postgres file for why a foreign key
-- to `agents(id)` was the wrong reference and (workspace_id, agent_id) is the right one.
--
-- This driver cannot say ALTER TABLE ... DROP CONSTRAINT, so the table is rebuilt: same columns,
-- same primary key, same checks, one different foreign key. `secret_refs` has no children, so
-- the three-step dance migration 006 needed does not apply — but foreign keys are ON in this
-- driver and the copy runs while both tables exist, so `defer_foreign_keys` still covers the
-- moment in between. It is settable inside a transaction, which `foreign_keys` is not.
--
-- The unique index on the parent's pair comes first: a composite foreign key needs one, and
-- without it the new table's key would simply be unenforceable.

PRAGMA defer_foreign_keys = ON;

CREATE UNIQUE INDEX agents_workspace_id_id ON agents (workspace_id, id);

CREATE TABLE secret_refs_new (
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  name         TEXT NOT NULL,
  provider     TEXT,
  scope        TEXT NOT NULL DEFAULT 'workspace' CHECK (scope IN ('workspace', 'agent')),
  agent_id     TEXT,
  configured   INTEGER NOT NULL DEFAULT 0,
  created_at   TEXT NOT NULL,
  updated_at   TEXT NOT NULL,
  last_used_at TEXT,
  PRIMARY KEY (workspace_id, name),
  FOREIGN KEY (workspace_id, agent_id) REFERENCES agents (workspace_id, id) ON DELETE CASCADE,
  CHECK ((scope = 'agent' AND agent_id IS NOT NULL) OR (scope = 'workspace' AND agent_id IS NULL))
);

INSERT INTO secret_refs_new
  (workspace_id, name, provider, scope, agent_id, configured, created_at, updated_at, last_used_at)
SELECT workspace_id, name, provider, scope, agent_id, configured, created_at, updated_at, last_used_at
  FROM secret_refs;

DROP TABLE secret_refs;
ALTER TABLE secret_refs_new RENAME TO secret_refs;

CREATE INDEX secret_refs_ws_configured ON secret_refs (workspace_id, configured, name);
