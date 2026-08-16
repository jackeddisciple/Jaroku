-- 037_check_runs — the join between a pull request, a GitHub Check Run, and an eval run.
--
-- Three identifier spaces meet here and none of them can name the other two. GitHub knows a check
-- run id and a head sha. The eval engine knows an `eval_runs.id`. The panel knows an agent. A
-- check that posts a pass-rate has to hold all three at once — to update the check when the eval
-- finishes, to find the BASELINE for the next one, and to render the ⧫ markers §B.8.2 hangs off
-- this table — and there is no third table that already does.
--
-- WHY THIS IS NOT A COLUMN ON `eval_runs`. An eval run is a first-class thing somebody starts from
-- the Evals tab, and most of them have no pull request anywhere near them. Adding two nullable
-- GitHub columns to that table would put a feature's optional metadata on the frozen path every
-- eval takes, and would leave "was this eval a CI check?" answerable only by testing a column for
-- null. A row here is the statement.
--
-- `eval_run_id` IS NULLABLE, AND THE WINDOW IT COVERS IS THE POINT. §B.1.2 requires the check to
-- appear on the pull request as soon as the commit arrives — "queued", before anything has been
-- dispatched — so the row is written when the check is CREATED and the eval id is patched in when
-- there is one. A schema that required the eval up front would make the visible half of the
-- feature wait on the expensive half.
--
-- THE DELTAS ARE STORED RATHER THAN RECOMPUTED, and they are stored as nullable doubles, which is
-- the same null-not-zero rule the cost accounting has held since v0.1.9. A first check on a branch
-- with no baseline has NO delta; writing 0 there would claim the numbers did not move. The check's
-- own text says "no baseline yet; this run establishes one" precisely when these are null, so a
-- zero here would make the summary contradict the row it was rendered from.
--
-- WHY `head_sha` IS A COLUMN WHEN THE CHECK RUN ID EXISTS. Superseding is computed locally, before
-- any call to GitHub: a new commit on the same (agent, pr_number) means every earlier row for a
-- DIFFERENT head is stale and its check is to be cancelled. Asking GitHub which of its check runs
-- belong to an older commit would be a round trip to learn something we wrote down ourselves.

CREATE TABLE check_runs (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id        uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  agent_id            uuid NOT NULL,
  link_id             uuid REFERENCES github_links(id) ON DELETE SET NULL,
  pr_number           integer NOT NULL,
  -- The commit the check is ABOUT. Not the branch: a branch moves and a check does not follow it.
  head_sha            text NOT NULL,
  -- GitHub's own id for the check run, so a later update patches rather than posts a second one.
  -- NULL between deciding to check and GitHub accepting the creation.
  github_check_run_id text,
  -- `text`, for the reason 036's `ci_dataset_id` is: `eval_runs.id` is a `text` primary key from
  -- 002, and a `uuid` column here would make the foreign key unbuildable rather than merely
  -- inconsistent. The SQLite half already spells it TEXT, which is why this only ever failed on
  -- the driver the eval engine is actually deployed against.
  eval_run_id         text REFERENCES eval_runs(id) ON DELETE SET NULL,
  -- GitHub's vocabulary, deliberately, because these two go out on the wire as they are stored.
  -- Inventing a third spelling here would mean a translation table nobody would keep current.
  status              text NOT NULL DEFAULT 'queued',
  conclusion          text,
  -- Which provider the check was ALLOWED to run on, after §B.1.3's boundary was applied. Recorded
  -- rather than derived, because the answer depends on who opened the pull request at the moment
  -- it ran, and that can change afterwards — a contributor added to the repository tomorrow does
  -- not retroactively make yesterday's check a paid one.
  provider_mode       text NOT NULL DEFAULT 'dry_run',
  -- 0..1. NULL when the eval produced nothing scoreable — "unscored", never "scored zero".
  pass_rate           double precision,
  cost_per_run_usd    double precision,
  latency_p50_ms      integer,
  -- Signed, against the baseline named below. All three NULL together when there is no baseline.
  pass_rate_delta     double precision,
  cost_delta          double precision,
  latency_delta       integer,
  -- The row these deltas were computed against, so the summary can name it and so a later reader
  -- can tell "no baseline existed" from "the baseline was this and the delta happened to be 0".
  baseline_check_id   uuid REFERENCES check_runs(id) ON DELETE SET NULL,
  created_at          timestamptz NOT NULL DEFAULT now(),
  completed_at        timestamptz,
  FOREIGN KEY (workspace_id, agent_id) REFERENCES agents (workspace_id, id) ON DELETE CASCADE
);

ALTER TABLE check_runs
  ADD CONSTRAINT check_runs_status_check
  CHECK (status IN ('queued', 'in_progress', 'completed'));

ALTER TABLE check_runs
  ADD CONSTRAINT check_runs_conclusion_check
  CHECK (conclusion IS NULL OR conclusion IN ('success', 'failure', 'neutral', 'cancelled', 'timed_out'));

ALTER TABLE check_runs
  ADD CONSTRAINT check_runs_provider_mode_check
  CHECK (provider_mode IN ('dry_run', 'paid'));

-- Superseding reads this: every live row for one pull request, newest first, so the ones whose
-- head is no longer the tip can be cancelled in one pass.
CREATE INDEX check_runs_pr ON check_runs (workspace_id, agent_id, pr_number, created_at DESC);

-- The baseline lookup reads this: the last completed check against a given commit. §B.1.1's
-- comparison is against the last eval recorded on the pull request's BASE ref, which resolves to
-- a sha before it reaches this table.
CREATE INDEX check_runs_head ON check_runs (workspace_id, agent_id, head_sha, created_at DESC);

ALTER TABLE check_runs ENABLE ROW LEVEL SECURITY;
ALTER TABLE check_runs FORCE  ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON check_runs;
CREATE POLICY tenant_isolation ON check_runs
  USING      (workspace_id = NULLIF(current_setting('app.workspace_id', true), '')::uuid)
  WITH CHECK (workspace_id = NULLIF(current_setting('app.workspace_id', true), '')::uuid);

GRANT SELECT, INSERT, UPDATE, DELETE ON check_runs TO jaroku_app;
