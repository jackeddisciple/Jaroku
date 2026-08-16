-- 036_agent_ci_config — the SQLite half. Read the Postgres file for why the row's absence is the
-- default, why `ci_dataset_id` is nullable on a table that exists to hold it, why the provider
-- policy is three values rather than a boolean, and why the addendum's 035 is this file's 036.
--
-- Same translation as every migration on this driver: uuid -> TEXT, timestamptz -> TEXT ISO-8601,
-- boolean -> INTEGER 0/1, json -> TEXT. Ids that Postgres defaults with `gen_random_uuid()` are
-- supplied by the application here.
--
-- TWO DIALECT DIFFERENCES, both already established by 033 and 034 and repeated rather than
-- rediscovered:
--
--   SQLite HAS NO `ALTER TABLE ... ADD CONSTRAINT`, so the CHECK on `provider_policy` is written
--   inline on the column.
--
--   THE COMPOSITE FOREIGN KEY TO `agents (workspace_id, id)` NEEDS A UNIQUE INDEX TO POINT AT, and
--   018 created `agents_workspace_id_id` for exactly this. The FK is spelled the same way in both
--   files rather than quietly dropped on one driver — a tenancy constraint that exists on only one
--   of two supported databases is not a constraint.
--
-- NO RLS, on this driver, ever. See 009: the repository layer's WHERE clause is the whole of the
-- enforcement here, and the table exists so the tenancy suite runs on both drivers.

CREATE TABLE agent_ci_config (
  id              TEXT PRIMARY KEY,
  workspace_id    TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  agent_id        TEXT NOT NULL,
  ci_dataset_id   TEXT REFERENCES datasets(id) ON DELETE SET NULL,
  provider_policy TEXT NOT NULL DEFAULT 'collaborators_paid'
    CHECK (provider_policy IN ('dry_run_only', 'collaborators_paid', 'always_paid')),
  updated_by      TEXT REFERENCES users(id) ON DELETE SET NULL,
  created_at      TEXT NOT NULL,
  updated_at      TEXT NOT NULL,
  FOREIGN KEY (workspace_id, agent_id) REFERENCES agents (workspace_id, id) ON DELETE CASCADE
);

CREATE UNIQUE INDEX agent_ci_config_agent ON agent_ci_config (workspace_id, agent_id);
