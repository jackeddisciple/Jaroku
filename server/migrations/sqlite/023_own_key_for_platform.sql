-- 023_own_key_for_platform — the SQLite half. Read the Postgres file for why the default is
-- false and why the flag lives on the balance row.
--
-- Same translation as every migration before it: boolean -> INTEGER 0/1.
ALTER TABLE workspace_balances
  ADD COLUMN own_key_for_platform INTEGER NOT NULL DEFAULT 0;
