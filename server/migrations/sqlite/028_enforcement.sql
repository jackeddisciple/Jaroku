-- 028_enforcement — the SQLite half. Read the Postgres file for why this is append-only with a
-- `lifted_at` rather than a status column, why `applied_by` being null is load-bearing, why the
-- evidence is a snapshot, and why only the automatic rungs carry an expiry.
--
-- Same translation as every migration before it: uuid -> TEXT, timestamptz -> TEXT ISO-8601,
-- jsonb -> TEXT holding JSON. No RLS here and there never will be; the repository layer is the
-- whole of the enforcement on this driver.

CREATE TABLE workspace_enforcements (
  id            TEXT PRIMARY KEY,
  workspace_id  TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  level         TEXT NOT NULL,
  reason        TEXT NOT NULL,
  evidence      TEXT NOT NULL DEFAULT '{}',
  applied_by    TEXT REFERENCES users(id) ON DELETE SET NULL,
  applied_at    TEXT NOT NULL,
  expires_at    TEXT,
  lifted_at     TEXT,
  lifted_by     TEXT REFERENCES users(id) ON DELETE SET NULL,
  lifted_reason TEXT,
  appeal_note   TEXT,
  appealed_at   TEXT
);

CREATE INDEX workspace_enforcements_live ON workspace_enforcements (workspace_id, applied_at DESC)
  WHERE lifted_at IS NULL;
CREATE INDEX workspace_enforcements_level ON workspace_enforcements (level, applied_at DESC)
  WHERE lifted_at IS NULL;
