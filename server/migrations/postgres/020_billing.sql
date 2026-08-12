-- 020_billing — where the money is recorded, and where it is held before it is spent.
--
-- The arithmetic is not new. `runtime/pricing.json` is still the single source of truth, cost
-- is still summed from `steps` and never from `runs.cost`, and an unpriced model still costs
-- NULL rather than zero. What this migration adds is somewhere to write those numbers down
-- per workspace, and somewhere to hold money BEFORE it is spent — because with concurrency,
-- "check the balance, then spend it" is not a check at all.
--
-- FOUR TABLES, PLUS ONE THE SPEC DOES NOT NAME. Taking each in turn:
--
-- `usage_events` — one row per metered thing. The `idempotency_key` is what makes this table
-- safe under the at-least-once ingestion Session 4 built: a trace batch redelivered after a
-- worker died must not bill twice, and the only way to know it is the same event is for the
-- producer to name it deterministically. A unique index is the enforcement; the application
-- inserts ON CONFLICT DO NOTHING and never checks first, because checking first is the same
-- race in a different costume.
--
-- `cost_usd` IS NULLABLE AND `cost_known` IS NOT. That pair is the whole "unknown is not
-- zero" rule expressed in a schema. A NULL cost with `cost_known = false` says we metered
-- real tokens against an unpriced model; a 0 with `cost_known = true` says the model is
-- genuinely free (the dry-run provider is priced, at zero). Collapsing those two into one
-- column means a dashboard cannot tell "free" from "we don't know", which is the exact
-- confusion §Cost accounting exists to prevent — and it is worse here than in the eval
-- dashboard, because here somebody is being asked to pay against it.
--
-- `workspace_balances` — one row per workspace, holding what it has and what is spoken for.
-- `reserved_usd` is the part of `balance_usd` that some run in flight has already claimed.
-- The available figure is `balance - reserved` and it is never stored, because a stored
-- derived number is a number that can disagree with the two it came from.
--
-- `billing_holds` — the table the spec does not name, and the one that makes the reservation
-- releasable. The atomic UPDATE the spec gives increments `reserved`; something has to
-- decrement it by exactly the same amount later, and "exactly the same amount" has to survive
-- the process that took it dying. Session 5 already learned this in the small: a per-workspace
-- interactive reservation taken for a run that never started locked that workspace out for the
-- lease's full hour, because the release lived on the run's exit and there was no run. A hold
-- is therefore a ROW with an amount and an expiry, not a number added to a counter and
-- remembered in a variable — so a sweeper can find the ones nobody released and give the money
-- back. Money is worse than a slot: a leaked slot costs a workspace an hour, a leaked hold
-- costs it the balance.
--
-- `subscriptions` — what a payment provider believes about this workspace, kept separately from
-- `workspaces.plan`, which is what THIS system believes. They are not the same fact and
-- conflating them is how a workspace ends up on a plan it stopped paying for, or off one it is
-- still paying for. `workspaces.plan` is what the limits are read from; a subscription row is
-- the evidence for it, and the state machine that reconciles the two is in code.
--
-- `plans` — a registry, and DELIBERATELY NOT WHERE THE LIMITS LIVE. Concurrency, monthly
-- credits, the budget ceiling, retention and seat limits are in `server/src/billing/plans.ts`
-- for exactly the reason roles are in `auth/capabilities.ts` and job classes are in
-- `queue/jobs.ts`: two copies of the same number drift, and the copy that drifts is always the
-- one in the place nobody reopened. What is here instead is the part that genuinely cannot be
-- in code — which payment-provider price a plan maps to on THIS deployment, and whether it can
-- be subscribed to right now. A price id is configuration; a concurrency limit is a decision.

-- --- the registry ---------------------------------------------------------------------------
--
-- No workspace_id and no policy: this is a list of what the platform sells, the same shape as
-- `workspaces` being the table policies point AT rather than one that carries a policy. Every
-- tenant reads the same rows.
CREATE TABLE plans (
  -- Matches `workspaces.plan`, and matches a key in billing/plans.ts. A row here with no
  -- definition there is refused at boot rather than silently granting a workspace nothing.
  id                text PRIMARY KEY,
  display_name      text NOT NULL,
  -- The payment provider's price object, or NULL for a plan nobody can buy (`free`, and any
  -- plan negotiated by hand). Configuration, not a decision — hence a column.
  external_price_id text,
  -- Whether checkout may be started for it today. A plan being withdrawn stays here so the
  -- workspaces already on it keep resolving; it just stops being purchasable.
  purchasable       boolean NOT NULL DEFAULT false,
  created_at        timestamptz NOT NULL DEFAULT now()
);

-- --- what a workspace has, and what is spoken for --------------------------------------------

CREATE TABLE workspace_balances (
  workspace_id   uuid PRIMARY KEY REFERENCES workspaces(id) ON DELETE CASCADE,
  -- Credit purchased or granted, in USD. Under BYOK this stays 0 forever and nothing checks
  -- it — see billing/plans.ts on why metering and billing are separate concepts here.
  balance_usd    numeric NOT NULL DEFAULT 0,
  -- The part of `balance_usd` some in-flight run has already claimed. Only ever moved
  -- alongside a `billing_holds` row, in one transaction, so the sum of live holds and this
  -- number cannot disagree.
  reserved_usd   numeric NOT NULL DEFAULT 0,
  -- A hard ceiling on spend for this workspace, overriding the plan's. NULL means "whatever
  -- the plan says", which is different from 0 — 0 is a workspace that may start nothing.
  ceiling_usd    numeric,
  -- This workspace's negotiated exceptions to its plan's limits, keyed by the same names
  -- billing/plans.ts uses. Empty for almost everybody. Here rather than in code because it is
  -- per-tenant data; the DEFAULTS it overrides are still code.
  limit_overrides jsonb NOT NULL DEFAULT '{}',
  updated_at     timestamptz NOT NULL DEFAULT now(),
  -- Neither may go negative. The reservation UPDATE already refuses to overdraw, and this is
  -- the backstop for the day something else writes here — the same relationship the RLS
  -- policies have to the repository layer.
  CONSTRAINT workspace_balances_nonneg CHECK (balance_usd >= 0 AND reserved_usd >= 0)
);

-- --- one row per metered thing ---------------------------------------------------------------

CREATE TABLE usage_events (
  id            bigserial PRIMARY KEY,
  workspace_id  uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  -- The run this is attributable to, when there is one. Deliberately NOT a foreign key: a
  -- generation or a plan call has no run, an eval's judge call belongs to a job rather than a
  -- run, and a run's rows can be swept by retention long before its invoice is settled. A
  -- dangling id is a worse outcome here than a missing constraint.
  run_id        text,
  -- What was metered. The set is closed and lives in billing/usage.ts; kept as text rather
  -- than an enum so adding one is a migration nobody has to write.
  --   llm.provider   — an agent's own model calls, from its trace steps
  --   llm.judge      — the eval judge. Eval OVERHEAD, never a provider's agent cost
  --   llm.generation | llm.plan | llm.edit | llm.explain — the platform thinking on a
  --                    workspace's behalf
  --   sandbox.seconds | storage.bytes — what BYOK still bills for
  kind          text NOT NULL,
  provider      text,
  model         text,
  input_tokens  bigint,
  output_tokens bigint,
  cached_input_tokens bigint,
  -- NULL means UNKNOWN. Never 0 for unknown — see the header.
  cost_usd      numeric,
  -- Whether `cost_usd` is an answer. `false` with a NULL cost is "we metered this and could
  -- not price it"; `true` with 0 is "this genuinely cost nothing".
  cost_known    boolean NOT NULL,
  occurred_at   timestamptz NOT NULL DEFAULT now(),
  -- What makes at-least-once ingestion safe for billing. Globally unique, not per-workspace:
  -- the key already carries everything that identifies the event, and scoping the constraint
  -- would let the same event be billed twice by naming a different workspace — which is
  -- precisely the mistake it exists to prevent.
  idempotency_key text NOT NULL UNIQUE
);

-- Workspace-leading, like every other hot index in this schema. The dashboard asks "this
-- workspace, this period", and a trailing tenant column makes the planner walk an index built
-- for a different question.
CREATE INDEX usage_events_ws_occurred ON usage_events (workspace_id, occurred_at DESC);
-- The per-run breakdown the dashboard drills into, and the settle path's own lookup.
CREATE INDEX usage_events_ws_run ON usage_events (workspace_id, run_id);

-- --- money held before it is spent ------------------------------------------------------------

CREATE TABLE billing_holds (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  -- What was estimated and therefore held. Settled against real usage at release; the
  -- difference goes back.
  amount_usd   numeric NOT NULL CHECK (amount_usd >= 0),
  -- `run` or `eval`, plus the id — so a sweeper's log line names the thing that leaked rather
  -- than a uuid nobody can look up.
  purpose      text NOT NULL,
  subject_id   text,
  created_at   timestamptz NOT NULL DEFAULT now(),
  -- The safety net, not the release path — the same distinction the interactive reservation
  -- draws. A run releases its own hold when it ends; this is for the run whose worker died.
  expires_at   timestamptz NOT NULL,
  -- Set when the hold was given back. Kept rather than deleted, so "where did my balance go"
  -- has an answer that outlives the run.
  released_at  timestamptz
);

-- The sweeper's query: live holds, oldest expiry first. Partial, because a released hold is
-- history and the sweep never wants to see one.
CREATE INDEX billing_holds_live ON billing_holds (workspace_id, expires_at)
  WHERE released_at IS NULL;

-- --- what the payment provider believes --------------------------------------------------------

CREATE TABLE subscriptions (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id         uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  plan_id              text NOT NULL REFERENCES plans(id),
  -- The provider's own vocabulary, normalised in code rather than here: `incomplete`,
  -- `active`, `past_due`, `canceled`. A CHECK constraint would mean a migration every time a
  -- provider invents a state, and the state machine that matters is the one in billing/.
  status               text NOT NULL,
  external_customer_id     text,
  external_subscription_id text UNIQUE,
  current_period_end   timestamptz,
  cancel_at_period_end boolean NOT NULL DEFAULT false,
  created_at           timestamptz NOT NULL DEFAULT now(),
  updated_at           timestamptz NOT NULL DEFAULT now()
);

-- One LIVE subscription per workspace. Partial rather than a plain UNIQUE, because a
-- workspace that cancelled and resubscribed has two rows and only one of them is in force —
-- and the cancelled one is evidence somebody will eventually want to read.
CREATE UNIQUE INDEX subscriptions_one_live_per_workspace
  ON subscriptions (workspace_id) WHERE status IN ('incomplete', 'active', 'past_due');

-- --- the backstop -------------------------------------------------------------------------------
--
-- Same ENABLE + FORCE + policy as 009, extended to the four tenant tables here. `plans` is
-- deliberately absent: it is the platform's own catalogue, the same way `workspaces` is, and a
-- policy on it would mean nobody could read the plan they are on.
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['workspace_balances', 'usage_events', 'billing_holds', 'subscriptions']
  LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE  ROW LEVEL SECURITY', t);
    EXECUTE format('DROP POLICY IF EXISTS tenant_isolation ON %I', t);
    EXECUTE format($f$
      CREATE POLICY tenant_isolation ON %I
        USING      (workspace_id = NULLIF(current_setting('app.workspace_id', true), '')::uuid)
        WITH CHECK (workspace_id = NULLIF(current_setting('app.workspace_id', true), '')::uuid)
    $f$, t);
  END LOOP;
END
$$;

GRANT SELECT ON plans TO jaroku_app;
GRANT SELECT, INSERT, UPDATE, DELETE
  ON workspace_balances, usage_events, billing_holds, subscriptions TO jaroku_app;
GRANT USAGE, SELECT ON SEQUENCE usage_events_id_seq TO jaroku_app;

-- The plans this deployment ships with. Ids only — every number about them is in
-- billing/plans.ts, and `npm run test:plans` fails when the two lists disagree.
INSERT INTO plans (id, display_name, purchasable) VALUES
  ('free',  'Free',  false),
  ('pro',   'Pro',   true),
  ('scale', 'Scale', true)
ON CONFLICT (id) DO NOTHING;
