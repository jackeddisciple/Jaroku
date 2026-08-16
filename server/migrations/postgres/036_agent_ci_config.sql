-- 036_agent_ci_config — which dataset a pull request runs against, and whose money it may spend.
--
-- Addendum B numbers this one 035. That number was taken by the webhook scope policy between the
-- addendum being written and it being built, so this sequence runs 036–040 for the addendum's
-- 035–039. The names are the addendum's; only the integers moved, and they moved because a
-- migration number is a position in a history rather than a label somebody chose.
--
-- ONE ROW PER AGENT, AND ITS ABSENCE IS THE DEFAULT. Linking a repository does not enable an eval
-- check — §B.1.2 is explicit that silent, unbounded spend on every push to a pull request is not a
-- default this product gets to have. So there is no row until somebody names a dataset, and the
-- check-posting path reads "no row" as "post nothing" rather than as "use some fallback".
--
-- WHY `ci_dataset_id` IS NULLABLE ON A TABLE THAT ONLY EXISTS TO HOLD IT. The provider policy is
-- the other half, and somebody can legitimately set a policy first, or clear a dataset while
-- keeping the policy they had chosen. A row with a null dataset is "configured, and currently
-- posting nothing" — which is a different fact from "never configured", and the difference is
-- worth a column rather than a deletion.
--
-- `provider_policy` IS AN ENUM OF THREE AND NOT A BOOLEAN. §B.1.3's rule has three positions, not
-- two: never spend, spend for collaborators only, always spend. Spelling the middle one as a
-- boolean pair would put the interesting case — the one that has to consult GitHub about who
-- opened the pull request — in whichever combination of two flags somebody guessed at.
--
-- THE FOREIGN KEY IS ON THE PAIR, for the reason 018 established for `secret_refs` and 034
-- repeated for `github_links`: `agents(id)` alone is satisfiable by any tenant's agent, which
-- makes this row's lifetime somebody else's to decide through ON DELETE CASCADE.

CREATE TABLE agent_ci_config (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id    uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  agent_id        uuid NOT NULL,
  -- Which dataset a pull request's check runs. NULL means configured-but-posting-nothing; see
  -- the header. ON DELETE SET NULL rather than CASCADE: deleting a dataset should stop the check,
  -- not silently discard the provider policy somebody chose alongside it.
  ci_dataset_id   uuid REFERENCES datasets(id) ON DELETE SET NULL,
  provider_policy text NOT NULL DEFAULT 'collaborators_paid',
  updated_by      uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (workspace_id, agent_id) REFERENCES agents (workspace_id, id) ON DELETE CASCADE
);

ALTER TABLE agent_ci_config
  ADD CONSTRAINT agent_ci_config_policy_check
  CHECK (provider_policy IN ('dry_run_only', 'collaborators_paid', 'always_paid'));

-- One row per agent, enforced by the database rather than by the repository method. Two members
-- opening the settings at once must not be able to produce two policies for one agent, with the
-- check path reading whichever the planner returned first.
CREATE UNIQUE INDEX agent_ci_config_agent ON agent_ci_config (workspace_id, agent_id);

ALTER TABLE agent_ci_config ENABLE ROW LEVEL SECURITY;
ALTER TABLE agent_ci_config FORCE  ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON agent_ci_config;
CREATE POLICY tenant_isolation ON agent_ci_config
  USING      (workspace_id = NULLIF(current_setting('app.workspace_id', true), '')::uuid)
  WITH CHECK (workspace_id = NULLIF(current_setting('app.workspace_id', true), '')::uuid);

GRANT SELECT, INSERT, UPDATE, DELETE ON agent_ci_config TO jaroku_app;
