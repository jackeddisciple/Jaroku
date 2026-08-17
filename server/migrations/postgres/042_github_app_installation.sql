-- 042_github_app_installation — the grant stops being a token somebody pasted.
--
-- 034 built `github_installations` around a personal access token: one `token_secret_name`, a name
-- in the SecretStore, and a row that means "this workspace holds a credential". A GitHub App
-- installation is a different shape in three ways, and each one is a column here.
--
-- IT HAS AN IDENTITY OF ITS OWN. An installation has a numeric id on GitHub's side, and that id —
-- not a token — is what a repository call starts from: mint an access token FOR installation N,
-- use it for an hour, throw it away. So the durable thing to store is the id, and the token stops
-- being stored at all. That is the security half of this migration: after it, a database dump of
-- `github_installations` contains no credential and no pointer to one for the App path.
--
-- IT NEEDS A SECOND TOKEN FOR THREE CALLS. An installation token can do anything to a REPOSITORY
-- and nothing about a USER — `GET /user`, `GET /user/repos` and `POST /user/repos` all refuse it,
-- and the last of those is §2.2's "Create new repo". So the App also asks for user authorization at
-- install time, and the resulting user-to-server token lives in the SecretStore like any other
-- credential, with its expiry beside it because unlike a PAT it has one.
--
-- `token_secret_name` STAYS AND STAYS NOT NULL. The PAT path is not deleted — it is the answer for
-- GitHub Enterprise Server and for a self-hosted deployment with no callback URL, and 034's column
-- is what it uses. An App row writes the sentinel below rather than a secret name, which is a
-- readable statement in a `psql` session rather than a null somebody has to interpret.
--
-- WHY NO `github_apps` TABLE. The App's own credentials — id, slug, client secret, private key —
-- belong to the DEPLOYMENT and are identical for every workspace on it, so they live in
-- `runtime/.env` beside the Anthropic key and the Stripe secret. A table would mean storing one
-- deployment-wide private key once per tenant and answering "whose is it" with a lie.

ALTER TABLE github_installations
  ADD COLUMN github_installation_id text,
  ADD COLUMN user_token_secret_name text,
  ADD COLUMN user_token_expires_at   timestamptz,
  ADD COLUMN user_refresh_secret_name text;

COMMENT ON COLUMN github_installations.github_installation_id IS
  'GitHub''s own id for the installation. NULL on a personal-access-token row, which is how the two paths are told apart at read time.';

COMMENT ON COLUMN github_installations.user_token_expires_at IS
  'When the user-to-server token dies. NULL means it does not expire — an App setting, not our choice — and never means "unknown".';

-- Two live grants for one account in one workspace was already impossible (034's partial unique
-- index). This says the same thing about the installation id, so a webhook or a repeated install
-- callback cannot produce a second row for one installation while the first is still live.
CREATE UNIQUE INDEX github_installations_live_app
  ON github_installations (workspace_id, github_installation_id)
  WHERE revoked_at IS NULL AND github_installation_id IS NOT NULL;
