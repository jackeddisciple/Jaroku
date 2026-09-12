-- 074_turn_variant_selected — the SQLite half. Read the Postgres file for every decision: why the
-- column exists at all, why it is a flag on the variant rather than a pointer on the turn, why
-- there is deliberately no unique index, and why there is no backfill.
--
-- `boolean NOT NULL DEFAULT false` BECOMES `INTEGER NOT NULL DEFAULT 0`, which is this driver's
-- translation of a boolean everywhere in this schema — and the reason `test:boolean-literals`
-- exists: a literal 0 is not a `false` on the other driver, so the SQL that WRITES this column has
-- to go through the repository's own coercion rather than embedding either spelling.
--
-- `ADD COLUMN` IN PLACE, like 073 and unlike 072: a defaulted column with no CHECK is the one
-- schema change SQLite makes without rewriting the table, so the indexes, the unique constraint
-- and the foreign key are all untouched.

ALTER TABLE turn_variants ADD COLUMN selected INTEGER NOT NULL DEFAULT 0;

CREATE INDEX turn_variants_selected ON turn_variants (workspace_id, turn_id, selected);
