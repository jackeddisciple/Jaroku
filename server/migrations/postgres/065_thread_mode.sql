-- 065_thread_mode — what a conversation is FOR, on the table that already holds conversations.
--
-- Part 3 adds a second kind of conversation: not "help me build this agent" but "what did this
-- agent do, and do this next". Both are one agent, one thread, one archival rule, one title, one
-- status derivation and one spend attribution — six things `threads` already does correctly — so
-- the second kind is a COLUMN rather than a second table. A parallel `agent_conversations` would
-- need its own copies of `threadStatus.ts` and `threadFacts.ts`, which is precisely the second
-- source of truth those two files were written to prevent.
--
-- EVERY EXISTING ROW IS A BUILD THREAD AND THE DEFAULT SAYS SO. Nothing is backfilled by guessing:
-- every row in this table today was opened by the build composer, so `build` is not an assumption
-- about them, it is what they are. A migration that tried to infer operate threads from, say, the
-- presence of a deployed run would be inventing intent for rows nobody wrote with intent.
--
-- `NOT NULL DEFAULT 'build'` RATHER THAN NULLABLE, and that is the expand/contract rule rather than
-- a preference. The version currently serving does not name this column in its INSERTs, so a NOT
-- NULL column without a default would make every `createThread` on the old replicas fail during the
-- rolling window. With the default they keep working and keep writing build threads, which is
-- exactly what they are doing.
--
-- THE CHECK IS A SEPARATE STATEMENT, as 043's is, because Postgres has `ADD CONSTRAINT` and reads
-- better for it. The SQLite half puts the same two words inline on the column, which is the only
-- form that driver offers — 043's header makes the same note about `status`.
--
-- AND NO INDEX ON IT, deliberately. The only read that filters on mode is the Threads list, which
-- already reads every row in the workspace in one query and regroups client-side (`threadGroups.ts`)
-- — so an index would serve a filter nothing performs, on a table whose whole listing is one scan
-- bounded by a workspace. `thread_items_ref` is the index this feature actually leans on, and 066
-- is where it is recreated.

ALTER TABLE threads ADD COLUMN mode text NOT NULL DEFAULT 'build';

ALTER TABLE threads
  ADD CONSTRAINT threads_mode_check CHECK (mode IN ('build', 'operate'));

COMMENT ON COLUMN threads.mode IS
  'build: plans, generations, proposals, diffs, Apply and Undo. operate: questions answered from the record and commands dispatched to a live deployment. Which item kinds may be written into a thread is decided by this column and enforced in ThreadStore.addItem.';
