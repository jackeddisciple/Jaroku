-- 087_run_sampling — the temperature and seed a run was started with, when it was given one.
--
-- The Postgres migration of the same number says why. Null is the provider's own default.

ALTER TABLE runs ADD COLUMN temperature REAL;
ALTER TABLE runs ADD COLUMN seed INTEGER;
