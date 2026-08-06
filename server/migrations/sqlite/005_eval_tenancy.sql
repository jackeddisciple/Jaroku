-- 005_eval_tenancy — workspace_id across the eval control plane.
--
-- Read the Postgres version for what this does and for why the shared default rubric had to
-- be retired. The dialect difference is the same one 004 documents: SQLite has no ALTER
-- COLUMN, so NOT NULL arrives with a permanent default, and that default is the empty string
-- — a value equal to no workspace, so a row that somehow gets it is unreachable rather than
-- quietly somebody's.

INSERT OR IGNORE INTO workspaces (id, slug, name, kind, plan, created_at)
VALUES ('00000000-0000-4000-8000-000000000001', 'local', 'Local', 'personal', 'free',
        strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));

ALTER TABLE datasets         ADD COLUMN workspace_id TEXT NOT NULL DEFAULT '';
ALTER TABLE dataset_examples ADD COLUMN workspace_id TEXT NOT NULL DEFAULT '';
ALTER TABLE rubrics          ADD COLUMN workspace_id TEXT NOT NULL DEFAULT '';
ALTER TABLE eval_runs        ADD COLUMN workspace_id TEXT NOT NULL DEFAULT '';
ALTER TABLE eval_jobs        ADD COLUMN workspace_id TEXT NOT NULL DEFAULT '';
ALTER TABLE eval_scores      ADD COLUMN workspace_id TEXT NOT NULL DEFAULT '';

UPDATE datasets         SET workspace_id = '00000000-0000-4000-8000-000000000001' WHERE workspace_id = '';
UPDATE dataset_examples SET workspace_id = '00000000-0000-4000-8000-000000000001' WHERE workspace_id = '';
UPDATE rubrics          SET workspace_id = '00000000-0000-4000-8000-000000000001' WHERE workspace_id = '';
UPDATE eval_runs        SET workspace_id = '00000000-0000-4000-8000-000000000001' WHERE workspace_id = '';
UPDATE eval_jobs        SET workspace_id = '00000000-0000-4000-8000-000000000001' WHERE workspace_id = '';
UPDATE eval_scores      SET workspace_id = '00000000-0000-4000-8000-000000000001' WHERE workspace_id = '';

CREATE INDEX datasets_ws_agent    ON datasets (workspace_id, agent_id);
CREATE INDEX examples_ws_dataset  ON dataset_examples (workspace_id, dataset_id, position);
CREATE INDEX rubrics_ws_dataset   ON rubrics (workspace_id, dataset_id);
CREATE INDEX eval_runs_ws_started ON eval_runs (workspace_id, started_at DESC);
CREATE INDEX eval_jobs_ws_status  ON eval_jobs (workspace_id, eval_id, status);
CREATE INDEX eval_jobs_ws_run     ON eval_jobs (workspace_id, run_id);
CREATE INDEX eval_scores_ws_job   ON eval_scores (workspace_id, job_id);

DROP INDEX IF EXISTS idx_examples_dataset;
DROP INDEX IF EXISTS idx_datasets_agent;
DROP INDEX IF EXISTS idx_jobs_eval;
DROP INDEX IF EXISTS idx_jobs_run;
DROP INDEX IF EXISTS idx_rubrics_dataset;
