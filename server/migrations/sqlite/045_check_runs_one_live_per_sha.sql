-- 045_check_runs_one_live_per_sha — the SQLite half. Read the Postgres file for why a redelivered
-- pull-request webhook opened a rival check and dispatched a second paid eval, why the constraint
-- is partial rather than total, and why the backfill has to run before the index.
--
-- Same translation as everywhere else. The only shape difference is the backfill: SQLite has no
-- `UPDATE ... FROM` alias form and no row-value comparison in this position, so the "is there a
-- newer live row for the same key" test is written as a correlated subquery over the two columns
-- separately. Same rows, same outcome.
--
-- NO RLS, on this driver, ever — see 009.

UPDATE check_runs
   SET status = 'completed',
       conclusion = 'cancelled',
       -- `strftime` rather than `datetime('now')`: this column is TEXT on this driver and every
       -- other writer of it is `new Date().toISOString()`, so a bare `datetime` would put
       -- `2026-08-17 20:11:04` beside `2026-08-17T20:11:04.812Z` in one column — two formats that
       -- do not sort against each other, in a table read newest-first.
       completed_at = COALESCE(completed_at, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
 WHERE status <> 'completed'
   AND EXISTS (
     SELECT 1 FROM check_runs newer
      WHERE newer.workspace_id = check_runs.workspace_id
        AND newer.agent_id = check_runs.agent_id
        AND newer.pr_number = check_runs.pr_number
        AND newer.head_sha = check_runs.head_sha
        AND newer.status <> 'completed'
        AND (newer.created_at > check_runs.created_at
             OR (newer.created_at = check_runs.created_at AND newer.id > check_runs.id))
   );

CREATE UNIQUE INDEX check_runs_one_live_per_sha
  ON check_runs (workspace_id, agent_id, pr_number, head_sha)
  WHERE status <> 'completed';
