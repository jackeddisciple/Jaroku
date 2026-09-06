-- 068_agent_identity — the two columns §5.1 asks for, and why only one of them is NOT NULL.
--
-- `category` IS `TEXT NOT NULL DEFAULT 'Uncategorized'`. NOT an enum, per I6, and the brief spends a
-- paragraph on why: "Twenty-five presets plus 'name your own'. The column is TEXT, never an enum —
-- the list will change, and a migration to add 'Compliance' to a preset list would be absurd." The
-- DEFAULT is what lets it be NOT NULL at all — `db/expandContract.ts` refuses `ADD COLUMN ... NOT
-- NULL` without one, because the version still serving does not name the column in its INSERTs —
-- and here the default IS the answer the backfill wanted anyway. There is nothing to guess: an
-- existing agent has no category, and `Uncategorized` says exactly that.
--
-- `avatar_id` IS NULLABLE, and follows migration 067's reasoning one column over. A DEFAULT here
-- would be a named character, so every row an older version inserted during a rolling deploy would
-- silently be Alder — a WRONG identity rather than a missing one, on the feature whose entire
-- purpose is that a face identifies an agent. NULL renders the agent's emoji instead, which is the
-- honest answer and the fallback the card already has. Every INSERT path in
-- `db/repositories/agents.ts` writes one, and `test:agent-avatar` reads that file and fails on one
-- that does not. Tightening to NOT NULL is a contract step for a later release.
--
-- THE BACKFILL DOES NOT REPRODUCE FNV-1a, AND DOES NOT TRY — the same call migration 067 made, for
-- the same reason. §5.1 asks for "the same FNV-1a discipline", and what that discipline is FOR is
-- that a workspace's agents are distinguishable from each other; matching a hash nobody could have
-- run before the column existed is not a property anybody can observe. So each agent takes the
-- roster entry at its own position in its workspace's creation order — consecutive, distinct until
-- the twenty-ninth agent, and stable because the ordering key is `created_at` with `id` as the
-- tie-break. Agents created from here on go through `avatarIdFor`, which hashes.
--
-- A CORRELATED COUNT RATHER THAN `ROW_NUMBER()`, so the two dialects run the same statement: SQLite
-- and Postgres both have the window function, and `UPDATE ... FROM` is where they stop agreeing.
--
-- THE TWENTY-EIGHT NAMES ARE SPELLED OUT because a migration cannot import the roster, and it must
-- not: this file is checksummed and applied once, and a backfill that read a list somebody edits
-- later would produce a different database depending on when it ran. The list is the roster as it
-- stood at this version, frozen with the statement that uses it — which is what a migration IS.
--
-- THE POSTGRES HALF IS THE SAME THREE STATEMENTS. Adding a nullable column with no default is a
-- catalogue-only change, and since Postgres 11 so is adding one WITH a default — neither rewrites
-- `agents` and neither holds a lock past the statement.

ALTER TABLE agents ADD COLUMN category TEXT NOT NULL DEFAULT 'Uncategorized';

ALTER TABLE agents ADD COLUMN avatar_id TEXT;

UPDATE agents
   SET avatar_id = CASE ((SELECT COUNT(*) FROM agents AS earlier
                           WHERE earlier.workspace_id = agents.workspace_id
                             AND (earlier.created_at < agents.created_at
                                  OR (earlier.created_at = agents.created_at AND earlier.id < agents.id))
                         ) % 28)
           WHEN 0 THEN 'alder'
           WHEN 1 THEN 'ash'
           WHEN 2 THEN 'basalt'
           WHEN 3 THEN 'birch'
           WHEN 4 THEN 'cedar'
           WHEN 5 THEN 'clover'
           WHEN 6 THEN 'cobalt'
           WHEN 7 THEN 'coral'
           WHEN 8 THEN 'dune'
           WHEN 9 THEN 'fennel'
           WHEN 10 THEN 'flint'
           WHEN 11 THEN 'gorse'
           WHEN 12 THEN 'hazel'
           WHEN 13 THEN 'indigo'
           WHEN 14 THEN 'juniper'
           WHEN 15 THEN 'kelp'
           WHEN 16 THEN 'larch'
           WHEN 17 THEN 'linen'
           WHEN 18 THEN 'maple'
           WHEN 19 THEN 'marble'
           WHEN 20 THEN 'nettle'
           WHEN 21 THEN 'onyx'
           WHEN 22 THEN 'opal'
           WHEN 23 THEN 'pebble'
           WHEN 24 THEN 'quartz'
           WHEN 25 THEN 'rowan'
           WHEN 26 THEN 'sage'
           WHEN 27 THEN 'slate'
           ELSE 'alder'
         END
 WHERE avatar_id IS NULL;
