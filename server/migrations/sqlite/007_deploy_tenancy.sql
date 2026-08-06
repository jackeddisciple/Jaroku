-- 007_deploy_tenancy — workspace_id on the deploy records.
--
-- Read the Postgres version for why these two tables have to be scoped even though the spec's
-- list of them did not include them. The dialect difference is the one 004 documents: NOT NULL
-- arrives with a permanent empty-string default, which equals no workspace.

INSERT OR IGNORE INTO workspaces (id, slug, name, kind, plan, created_at)
VALUES ('00000000-0000-4000-8000-000000000001', 'local', 'Local', 'personal', 'free',
        strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));

ALTER TABLE deployments     ADD COLUMN workspace_id TEXT NOT NULL DEFAULT '';
ALTER TABLE deployment_logs ADD COLUMN workspace_id TEXT NOT NULL DEFAULT '';

UPDATE deployments     SET workspace_id = '00000000-0000-4000-8000-000000000001' WHERE workspace_id = '';
UPDATE deployment_logs SET workspace_id = '00000000-0000-4000-8000-000000000001' WHERE workspace_id = '';

CREATE INDEX deployments_ws_agent  ON deployments (workspace_id, agent_id, created_at DESC);
CREATE INDEX deployments_ws_status ON deployments (workspace_id, status);
CREATE INDEX deploy_logs_ws_seq    ON deployment_logs (workspace_id, deployment_id, seq);

DROP INDEX IF EXISTS idx_deployments_agent;
DROP INDEX IF EXISTS idx_deployments_status;
