-- 009_rls — the backstop.
--
-- The repository layer is the enforcement: every method takes a TenantContext and every
-- statement filters on it. This is what catches the day somebody writes a query that does
-- not. It is a second wall, not the first one, and it is worth having precisely because the
-- first one is made of code that people edit.
--
-- ENABLE plus FORCE, and FORCE is the one that matters. ENABLE alone exempts the table's
-- OWNER from its own policies, and the owner is whoever ran the migrations — so on a small
-- deployment where the app and the migrator are the same role, ENABLE-only RLS is a policy
-- that never once applies. FORCE removes the exemption.
--
-- THE POLICY READS A SETTING, NOT A ROLE. `current_setting('app.workspace_id', true)` is set
-- by the repository's transaction wrapper with SET LOCAL, which is transaction-scoped — so it
-- cannot leak to the next user of a pooled connection, which is exactly the failure a
-- session-scoped SET would produce under PgBouncer.
--
-- AND A MISSING SETTING MATCHES NOTHING. current_setting(..., true) returns NULL when unset,
-- NULL = anything is NULL, and a policy that is not true does not admit the row. So a query
-- that reaches these tables with no scope established sees an empty table rather than
-- everything. Fail closed, and that is the entire point.
--
-- The NULLIF is not decoration, and the test is what found it. A custom GUC that has ever
-- been set on a connection keeps EXISTING on that connection afterwards, holding the empty
-- string rather than being unset — so on a POOLED connection, `current_setting(..., true)`
-- returns '' rather than NULL for the second, unscoped user of that connection. Without the
-- NULLIF, ''::uuid raises 22P02 and the query fails with a cast error instead of returning
-- nothing. Failing closed is right; failing closed QUIETLY, the same way on the first and
-- fiftieth use of a connection, is what makes the behaviour predictable.
--
-- TWO TABLES ARE DELIBERATELY NOT HERE, and both for the same reason: a policy on them would
-- break the thing that makes every other policy work.
--
--   audit_log — its most important row is a DENIED cross-tenant attempt, whose workspace_id
--   may name a workspace that does not exist, or none at all. A policy would refuse to write
--   exactly the record the table exists for. It is append-only and its reads go through a
--   repository method that scopes them.
--
--   workspace_members — this is the table that ANSWERS "which workspace may this request act
--   in". A policy reading app.workspace_id could only be satisfied by already knowing the
--   answer, and "which workspaces does this user belong to" — the query behind every
--   workspace switcher — is scoped by user_id across all of them by definition. Scoping it by
--   workspace would return nothing, every time. The repository scopes it correctly instead:
--   by workspace when checking one membership, by user when listing them.

-- --- a role that cannot ignore the policies -------------------------------------------------
--
-- Created here so a deployment cannot forget. The app connects as this role; migrations run
-- as the owner. NOLOGIN and no password: a real deployment GRANTs it to whichever login role
-- its connection string uses, which keeps the credential out of this file and out of git.
--
-- IT MUST NOT BE A SUPERUSER AND MUST NOT HAVE BYPASSRLS. A superuser ignores every policy
-- unconditionally — forced or not — so an app that connects as one has no second wall at all,
-- and nothing about the schema would tell you. The role created here has neither, and
-- test:rls asserts both, because the failure is invisible from inside the application.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'jaroku_app') THEN
    CREATE ROLE jaroku_app NOLOGIN;
  END IF;
END
$$;

GRANT USAGE ON SCHEMA public TO jaroku_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO jaroku_app;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO jaroku_app;
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO jaroku_app;
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT USAGE, SELECT ON SEQUENCES TO jaroku_app;

-- --- policies -------------------------------------------------------------------------------
--
-- USING governs what a statement can SEE; WITH CHECK governs what it may WRITE. Both, on
-- every table: without WITH CHECK a caller could insert a row into another workspace and
-- simply not be able to read it back, which is a write across the boundary and still a hole.

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'runs', 'steps',
    'datasets', 'dataset_examples', 'rubrics', 'eval_runs', 'eval_jobs', 'eval_scores',
    'mcp_servers', 'mcp_tools',
    'deployments', 'deployment_logs',
    'agents'
  ]
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

-- agent_versions has no workspace_id of its own — it hangs off agents, which has one. The
-- policy follows the parent rather than duplicating the column, so a version can never
-- outlive or out-scope the agent it belongs to.
ALTER TABLE agent_versions ENABLE ROW LEVEL SECURITY;
ALTER TABLE agent_versions FORCE  ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON agent_versions;
CREATE POLICY tenant_isolation ON agent_versions
  USING (EXISTS (
    SELECT 1 FROM agents a
     WHERE a.id = agent_versions.agent_id
       AND a.workspace_id = NULLIF(current_setting('app.workspace_id', true), '')::uuid))
  WITH CHECK (EXISTS (
    SELECT 1 FROM agents a
     WHERE a.id = agent_versions.agent_id
       AND a.workspace_id = NULLIF(current_setting('app.workspace_id', true), '')::uuid));
