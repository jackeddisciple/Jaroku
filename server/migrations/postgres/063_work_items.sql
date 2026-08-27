-- 063_work_items — a job somebody gave a deployed agent, and what became of it.
--
-- THE COCKPIT'S ONE TABLE. Part 1 made a deployed run an ordinary traced run, so `runs` and `steps`
-- already hold what happened; what nothing in this schema held is what was ASKED FOR, by whom, of
-- which deployment, and whether it is still waiting on a person. A row here is that request. It is
-- not a second trace and it never becomes one — it LINKS to the trace, through `run_id`, and every
-- number the Cockpit renders about money or duration is derived from `steps` through the existing
-- aggregation rather than copied here.
--
-- `created_by` IS NOT NULL, AND IT IS THE COLUMN `runs` NEVER HAD. "Who gave this agent a job" is
-- the question the whole tab exists to answer, and the Activity tab already demonstrates what a
-- nullable actor costs: two of its five feed columns are honestly-but-uselessly unattributed,
-- because the rows they read were written by code that had no person to name. Every path that
-- writes a row here has one — a person pressed dispatch — so the column is NOT NULL from the first
-- migration rather than nullable-for-now. A scheduled item (Part 3, §17.1) is deliberately NOT the
-- exception that would loosen this: the actor of a scheduled item is the person who created the
-- SCHEDULE, which is a real user id, and the schedule it came from would be a column beside this
-- one rather than a null in it.
--
-- `run_id` IS NULLABLE ONLY BETWEEN INSERT AND DISPATCH, and non-null forever after. The row is
-- written BEFORE anything leaves the process — the same discipline `eval_jobs` and `deployments`
-- both hold, and for the same reason: a deploy or a dispatch creates something in somebody else's
-- account and can be interrupted at any point, so a record that only appears on success turns a
-- crash into money spent with nothing in Jaroku knowing it was spent. The run id is minted first
-- and written with the row, so the window where this is null is a few statements wide and exists
-- only for a row that never reached the container at all.
--
-- IT IS DELIBERATELY NOT A FOREIGN KEY TO `runs`. Retention sweeps `runs` on the plan's window and
-- this table on `ended_at`, and the two windows are not the same window — an FK would either
-- cascade a work item away with the trace it points at, or refuse the sweep. What a dangling
-- `run_id` costs is one honest sentence in the detail panel ("the trace for this job has been
-- swept"); what an FK costs is either half the operational record or a retention sweep that fails.
--
-- THERE IS NO cost, tokens OR duration COLUMN, and that is the sharpest decision in this file.
-- `runs.cost` is written by `run_end`, so a run that crashed mid-graph reads 0 while its steps
-- record real money already spent — which is the exact bug `evalAggregate.ts`'s header opens with
-- and the reason `pricing.json` exists at all. A cost column here would be `runs.cost` a second
-- time, wrong in the same case, and drifting from the figure everything else in the product shows.
-- The Cockpit sums `steps`, like the eval dashboard and the billing ledger do.
--
-- `deployment_id` IS A HARD FK to the deployment that actually ran it, `text` because
-- `deployments.id` is text from migration 002 and a uuid here could not reference it. A later
-- redeploy must not rewrite the history of what ran: "this job failed on v7" stays true after v8
-- ships, which is only true if the row names the deployment rather than the agent's current one.
--
-- `input` IS CAPPED AT 65,536 BYTES AT WRITE TIME, matching `MAX_BODY_BYTES` in http/router.ts.
-- The cap is enforced in the store rather than as a CHECK, for the reason §6 gives: refuse at the
-- composer, where somebody can shorten what they typed, not at the container, where the refusal is
-- an HTTP status attached to a job that already has a row.
--
-- `workspace_id` LEADS EVERY INDEX, which is this schema's rule everywhere and is load-bearing
-- here: every read the Cockpit makes is one workspace's work, and an index that led with status or
-- with the actor would be scanned across every tenant to answer a question about one.

CREATE TABLE work_items (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id  uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  agent_id      uuid NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  -- The deployment this ran on, not the agent's current one. See the header.
  deployment_id text NOT NULL REFERENCES deployments(id),
  -- The trace. Null only between insert and dispatch; not an FK — see the header.
  run_id        text,
  created_by    uuid NOT NULL REFERENCES users(id),
  input         text NOT NULL,
  -- A closed set of six, as a CHECK rather than as a registry the way `inbox_items.type` is. The
  -- difference is that an item TYPE is a definition with a trigger, a predicate, an icon and a set
  -- of actions behind it — sixteen of them, extended by writing code — whereas these six are the
  -- whole lifecycle of a job and adding a seventh would be a change to what a job IS. A CHECK on
  -- six values is one line; a seventeenth copy of a sixteen-name list is a migration nobody wants.
  --
  -- `waiting` MEANS A PERSON HAS TO ANSWER SOMETHING, and it is here because Part 1 made it
  -- reachable: a deployed run that hits a high-impact MCP tool parks on the confirmation gate and
  -- stops. If that were not reachable this state would not exist, because a status nothing can
  -- enter is a status that lies about what the product can do.
  --
  -- `cancelled` MEANS GENUINELY CANCELLED AT A NODE BOUNDARY. Part 1's cancel asks the container to
  -- stop and the run emits its own `run_end`; it is not "we stopped listening", which is what this
  -- word would have meant before the control action existed and which now has its own failure kind.
  status        text NOT NULL CHECK (status IN
                  ('queued','running','waiting','succeeded','failed','cancelled')),
  output        text,
  error         text,
  -- Why it failed, as a value rather than a sentence, because the six are acted on differently and
  -- the Cockpit renders them differently: `unauthorised` is the only one with a button attached.
  -- Null for anything that did not fail.
  --
  -- `stopped_reporting` IS NOT `failed` AND MUST NEVER BE WORDED AS ONE. Part 1's reconciliation
  -- closes out a container that went quiet past its ceiling; the container may have completed, and
  -- it may have spent money. Saying "failed" there is a confident claim about somebody's bill that
  -- nothing in this system is in a position to make.
  failure_kind  text CHECK (failure_kind IN
                  ('unauthorised','agent_error','rejected','unreachable','stopped_reporting','busy')),
  created_at    timestamptz NOT NULL DEFAULT now(),
  -- When the container accepted it. Null while queued, and never a guess at when it will start.
  started_at    timestamptz,
  -- What retention sweeps on. Never `created_at` — an item running for six months is a stuck job,
  -- not old data, and sweeping it would remove the one row saying a container is still spending.
  ended_at      timestamptz,
  -- Insertion order, breaking the `created_at` tie, for the reason `deployments.created_seq`
  -- exists: an ISO timestamp has millisecond resolution, and two dispatches in the same
  -- millisecond made "the most recent" whichever row the database happened to return first. This
  -- list is ordered on every read the tab makes, so a coin flip there is rows that move under a
  -- cursor while somebody is looking at them.
  created_seq   integer NOT NULL DEFAULT 0
);

-- The work list's own read: one workspace, newest first. Every other index below is this one
-- narrowed by the thing a filter names.
CREATE INDEX work_items_ws_created ON work_items (workspace_id, created_at DESC);

-- The status filter, and the badge. `waiting` is counted on every snapshot and on connect, so it
-- is the one read that happens whether or not anybody opens the tab.
CREATE INDEX work_items_ws_status  ON work_items (workspace_id, status);

-- The Agent-detail pointer strip, and the Cockpit filtered to one agent from it.
CREATE INDEX work_items_ws_agent   ON work_items (workspace_id, agent_id, created_at DESC);

-- §8's "mine" filter, which is the DEFAULT view — the operator's first question is about their own
-- jobs — so this index answers the read that happens most rather than the one somebody toggles to.
CREATE INDEX work_items_ws_actor   ON work_items (workspace_id, created_by, created_at DESC);
