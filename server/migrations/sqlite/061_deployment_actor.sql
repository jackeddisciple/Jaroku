-- 061_deployment_actor — the SQLite half. Read the Postgres file for why this column exists at all:
-- §13 asks who deployed an agent, `deployments` has never recorded a person, and there is no audit
-- row anywhere to reconstruct one from.
--
-- `ALTER TABLE ... ADD COLUMN` WITHOUT A REBUILD, which is the one thing this driver will do to a
-- table in place — and it will do it with a REFERENCES clause exactly as long as the new column
-- defaults to NULL, which this one does because it is never backfilled. So the idiom migrations
-- 006, 018 and 059 need here does not apply, and `deployment_logs` keeps pointing at rows that were
-- never dropped.

ALTER TABLE deployments ADD COLUMN created_by TEXT REFERENCES users(id);
