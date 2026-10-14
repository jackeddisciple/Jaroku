-- 086_step_token_split — a model call's tokens, split into what it read and what it wrote.
--
-- WHAT FOR. The trace draws a model call's tokens as one bar, prompt against completion (the product
-- owner's list, 2026-10-14) — and a step kept only their total, so the split was named "not
-- recorded" rather than drawn. The interceptor has always known it: pricing needs it. It now sends
-- both halves beside the total, and they are kept here.
--
-- ADDITIVE TO THE FROZEN SCHEMA, NOT A CHANGE TO IT. `tokens` keeps its meaning — every token the
-- call consumed — and these two add up to it: `input_tokens` is all the call read, its cached parts
-- included (cached tokens are still tokens it read), and `output_tokens` all it wrote.
--
-- NULLABLE AND WITHOUT A DEFAULT: an expand step. Every step recorded before this has its total and
-- no split, null being the true answer for both; and a step that is not a model call has neither.
-- On the partitioned `steps` (migration 029) an ADD COLUMN on the parent reaches every partition.

ALTER TABLE steps ADD COLUMN input_tokens bigint;
ALTER TABLE steps ADD COLUMN output_tokens bigint;
