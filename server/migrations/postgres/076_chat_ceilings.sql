-- 076_chat_ceilings — §12: displaying a number is not the same as bounding it.
--
-- §12 OPENS WITH THE ARGUMENT AND IT IS THE RIGHT ONE. v0.1.9 gave the eval engine a hard budget
-- ceiling and a pre-run estimate; chat has neither, and "a long thread, an accidental loop, or a
-- regenerate pressed ten times can spend quietly. A cost-honest product's next step is to be
-- cost-controlled."
--
-- TWO CEILINGS BECAUSE THEY ANSWER TWO DIFFERENT QUESTIONS, and §12.1 is explicit about which is
-- which. The soft one is per THREAD and does not block: a conversation that has cost more than
-- expected is worth saying out loud, and blocking it would strand somebody mid-debug. The hard one
-- is per WORKSPACE PER DAY and does: that is the one that stops an accidental loop, and a loop is a
-- property of the workspace rather than of one conversation.
--
-- BOTH ON `workspaces` BECAUSE BOTH ARE POLICY, and policy in this product is a workspace's.
-- `conversation_settings` holds what one conversation is SET TO — its effort, its permission mode —
-- and a per-thread ceiling stored there would be a limit each thread could raise for itself, which
-- is not a limit. The soft one is applied per thread and configured once, which is the same shape
-- `default_reasoning_effort` already has.
--
-- THE DEFAULTS ARE NOT ZERO AND NOT NULL, which is §12.2's first rule: "both ceilings are
-- configurable and both have sane defaults. A user who never opens settings is still protected."
-- $2.00 a day is §12.2's own figure, quoted in the refusal it asks for. $0.50 a thread is chosen
-- rather than quoted: about a hundred ordinary chat turns on the default model, which is far more
-- than a conversation and far less than a surprise.
--
-- `numeric` AND NOT `double precision`, unlike `turn_variants.cost_usd`. A ceiling is a figure
-- somebody TYPED and will read back, so it has to come out exactly as it went in — `2.00` must not
-- render as `1.9999999999`. The costs it is compared against are rounded to eight decimals by
-- `round8` before they are stored, which is orders of magnitude below the precision of a limit
-- anybody sets.
--
-- ZERO IS A REAL VALUE AND MEANS "NO CHAT AT ALL", which is why the CHECK admits it: an
-- administrator turning conversational spend off entirely is a coherent thing to want, and NULL is
-- not that — NULL would have to mean "unlimited", and §12's whole point is that unlimited is what
-- was wrong. Negative is not a limit in any reading, so it is refused.
--
-- AN EXPAND: two defaulted columns the running version does not select.

ALTER TABLE workspaces
  ADD COLUMN chat_thread_ceiling_usd numeric NOT NULL DEFAULT 0.50;
ALTER TABLE workspaces
  ADD COLUMN chat_daily_ceiling_usd  numeric NOT NULL DEFAULT 2.00;

ALTER TABLE workspaces
  ADD CONSTRAINT workspaces_chat_thread_ceiling_check CHECK (chat_thread_ceiling_usd >= 0);
ALTER TABLE workspaces
  ADD CONSTRAINT workspaces_chat_daily_ceiling_check  CHECK (chat_daily_ceiling_usd  >= 0);
