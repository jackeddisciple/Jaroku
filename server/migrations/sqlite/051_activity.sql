-- 051_activity — the SQLite half. Read the Postgres file for what these three indexes are for, why
-- `agent_versions` leads with `agent_id` rather than with a workspace column it does not have, why
-- the undone index is partial, and — the longer half — why `runs`, `steps`, `usage_events` and
-- `audit_log` get nothing here.
--
-- Nothing to translate. An index declaration, partial predicate included, is one of the few kinds of
-- statement the two dialects spell identically, so this file differs from its Postgres twin only in
-- the commentary above it.
CREATE INDEX deployments_ws_created ON deployments (workspace_id, created_at DESC);
CREATE INDEX agent_versions_agent_created ON agent_versions (agent_id, created_at DESC);
CREATE INDEX agent_versions_agent_undone ON agent_versions (agent_id, undone_at DESC)
  WHERE undone_at IS NOT NULL;
