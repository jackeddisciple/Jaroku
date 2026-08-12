-- 024_usage_payer — who actually paid for a metered call.
--
-- `kind` says what was bought. It does not say whose money bought it, and under BYOK those are
-- different questions about the same row: an `llm.provider` call made on a workspace's own key
-- is the workspace's bill, and the identical call made on the platform's key is ours. A
-- platform-key ceiling that counted by kind would count both and would throttle a workspace for
-- spending its own money.
--
-- So the payer is recorded rather than inferred. Inferring it later is not possible even in
-- principle: whether a run used its workspace's key depends on what was configured AT THE TIME,
-- and a workspace that connects a key on Tuesday would retroactively change what Monday's rows
-- mean.
--
-- TWO VALUES, AND NO CHECK CONSTRAINT. `platform` and `workspace` are the only payers there can
-- be while the product is BYOK-or-us; the set lives in billing/usage.ts with the kinds, for the
-- same reason the kinds are not an enum here — adding one should be a migration nobody has to
-- write.
--
-- DEFAULT `platform`, AND THAT IS A DESCRIPTION RATHER THAN A GUESS. Every row written before
-- this migration was written by a deployment where platform-side calls used the platform's key
-- and a run inherited the server's environment. Backfilling them as `platform` says what they
-- were. The one honest caveat: the per-workspace provider keys that landed in the commit
-- immediately before this one could, in principle, have produced a `workspace` row already —
-- there is one commit of history where the column would be wrong, and it is worth more to have
-- a NOT NULL column with a truthful default than a nullable one that every query has to
-- COALESCE and every reader has to think about.
ALTER TABLE usage_events ADD COLUMN payer text NOT NULL DEFAULT 'platform';

-- The platform-key ceiling's own query: this workspace, this period, what WE paid for. Partial,
-- because the other half of the table is exactly what this index must not have to walk.
CREATE INDEX usage_events_platform_paid ON usage_events (workspace_id, occurred_at DESC)
  WHERE payer = 'platform';
