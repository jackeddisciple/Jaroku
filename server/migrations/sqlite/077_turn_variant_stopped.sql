-- 077_turn_variant_stopped — the SQLite half. Read the Postgres file for every decision: why the
-- column exists, why being stopped is a fact about the answer while being interrupted is a fact
-- about the connection, why there is no backfill, and why there is no index.
--
-- `boolean NOT NULL DEFAULT false` BECOMES `INTEGER NOT NULL DEFAULT 0`, this driver's translation
-- of a boolean throughout this schema — and the reason `test:boolean-literals` exists: a literal 0
-- is not a `false` on the other driver, so whatever WRITES this column goes through the
-- repository's own coercion rather than embedding either spelling.
--
-- `ADD COLUMN` IN PLACE, like 073 and 074: a defaulted column with no CHECK is the one schema
-- change SQLite makes without rewriting the table, so the indexes, the unique constraint and the
-- foreign key are all untouched.

ALTER TABLE turn_variants ADD COLUMN stopped INTEGER NOT NULL DEFAULT 0;
