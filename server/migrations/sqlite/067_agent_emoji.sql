-- 067_agent_emoji — one column, and the reason it is nullable rather than NOT NULL.
--
-- THE BRIEF ASKS FOR `TEXT NOT NULL` WITH NO DEFAULT, AND THIS REPOSITORY ALREADY REFUSES THAT
-- SHAPE. `db/expandContract.ts`'s BREAKING table spells the rule out: "ADD COLUMN ... NOT NULL
-- without a DEFAULT — the running version's INSERTs do not name this column and would fail — add it
-- nullable or with a DEFAULT, and tighten in a later deploy." `migrate:check` runs in CI between
-- build and migrate, so a NOT NULL column here would fail the gate rather than ship.
--
-- The brief's ACTUAL requirement is not the constraint, it is what the constraint is for: "no
-- default in the schema — a default would let a row exist without going through assignment, which
-- is how duplicates get in." A DEFAULT is exactly what this file does not have. The assignment is
-- enforced where it can be without breaking a rolling deploy: every INSERT path in
-- `db/repositories/agents.ts` writes an emoji, and `test:agent-emoji` reads that file and fails on
-- one that does not. Stronger than a schema default, weaker than NOT NULL, and the only one of the
-- three this codebase's own gate permits. Tightening is a contract step for a later release, once
-- no serving version writes an agent without one.
--
-- THE BACKFILL IS DETERMINISTIC AND COLLISION-FREE PER WORKSPACE, and it is SQL rather than a
-- script because a migration that needs the application running is a migration that runs twice.
--
-- IT DOES NOT REPRODUCE FNV-1a AND DOES NOT TRY. What an existing workspace needs is that its
-- agents are distinguishable FROM EACH OTHER, not that they match a hash nobody could have run
-- before the column existed. So each agent takes the palette entry at its own position in its
-- workspace's creation order — consecutive, distinct until the sixty-fifth agent, and stable
-- because the ordering key is `created_at` with `id` as the tie-break. Agents created from here on
-- go through `assignEmoji`, which hashes and then probes.
--
-- A CORRELATED COUNT RATHER THAN `ROW_NUMBER()`, so the two dialects run the same statement: SQLite
-- and Postgres both have the window function now, and `UPDATE ... FROM` is where they stop
-- agreeing. The count is over rows strictly before this one in the same workspace, which is exactly
-- what a zero-based row number is.

ALTER TABLE agents ADD COLUMN emoji TEXT;

UPDATE agents
   SET emoji = CASE ((SELECT COUNT(*) FROM agents AS earlier
                       WHERE earlier.workspace_id = agents.workspace_id
                         AND (earlier.created_at < agents.created_at
                              OR (earlier.created_at = agents.created_at AND earlier.id < agents.id))
                     ) % 64)
           WHEN 0 THEN '⚓'
           WHEN 1 THEN '🌰'
           WHEN 2 THEN '🌲'
           WHEN 3 THEN '🌴'
           WHEN 4 THEN '🌵'
           WHEN 5 THEN '🌻'
           WHEN 6 THEN '🌾'
           WHEN 7 THEN '🌿'
           WHEN 8 THEN '🍄'
           WHEN 9 THEN '🍆'
           WHEN 10 THEN '🍇'
           WHEN 11 THEN '🍉'
           WHEN 12 THEN '🍐'
           WHEN 13 THEN '🎁'
           WHEN 14 THEN '🎈'
           WHEN 15 THEN '🎩'
           WHEN 16 THEN '🎺'
           WHEN 17 THEN '🎻'
           WHEN 18 THEN '🐊'
           WHEN 19 THEN '🐌'
           WHEN 20 THEN '🐘'
           WHEN 21 THEN '🐙'
           WHEN 22 THEN '🐛'
           WHEN 23 THEN '🐝'
           WHEN 24 THEN '🐞'
           WHEN 25 THEN '🐢'
           WHEN 26 THEN '🐧'
           WHEN 27 THEN '🐫'
           WHEN 28 THEN '🐬'
           WHEN 29 THEN '🐳'
           WHEN 30 THEN '📌'
           WHEN 31 THEN '📎'
           WHEN 32 THEN '📷'
           WHEN 33 THEN '🔑'
           WHEN 34 THEN '🔒'
           WHEN 35 THEN '🔗'
           WHEN 36 THEN '🔧'
           WHEN 37 THEN '🔨'
           WHEN 38 THEN '🔩'
           WHEN 39 THEN '🔬'
           WHEN 40 THEN '🔭'
           WHEN 41 THEN '🚀'
           WHEN 42 THEN '🚁'
           WHEN 43 THEN '🚂'
           WHEN 44 THEN '🚜'
           WHEN 45 THEN '🚤'
           WHEN 46 THEN '🚲'
           WHEN 47 THEN '🛶'
           WHEN 48 THEN '🥁'
           WHEN 49 THEN '🥑'
           WHEN 50 THEN '🥥'
           WHEN 51 THEN '🥦'
           WHEN 52 THEN '🥬'
           WHEN 53 THEN '🦀'
           WHEN 54 THEN '🦇'
           WHEN 55 THEN '🦉'
           WHEN 56 THEN '🦋'
           WHEN 57 THEN '🦎'
           WHEN 58 THEN '🦑'
           WHEN 59 THEN '🧪'
           WHEN 60 THEN '🧬'
           WHEN 61 THEN '🧭'
           WHEN 62 THEN '🧲'
           WHEN 63 THEN '🧿'
           ELSE '⚓'
         END
 WHERE emoji IS NULL;
