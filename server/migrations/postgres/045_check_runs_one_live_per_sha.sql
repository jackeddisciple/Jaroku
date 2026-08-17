-- 045_check_runs_one_live_per_sha — one live check per (agent, pull request, commit).
--
-- WHAT WENT WRONG WITHOUT IT. §B.1.2's supersede rule cancels live checks on a pull request that
-- are about an OLDER commit — `head_sha <> ?` — so it finds nothing when a delivery arrives for a
-- commit already being checked. And a delivery does arrive twice: GitHub retries anything it did
-- not get a timely response to, `onPullRequest` awaits a collaborator lookup, two check-run writes
-- and an eval dispatch before the route answers, a retry can land on a different replica or after a
-- restart, and `reopened` is an admitted action carrying the same head sha as the `opened` that
-- preceded it. The only dedup on that path is a 500-entry `Set` built per process, whose own
-- comment explains that it guards a path where "the worst outcome of a missed dedup is a redundant
-- broadcast" — true of the push handler it was written for, and false of the pull-request handler
-- that was later added behind it, which opens a check run and SPENDS A WORKSPACE'S PROVIDER
-- BALANCE.
--
-- So a redelivery produced a second check run with the same name on the same pull request and a
-- second paid eval fan-out for the same commit.
--
-- A PARTIAL UNIQUE INDEX, NOT A CODE CHECK, and that is the whole point. A read-then-insert is a
-- TOCTOU across exactly the window two concurrent deliveries occupy — the same shape as the guards
-- this codebase has already had to fix once — and the two deliveries can be on two replicas, where
-- no in-process guard can help at all. This makes "one live check per commit" a fact about the
-- table, and the insert's ON CONFLICT is what turns a rival delivery into a read of the row that
-- already exists.
--
-- PARTIAL ON `status <> 'completed'`, because the constraint is about LIVE checks. A commit can
-- legitimately be checked again after the first attempt finished — a re-run, a rerequest, a
-- baseline recomputed weeks later — and a total unique index would refuse those and make the table
-- unable to hold its own history.
--
-- THE BACKFILL COMES FIRST. An installation that already hit this has duplicate live rows, and
-- creating the index over them would fail the migration on exactly the deployments that needed it
-- most. The older duplicates are cancelled — which is the status §B.1.2 gives a superseded check
-- anyway, and is honest: they are checks nothing was ever going to complete.

UPDATE check_runs c
   SET status = 'completed',
       conclusion = 'cancelled',
       completed_at = COALESCE(c.completed_at, now())
 WHERE c.status <> 'completed'
   AND EXISTS (
     SELECT 1 FROM check_runs newer
      WHERE newer.workspace_id = c.workspace_id
        AND newer.agent_id = c.agent_id
        AND newer.pr_number = c.pr_number
        AND newer.head_sha = c.head_sha
        AND newer.status <> 'completed'
        AND (newer.created_at, newer.id) > (c.created_at, c.id)
   );

CREATE UNIQUE INDEX check_runs_one_live_per_sha
  ON check_runs (workspace_id, agent_id, pr_number, head_sha)
  WHERE status <> 'completed';
