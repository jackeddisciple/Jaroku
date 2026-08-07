-- 012_invites — the SQLite half. See the Postgres file for the design, and in particular for
-- why this table keeps its row-level-security policy when `ws_tickets` could not.
--
-- The usual differences: TEXT for uuids and timestamps, and COLLATE NOCASE where Postgres has
-- citext. SQLite has no RLS at all, so there is no policy here — the repository layer is the
-- whole of the enforcement on this driver, which is exactly why `npm run test:tenancy` runs
-- against it too.

CREATE TABLE workspace_invites (
  id            TEXT PRIMARY KEY,
  workspace_id  TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  email         TEXT NOT NULL COLLATE NOCASE,
  role          TEXT NOT NULL CHECK (role IN ('owner', 'admin', 'member')),
  token_hash    TEXT NOT NULL,
  invited_by    TEXT REFERENCES users(id),
  expires_at    TEXT NOT NULL,
  accepted_at   TEXT,
  accepted_by   TEXT REFERENCES users(id),
  revoked_at    TEXT,
  created_at    TEXT NOT NULL
);

CREATE UNIQUE INDEX workspace_invites_token ON workspace_invites (token_hash);

-- One live invite per address per workspace; a partial index, so re-inviting somebody who
-- declined last month still works. SQLite supports partial indexes, so this is the same
-- constraint the Postgres file has rather than an approximation of it.
CREATE UNIQUE INDEX workspace_invites_pending
  ON workspace_invites (workspace_id, email)
  WHERE accepted_at IS NULL AND revoked_at IS NULL;

CREATE INDEX workspace_invites_ws ON workspace_invites (workspace_id, created_at DESC);
