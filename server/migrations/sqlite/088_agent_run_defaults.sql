-- 088_agent_run_defaults — what an agent runs on by default, and its run of record.
--
-- The Postgres migration of the same number says why. Null is "never applied".

ALTER TABLE agents ADD COLUMN default_model TEXT;
ALTER TABLE agents ADD COLUMN default_temperature REAL;
ALTER TABLE agents ADD COLUMN default_seed INTEGER;
ALTER TABLE agents ADD COLUMN record_run_id TEXT;
