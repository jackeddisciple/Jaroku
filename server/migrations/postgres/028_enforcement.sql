-- 028_enforcement — what was DONE about what 027 observed, and by whom.
--
-- APPEND-ONLY, WITH A `lifted_at`. The current state of a workspace is its most recent row that
-- has not been lifted; the rows before it are the history. A single mutable `workspaces.status`
-- column would have been smaller and would have thrown away the only thing that makes an
-- enforcement defensible: what it was, when it started, what the evidence was at the time, who
-- decided, and — the part a mutable column erases completely — that it was lifted at all.
--
-- EVERY ROW NAMES A DECIDER. `applied_by` is a user id for a human decision and NULL for an
-- automatic one, and the difference is load-bearing rather than informational: the ladder in
-- abuse/enforcement.ts escalates automatically only as far as a reversible inconvenience, and
-- the two rungs that stop somebody working require a person. A table that could not tell the two
-- apart could not enforce that rule, and could not answer "did a human agree to this" during the
-- appeal that follows.
--
-- `evidence` IS A SNAPSHOT, NOT A JOIN. The score and the signals that produced it are copied in
-- at the moment of the decision, for the same reason 027 copies a signal's weight: signals decay
-- and are swept after thirty days, so a row that pointed at them would, by the time anybody
-- appealed, point at nothing and read as an enforcement with no cause.
--
-- `expires_at` IS HOW A SOFT LIMIT UNDOES ITSELF. The automatic rungs are meant to be temporary —
-- a workspace that stops behaving badly should stop being limited without anybody filing
-- anything — so an automatic row carries an expiry and the gate treats a lapsed one as lifted.
-- A human decision has no expiry: it ends when a human ends it.

CREATE TABLE workspace_enforcements (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id  uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  -- watch | soft_limit | verify | suspended | blocked. Not a CHECK constraint: the ladder is a
  -- table in code (abuse/enforcement.ts) that is expected to gain rungs, and a constraint here
  -- would make adding one a migration — the same reasoning 027 gives for `kind`.
  level         text NOT NULL,
  -- The sentence the workspace is shown. Written to be read by the person it happened to, which
  -- is why it is stored rather than derived: the wording of a decision is part of the decision.
  reason        text NOT NULL,
  -- The score and the signal counts as they stood. See the header on why this is a copy.
  evidence      jsonb NOT NULL DEFAULT '{}',
  -- NULL for an automatic decision, a user id for a human one. See the header.
  applied_by    uuid REFERENCES users(id) ON DELETE SET NULL,
  applied_at    timestamptz NOT NULL DEFAULT now(),
  -- When an automatic rung stops applying by itself. NULL for a human decision.
  expires_at    timestamptz,
  -- Set when it is ended deliberately: by a human, or by the gate when the score has fallen.
  lifted_at     timestamptz,
  lifted_by     uuid REFERENCES users(id) ON DELETE SET NULL,
  lifted_reason text,
  -- What the workspace said about it. Present because an appeal that has nowhere to live is not
  -- an appeal — the ladder promises one, and a promise with no column is a sentence in a README.
  appeal_note   text,
  appealed_at   timestamptz
);

-- The gate's question, asked on every dispatch: what is in force for this workspace right now?
CREATE INDEX workspace_enforcements_live ON workspace_enforcements (workspace_id, applied_at DESC)
  WHERE lifted_at IS NULL;
-- And the platform-side one: who is currently under enforcement, and at which rung.
CREATE INDEX workspace_enforcements_level ON workspace_enforcements (level, applied_at DESC)
  WHERE lifted_at IS NULL;

-- --- the backstop -----------------------------------------------------------------------------
--
-- ENABLE + FORCE + policy, like every tenant table. A workspace may read its own enforcement —
-- it has to, or the refusal it is shown cannot say why — and may not read anybody else's, which
-- would be a map of who is in trouble and how close to a threshold.
--
-- NOTE WHAT THE POLICY DOES NOT PREVENT: a workspace's own context can, as far as Postgres is
-- concerned, INSERT a row lifting its own suspension. The wall there is the capability check and
-- the repository, not RLS — there is no `enforcement:manage` capability in any role's matrix, so
-- nothing a member can send reaches this table. RLS is the backstop for scope, and it has never
-- been the backstop for authority.
ALTER TABLE workspace_enforcements ENABLE ROW LEVEL SECURITY;
ALTER TABLE workspace_enforcements FORCE  ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON workspace_enforcements;
CREATE POLICY tenant_isolation ON workspace_enforcements
  USING      (workspace_id = NULLIF(current_setting('app.workspace_id', true), '')::uuid)
  WITH CHECK (workspace_id = NULLIF(current_setting('app.workspace_id', true), '')::uuid);

GRANT SELECT, INSERT, UPDATE ON workspace_enforcements TO jaroku_app;
