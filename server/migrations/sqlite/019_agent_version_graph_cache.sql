-- 019_agent_version_graph_cache — the SQLite half. Read the Postgres file for why this exists.
--
-- Same translation as every migration before it: json -> TEXT, no CHECK needed here.
ALTER TABLE agent_versions ADD COLUMN graph_cache TEXT;
