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
       completed_at = COALESCE(completed_at, datetime('now'))
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
