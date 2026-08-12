-- 026_oauth — the SQLite half. Read the Postgres file for why there are no token columns, why
-- `scopes` records what was GRANTED rather than what was asked for, why the state row holds a
-- hash, and why the PKCE verifier is stored in plaintext without being an exception to any of it.
--
-- Same translation as every migration before it: uuid -> TEXT, timestamptz -> TEXT ISO-8601,
-- jsonb -> TEXT holding JSON. There is no RLS here and there never will be; on this driver the
-- repository layer is the whole of the enforcement, which is why every method takes a context
-- rather than trusting one to have been set.
--
-- THESE TABLES EXIST ON SQLITE EVEN THOUGH `npm run dev` NEVER RUNS AN OAUTH FLOW. The tenancy
-- suite runs on both drivers and is the gate for every later session, so a table only Postgres
-- has is a table only half the suite can exercise — and the isolation properties that matter for
-- a connection are the application layer's, which is exactly the half SQLite tests. Same
-- reasoning as 015's note on the vault tables.

CREATE TABLE oauth_connections (
  id                     TEXT PRIMARY KEY,
  workspace_id           TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  provider               TEXT NOT NULL,
  connector_id           TEXT NOT NULL,
  connected_by           TEXT REFERENCES users(id) ON DELETE SET NULL,
  external_account_id    TEXT,
  external_account_label TEXT,
  scopes                 TEXT NOT NULL DEFAULT '[]',
  status                 TEXT NOT NULL DEFAULT 'active'
                         CHECK (status IN ('active', 'reauth_required', 'revoked')),
  access_secret_name     TEXT NOT NULL,
  refresh_secret_name    TEXT,
  access_expires_at      TEXT,
  last_refreshed_at      TEXT,
  last_error             TEXT,
  created_at             TEXT NOT NULL,
  updated_at             TEXT NOT NULL,
  revoked_at             TEXT,
  UNIQUE (workspace_id, connector_id)
);

CREATE INDEX oauth_connections_ws_connector ON oauth_connections (workspace_id, connector_id);
CREATE INDEX oauth_connections_expiring ON oauth_connections (access_expires_at)
  WHERE status = 'active' AND access_expires_at IS NOT NULL;

CREATE TABLE oauth_states (
  state_hash    TEXT PRIMARY KEY,
  workspace_id  TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  user_id       TEXT REFERENCES users(id) ON DELETE CASCADE,
  provider      TEXT NOT NULL,
  connector_id  TEXT NOT NULL,
  code_verifier TEXT NOT NULL,
  redirect_uri  TEXT NOT NULL,
  scopes        TEXT NOT NULL DEFAULT '[]',
  return_to     TEXT,
  created_at    TEXT NOT NULL,
  expires_at    TEXT NOT NULL
);

CREATE INDEX oauth_states_expiry ON oauth_states (expires_at);
