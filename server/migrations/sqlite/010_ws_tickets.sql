-- 010_ws_tickets — the SQLite half. See the Postgres file for why this table exists and why
-- it deliberately carries no row-level security policy.
--
-- The differences are the usual two: TEXT for a uuid and TEXT for a timestamp, both because
-- SQLite has neither type and an ISO-8601 string sorts and compares correctly anyway.

CREATE TABLE ws_tickets (
  token_hash   TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  user_id      TEXT REFERENCES users(id) ON DELETE CASCADE,
  role         TEXT NOT NULL CHECK (role IN ('owner', 'admin', 'member', 'system')),
  expires_at   TEXT NOT NULL,
  created_at   TEXT NOT NULL
);

CREATE INDEX ws_tickets_expiry  ON ws_tickets (expires_at);
CREATE INDEX ws_tickets_ws_user ON ws_tickets (workspace_id, user_id);
