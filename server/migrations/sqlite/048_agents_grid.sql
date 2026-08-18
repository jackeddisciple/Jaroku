-- 048_agents_grid — the SQLite half. Read the Postgres file for why this migration adds an index and
-- no columns, why the index is on `threads` rather than on `runs` or `usage_events`, and why
-- `archived_at` is deliberately not in it.
--
-- Nothing to translate: an index declaration is the one kind of statement the two dialects spell
-- identically, so this file differs from its Postgres twin only in the commentary above it.
CREATE INDEX threads_ws_agent_activity ON threads (workspace_id, agent_id, last_activity_at DESC);
