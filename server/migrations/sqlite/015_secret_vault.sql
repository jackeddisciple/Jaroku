-- 015_secret_vault — the SQLite half. Read the Postgres file for the envelope design and for
-- why the ciphertext is bound to its workspace and name.
--
-- Same translation as every migration before it: uuid -> TEXT, timestamptz -> TEXT ISO-8601.
-- There is no RLS here and there never will be; on this driver the repository layer is the
-- whole of the enforcement, which is why every method takes a context rather than trusting one
-- to have been set.
--
-- THESE TABLES EXIST ON SQLITE EVEN THOUGH THE LOCAL PATH DOES NOT USE THEM. Two reasons, and
-- neither is symmetry for its own sake. The tenancy suite runs on both drivers and is the gate
-- for every later session, so a table only Postgres has is a table only half the suite can
-- exercise — and the isolation properties that matter here are the application layer's, which
-- is exactly the half SQLite tests. And the hosted store is selectable in development, so
-- somebody debugging the vault can point it at a file rather than at a database they have to
-- stand up first.

CREATE TABLE workspace_data_keys (
  id            TEXT PRIMARY KEY,
  workspace_id  TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  version       INTEGER NOT NULL,
  master_key_id TEXT NOT NULL,
  wrapped_key   TEXT NOT NULL,
  created_at    TEXT NOT NULL,
  retired_at    TEXT,
  UNIQUE (workspace_id, version)
);

CREATE INDEX workspace_data_keys_ws_version ON workspace_data_keys (workspace_id, version DESC);

CREATE TABLE workspace_secrets (
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  name         TEXT NOT NULL,
  data_key_id  TEXT NOT NULL REFERENCES workspace_data_keys(id),
  ciphertext   TEXT NOT NULL,
  provider     TEXT,
  created_at   TEXT NOT NULL,
  updated_at   TEXT NOT NULL,
  last_used_at TEXT,
  PRIMARY KEY (workspace_id, name)
);
