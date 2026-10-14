-- 087_run_sampling — the temperature and seed a run was started with, when it was given one.
--
-- WHAT FOR. "Re-run from here" can now change what the branch runs on — another model, a temperature,
-- a seed (the trace panel's feature list, 2026-10-14) — and "Apply" adopts a branch's settings as the
-- agent's own. The model was always on the run; these two were nowhere, so a branch run at 0.2 read
-- exactly like one at the provider's default, and there was nothing for Apply to adopt.
--
-- A CONTROL-PLANE COLUMN BESIDE THE FROZEN SCHEMA, like `parent_run_id` and `input`: written by the
-- server when it starts the run, never emitted in an event. Null — the provider's own default — for
-- every run before this and every run not given one. Nullable without a default: an expand step.

ALTER TABLE runs ADD COLUMN temperature double precision;
ALTER TABLE runs ADD COLUMN seed bigint;
