-- 057_turn_variants — a turn's response variants, so regenerating never destroys what it replaces.
--
-- §5.4 is the subtlest thing in the composer spec, and the reason is stated there: "a regenerated
-- turn can produce agent code, and Jaroku's whole guarantee is that generated code goes through
-- staging -> validate -> publish." So a regeneration is not an edit. It is a NEW ROW beside the old
-- one, and the old one keeps its own model, its own effort, its own duration and its own version.
--
-- "NEVER OVERWRITE VARIANT 1'S METADATA WITH VARIANT 2'S" is the spec's own sentence and it is the
-- whole shape of this table. Every column here is per-variant rather than per-turn precisely
-- because the alternative — a turn row that gets updated — answers "which model wrote this?" with
-- whichever model wrote it LAST, on a response the user is currently reading that a different
-- model produced.
--
-- `agent_version_id` IS NULLABLE AND IS NOT A PUBLISHED POINTER. §5.4: "If a variant produced a
-- version, that version follows the normal staged-write path. Switching variants in the UI does
-- NOT move the published pointer — it shows a different response. Promoting a variant's version is
-- an explicit Apply action on that variant." This column records what a variant PRODUCED; what is
-- published lives on `agents.current_version` and is moved by the publish path alone. Conflating
-- the two would make a view change into a deploy.
--
-- `ordinal` IS THE VARIANT NUMBER THE UI SHOWS — the "2" in "< 2/2 >". Unique per turn, so two
-- concurrent regenerations cannot both claim to be variant 2 and leave a switcher that skips a
-- number. It is deliberately not a timestamp ordering: a variant's number is a name a person reads
-- and refers to, and it must not change because another one arrived.
--
-- COST AND TOKENS ARE HERE RATHER THAN JOINED FROM `usage_events`. The metadata row's hover card
-- shows "this turn's token counts + cost", and a join through the ledger would attribute a whole
-- run to a variant when a run can span several. These are what THIS response spent.
--
-- THE FOREIGN KEY IS THE PAIR — §7's rule. A bare `thread_items(id)` reference is satisfiable by
-- any tenant's turn.

CREATE TABLE turn_variants (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id     uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  turn_id          uuid NOT NULL,
  -- 1-based, and it is what the switcher renders. See the header for why it is not a timestamp.
  ordinal          integer NOT NULL,

  model_id         text,
  provider         text,
  -- BOTH LEVELS, because §6.2 renders the clamp marker by comparing them. A single `effort` column
  -- would make "XHigh requested; this model caps at High" underivable after the fact, which is the
  -- silent-degradation failure the effort adapter exists to prevent.
  effort_requested text CHECK (effort_requested IN ('low', 'medium', 'high', 'xhigh')),
  effort_applied   text CHECK (effort_applied   IN ('low', 'medium', 'high', 'xhigh')),

  duration_ms      integer,
  tokens_in        integer,
  tokens_out       integer,
  cost_usd         numeric,

  -- What this variant PRODUCED. Never what is published — see the header.
  agent_version_id uuid,

  created_at       timestamptz NOT NULL DEFAULT now(),

  -- One variant per number per turn. Without it, two concurrent regenerations both write ordinal 2
  -- and the switcher renders "2/3" with two identical numbers in it.
  UNIQUE (workspace_id, turn_id, ordinal),
  FOREIGN KEY (workspace_id, turn_id)
    REFERENCES thread_items (workspace_id, id) ON DELETE CASCADE
);

CREATE INDEX turn_variants_turn ON turn_variants (workspace_id, turn_id, ordinal);

-- --- the backfill -----------------------------------------------------------------------------
--
-- §7's migration note: "Existing turns backfill into turn_variants as ordinal = 1, carrying
-- whatever model/duration data already exists; null the rest rather than guessing."
--
-- NULL RATHER THAN GUESSING is the instruction that matters. A backfilled variant with an invented
-- duration would put a number in the metadata row that nobody measured, and doc §8's rule about
-- cost applies to every figure in that row: a wrong number is worse than an absent one, because an
-- absent one is visibly absent.
--
-- Only turns that CAN carry a response get one. A user's own message is not a response and has no
-- variant; giving every row one would make the switcher appear under things nobody generated.
INSERT INTO turn_variants (workspace_id, turn_id, ordinal, created_at)
SELECT ti.workspace_id, ti.id, 1, ti.created_at
  FROM thread_items ti
 WHERE ti.kind IN ('plan', 'generation', 'proposal')
   AND NOT EXISTS (
     SELECT 1 FROM turn_variants v
      WHERE v.workspace_id = ti.workspace_id AND v.turn_id = ti.id);

ALTER TABLE turn_variants ENABLE ROW LEVEL SECURITY;
ALTER TABLE turn_variants FORCE  ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON turn_variants;
CREATE POLICY tenant_isolation ON turn_variants
  USING      (workspace_id = NULLIF(current_setting('app.workspace_id', true), '')::uuid)
  WITH CHECK (workspace_id = NULLIF(current_setting('app.workspace_id', true), '')::uuid);
