-- 064_work_items_rls — the second wall under 063, and the privilege that lets the app reach it.
--
-- ITS OWN MIGRATION RATHER THAN THE LAST STANZA OF 063, which is worth being exact about because
-- the specification cites a precedent that is not quite what the repository did: 053 did not add
-- RLS for 052, and every other tenant table in this schema — `inbox_items`, `agent_grants`,
-- `conversation_settings` — carries its policy in the migration that creates it. So this is a
-- deliberate departure from the house pattern, and it needs its own reason rather than a citation.
--
-- The reason is that the split is FAIL-CLOSED, and the seam is visible. Between 063 and this file
-- `work_items` exists and `jaroku_app` has no privilege on it at all: the GRANT is here, beside the
-- policy it depends on, so a half-applied pair produces a table the application cannot read rather
-- than one it can read across tenants. The other order — table and GRANT in 063, policy here —
-- would open exactly the window RLS exists to close, and it is the order somebody splitting for
-- tidiness would reach for. Both files are applied by one `migrate()` run in any case; what the
-- split buys is that the policy and the privilege can be reviewed, and tested as the application
-- role, as one thing.
--
-- USING AND WITH CHECK, BOTH, and not because symmetry is pretty. USING alone lets a caller INSERT
-- a row naming another workspace and merely not read it back — a write across the boundary that
-- leaves a job attributed to a tenant who never asked for it, running on a deployment they own.
-- `test:rls` has a case for exactly that shape on `runs`, and this table is a sharper version of
-- it: a row here does not just describe work, it is what the dispatcher reads to decide whether a
-- run may be cancelled or retried.
--
-- `NULLIF(current_setting('app.workspace_id', true), '')::uuid` IS THE FORM EVERY POLICY HERE USES,
-- and the `true` is the load-bearing character: without it an unscoped query RAISES instead of
-- returning nothing, and a raise in a background sweep is a stack trace somebody silences. With
-- it the setting is NULL, `workspace_id = NULL` is NULL, and a policy that is not true admits no
-- row — so an unscoped read sees nothing rather than everything.

ALTER TABLE work_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE work_items FORCE  ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON work_items;
CREATE POLICY tenant_isolation ON work_items
  USING      (workspace_id = NULLIF(current_setting('app.workspace_id', true), '')::uuid)
  WITH CHECK (workspace_id = NULLIF(current_setting('app.workspace_id', true), '')::uuid);

-- DELETE is granted, and it is the one verb here that looks unnecessary. Nothing in the Cockpit
-- deletes a work item — the tab has no destructive verb at all — but the retention sweep does, on
-- `ended_at` past the plan's window, and it runs as the application role like everything else.
GRANT SELECT, INSERT, UPDATE, DELETE ON work_items TO jaroku_app;
