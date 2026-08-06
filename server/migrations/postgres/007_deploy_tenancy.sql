-- 007_deploy_tenancy — workspace_id on the deploy records.
--
-- NOT IN THE SPEC'S LIST OF TABLES TO SCOPE, and it has to be. `deployments` and
-- `deployment_logs` carry Railway project and service ids, the names of the environment
-- variables handed over, a public URL, and the build output — for an agent that belongs to a
-- workspace and was deployed into somebody's own cloud account.
--
-- Leaving them global would mean the sidebar's Deployed filter shows other tenants' URLs,
-- `reusableTarget` hands a redeploy the Railway service of whoever deployed that agent id
-- last, and `supersede` marks somebody else's live deployment as replaced. The last of those
-- is not a read at all — it is one workspace changing another's record of what is running.
--
-- No credential is affected, because there was never a column one could sit in: env_keys is
-- an array of NAMES, and log lines are stored already scrubbed.

ALTER TABLE deployments     ADD COLUMN workspace_id uuid REFERENCES workspaces(id);
ALTER TABLE deployment_logs ADD COLUMN workspace_id uuid REFERENCES workspaces(id);

UPDATE deployments     SET workspace_id = '00000000-0000-4000-8000-000000000001' WHERE workspace_id IS NULL;
UPDATE deployment_logs SET workspace_id = '00000000-0000-4000-8000-000000000001' WHERE workspace_id IS NULL;

ALTER TABLE deployments     ALTER COLUMN workspace_id SET NOT NULL;
ALTER TABLE deployment_logs ALTER COLUMN workspace_id SET NOT NULL;

CREATE INDEX deployments_ws_agent  ON deployments (workspace_id, agent_id, created_at DESC);
CREATE INDEX deployments_ws_status ON deployments (workspace_id, status);
CREATE INDEX deploy_logs_ws_seq    ON deployment_logs (workspace_id, deployment_id, seq);

DROP INDEX IF EXISTS idx_deployments_agent;
DROP INDEX IF EXISTS idx_deployments_status;
