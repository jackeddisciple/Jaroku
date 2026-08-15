-- 035_github_webhook_scope — the one read the GitHub webhook cannot do as a tenant.
--
-- WHY A POLICY AT ALL. Every other read of `github_links` happens on somebody's behalf: a socket
-- resolves its workspace, the repository takes a `TenantContext`, and the WHERE carries
-- `workspace_id` because on SQLite that clause IS the tenancy boundary. A webhook has none of
-- that. GitHub POSTs a repository full name to a public URL with no session, no socket and no
-- tenant, and the server's first question is precisely the one no tenant can ask: WHICH
-- workspaces have linked this repository?
--
-- So the lookup crosses workspaces, and 032 set the rule for that case out loud — "anything else
-- that wants to cross workspaces gets a policy of its own, in a migration somebody reviews". This
-- is that migration.
--
-- SELECT ONLY, AND ONLY THIS TABLE. The handler's job is to find the links and then act on each
-- one AS ITS OWN WORKSPACE — every write that follows goes back through `forWorkspace`, so the
-- watermark update and the event row are ordinary tenant-scoped statements. Granting the platform
-- marker anything more than a read here would let a forged delivery reach further than the fact
-- it is allowed to establish, which is only ever "this repository moved".
--
-- WHAT THE POLICY DOES NOT DECIDE is whether the delivery was genuine. That is the HMAC in
-- `githubWebhook.ts`, checked over the raw bytes before this table is touched at all. This policy
-- is about what an already-authenticated platform read may see; the signature is about whether
-- there is anything to read for.

DROP POLICY IF EXISTS platform_read ON github_links;
CREATE POLICY platform_read ON github_links
  FOR SELECT
  USING (current_setting('app.platform', true) = 'on');
