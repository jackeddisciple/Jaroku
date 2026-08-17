-- 044_thread_items — what a thread OWNS, and where its cost is charged.
--
-- 043 made a build session a row. This is the row that says a plan, a generation, an edit proposal,
-- a run, an eval or a message belongs to that session rather than to whichever agent the sidebar
-- happened to have selected. Without it, §3.1's whole point is unreachable: one `api_gateway` with
-- three live threads has three pending diffs and nothing anywhere says which belongs to which.
--
-- A JOIN TABLE, NOT A COPY. `ref_id` points at something that already exists in its own table — a
-- run in `runs`, an eval in `eval_runs`, a proposal in the editor's own memory — and this row is
-- only the statement that it happened inside a particular session. That is why there is no `state`
-- column: whether a run is live is `runs.status`, whether an eval is finished is
-- `eval_runs.status`, and whether a proposal is still pending is the editor's, since a proposal
-- does not survive a restart and a durable row claiming one does would be a row that lies.
-- §3.3's derivation reads liveness from those owners and ownership from here, which is one source
-- of truth per fact rather than two that can disagree.
--
-- ONLY THE USER'S OWN TURNS ARE STORED AS `message`, and that is a decision rather than a gap. The
-- two things this feature reads a message for are §4.3's preview ("the last USER message, not
-- Jaroku's reply") and §5's title (the first one). Jaroku's own prose is streamed on the gen / edit
-- / reply channels and rebuilt into the conversation from them; persisting a second copy here would
-- make this table the transcript of record without anything reading it as one.
--
-- WHY `usage_events` GAINS A COLUMN RATHER THAN THIS TABLE GAINING A COST. Per-thread spend is
-- SUM(cost_usd) over the rows a thread caused, and most of those rows already name their cause:
-- an agent's own model calls carry `run_id`, and a run is joined to its thread here. The rows that
-- carry no run are exactly the platform's own thinking — `llm.plan`, `llm.generation`, `llm.edit`,
-- `llm.explain` — which happen in a thread and in nothing else. Those are what this column is for,
-- and it is nullable because every other kind of row still attributes through its run.
--
-- Nothing about the frozen trace schema moves for any of this. A run does not gain a field; the
-- statement that a run belongs to a session is a row over here (§7, §9).

CREATE TABLE thread_items (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  thread_id    uuid NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
  -- What kind of thing happened. A closed set, checked below, for the reason `usage.ts` names its
  -- kinds in one module: "which kind is this" should be a decision somebody makes while looking at
  -- every other kind, not a string typed at a call site.
  kind         text NOT NULL,
  -- The id in the table that owns the thing: `runs.id`, `eval_runs.id`, a plan id, a proposal id.
  -- NULL for a message, which owns itself. Deliberately `text` and not a uuid: a plan id and a
  -- proposal id are minted in memory and an eval id is `text` from migration 002, so a uuid column
  -- here would be a column three of the six kinds could not use.
  ref_id       text,
  -- 'user' on a message, NULL otherwise. A column rather than a second kind, because "who said it"
  -- is a property of a message and not a different sort of event.
  role         text,
  -- The message itself. NULL for every other kind — a run does not have prose.
  body         text,
  created_at   timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE thread_items
  ADD CONSTRAINT thread_items_kind_check
  CHECK (kind IN ('message', 'plan', 'generation', 'proposal', 'run', 'eval'));

-- The conversation, in order. Read to build a thread's preview and its first-message title.
CREATE INDEX thread_items_thread ON thread_items (workspace_id, thread_id, created_at);

-- The other direction, and the one the derivation uses: given every live run in the workspace,
-- which thread does each belong to. Without this that is a scan per snapshot.
CREATE INDEX thread_items_ref ON thread_items (workspace_id, kind, ref_id);

ALTER TABLE thread_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE thread_items FORCE  ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON thread_items;
CREATE POLICY tenant_isolation ON thread_items
  USING      (workspace_id = NULLIF(current_setting('app.workspace_id', true), '')::uuid)
  WITH CHECK (workspace_id = NULLIF(current_setting('app.workspace_id', true), '')::uuid);

GRANT SELECT, INSERT, UPDATE, DELETE ON thread_items TO jaroku_app;

-- Where the platform's own thinking is charged. See the header for why this is a column here and
-- not a total on `thread_items`.
ALTER TABLE usage_events ADD COLUMN thread_id uuid;

COMMENT ON COLUMN usage_events.thread_id IS
  'The build session that caused this call, for rows with no run to attribute through — the platform''s own plan / generation / edit / explain. NULL on every other kind, which is joined to its thread through run_id.';

-- AND NO INDEX ON IT, deliberately. The obvious `(workspace_id, thread_id)` was written here and
-- taken out again: `migrate:check` refuses an unqualified CREATE INDEX on this table because
-- building one takes a write lock for the whole build on the ledger every run writes to, and a
-- migration file cannot use CONCURRENTLY — the runner puts each file in one transaction. The read
-- this column serves is the same shape `spendByAgent` and `spendByRun` already are: filtered by
-- `workspace_id` first, which `usage_events_ws_occurred` already bounds, then grouped. So the index
-- would buy a per-workspace grouping what it already has, at the cost of an outage on deploy.

-- ONE THREAD PER EXISTING AGENT, so nothing that already happened is orphaned.
--
-- Every agent in the database gets the session it implicitly already had, titled with its own name
-- and dated by its most recent run rather than by now() — a backfilled thread must not sort above
-- one somebody used this morning. Soft-deleted agents are included on purpose: §3.2's whole
-- position is that a deleted agent's history survives, and skipping them here would be this
-- migration deciding otherwise for every agent deleted before it ran.
--
-- THE `FORCE` TOGGLE IS WHAT MAKES THIS RUN AT ALL, and it is worth stating rather than
-- discovering. 043 puts `FORCE ROW LEVEL SECURITY` on `threads`, which means the policy applies to
-- the table's OWNER too — and a backfill that spans every workspace has no single
-- `app.workspace_id` to set, so `WITH CHECK` would be false for every row and the INSERT would
-- write nothing. A superuser bypasses RLS and would not notice; a non-superuser owner running the
-- same migration in production would get an empty backfill and no error. Lifting FORCE for the two
-- statements and putting it straight back is the one honest way to write a cross-tenant backfill
-- into a policy-protected table, and it is scoped to this transaction like everything else here.
ALTER TABLE threads      NO FORCE ROW LEVEL SECURITY;
ALTER TABLE thread_items NO FORCE ROW LEVEL SECURITY;

INSERT INTO threads (workspace_id, agent_id, agent_name_snapshot, title, created_by,
                     created_at, last_activity_at, status)
SELECT a.workspace_id,
       a.id,
       COALESCE(a.display_name, a.slug),
       COALESCE(a.display_name, a.slug),
       a.created_by,
       a.created_at,
       -- `::timestamptz` ON BOTH SIDES OF THE COALESCE, and this is the one place the two dialects
       -- genuinely diverge rather than merely spelling a type differently.
       --
       -- `runs.started_at` is ISO-8601 `text` — deliberately, and 029 argues it at length, because
       -- the steps table is partitioned on it. `threads.last_activity_at` is `timestamptz`. SQLite
       -- has neither type and compares both as strings, so the same statement is correct there and
       -- is a planner error here: "COALESCE types text and timestamp with time zone cannot be
       -- matched". Postgres resolves a COALESCE to one common type and there is no implicit cast
       -- between those two, by design — an implicit text→timestamp cast is exactly how a badly
       -- formatted string becomes a silently wrong date somewhere else.
       --
       -- The cast is INSIDE the aggregate rather than around it. `MAX` over the text column is a
       -- lexicographic maximum, which happens to agree with chronological order for UTC ISO-8601
       -- and stops agreeing the moment a row carries an offset — so the aggregate is given real
       -- timestamps and asked for the latest one, which is what this actually means.
       COALESCE((SELECT MAX(r.started_at::timestamptz) FROM runs r
                  WHERE r.workspace_id = a.workspace_id AND r.agent_id = a.slug),
                a.created_at),
       'idle'
  FROM agents a
  -- An agent that somehow already has a thread is left alone. 043 shipped before this file, so a
  -- deployment that ran the app between the two has real threads in it, and a second one per agent
  -- would split one session's history across two rows.
 WHERE NOT EXISTS (SELECT 1 FROM threads t
                    WHERE t.workspace_id = a.workspace_id AND t.agent_id = a.id);

-- And the runs those agents did, bound to it. This is what makes a backfilled thread carry its own
-- cost and its own failures rather than being an empty row with a name: the derivation reads
-- liveness and outcome from `runs`, and it can only find them through a row here.
--
-- `runs.agent_id` is the SLUG, not the uuid — it predates migration 008 and still names the
-- directory. That is why this join is on `a.slug` and the one above is on `a.id`.
--
-- The OLDEST thread for the agent, rather than any of them: the row above was dated with the
-- agent's own `created_at`, so it is the earliest by construction, and a workspace with a
-- hand-made thread from between the two migrations keeps that thread's own contents to itself.
-- `r.started_at::timestamptz` again, for the same reason as above. Postgres would accept the bare
-- text here — an assignment into a column is allowed an I/O conversion where an expression is not —
-- but relying on that would leave the two statements in this file disagreeing about whether the
-- conversion is worth writing down, and the next reader would have to work out which is which.
INSERT INTO thread_items (workspace_id, thread_id, kind, ref_id, created_at)
SELECT r.workspace_id, t.id, 'run', r.id, r.started_at::timestamptz
  FROM runs r
  JOIN agents a ON a.workspace_id = r.workspace_id AND a.slug = r.agent_id
  JOIN threads t ON t.id = (SELECT t2.id FROM threads t2
                             WHERE t2.workspace_id = a.workspace_id AND t2.agent_id = a.id
                             ORDER BY t2.created_at ASC, t2.id ASC
                             LIMIT 1);

ALTER TABLE threads      FORCE ROW LEVEL SECURITY;
ALTER TABLE thread_items FORCE ROW LEVEL SECURITY;
