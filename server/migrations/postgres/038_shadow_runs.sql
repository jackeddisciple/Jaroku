-- 038_shadow_runs — a git ref, an ordinary run, and the fact that the two were never published.
--
-- §B.2's whole claim is that "what does this branch do?" is answerable without making that branch
-- the working state. The run itself is not new: it is the branch/fork run primitive from v0.1.5
-- pointed at a ref instead of a checkpoint, and it produces ordinary schema-v1 `runs` and `steps`
-- rows. What is new is the mapping — which ref, which sha, which staging directory — and that is
-- all this table holds.
--
-- BESIDE THE FROZEN SCHEMA, NEVER INSIDE IT. `schema/events.md` v1 is frozen, and pause/resume and
-- the eval engine both established the pattern for host-level facts about a run: a new column or a
-- new table beside it, joined on `run_id`. A `source: 'shadow'` column on `runs` would be a change
-- to the frozen schema for a fact no event has ever needed to carry.
--
-- WHY A ROW EXISTS AT ALL FOR SOMETHING DEFINED AS DISPOSABLE. Three reasons, and none of them is
-- history: the transient list §B.2.2 renders has to be readable after a page reload; the sweep has
-- to know which staging directories belong to finished shadow runs, the same way the checkpoint
-- sweep knows which belong to finished eval jobs (v0.2.5); and the side-by-side comparison in
-- §B.2.3 needs to find the OTHER run for the same input. All three are answered by a row and none
-- of them by a log line.
--
-- `swept_at` RATHER THAN A DELETE. The sweep marks; it does not remove. A deleted row would make
-- "this shadow run's trace is gone" indistinguishable from "there was never a shadow run", and the
-- second is what a comparison view would render as an empty column with no explanation.
--
-- NOTHING HERE POINTS AT `agent_versions`, and that absence is the feature. §B.2.2's guarantee is
-- that the promotion step is never reached: no candidate version, nothing entering `agent_versions`,
-- and `current_version` never moving. A foreign key to a version would be a column somebody would
-- eventually fill in.

CREATE TABLE shadow_runs (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id  uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  agent_id      uuid NOT NULL,
  link_id       uuid REFERENCES github_links(id) ON DELETE SET NULL,
  -- The ref as the user named it — `feat/new-prompt`, `main` — and the commit it resolved to at
  -- the moment the run started. Both, because a branch moves and the sha is what was actually run;
  -- the name is what the panel says and the sha is what a comparison is keyed on.
  ref           text NOT NULL,
  head_sha      text NOT NULL,
  -- The ordinary run this produced. `runs.id` is text in the frozen schema, so this is too, and
  -- there is no FK: `runs` is partitioned by way of `steps` and predates this table by thirty
  -- migrations. NULL until the runner has one — a shadow run that failed to stage never gets an id.
  run_id        text,
  -- `agents/.staging/<id>__shadow-<sha>/`, exactly as a generation stages. Recorded so the sweep
  -- removes what this row created rather than what it guesses the name would have been.
  staging_key   text,
  status        text NOT NULL DEFAULT 'staging',
  -- Why it ended, when it ended badly. §B.2.2: a contract failure surfaces as a run with
  -- status "error" rather than as a validator refusal, because a shadow run is disposable and the
  -- graceful failure v0.0.1's runner guarantees is the right shape for it.
  error         text,
  created_by    uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at    timestamptz NOT NULL DEFAULT now(),
  ended_at      timestamptz,
  -- When the sweep reclaimed the staging directory. The row survives it — see the header.
  swept_at      timestamptz,
  FOREIGN KEY (workspace_id, agent_id) REFERENCES agents (workspace_id, id) ON DELETE CASCADE
);

ALTER TABLE shadow_runs
  ADD CONSTRAINT shadow_runs_status_check
  CHECK (status IN ('staging', 'running', 'completed', 'error', 'cancelled'));

-- The transient list: this agent's shadow runs, newest first. It is deliberately a different index
-- from anything the ordinary run history uses, because §B.2.2 requires these never to appear there.
CREATE INDEX shadow_runs_agent ON shadow_runs (workspace_id, agent_id, created_at DESC);

-- The sweep: everything finished and not yet reclaimed, oldest first, across the workspace.
CREATE INDEX shadow_runs_sweep ON shadow_runs (workspace_id, swept_at, ended_at);

ALTER TABLE shadow_runs ENABLE ROW LEVEL SECURITY;
ALTER TABLE shadow_runs FORCE  ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON shadow_runs;
CREATE POLICY tenant_isolation ON shadow_runs
  USING      (workspace_id = NULLIF(current_setting('app.workspace_id', true), '')::uuid)
  WITH CHECK (workspace_id = NULLIF(current_setting('app.workspace_id', true), '')::uuid);

GRANT SELECT, INSERT, UPDATE, DELETE ON shadow_runs TO jaroku_app;
