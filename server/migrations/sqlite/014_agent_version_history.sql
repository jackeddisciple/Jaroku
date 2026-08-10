-- 014_agent_version_history — the SQLite half. Read the Postgres file for what these columns
-- are for and why an undone version is marked rather than deleted.
--
-- Same translation as every migration before it: timestamptz -> TEXT ISO-8601, json -> TEXT,
-- bigint -> INTEGER. SQLite's ALTER TABLE ADD COLUMN accepts a CHECK constraint inline but not
-- as a separate ADD CONSTRAINT statement, so `source` carries its check on the column rather
-- than after it — the same rule, spelled the way this dialect spells it.

ALTER TABLE agent_versions ADD COLUMN source TEXT NOT NULL DEFAULT 'import'
  CHECK (source IN ('generation', 'edit', 'import', 'deploy'));
ALTER TABLE agent_versions ADD COLUMN instruction TEXT;
ALTER TABLE agent_versions ADD COLUMN summary     TEXT;
ALTER TABLE agent_versions ADD COLUMN file_stats  TEXT NOT NULL DEFAULT '[]';
ALTER TABLE agent_versions ADD COLUMN total_bytes INTEGER NOT NULL DEFAULT 0;
ALTER TABLE agent_versions ADD COLUMN undone_at   TEXT;

CREATE INDEX agent_versions_agent_version ON agent_versions (agent_id, version DESC);
