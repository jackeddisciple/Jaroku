-- 078_turn_variant_route — the SQLite half. Read the Postgres file for every decision: why the
-- column exists, why it lives on the variant rather than the turn, why it is written at `begin`,
-- why there is deliberately no CHECK, and why there is no backfill.
--
-- `ADD COLUMN` IN PLACE, like 073, 074 and 077: a nullable column with no CHECK and no default is
-- the cheapest schema change this driver makes, so the indexes, the unique constraint and the
-- foreign key are all untouched.

ALTER TABLE turn_variants ADD COLUMN route text;
