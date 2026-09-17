-- 079_agent_picture — one nullable column, and why it is a new one rather than `avatar_id` reused.
--
-- WHAT IS CHANGING. `agents.avatar_id` named one of twenty-eight procedurally-generated 3D
-- characters and `agents.emoji` named the mark the sidebar drew; both are being retired in favour of
-- ONE picture per agent, drawn from the eleven illustrated portraits in `client/public/agent-faces/`.
-- Each portrait comes with a banner cut from its own palette and a name of its own, so a row that
-- carries the picture carries the whole identity.
--
-- SO WHY NOT WRITE THE NEW IDS INTO `avatar_id`. Because expand/contract is the rule this repository
-- checks rather than remembers (`db/expandContract.ts`), and repurposing a column is a rename with
-- the rename left out: for the window of a rolling deploy the old version is still SELECTing
-- `avatar_id` and handing it to a renderer that knows twenty-eight names, none of which is
-- `avatar-04`. That renders nothing, on the one feature whose entire purpose is that something is
-- drawn. A new column is invisible to the version still serving, which is the whole point of adding
-- one.
--
-- `emoji` AND `avatar_id` ARE NOT TOUCHED HERE and are not dropped here. They are dropped in a LATER
-- migration, once no running version reads them — which is the contract step, and it needs its own
-- deploy.
--
-- NULLABLE, AND FOR MIGRATION 068'S REASON ONE COLUMN OVER. A DEFAULT would be a NAMED PORTRAIT, so
-- every row an older version inserted during a rolling deploy would silently be Iris — a WRONG
-- identity rather than a missing one, on a feature whose point is that a face identifies an agent.
-- NULL renders the agent's initial instead, which is the honest answer and the fallback
-- `AgentAvatar` already has. Every INSERT path in `db/repositories/agents.ts` writes one, and
-- `test:agent-faces` reads that file and fails on one that does not. Tightening to NOT NULL is a
-- contract step for a later release.
--
-- ── THE BACKFILL IS A POSITION, NOT A HASH, AND THAT IS A REAL DECISION ────────────────────────
--
-- Migrations 067 and 068 both declined to reproduce FNV-1a in SQL and took each agent's position in
-- its workspace's creation order instead, on the argument that matching a hash nobody could have run
-- before the column existed is not a property anybody can observe. This goes further: the position
-- IS the assignment now, here and in `agents/faces.ts`, and the hash is gone from this feature
-- entirely.
--
-- THE REASON IS THE BIRTHDAY BOUND. Over eleven pictures a hash collides on the fourth or fifth
-- agent more often than not, so a hashed workspace shows two agents wearing one face almost at once
-- — and where twenty-eight characters had a picker that warned about a duplicate, these are handed
-- out silently. A position gives the first eleven agents eleven different faces, which is the only
-- thing this feature is actually for.
--
-- A CORRELATED COUNT RATHER THAN `ROW_NUMBER()`, so the two dialects run the same statement: SQLite
-- and Postgres both have the window function, and `UPDATE ... FROM` is where they stop agreeing.
--
-- THE COUNT IS UNFILTERED — archived and swept rows are counted — because the sequence is a counter
-- rather than a census, and `agents/faces.ts` counts the same way. A workspace that archived its
-- third agent should hand the next one the fourth face rather than repeating the third.
--
-- THE ELEVEN IDS ARE SPELLED OUT because a migration cannot import the list, and must not: this file
-- is checksummed and applied once, and a backfill that read a list somebody edits later would
-- produce a different database depending on when it ran. The list is the set as it stood at this
-- version, frozen with the statement that uses it — which is what a migration IS.
--
-- THE POSTGRES HALF IS THE SAME TWO STATEMENTS. Adding a nullable column with no default is a
-- catalogue-only change since Postgres 11 — it does not rewrite `agents` and does not hold a lock
-- past the statement — and the backfill is one UPDATE over a table with one row per agent.

ALTER TABLE agents ADD COLUMN picture TEXT;

UPDATE agents
   SET picture = CASE ((SELECT COUNT(*) FROM agents AS earlier
                         WHERE earlier.workspace_id = agents.workspace_id
                           AND (earlier.created_at < agents.created_at
                                OR (earlier.created_at = agents.created_at AND earlier.id < agents.id))
                       ) % 11)
           WHEN 0 THEN 'avatar-01'
           WHEN 1 THEN 'avatar-02'
           WHEN 2 THEN 'avatar-03'
           WHEN 3 THEN 'avatar-04'
           WHEN 4 THEN 'avatar-05'
           WHEN 5 THEN 'avatar-06'
           WHEN 6 THEN 'avatar-07'
           WHEN 7 THEN 'avatar-08'
           WHEN 8 THEN 'avatar-09'
           WHEN 9 THEN 'avatar-10'
           WHEN 10 THEN 'avatar-11'
           ELSE 'avatar-01'
         END
 WHERE picture IS NULL;
