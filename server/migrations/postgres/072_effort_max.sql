-- The fifth reasoning effort, `max`.
--
-- The composer's effort control went from four levels to five on 2026-09-11. Claude's Sonnet 5,
-- Opus 5 and Fable 5.1 and OpenAI's GPT-6 Astra and GPT-5.6 all take a level above XHigh, and the
-- product now offers it. Every column that stores a level refused the word, so a conversation told
-- to remember Max, or a variant that ran at it, would have failed its write.
--
-- WIDENING A CHECK IS AN EXPAND, NOT A CONTRACT — 066 makes the full argument. Each replacement
-- permits every level the constraint it replaces permits, so nothing the running version writes
-- becomes invalid. `NOT VALID` and then `VALIDATE` keeps the ADD from holding its lock across a scan
-- of every row, for the reason 066 gives.

-- jaroku:contract-step — a widening: the replacement permits every level this one permits.
ALTER TABLE conversation_settings DROP CONSTRAINT conversation_settings_reasoning_effort_check;

ALTER TABLE conversation_settings
  ADD CONSTRAINT conversation_settings_reasoning_effort_check
  CHECK (reasoning_effort IN ('low', 'medium', 'high', 'xhigh', 'max'))
  NOT VALID;

ALTER TABLE conversation_settings VALIDATE CONSTRAINT conversation_settings_reasoning_effort_check;

-- jaroku:contract-step — a widening, as above.
ALTER TABLE workspaces DROP CONSTRAINT workspaces_default_reasoning_effort_check;

ALTER TABLE workspaces
  ADD CONSTRAINT workspaces_default_reasoning_effort_check
  CHECK (default_reasoning_effort IN ('low', 'medium', 'high', 'xhigh', 'max'))
  NOT VALID;

ALTER TABLE workspaces VALIDATE CONSTRAINT workspaces_default_reasoning_effort_check;

-- jaroku:contract-step — a widening, as above.
ALTER TABLE turn_variants DROP CONSTRAINT turn_variants_effort_requested_check;

ALTER TABLE turn_variants
  ADD CONSTRAINT turn_variants_effort_requested_check
  CHECK (effort_requested IN ('low', 'medium', 'high', 'xhigh', 'max'))
  NOT VALID;

ALTER TABLE turn_variants VALIDATE CONSTRAINT turn_variants_effort_requested_check;

-- jaroku:contract-step — a widening, as above.
ALTER TABLE turn_variants DROP CONSTRAINT turn_variants_effort_applied_check;

ALTER TABLE turn_variants
  ADD CONSTRAINT turn_variants_effort_applied_check
  CHECK (effort_applied IN ('low', 'medium', 'high', 'xhigh', 'max'))
  NOT VALID;

ALTER TABLE turn_variants VALIDATE CONSTRAINT turn_variants_effort_applied_check;
