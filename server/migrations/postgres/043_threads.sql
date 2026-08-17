-- 043_threads — a build session becomes a row.
--
-- Today a conversation is implicit: it belongs to whichever agent the sidebar has selected, it
-- lives in a browser's memory, and a reload ends it. Everything a person would want to find again
-- afterwards — what they asked for, what it cost, what it left unapplied — is therefore reachable
-- only from the tab that was open at the time. This table is the first-class thing that replaces
-- it, and §1.1 is the reason it is worth a table at all: a thread is not a chat, it is a session
-- with SIDE EFFECTS, and the question the list has to answer is "what did this leave unresolved".
--
-- MANY THREADS PER AGENT, and that shape is the whole reason Threads and Agents are separate
-- destinations (§3.1). One `api_gateway` legitimately has a "Rate limiting" thread, an "OAuth
-- flow" thread and a "Fix the 429s" thread. A conversation keyed by agent could hold one.
--
-- `agent_id` IS NULLABLE FOR TWO DIFFERENT REASONS, and both are load-bearing:
--
--   BEFORE — a thread exists before any agent does (§3.1). Somebody describes an agent, reads a
--   plan, revises it twice, and has not pressed Generate. That is a real thread with real content
--   and real cost, and there is nothing for it to point at yet.
--
--   AFTER — an agent's deletion nulls it and keeps `agent_name_snapshot` (§3.2). The row then
--   renders as `stripe_webhook (deleted)` rather than "(agent deleted)", so the historical record
--   degrades not at all. That is the same discipline as branches never mutating their parent and
--   undo restoring from a snapshot: nothing is destroyed as a side effect of something else being
--   destroyed.
--
-- WHY THE FK IS ONE COLUMN AND NOT THE PAIR. Migration 018 added `UNIQUE (workspace_id, id)` on
-- `agents` so children could carry tenancy in their key, and every child since has. This one
-- cannot: the action it needs is ON DELETE SET NULL, and a composite SET NULL would have to null
-- `workspace_id` too, which is NOT NULL here and must be — the scope is the one column no row may
-- lose. So the tenancy half is the policy below plus the repository's own WHERE, and the FK is
-- what remains: a backstop, in the direction that keeps the thread. `detachAgent` in the thread
-- store is what actually fires on a delete, because it also writes the snapshot, which no
-- referential action could.
--
-- `status` IS A CACHE OF A DERIVATION, NEVER AN INPUT. §3.3 is explicit that status is computed
-- from things the server already knows — pending diffs, in-flight runs, failed steps, awaiting
-- plans — and is not a field a client may set. It is stored anyway, for two reasons: the list has
-- to be able to filter and order by it without recomputing five subqueries per row, and
-- `archived` is a state the derivation reads off THIS table. The rule that keeps the two honest is
-- that the deriver is the only writer, and a read that recomputes a different answer writes the
-- new one back rather than rendering the stale one.

CREATE TABLE threads (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id        uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  -- Null before an agent exists, and null again after one is deleted. See the header.
  agent_id            uuid REFERENCES agents(id) ON DELETE SET NULL,
  -- The name the thread was linked to, kept so nulling the FK erases nothing a person can read.
  agent_name_snapshot text,
  title               text NOT NULL,
  -- Set by a rename. Auto-titling from the first user message must never overwrite one (§5), and
  -- this column is the only thing that can tell the two apart after the fact.
  title_is_custom     boolean NOT NULL DEFAULT false,
  -- Attribution, for the Team-workspace author column (§4.3). Nullable, because a thread can be
  -- opened by server-side work — a reconciliation, an import — and inventing a person for it
  -- would put a name on a row nobody wrote.
  created_by          uuid REFERENCES users(id),
  created_at          timestamptz NOT NULL DEFAULT now(),
  -- The primary sort key for two of the three sections. NOT `updated_at`: it moves when the
  -- thread DOES something, not when a column is patched, so a rename does not push a thread to
  -- the top of a list ordered by when work last happened on it.
  last_activity_at    timestamptz NOT NULL DEFAULT now(),
  -- Null means active. §3.4: threads are never hard-deleted, so this is the only way one leaves
  -- the default list, and restore is clearing it.
  archived_at         timestamptz,
  status              text NOT NULL DEFAULT 'idle'
);

-- The five §3.3 statuses and nothing else. A sixth would be a colour this product does not have.
ALTER TABLE threads
  ADD CONSTRAINT threads_status_check
  CHECK (status IN ('needs_you', 'running', 'errored', 'idle', 'archived'));

-- The list query reads this, and the column order is the query's: one workspace, active or
-- archived, newest first. `archived_at` is in the middle rather than at the end because the
-- default list and the Archived filter are two halves of one index rather than two scans.
CREATE INDEX threads_ws_archived_activity
  ON threads (workspace_id, archived_at, last_activity_at DESC);

-- §4.3.4's collision marker reads this: every live thread against one agent. Scoped, so the count
-- is per workspace even though `agents.id` is globally unique — the marker is rendered from a
-- snapshot one workspace's socket asked for.
CREATE INDEX threads_agent ON threads (workspace_id, agent_id);

ALTER TABLE threads ENABLE ROW LEVEL SECURITY;
ALTER TABLE threads FORCE  ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON threads;
CREATE POLICY tenant_isolation ON threads
  USING      (workspace_id = NULLIF(current_setting('app.workspace_id', true), '')::uuid)
  WITH CHECK (workspace_id = NULLIF(current_setting('app.workspace_id', true), '')::uuid);

GRANT SELECT, INSERT, UPDATE, DELETE ON threads TO jaroku_app;
