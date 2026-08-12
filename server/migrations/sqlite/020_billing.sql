-- 020_billing — the SQLite half. Read the Postgres file for what each table is for, why the
-- holds table exists at all, and why the plan LIMITS are not in the `plans` table.
--
-- Same translation as every migration before it: uuid -> TEXT, timestamptz -> TEXT ISO-8601,
-- numeric -> REAL, jsonb -> TEXT, bigserial -> INTEGER PRIMARY KEY AUTOINCREMENT. There is no
-- RLS here and there never will be; on this driver the repository layer is the whole of the
-- enforcement.
--
-- REAL RATHER THAN numeric, AND WHY THAT IS ACCEPTABLE HERE. Postgres `numeric` is exact and a
-- REAL is not, which is normally the wrong trade for money. It is the same trade `runs.cost`
-- and `eval_jobs.spent_usd` already made, and it holds for the same reason: every figure is
-- rounded to eight decimal places by `round8` before it is written, and eight places of USD is
-- orders of magnitude below any real step cost, so per-row error cannot accumulate into a
-- visible one. The driver that actually bills anybody is Postgres.

CREATE TABLE plans (
  id                TEXT PRIMARY KEY,
  display_name      TEXT NOT NULL,
  external_price_id TEXT,
  purchasable       INTEGER NOT NULL DEFAULT 0,
  created_at        TEXT NOT NULL
);

CREATE TABLE workspace_balances (
  workspace_id    TEXT PRIMARY KEY REFERENCES workspaces(id) ON DELETE CASCADE,
  balance_usd     REAL NOT NULL DEFAULT 0,
  reserved_usd    REAL NOT NULL DEFAULT 0,
  ceiling_usd     REAL,
  limit_overrides TEXT NOT NULL DEFAULT '{}',
  updated_at      TEXT NOT NULL,
  CONSTRAINT workspace_balances_nonneg CHECK (balance_usd >= 0 AND reserved_usd >= 0)
);

CREATE TABLE usage_events (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  workspace_id  TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  run_id        TEXT,
  kind          TEXT NOT NULL,
  provider      TEXT,
  model         TEXT,
  input_tokens  INTEGER,
  output_tokens INTEGER,
  cached_input_tokens INTEGER,
  cost_usd      REAL,
  cost_known    INTEGER NOT NULL,
  occurred_at   TEXT NOT NULL,
  idempotency_key TEXT NOT NULL UNIQUE
);

CREATE INDEX usage_events_ws_occurred ON usage_events (workspace_id, occurred_at DESC);
CREATE INDEX usage_events_ws_run ON usage_events (workspace_id, run_id);

CREATE TABLE billing_holds (
  id           TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  amount_usd   REAL NOT NULL CHECK (amount_usd >= 0),
  purpose      TEXT NOT NULL,
  subject_id   TEXT,
  created_at   TEXT NOT NULL,
  expires_at   TEXT NOT NULL,
  released_at  TEXT
);

CREATE INDEX billing_holds_live ON billing_holds (workspace_id, expires_at)
  WHERE released_at IS NULL;

CREATE TABLE subscriptions (
  id                   TEXT PRIMARY KEY,
  workspace_id         TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  plan_id              TEXT NOT NULL REFERENCES plans(id),
  status               TEXT NOT NULL,
  external_customer_id     TEXT,
  external_subscription_id TEXT UNIQUE,
  current_period_end   TEXT,
  cancel_at_period_end INTEGER NOT NULL DEFAULT 0,
  created_at           TEXT NOT NULL,
  updated_at           TEXT NOT NULL
);

CREATE UNIQUE INDEX subscriptions_one_live_per_workspace
  ON subscriptions (workspace_id) WHERE status IN ('incomplete', 'active', 'past_due');

-- The same three plans, with the same absence of numbers. `created_at` is written explicitly
-- because SQLite has no now() default this schema uses anywhere else.
INSERT INTO plans (id, display_name, purchasable, created_at) VALUES
  ('free',  'Free',  0, '1970-01-01T00:00:00.000Z'),
  ('pro',   'Pro',   1, '1970-01-01T00:00:00.000Z'),
  ('scale', 'Scale', 1, '1970-01-01T00:00:00.000Z')
ON CONFLICT (id) DO NOTHING;
