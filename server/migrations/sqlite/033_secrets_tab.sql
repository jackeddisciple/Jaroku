-- 033_secrets_tab — the SQLite half. Read the Postgres file for why the metadata extends
-- `secret_refs` rather than arriving as a second table, why `masked_hint` is stored rather than
-- derived, why an elevation is one row per issued token, and why the blast-radius table is called
-- `secret_usages`.
--
-- Same translation as everywhere else: uuid -> TEXT, timestamptz -> TEXT ISO-8601, boolean ->
-- INTEGER 0/1, json -> TEXT. Ids that Postgres defaults with `gen_random_uuid()` are supplied by
-- the application here, which is what every other table on this driver already does.
--
-- TWO DIALECT DIFFERENCES WORTH NAMING RATHER THAN LEAVING TO BE NOTICED:
--
--   SQLite HAS NO `ALTER TABLE ... ADD CONSTRAINT`, so the CHECKs that are separate statements on
--   Postgres are written inline on the column instead — the same rule, spelled the way this
--   dialect spells it, exactly as 016 did for the scope/agent CHECK. SQLite does not re-validate
--   existing rows when a CHECK arrives with a new column, which is harmless here because every
--   one of these columns is defaulted and every default satisfies its own constraint.
--
--   NO RLS, on this driver, ever. There are no roles and no `current_setting`, so the repository
--   layer is the whole of the enforcement — see 009. The tables exist here anyway so the tenancy
--   suite runs on both drivers rather than on the one that happens to have policies.

-- --- the metadata ----------------------------------------------------------------------------

ALTER TABLE secret_refs ADD COLUMN kind TEXT NOT NULL DEFAULT 'custom'
  CHECK (kind IN ('provider_key', 'managed', 'custom'));
ALTER TABLE secret_refs ADD COLUMN masked_hint TEXT;
ALTER TABLE secret_refs ADD COLUMN status TEXT NOT NULL DEFAULT 'unknown'
  CHECK (status IN ('valid', 'invalid', 'expiring', 'unknown'));
ALTER TABLE secret_refs ADD COLUMN expires_at TEXT;
ALTER TABLE secret_refs ADD COLUMN rotated_at TEXT;
ALTER TABLE secret_refs ADD COLUMN created_by TEXT REFERENCES users(id) ON DELETE SET NULL;
ALTER TABLE secret_refs ADD COLUMN connector_id TEXT;
ALTER TABLE secret_refs ADD COLUMN rotate_every_days INTEGER
  CHECK (rotate_every_days IS NULL OR rotate_every_days > 0);

CREATE INDEX secret_refs_ws_status ON secret_refs (workspace_id, status, expires_at);

-- --- the gate's policy ------------------------------------------------------------------------

ALTER TABLE workspaces ADD COLUMN secrets_gate TEXT NOT NULL DEFAULT 'tab'
  CHECK (secrets_gate IN ('tab', 'mutations'));

-- --- the passcode -----------------------------------------------------------------------------

CREATE TABLE user_secret_passcodes (
  workspace_id     TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  user_id          TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  hash             TEXT NOT NULL,
  salt             TEXT NOT NULL,
  algo             TEXT NOT NULL,
  params           TEXT NOT NULL DEFAULT '{}',
  failed_attempts  INTEGER NOT NULL DEFAULT 0,
  locked_until     TEXT,
  last_verified_at TEXT,
  created_at       TEXT NOT NULL,
  updated_at       TEXT NOT NULL,
  PRIMARY KEY (workspace_id, user_id)
);

-- --- elevation --------------------------------------------------------------------------------

CREATE TABLE secret_elevations (
  id            TEXT PRIMARY KEY,
  workspace_id  TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  user_id       TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  session_id    TEXT NOT NULL,
  token_hash    TEXT NOT NULL,
  method        TEXT NOT NULL CHECK (method IN ('passcode', 'webauthn', 'oidc')),
  issued_at     TEXT NOT NULL,
  expires_at    TEXT NOT NULL,
  revoked_at    TEXT,
  revoke_reason TEXT,
  ip            TEXT,
  user_agent    TEXT
);

CREATE UNIQUE INDEX secret_elevations_token ON secret_elevations (token_hash);
CREATE INDEX secret_elevations_ws_session ON secret_elevations (workspace_id, session_id, expires_at DESC);

-- --- blast radius -----------------------------------------------------------------------------

CREATE TABLE secret_usages (
  id            TEXT PRIMARY KEY,
  workspace_id  TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  name          TEXT NOT NULL,
  agent_id      TEXT,
  source        TEXT NOT NULL CHECK (source IN ('static_scan', 'runtime_read')),
  location      TEXT,
  hits          INTEGER NOT NULL DEFAULT 1,
  first_seen_at TEXT NOT NULL,
  detected_at   TEXT NOT NULL,
  FOREIGN KEY (workspace_id, name) REFERENCES secret_refs (workspace_id, name) ON DELETE CASCADE,
  FOREIGN KEY (workspace_id, agent_id) REFERENCES agents (workspace_id, id) ON DELETE CASCADE
);

-- The COALESCE is doing the same work it does on Postgres: two NULLs are distinct in an ordinary
-- unique index, so a workspace-scoped runtime read would insert a fresh row on every single run.
CREATE UNIQUE INDEX secret_usages_site
  ON secret_usages (workspace_id, name, source, COALESCE(agent_id, ''), COALESCE(location, ''));

CREATE INDEX secret_usages_ws_name ON secret_usages (workspace_id, name, source);

-- --- rotation history -------------------------------------------------------------------------

CREATE TABLE secret_rotations (
  id           TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  name         TEXT NOT NULL,
  rotated_by   TEXT REFERENCES users(id) ON DELETE SET NULL,
  masked_hint  TEXT,
  reason       TEXT,
  rotated_at   TEXT NOT NULL,
  FOREIGN KEY (workspace_id, name) REFERENCES secret_refs (workspace_id, name) ON DELETE CASCADE
);

CREATE INDEX secret_rotations_ws_name ON secret_rotations (workspace_id, name, rotated_at DESC);

-- The Postgres file also grants a `platform_sweep` policy so the expired-elevation sweep can reach
-- every workspace. There is nothing to write here: no policies means nothing blocks the same
-- DELETE, and `asPlatform` is an ordinary transaction on this driver.

