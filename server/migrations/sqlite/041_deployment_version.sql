-- 041_deployment_version — the SQLite half. Read the Postgres file for why the column was missing
-- until §B.8.2's canvas needed it, why it is nullable rather than backfilled, and why it is an
-- integer rather than a foreign key.
--
-- ONE DIALECT DIFFERENCE: there is no `COMMENT ON COLUMN` here, so the sentence that rides on the
-- column in Postgres lives only in that file and in this one. That is the ordinary asymmetry —
-- 009's note applies, and the column itself is identical.
--
-- `ALTER TABLE ... ADD COLUMN` with no default and no NOT NULL is the one shape SQLite performs
-- without rewriting the table, which matters on a table a running deploy is writing to.

ALTER TABLE deployments ADD COLUMN version INTEGER;
