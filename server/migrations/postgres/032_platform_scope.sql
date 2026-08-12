-- 032_platform_scope — the two statements that are legitimately about every workspace.
--
-- WHAT WAS SILENTLY BROKEN. Two operations are not on any tenant's behalf and were written as
-- bare unscoped statements, which is the honest-looking spelling of "all workspaces" and, under
-- row-level security, means the opposite:
--
--   AbuseSignals.sweep         DELETE FROM abuse_signals WHERE observed_at < …
--   Enforcement.workspacesAt   SELECT workspace_id, level FROM workspace_enforcements WHERE …
--
-- With no `app.workspace_id` set, `tenant_isolation` evaluates false for every row. The DELETE
-- removed nothing and the SELECT returned nothing, both without an error. The sweep is the
-- retention promise on a table 027's own header says must not become "a permanent dossier on
-- everybody who ever hit a rate limit"; the SELECT is the operator's "who is suspended" question
-- and the gauge commit 12 exports from it, which has been reporting an empty list.
--
-- Neither was visible from any test. `withScratchPostgres` connects as the database owner, which
-- in CI is a superuser, and a superuser has no policies at all — so every assertion about these
-- two passed while the production behaviour was the opposite one. 027 hit the same wall and
-- solved its half correctly with `platform_subject_rows`; that policy only reaches rows whose
-- workspace_id IS NULL, which is why it covered the subject-keyed signals and nothing else.
--
-- --- a marker that has to be set, never a scope that is missing ---------------------------------
--
-- The tempting policy is `USING (current_setting('app.workspace_id', true) IS NULL)` — "if you
-- did not name a workspace, you may see them all". It is one line and it is a trapdoor: the
-- single failure this whole design exists to survive is a forgotten scope, and that policy
-- promotes a forgotten scope from "sees nothing" to "sees everything". 009's suite asserts the
-- first of those in its most important case, and this would have quietly repealed it for these
-- two tables.
--
-- So the condition is a marker that has to be set ON PURPOSE, by `Db.asPlatform`, which sets it
-- with SET LOCAL and never sets a workspace alongside it. A statement that forgot its scope
-- still sees nothing. A statement that meant to cross workspaces says so, in a call anybody can
-- grep for.
--
-- ONE COMMAND EACH, AND NOT `FOR ALL`. `FOR ALL` would hand the marker every verb on the table
-- including INSERT, and the platform has no business writing an enforcement or forging a signal
-- for a workspace. `abuse_signals` gets DELETE because the sweep deletes; reading a signal is
-- already covered per-tenant by `tenant_isolation` and per-subject by `platform_subject_rows`.
-- `workspace_enforcements` gets SELECT because the gauge reads. Anything else that wants to
-- cross workspaces gets a policy of its own, in a migration somebody reviews.

-- --- abuse_signals: the retention sweep ---------------------------------------------------------

DROP POLICY IF EXISTS platform_sweep ON abuse_signals;
CREATE POLICY platform_sweep ON abuse_signals
  FOR DELETE
  USING (current_setting('app.platform', true) = 'on');

-- --- workspace_enforcements: who is currently under a rung --------------------------------------

DROP POLICY IF EXISTS platform_read ON workspace_enforcements;
CREATE POLICY platform_read ON workspace_enforcements
  FOR SELECT
  USING (current_setting('app.platform', true) = 'on');
