-- 075_thread_lineage — a conversation can fork, and the fork remembers where it came from.
--
-- §6.3 IS THE WHOLE ARGUMENT AND IT IS NOT ABOUT CHAT. "Editing an earlier message is where most
-- products quietly delete everything that came after it. Jaroku should not, because it already has
-- the primitive that makes deletion unnecessary."
--
-- THE PRIMITIVE IS RUN BRANCHING, AND THESE TWO COLUMNS ARE ITS MIRROR. v0.1.5 and v0.1.6 built
-- exactly this operation one level down: fork from any boundary, copy the prefix with relationships
-- remapped, leave the parent immutable, and record lineage through `runs.parent_run_id` and
-- `runs.branch_from_seq` (migration 002). A conversation is a different sequence and the same
-- operation — editing turn 3 of a thread is forking at turn 3 — so the columns are named to read the
-- same way:
--
--     runs.parent_run_id       ->  threads.parent_thread_id
--     runs.branch_from_seq     ->  threads.branch_from_turn
--
-- Anybody who has read one lineage model can read the other without being told, which is §6.3's
-- instruction about the RENDERING applied to the schema: "do not invent a second lineage visual
-- language" has a data-model half.
--
-- THE FK IS THE PAIR, AND THAT IS MIGRATION 018'S LESSON RATHER THAN A STYLE CHOICE. A bare
-- `threads(id)` reference is satisfiable by ANY tenant's thread — `threads.id` is globally unique —
-- so a row naming another workspace's conversation as its parent would satisfy the constraint
-- perfectly. §6.3 asks for the pair in so many words, and 018 added `UNIQUE (workspace_id, id)` to
-- make it expressible.
--
-- AND THE ACTION IS `SET NULL` RATHER THAN `CASCADE`, which is the opposite of what a first reading
-- suggests. A parent thread is never hard-deleted — §3.4: threads archive, and there is
-- deliberately no `deleteThread` on the store — so this fires only when a workspace is removed and
-- everything goes at once. What it must NOT do is take the child with it: the child is a real
-- conversation with its own turns and its own cost, and 043's own header states the discipline
-- ("nothing is destroyed as a side effect of something else being destroyed"). A fork whose parent
-- is gone renders as a fork with no visible parent, which is honest; a fork that vanished with it
-- would destroy a record nobody asked to delete.
--
-- `branch_from_turn` IS AN INDEX INTO THE PARENT'S TURNS, 1-based, and it is a NUMBER rather than a
-- `thread_items` id on purpose. §6.3 labels the fork `branch @3`, which is a position a person
-- counted; an id would render as a uuid and would also have to survive the parent's turns being
-- read in a different order, which `created_at` ordering does not promise across two writes in one
-- millisecond. The number is what the label says and what the label means.
--
-- AN EXPAND: two nullable columns with no default. The version currently serving selects neither.

ALTER TABLE threads ADD COLUMN parent_thread_id uuid;
ALTER TABLE threads ADD COLUMN branch_from_turn integer;

ALTER TABLE threads
  ADD CONSTRAINT threads_parent_fk
  FOREIGN KEY (workspace_id, parent_thread_id)
  REFERENCES threads (workspace_id, id) ON DELETE SET NULL;

-- A turn index is a position in a list, so zero and below are not positions. Stated as a
-- constraint rather than trusted to the writer: `branch @0` would render as a fork before the
-- conversation began.
ALTER TABLE threads
  ADD CONSTRAINT threads_branch_from_turn_check
  CHECK (branch_from_turn IS NULL OR branch_from_turn >= 1);

-- WHAT THE LIST READS: every fork of a given thread, so a parent row can render its children's
-- lineage without a scan. Scoped, like every index on this table.
CREATE INDEX threads_parent ON threads (workspace_id, parent_thread_id);
