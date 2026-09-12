-- 075_thread_lineage — the SQLite half. Read the Postgres file for every decision: why these two
-- columns mirror `runs.parent_run_id` / `runs.branch_from_seq` exactly, why the foreign key is the
-- PAIR rather than `threads(id)` alone, why the action is SET NULL rather than CASCADE, and why the
-- turn index is a number rather than a `thread_items` id.
--
-- THE TRANSLATION: uuid -> TEXT, integer -> INTEGER. Ids Postgres would default are supplied by the
-- repository, because SQLite has no `now()` or `gen_random_uuid()` that writes the same shape.
--
-- NO FOREIGN KEY AND NO CHECK ON THIS DRIVER, and that is the same decision 043 made for
-- `threads.agent_id`: SQLite cannot `ALTER TABLE ... ADD CONSTRAINT` at all, so the alternatives are
-- a full table rewrite — holding aside every row of the five tables that cascade from `threads` —
-- or accepting that the constraint lives one layer up. 066 did the rewrite because it had to widen a
-- CHECK; this does not, and the cost is not worth it: the repository's own WHERE is the tenancy
-- boundary on this driver anyway (migration 009 grants it no RLS), and `branchThread` validates the
-- parent by READING it through a scoped query before it writes the child. The constraint is
-- therefore enforced where it can be enforced on both drivers, and asserted on the one that has it.
--
-- `ADD COLUMN` IN PLACE, twice: two nullable columns with no default, which is the change this
-- driver makes without touching the table's indexes or its existing foreign keys.

ALTER TABLE threads ADD COLUMN parent_thread_id TEXT;
ALTER TABLE threads ADD COLUMN branch_from_turn INTEGER;

CREATE INDEX threads_parent ON threads (workspace_id, parent_thread_id);
