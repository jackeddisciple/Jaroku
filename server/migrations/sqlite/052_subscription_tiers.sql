-- 052_subscription_tiers — the SQLite half. Read the Postgres file for why the top tier's id
-- moves rather than its label, why the rename's three statements are in the order they are, why
-- a metered dimension is a row rather than a column, and why `metric` deliberately carries no
-- CHECK constraint despite the specification's DDL showing one.
--
-- Same translation as every migration on this driver: uuid -> TEXT, timestamptz -> TEXT
-- ISO-8601, numeric -> REAL, boolean -> INTEGER. Ids that Postgres defaults with
-- `gen_random_uuid()` are supplied by the store here, and so are the timestamps.
--
-- REAL RATHER THAN numeric FOR `count`, and 020's argument carries over unchanged: every figure
-- is rounded to eight decimal places by `round8` before it is written, eight places of USD is
-- orders of magnitude below any real step cost, and the driver that actually bills anybody is
-- Postgres. The two dimensions that count events rather than money are whole numbers well inside
-- what a double represents exactly.
--
-- No RLS here and there never will be; the repository layer's WHERE is the whole of the
-- enforcement on this driver, which is why every usage-period method takes a context first.

CREATE TABLE workspace_usage_periods (
  id           TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  period_start TEXT NOT NULL,
  period_end   TEXT NOT NULL,
  metric       TEXT NOT NULL,
  count        REAL NOT NULL DEFAULT 0,
  UNIQUE (workspace_id, period_start, metric)
);

-- --- what a subscription has to carry that it did not ------------------------------------------

ALTER TABLE subscriptions ADD COLUMN seat_count INTEGER NOT NULL DEFAULT 1;
ALTER TABLE subscriptions ADD COLUMN byok_enabled INTEGER NOT NULL DEFAULT 0;
ALTER TABLE subscriptions ADD COLUMN current_period_start TEXT;

-- --- scale becomes team --------------------------------------------------------------------
--
-- `created_at` is written explicitly because SQLite has no now() default this schema uses
-- anywhere else, and the epoch is what 020 wrote for the same three rows.

INSERT INTO plans (id, display_name, purchasable, created_at) VALUES
  ('team', 'Team', 1, '1970-01-01T00:00:00.000Z')
ON CONFLICT (id) DO NOTHING;

UPDATE subscriptions SET plan_id = 'team' WHERE plan_id = 'scale';
UPDATE workspaces    SET plan    = 'team' WHERE plan    = 'scale';

DELETE FROM plans WHERE id = 'scale';
