-- 088_agent_run_defaults — what an agent runs on by default, and its run of record.
--
-- WHAT FOR. "Apply" on a branch (the trace panel's feature list, 2026-10-14 — "Apply to the agent, or
-- promote this branch to the main version") does two things, the product owner's call that day: the
-- agent adopts the branch's model, temperature and seed as its own defaults, and the branch becomes
-- its run of record — the run that stands for how the agent behaves now.
--
-- `default_model`, NOT `default_provider`. The provider column is the manifest's and the disk sync
-- rewrites it; the model names its provider through the price sheet, so one column says both and
-- nothing that syncs from disk can undo an Apply.
--
-- `record_run_id` IS AN ID WITHOUT A FOREIGN KEY: a run of record swept by retention leaves the
-- agent pointing at nothing, which reads as "no run of record" rather than blocking the sweep.
--
-- Nullable without defaults — an expand step, and null is "never applied" for every agent.

ALTER TABLE agents ADD COLUMN default_model text;
ALTER TABLE agents ADD COLUMN default_temperature double precision;
ALTER TABLE agents ADD COLUMN default_seed bigint;
ALTER TABLE agents ADD COLUMN record_run_id text;
