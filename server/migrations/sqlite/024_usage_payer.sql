-- 024_usage_payer — the SQLite half. Read the Postgres file for why the payer is recorded
-- rather than inferred from the kind, and why the default is a description rather than a guess.
--
-- Same translation as every migration before it: text -> TEXT, and the partial index expressed
-- the same way (SQLite has had partial indexes since 3.8).
ALTER TABLE usage_events ADD COLUMN payer TEXT NOT NULL DEFAULT 'platform';

CREATE INDEX usage_events_platform_paid ON usage_events (workspace_id, occurred_at DESC)
  WHERE payer = 'platform';
