-- 052_subscription_tiers — what a workspace is entitled to, counted per month, and the third
-- tier finally called by the name the pricing says out loud.
--
-- THREE TIERS, AND THE TOP ONE WAS SPELLED TWO WAYS. `plans` has shipped `free`, `pro` and
-- `scale` since 020, and every document describing what people buy says Free, Pro and TEAM. One
-- of those had to move, and it is cheaper to move the id than to keep a translation table in
-- everybody's head — `assertPlanRegistry` already fails the boot when `plans` and
-- `billing/plans.ts` disagree, so the two halves of this rename cannot ship apart. The order
-- below is load bearing: `subscriptions.plan_id` REFERENCES `plans(id)`, so the new row exists
-- before anything points at it and the old row leaves only once nothing does.
--
-- ONE ROW PER METRIC PER PERIOD, NOT ONE COLUMN PER METRIC. A column per metered dimension means
-- a migration every time somebody wants to meter a new one — deployment-hours, stored gigabytes,
-- seats — and a migration for a counter is a migration nobody bothers with, so the counter never
-- gets added. A row keyed by a string means the next dimension is a constant in
-- `billing/usage.ts` and nothing here changes.
--
-- WHICH IS ALSO WHY `metric` CARRIES NO CHECK CONSTRAINT, and this is a deliberate departure
-- from the specification's own DDL. A `CHECK (metric IN (…))` would make every new dimension a
-- schema migration again, which is the exact cost the row-per-metric shape was chosen to avoid —
-- the specification says so two paragraphs above the DDL that contradicts it. It is also the
-- judgement 020 already made twice, for `subscriptions.status` and for `usage_events.kind`: the
-- closed set lives in the file that reads it, where adding to it is a code review rather than a
-- deploy. `npm run test:usage-periods` is what makes the set closed in practice.
--
-- WHY A SEPARATE TABLE FROM `usage_events` AT ALL, given that one already records every priced
-- call. Because they answer different questions and are true at different grains. `usage_events`
-- is the ledger: one row per thing that happened, immutable, joined to a run. This is the
-- counter: one row per workspace per month per dimension, incremented in place, and read on
-- every single quota check. A `COUNT(*) … WHERE occurred_at >= …` over the ledger is the right
-- answer computed the expensive way, on the hot path, forever.

CREATE TABLE workspace_usage_periods (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  -- The calendar month, in UTC, exactly as `billingPeriod()` in billing/gate.ts computes it —
  -- deliberately NOT the subscription's anniversary. Two workspaces looking at "this month"
  -- have to be looking at the same window or a support conversation starts by working out
  -- whose month it is. The subscription's own period is `subscriptions.current_period_*`, and
  -- keeping them apart is why both exist.
  period_start timestamptz NOT NULL,
  period_end   timestamptz NOT NULL,
  -- The dimension. A closed set in billing/usage.ts, not here — see the header.
  metric       text NOT NULL,
  -- `numeric` rather than an integer because two of the dimensions are money and one is tokens.
  -- A counter that had to be an integer would need a second table the day somebody meters a
  -- dollar, and the rounding discipline `round8` already imposes makes numeric exact here.
  count        numeric NOT NULL DEFAULT 0,
  -- One counter per workspace per period per metric. This constraint IS the increment path:
  -- every write is an upsert onto it, so a redelivered increment collides rather than doubling,
  -- and two replicas incrementing the same counter serialise on the same row.
  UNIQUE (workspace_id, period_start, metric)
);

-- No second index. The unique constraint's own index leads with `workspace_id`, which is the
-- prefix every read uses — "this workspace, this period, these metrics" — so a second one would
-- be the same columns under another name.

-- --- what a subscription has to carry that it did not ------------------------------------------

-- Seats, priced per user on Team. NOT NULL with a default because the running version's INSERTs
-- do not name it, and one seat is what every existing row means.
ALTER TABLE subscriptions ADD COLUMN seat_count integer NOT NULL DEFAULT 1;

-- The paid tiers' escape hatch: platform fee only, inference on the workspace's own keys. A
-- workspace-level fact rather than a plan-level one, because it is a choice a customer makes
-- and unmakes, not a property of what they bought.
ALTER TABLE subscriptions ADD COLUMN byok_enabled boolean NOT NULL DEFAULT false;

-- The other end of the period this row already stores the end of. Nullable, because every row
-- that exists today has an end and no beginning, and inventing one would be inventing evidence.
ALTER TABLE subscriptions ADD COLUMN current_period_start timestamptz;

-- --- scale becomes team --------------------------------------------------------------------

INSERT INTO plans (id, display_name, purchasable) VALUES ('team', 'Team', true)
ON CONFLICT (id) DO NOTHING;

UPDATE subscriptions SET plan_id = 'team' WHERE plan_id = 'scale';
UPDATE workspaces    SET plan    = 'team' WHERE plan    = 'scale';

-- Last, and only now that nothing references it. Not a DROP of anything the running version
-- reads — `planFor` falls back to the free limits for an id it does not recognise, so the worst
-- an in-flight request on the old code sees is the plan it would have seen had the row never
-- existed.
DELETE FROM plans WHERE id = 'scale';

-- --- the backstop -------------------------------------------------------------------------------
--
-- Same ENABLE + FORCE + policy as 009 and as 020, for the one new tenant table here. In this
-- migration rather than an edit to 009, because migrations are forward only and an applied file
-- is history — see ADR-017 and ADR-019.
--
-- Every detail below is 009's and load bearing for the same reasons: FORCE, because ENABLE alone
-- exempts the table owner and on a modest deployment the owner is whoever ran the migrations.
-- WITH CHECK, because USING alone permits a write across the boundary that the writer merely
-- cannot read back — quiet rather than absent. NULLIF, because a custom setting that has ever
-- been set keeps existing as an empty string on a pooled connection, and ''::uuid raises instead
-- of matching nothing.

ALTER TABLE workspace_usage_periods ENABLE ROW LEVEL SECURITY;
ALTER TABLE workspace_usage_periods FORCE  ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON workspace_usage_periods;
CREATE POLICY tenant_isolation ON workspace_usage_periods
  USING      (workspace_id = NULLIF(current_setting('app.workspace_id', true), '')::uuid)
  WITH CHECK (workspace_id = NULLIF(current_setting('app.workspace_id', true), '')::uuid);

GRANT SELECT, INSERT, UPDATE, DELETE ON workspace_usage_periods TO jaroku_app;
