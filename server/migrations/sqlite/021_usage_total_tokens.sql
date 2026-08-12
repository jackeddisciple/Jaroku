-- 021_usage_total_tokens — the SQLite half. Read the Postgres file for why a split-only usage
-- table cannot record an agent run's tokens at all.
--
-- Same translation as every migration before it: bigint -> INTEGER.
ALTER TABLE usage_events ADD COLUMN total_tokens INTEGER;
