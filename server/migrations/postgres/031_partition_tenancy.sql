-- 031_partition_tenancy — the backstop, extended to the tables the backstop forgot.
--
-- WHAT test:rls FOUND, the first time it was ever run against a migrated database:
--
--   FAIL no partition of steps is readable by the app role without a policy
--        (steps_default, steps_2026_08, steps_2026_09, steps_2026_10)
--
-- `jaroku_app` could SELECT, INSERT, UPDATE and DELETE every row of every tenant's trace by
-- naming a partition instead of the table. `SELECT * FROM steps_2026_08` — no policy, no scope,
-- no error. It is the exact failure 029's header says partitioning must not cause, guarded there
-- by a mechanism that does not reach this far.
--
-- HOW BOTH HALVES CAME LOOSE AT ONCE. 029 enables and forces row-level security on `steps` and
-- declares `tenant_isolation` on it, and says the policy is "inherited by every partition". It is
-- inherited by every partition OF A QUERY THAT GOES THROUGH THE PARENT — which is every query
-- this codebase writes, so the claim held for the code and not for the table. A query naming a
-- partition sees that partition's own RLS settings, and `CREATE TABLE … PARTITION OF` sets none.
--
-- The privilege half is 009, and it is the more dangerous of the two because it is automatic:
--
--   ALTER DEFAULT PRIVILEGES IN SCHEMA public
--     GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO jaroku_app;
--
-- Every table created in `public` from then on, by anyone, for any reason. Partitions are tables.
-- 029 created four and `lifecycle/partitions.ts` creates another every month at runtime, at boot,
-- unreviewed, forever — each one arriving fully granted and completely unpoliced. The hole was
-- not opened by a mistake in either file; it was opened by two correct files meeting.
--
-- --- what this migration does, and why it is two mechanisms rather than one -------------------
--
-- REVOKE, because no partition should ever be named by the application at all. Reads and writes
-- go through `steps`; privileges on a declaratively partitioned parent are what Postgres checks
-- for a query routed through it, so revoking on the partitions costs the app nothing. That is a
-- load-bearing claim about Postgres rather than about this schema, so test:rls now proves both
-- directions: that the app role can still read its own workspace through the parent, and that it
-- cannot reach another workspace by naming a partition.
--
-- AND A POLICY, because a REVOKE is one `GRANT ON ALL TABLES IN SCHEMA public` away from being
-- undone, and that statement is in 009 and will be in whatever provisions the next environment.
-- With the policy in place, re-granting restores access to the tenant's own rows rather than to
-- everybody's — the difference between a mistake and an incident.
--
-- ENABLE WITHOUT FORCE, DELIBERATELY, AND THIS FILE IS WHERE THAT IS ARGUED. FORCE makes the
-- OWNER subject to the policy too, and on this system the owner is the server: `index.ts` runs
-- the migrations and then calls `ensurePartitions`, so the process serving traffic is the one
-- holding DDL rights. Forcing here would bind it — and the first thing it would break is
-- `describePartitions`, whose `SELECT COUNT(*) FROM steps_default` is the source of
-- `steps_default_partition_rows`, a counter whose expected value is zero and whose alert fires
-- on anything else. It would have kept reporting zero, correctly shaped and permanently wrong,
-- which is worse than the hole this migration closes. The owner is not the surface being
-- defended against; `jaroku_app` is, and it is now denied twice.
--
-- Applied to the partitions that exist. The ones that do not exist yet are `partitions.ts`'s
-- problem and it does the same three statements in the same transaction as the CREATE, so no
-- window exists in which a new month is granted and unpoliced.

DO $$
DECLARE
  part text;
BEGIN
  FOR part IN
    SELECT c.relname
      FROM pg_inherits i
      JOIN pg_class c ON c.oid = i.inhrelid
      JOIN pg_class p ON p.oid = i.inhparent
     WHERE p.relname = 'steps'
  LOOP
    EXECUTE format('REVOKE ALL ON TABLE %I FROM jaroku_app', part);
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', part);
    EXECUTE format('DROP POLICY IF EXISTS tenant_isolation ON %I', part);
    EXECUTE format(
      'CREATE POLICY tenant_isolation ON %I '
      || 'USING      (workspace_id = NULLIF(current_setting(''app.workspace_id'', true), '''')::uuid) '
      || 'WITH CHECK (workspace_id = NULLIF(current_setting(''app.workspace_id'', true), '''')::uuid)',
      part
    );
  END LOOP;
END
$$;
