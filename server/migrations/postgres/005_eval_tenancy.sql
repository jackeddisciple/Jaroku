-- 005_eval_tenancy — workspace_id across the eval control plane.
--
-- Six tables, one rule. An eval is a batch of ordinary runs, so its rows are as tenant-owned
-- as the traces they point at: a dataset is somebody's test cases, an eval_job's cost is
-- somebody's bill, and a score is a judgement about their agent.
--
-- Same shape as 004: add, backfill into the workspace that migration created, constrain,
-- then index with workspace_id leading. Read 004 for why that order and why the default is
-- dropped afterwards.
--
-- THE SHARED DEFAULT RUBRIC HAS TO GO, and it is the only interesting part of this file.
--
--   `rubrics` allows dataset_id IS NULL, which meant "the built-in default, shared by every
--   dataset that has not customised one". The server seeded exactly one such row under a
--   fixed id, `rubric-default`.
--
--   One row shared by everybody is a cross-tenant object. Two workspaces editing "the
--   default rubric" would be editing each other's, and every eval either side ran afterwards
--   would be scored against criteria somebody they have never met chose. It is also
--   impossible to express: with workspace_id NOT NULL the row can only belong to one of
--   them, so the other's lookup finds nothing.
--
--   So the fixed id is retired. A workspace's default rubric is now "the row in MY workspace
--   with no dataset", created on first use, and the constant that named it is gone from the
--   code entirely. Any existing row is backfilled to the local workspace, where it goes on
--   being that workspace's default.

ALTER TABLE datasets         ADD COLUMN workspace_id uuid REFERENCES workspaces(id);
ALTER TABLE dataset_examples ADD COLUMN workspace_id uuid REFERENCES workspaces(id);
ALTER TABLE rubrics          ADD COLUMN workspace_id uuid REFERENCES workspaces(id);
ALTER TABLE eval_runs        ADD COLUMN workspace_id uuid REFERENCES workspaces(id);
ALTER TABLE eval_jobs        ADD COLUMN workspace_id uuid REFERENCES workspaces(id);
ALTER TABLE eval_scores      ADD COLUMN workspace_id uuid REFERENCES workspaces(id);

UPDATE datasets         SET workspace_id = '00000000-0000-4000-8000-000000000001' WHERE workspace_id IS NULL;
UPDATE dataset_examples SET workspace_id = '00000000-0000-4000-8000-000000000001' WHERE workspace_id IS NULL;
UPDATE rubrics          SET workspace_id = '00000000-0000-4000-8000-000000000001' WHERE workspace_id IS NULL;
UPDATE eval_runs        SET workspace_id = '00000000-0000-4000-8000-000000000001' WHERE workspace_id IS NULL;
UPDATE eval_jobs        SET workspace_id = '00000000-0000-4000-8000-000000000001' WHERE workspace_id IS NULL;
UPDATE eval_scores      SET workspace_id = '00000000-0000-4000-8000-000000000001' WHERE workspace_id IS NULL;

ALTER TABLE datasets         ALTER COLUMN workspace_id SET NOT NULL;
ALTER TABLE dataset_examples ALTER COLUMN workspace_id SET NOT NULL;
ALTER TABLE rubrics          ALTER COLUMN workspace_id SET NOT NULL;
ALTER TABLE eval_runs        ALTER COLUMN workspace_id SET NOT NULL;
ALTER TABLE eval_jobs        ALTER COLUMN workspace_id SET NOT NULL;
ALTER TABLE eval_scores      ALTER COLUMN workspace_id SET NOT NULL;

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
