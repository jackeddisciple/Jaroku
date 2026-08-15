-- 034_github — the three tables a second version lineage needs.
--
-- Jaroku already has a lineage: `agent_versions`, a monotonic number per agent, with the pointer
-- in `agents.current_version`. Git has one too. This feature is not "store some GitHub metadata"
-- — it is RECONCILING TWO LINEAGES, and every column below exists to answer one of the two
-- questions the panel asks on every render: what does GitHub have that we do not, and what do we
-- have that GitHub does not.
--
-- THREE TABLES, AND THE SPLIT IS BY LIFETIME RATHER THAN BY SUBJECT.
--
--   `github_installations` is a CREDENTIAL GRANT. It outlives any one agent, is revoked as a
--   unit, and is the thing a token belongs to.
--
--   `github_links` is a POINTER PAIR. One per agent, holding both ends of the reconciliation —
--   the last version we pushed and the last remote sha we saw — and nothing else. It is rewritten
--   constantly and carries no history.
--
--   `github_events` is the HISTORY, append-only. It is what the history view reads, what feeds
--   `audit_log`, and — per §8 of the spec — the table that answers whether Phase 2 is worth
--   building at all, because it records whether anybody is actually editing exported code.
--
-- Folding the second into the third (deriving "where are we" by replaying events) would make the
-- badge a scan instead of a lookup, and the badge is computed for every agent in the sidebar.
-- Folding the third into the second would lose the only record of a force override, which is the
-- one thing this feature does that somebody may have to answer for later.
--
-- NO TOKEN IS IN ANY OF THESE. `token_secret_name` is a NAME in the SecretStore — the same
-- indirection `secret_refs` uses, and for the same reason: the store has no plaintext-return path
-- reachable from a request handler, so a row here cannot be turned into a credential by anything
-- that reads it. A database dump is not a drawer of live GitHub tokens.
--
-- WHY THERE IS NO `github_commits` MIRROR. It is tempting to cache the remote's commit list so
-- History can render without a round trip, and it would be wrong: GitHub is the authority on its
-- own lineage, a cached copy is a second answer that goes stale the moment somebody pushes from a
-- laptop, and the whole design principle here is that the panel says what is TRUE right now.
-- `last_known_remote_sha` is deliberately the only remote fact stored, and it is stored because
-- it is not a cache — it is the watermark that makes divergence detectable at all.

-- --- the grant --------------------------------------------------------------------------------
--
-- PER WORKSPACE AND PER USER. The account is a person's — GitHub authorises `@username`, not an
-- organisation of ours — but the grant is exercised on a workspace's behalf, and two members of
-- one workspace legitimately link through two different GitHub accounts. So the pair is the key,
-- and the workspace half is what RLS reads.
--
-- `scopes` IS STORED RATHER THAN ASSUMED. What we asked for and what GitHub granted are different
-- lists — a user can decline repo access on an org while granting it personally — and a push that
-- 403s should be explainable from the row rather than from a support ticket. §2.1 puts the scope
-- sentence in the empty state precisely because access is part of the pitch; this is the same
-- honesty one layer down.
CREATE TABLE github_installations (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id      uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  -- Who in Jaroku linked it. NULL only for the local single-user path, where there is no user row.
  user_id           uuid REFERENCES users(id) ON DELETE SET NULL,
  -- The GitHub account the token acts as. Rendered as `✓ @username` in §2.2 and nowhere else.
  account_login     text NOT NULL,
  -- 'user' for a personal access token or OAuth grant, 'org' for a GitHub App installation. Both
  -- are named now so the second does not need a migration; only 'user' is implemented.
  account_type      text NOT NULL DEFAULT 'user',
  -- The SecretStore name, never a value. See the header.
  token_secret_name text NOT NULL,
  scopes            json NOT NULL DEFAULT '[]'::json,
  installed_at      timestamptz NOT NULL DEFAULT now(),
  -- Set when the user signs out here, or when GitHub answers 401 and we believe it. A revoked row
  -- is KEPT rather than deleted so `github_events` rows that reference it still resolve, and so
  -- "your access was revoked — reconnect" can name when.
  revoked_at        timestamptz,
  revoke_reason     text
);

ALTER TABLE github_installations
  ADD CONSTRAINT github_installations_account_type_check CHECK (account_type IN ('user', 'org'));

-- One live grant per account per workspace. Partial, so a revoked row does not block relinking the
-- same account — which is the ordinary recovery path after a token is rotated on GitHub's side.
CREATE UNIQUE INDEX github_installations_live
  ON github_installations (workspace_id, account_login)
  WHERE revoked_at IS NULL;

-- --- the link ---------------------------------------------------------------------------------
--
-- PER AGENT, NOT PER WORKSPACE, and §4 of the spec is explicit about why: different agents
-- legitimately belong in different repos, and one repo per workspace would break the monorepo case
-- that `subdirectory` exists for.
--
-- THE FOREIGN KEY IS ON THE PAIR. `agents(id)` alone is satisfiable by ANY tenant's agent, which
-- makes this row's lifetime somebody else's to decide through ON DELETE CASCADE. 018 fixed exactly
-- this on `secret_refs` and 033 repeated the fix on `secret_usages`; a third table making the same
-- mistake would be a pattern rather than an oversight.
--
-- `last_pushed_version_id` AND `last_known_remote_sha` ARE THE WHOLE RECONCILIATION. Ahead is
-- "versions newer than last_pushed_version_id"; behind is "the branch head is not
-- last_known_remote_sha"; diverged is both. Nothing else needs to be stored to compute the badge,
-- and storing anything else would be storing a second answer.
--
-- `subdirectory` IS NULLABLE AND MEANS THE REPO ROOT. Empty string would be a second spelling of
-- the same thing, and the day the two disagree is the day a push writes to `/` on one code path
-- and to `` on another.
CREATE TABLE github_links (
  id                     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id           uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  agent_id               uuid NOT NULL,
  installation_id        uuid NOT NULL REFERENCES github_installations(id) ON DELETE CASCADE,
  -- `owner/repo`, exactly as GitHub spells it. Stored whole rather than split: every API call and
  -- every rendered chip wants the pair, and splitting it would mean rejoining it everywhere.
  repo_full_name         text NOT NULL,
  -- `jaroku/<agent-slug>` by default. Jaroku never writes to `main` — see §3.1 — and this column
  -- is what that promise is enforced against.
  branch                 text NOT NULL,
  subdirectory           text,
  -- §2.2's checkbox: whether the Dockerfile and pyproject the deploy layer already synthesises are
  -- pushed too, so the repo is deploy-ready rather than source-only.
  include_artifacts      boolean NOT NULL DEFAULT true,
  last_pushed_version_id uuid REFERENCES agent_versions(id) ON DELETE SET NULL,
  last_pushed_sha        text,
  last_known_remote_sha  text,
  last_synced_at         timestamptz,
  created_by             uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at             timestamptz NOT NULL DEFAULT now(),
  -- SOFT, and §6 states the rule it enforces: an agent deleted in Jaroku soft-deletes its link and
  -- touches nothing in the user's repo. Jaroku never deletes somebody's repository, ever.
  deleted_at             timestamptz,
  FOREIGN KEY (workspace_id, agent_id) REFERENCES agents (workspace_id, id) ON DELETE CASCADE
);

-- One live link per agent. Partial for the same reason the installation index is: unlinking and
-- relinking is an ordinary thing to do, and the tombstone must not stand in the way of it.
CREATE UNIQUE INDEX github_links_live ON github_links (workspace_id, agent_id) WHERE deleted_at IS NULL;

-- The sidebar's Synced filter (§4) reads every live link in one query. workspace_id leads, per the
-- tenancy rule: a trailing tenant column makes the planner scan an index built for another question.
CREATE INDEX github_links_ws ON github_links (workspace_id, deleted_at, agent_id);

-- --- the history ------------------------------------------------------------------------------
--
-- APPEND-ONLY, AND THAT IS A PROPERTY RATHER THAN A CONVENTION: there is no UPDATE path to this
-- table in the repository, because the one row anybody would ever want to change is the one
-- recording an override they now regret.
--
-- `outcome` CARRIES 'refused' AS A FIRST-CLASS VALUE. A pull that validation refused is the most
-- informative row this table holds — it is the moment Jaroku's own bar was applied to somebody
-- else's code — and dropping it because "nothing happened" would erase exactly the evidence §3.6
-- exists to produce.
CREATE TABLE github_events (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  agent_id     uuid,
  link_id      uuid REFERENCES github_links(id) ON DELETE SET NULL,
  kind         text NOT NULL,
  outcome      text NOT NULL DEFAULT 'ok',
  actor_user_id uuid REFERENCES users(id) ON DELETE SET NULL,
  -- The versions this event moved, newest first. A list rather than a single id because a push
  -- carries several and a squashed push collapses them into one commit — the fact that six
  -- versions became one sha is the interesting half and is not recoverable from a single id.
  version_ids  json NOT NULL DEFAULT '[]'::json,
  commit_sha   text,
  -- What went wrong, in the words the user was shown. Never a stack trace and never a token: this
  -- is read back into a UI and into `audit_log`.
  detail       text,
  created_at   timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (workspace_id, agent_id) REFERENCES agents (workspace_id, id) ON DELETE CASCADE
);

ALTER TABLE github_events
  ADD CONSTRAINT github_events_kind_check
  CHECK (kind IN ('link', 'unlink', 'push', 'fetch', 'pull', 'pr_open', 'force_override', 'branch_switch'));

ALTER TABLE github_events
  ADD CONSTRAINT github_events_outcome_check CHECK (outcome IN ('ok', 'refused', 'failed'));

-- Newest first, per agent: every read of this table is "the last few things that happened to this
-- agent", which an ascending index answers by scanning to the end.
CREATE INDEX github_events_agent ON github_events (workspace_id, agent_id, created_at DESC);

-- --- the backstop -----------------------------------------------------------------------------
--
-- ENABLE + FORCE + policy, the same three every tenant table carries. FORCE is the one that
-- matters: ENABLE alone exempts the table owner, and on a small deployment the owner is the app.
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['github_installations', 'github_links', 'github_events']
  LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE  ROW LEVEL SECURITY', t);
    EXECUTE format('DROP POLICY IF EXISTS tenant_isolation ON %I', t);
    EXECUTE format($f$
      CREATE POLICY tenant_isolation ON %I
        USING      (workspace_id = NULLIF(current_setting('app.workspace_id', true), '')::uuid)
        WITH CHECK (workspace_id = NULLIF(current_setting('app.workspace_id', true), '')::uuid)
    $f$, t);
  END LOOP;
END
$$;

-- Explicit, for the reason 015 and 033 were explicit: a migration run by a different role than the
-- one that ran 009 is not covered by that migration's default privileges, and the symptom is a
-- permission error on somebody's first link rather than at deploy time.
GRANT SELECT, INSERT, UPDATE, DELETE
  ON github_installations, github_links, github_events
  TO jaroku_app;
