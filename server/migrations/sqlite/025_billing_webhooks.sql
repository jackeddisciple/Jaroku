-- 025_billing_webhooks — the SQLite half. Read the Postgres file for why this is a separate
-- table from `usage_events.idempotency_key` and why it carries no policy.
--
-- Same translation as every migration before it: uuid -> TEXT, timestamptz -> TEXT ISO-8601.
CREATE TABLE billing_webhook_events (
  id           TEXT PRIMARY KEY,
  type         TEXT NOT NULL,
  workspace_id TEXT,
  received_at  TEXT NOT NULL,
  processed_at TEXT,
  outcome      TEXT
);

CREATE INDEX billing_webhook_events_unprocessed ON billing_webhook_events (received_at)
  WHERE processed_at IS NULL;
