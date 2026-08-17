-- 047_agent_lifecycle — the SQLite half. Read the Postgres file for why an agent is archived rather
-- than deleted, why the archive cannot live in `deleted_at`, and why a rename needs a flag of its
-- own.
--
-- Same translation as every migration on this driver: timestamptz -> TEXT ISO-8601, boolean ->
-- INTEGER 0/1. SQLite's ALTER TABLE takes one column at a time, which is why these are two
-- statements rather than one.
ALTER TABLE agents ADD COLUMN archived_at TEXT;

ALTER TABLE agents ADD COLUMN display_name_is_custom INTEGER NOT NULL DEFAULT 0;

CREATE INDEX agents_ws_archived ON agents (workspace_id, archived_at);
