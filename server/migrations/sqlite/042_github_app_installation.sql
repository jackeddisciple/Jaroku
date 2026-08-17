-- 042_github_app_installation — the SQLite half. Read the Postgres file for why an installation is
-- an id rather than a token, why a second token exists for exactly three calls, why
-- `token_secret_name` stays, and why the App's own private key is not in any table.
--
-- Same translation as every migration on this driver: uuid -> TEXT, timestamptz -> TEXT ISO-8601.
--
-- ONE DIALECT DIFFERENCE. SQLite's `ALTER TABLE` adds one column per statement, so what is a single
-- statement on Postgres is four here. The migration runner runs a file in one transaction on both
-- drivers, so this is a spelling difference and not a difference in what happens.

ALTER TABLE github_installations ADD COLUMN github_installation_id TEXT;
ALTER TABLE github_installations ADD COLUMN user_token_secret_name TEXT;
ALTER TABLE github_installations ADD COLUMN user_token_expires_at TEXT;
ALTER TABLE github_installations ADD COLUMN user_refresh_secret_name TEXT;

CREATE UNIQUE INDEX github_installations_live_app
  ON github_installations (workspace_id, github_installation_id)
  WHERE revoked_at IS NULL AND github_installation_id IS NOT NULL;
