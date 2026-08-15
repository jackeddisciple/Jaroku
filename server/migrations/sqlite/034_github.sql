-- 034_github — the SQLite half. Read the Postgres file for why there are three tables rather than
-- one, why the split is by lifetime, why no token is in any of them, and why there is deliberately
-- no mirror of the remote's commit list.
--
-- Same translation as every migration on this driver: uuid -> TEXT, timestamptz -> TEXT ISO-8601,
-- boolean -> INTEGER 0/1, json -> TEXT. Ids that Postgres defaults with `gen_random_uuid()` are
-- supplied by the application here.
--
-- THREE DIALECT DIFFERENCES WORTH NAMING RATHER THAN LEAVING TO BE NOTICED:
--
--   SQLite HAS NO `ALTER TABLE ... ADD CONSTRAINT`, so the CHECKs that are separate statements on
--   Postgres are written inline on the column, exactly as 033 did.
--
--   THE COMPOSITE FOREIGN KEY TO `agents (workspace_id, id)` NEEDS A UNIQUE INDEX TO POINT AT.
--   Postgres accepts it because 008 declared `UNIQUE (workspace_id, slug)` and the primary key
--   covers the uuid; SQLite requires the exact parent columns to be unique as a pair. 018 hit this
--   first and created `agents_workspace_id_id` for it, so the index already exists here and this
--   migration simply relies on it — which is why the FK is spelled the same way in both files
--   rather than being quietly dropped on one driver. A tenancy constraint that exists on only one
--   of two supported databases is not a constraint.
--
--   NO RLS, on this driver, ever. There are no roles and no `current_setting`, so the repository
--   layer is the whole of the enforcement — see 009. The tables exist here anyway so the tenancy
--   suite runs on both drivers rather than on the one that happens to have policies.

-- --- the grant --------------------------------------------------------------------------------

CREATE TABLE github_installations (
  id                TEXT PRIMARY KEY,
  workspace_id      TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  user_id           TEXT REFERENCES users(id) ON DELETE SET NULL,
  account_login     TEXT NOT NULL,
  account_type      TEXT NOT NULL DEFAULT 'user' CHECK (account_type IN ('user', 'org')),
  token_secret_name TEXT NOT NULL,
  scopes            TEXT NOT NULL DEFAULT '[]',
  installed_at      TEXT NOT NULL,
  revoked_at        TEXT,
  revoke_reason     TEXT
);

CREATE UNIQUE INDEX github_installations_live
  ON github_installations (workspace_id, account_login)
  WHERE revoked_at IS NULL;

-- --- the link ---------------------------------------------------------------------------------

CREATE TABLE github_links (
  id                     TEXT PRIMARY KEY,
  workspace_id           TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  agent_id               TEXT NOT NULL,
  installation_id        TEXT NOT NULL REFERENCES github_installations(id) ON DELETE CASCADE,
  repo_full_name         TEXT NOT NULL,
  branch                 TEXT NOT NULL,
  subdirectory           TEXT,
  include_artifacts      INTEGER NOT NULL DEFAULT 1,
  last_pushed_version_id TEXT REFERENCES agent_versions(id) ON DELETE SET NULL,
  last_pushed_sha        TEXT,
  last_known_remote_sha  TEXT,
  last_synced_at         TEXT,
  created_by             TEXT REFERENCES users(id) ON DELETE SET NULL,
  created_at             TEXT NOT NULL,
  deleted_at             TEXT,
  FOREIGN KEY (workspace_id, agent_id) REFERENCES agents (workspace_id, id) ON DELETE CASCADE
);

CREATE UNIQUE INDEX github_links_live ON github_links (workspace_id, agent_id) WHERE deleted_at IS NULL;

CREATE INDEX github_links_ws ON github_links (workspace_id, deleted_at, agent_id);

-- --- the history ------------------------------------------------------------------------------

CREATE TABLE github_events (
  id            TEXT PRIMARY KEY,
  workspace_id  TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  agent_id      TEXT,
  link_id       TEXT REFERENCES github_links(id) ON DELETE SET NULL,
  kind          TEXT NOT NULL
    CHECK (kind IN ('link', 'unlink', 'push', 'fetch', 'pull', 'pr_open', 'force_override', 'branch_switch')),
  outcome       TEXT NOT NULL DEFAULT 'ok' CHECK (outcome IN ('ok', 'refused', 'failed')),
  actor_user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  version_ids   TEXT NOT NULL DEFAULT '[]',
  commit_sha    TEXT,
  detail        TEXT,
  created_at    TEXT NOT NULL,
  FOREIGN KEY (workspace_id, agent_id) REFERENCES agents (workspace_id, id) ON DELETE CASCADE
);

CREATE INDEX github_events_agent ON github_events (workspace_id, agent_id, created_at DESC);
