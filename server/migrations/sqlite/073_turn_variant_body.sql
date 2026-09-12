-- 073_turn_variant_body — the SQLite half. Read the Postgres file for every decision: why this
-- reverses migration 044's "no transcript" rule, why it is one column on `turn_variants` rather
-- than a table of its own, why most rows keep it null, and why there is no backfill.
--
-- NO TABLE REWRITE HERE, unlike 072's half. SQLite cannot alter a CHECK and 072 therefore had to
-- write both its tables out again; adding a nullable column with no default is the one schema
-- change this driver does support in place, so `ADD COLUMN` is the whole of it and the indexes,
-- the unique constraint and the foreign key are all untouched.
--
-- Same translation as every migration on this driver: `text` -> TEXT.

ALTER TABLE turn_variants ADD COLUMN body TEXT;
