-- 086_step_token_split — a model call's tokens, split into what it read and what it wrote.
--
-- The Postgres migration of the same number says why. Nullable, without a default: every older
-- step keeps its total and has no split.

ALTER TABLE steps ADD COLUMN input_tokens INTEGER;
ALTER TABLE steps ADD COLUMN output_tokens INTEGER;
