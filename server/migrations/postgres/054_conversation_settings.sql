-- 054_conversation_settings — what a conversation remembers about how it talks to a model.
--
-- Two settings, one row, created lazily. The composer spec's §7 asks for reasoning effort and
-- permission mode per conversation, and the interesting decisions are all about what this table
-- deliberately is NOT.
--
-- IT IS NOT BACKFILLED. §7's migration note is explicit — "conversation_settings rows are created
-- lazily on first change, falling back to workspace defaults. Do not backfill a row per
-- conversation." A row per existing thread would be a few thousand rows asserting that everybody
-- has explicitly chosen the default, which is exactly the fact the absence of a row records. It
-- also makes "has anybody in this workspace ever touched the shield" answerable by a COUNT, and
-- it makes changing the workspace default actually change existing conversations rather than only
-- future ones.
--
-- THE PRIMARY KEY IS THE PAIR, NOT `conversation_id` ALONE. The spec's DDL writes
-- `workspace_id, conversation_id PRIMARY KEY`, and on this driver that has to be spelled as a
-- table-level constraint over both columns or it silently becomes a key on one. It matters for
-- the same reason the FK below is a pair: a single-column key would be satisfiable by a row from
-- another tenant that happened to reach this table through a code path that forgot its WHERE.
--
-- AND THE FOREIGN KEY IS THE PAIR TOO. §7's rule, stated as a rule: "Any FK that reaches an agent
-- must be on the composite pair (workspace_id, agent_id), not agents(id) alone — a bare agent FK
-- is satisfiable by any tenant's agent, which is precisely the class of bug the earlier tenancy
-- hunt turned up." A conversation is a `threads` row here, so the same reasoning applies to it,
-- and `threads` needs a unique constraint on the pair before anything can reference it.
--
-- WHY `conversation_id` RATHER THAN `thread_id`. The column name is the spec's and the table it
-- points at is ours. Renaming the spec's column would make every future reader diff two documents
-- to convince themselves they describe the same thing; renaming our table is a much larger change
-- for no gain. The REFERENCES clause is where the two vocabularies meet, once, in writing.
--
-- THE CHECK CONSTRAINTS ARE HERE AND ARE NOT A DEPARTURE FROM 052's REASONING. 052 left
-- `usage_events.kind` unconstrained because metered dimensions are open-ended and a new one should
-- be a constant rather than a deploy. These two sets are closed by design: §3.2 fixes four effort
-- levels, and §3.2 again says of the permission modes "Three modes only. There is no 'approve
-- everything' mode, and adding one later is a product decision, not an implementation shortcut."
-- A CHECK is how that sentence is enforced rather than merely written down.

-- `threads` is referenced by the pair below, so it needs a key on the pair to reference.
-- Redundant with its primary key on `id` alone, and that redundancy IS the tenancy guarantee:
-- it is what makes `(workspace_id, conversation_id)` a resolvable target rather than two
-- independent columns that happen to sit beside each other.
ALTER TABLE threads ADD CONSTRAINT threads_ws_id_unique UNIQUE (workspace_id, id);

CREATE TABLE conversation_settings (
  workspace_id      uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  conversation_id   uuid NOT NULL,

  -- NULL means "inherit the workspace default", which is not the same as any of the four levels
  -- and must not be collapsed into one. A row can exist because somebody set the permission mode
  -- while leaving effort alone, and writing 'medium' there would freeze that conversation at
  -- today's default forever.
  reasoning_effort  text CHECK (reasoning_effort IN ('low', 'medium', 'high', 'xhigh')),
  permission_mode   text CHECK (permission_mode  IN ('strict', 'smart', 'fast')),

  updated_by        uuid REFERENCES users(id) ON DELETE SET NULL,
  updated_at        timestamptz NOT NULL DEFAULT now(),

  PRIMARY KEY (workspace_id, conversation_id),
  FOREIGN KEY (workspace_id, conversation_id)
    REFERENCES threads (workspace_id, id) ON DELETE CASCADE
);

-- --- workspace defaults ---------------------------------------------------------------------
--
-- The other half of "falling back to workspace defaults". On `workspaces` rather than in a table
-- of its own: there is exactly one row per workspace either way, and a second table would need
-- its own lazy-creation rule and its own answer for what a missing row means.
--
-- `permission_fast_disallowed` is §3.2's pinning: "A workspace admin can pin the default and
-- disallow Fast; when pinned, the control renders read-only with a tooltip naming the policy."
-- It is a separate column from the default rather than a magic value in it, because "the default
-- is Smart" and "nobody may choose Fast" are different statements and an admin will want to make
-- the second without the first.
ALTER TABLE workspaces ADD COLUMN default_reasoning_effort   text
  CHECK (default_reasoning_effort IN ('low', 'medium', 'high', 'xhigh'));
ALTER TABLE workspaces ADD COLUMN default_permission_mode    text
  CHECK (default_permission_mode  IN ('strict', 'smart', 'fast'));
ALTER TABLE workspaces ADD COLUMN permission_mode_pinned     boolean NOT NULL DEFAULT false;
ALTER TABLE workspaces ADD COLUMN permission_fast_disallowed boolean NOT NULL DEFAULT false;

-- --- RLS ---------------------------------------------------------------------------------------
--
-- The workspace's own policy, directly, because the workspace id is a column here rather than
-- something reached through a parent. WITH CHECK as well as USING: without it a tenant can INSERT
-- a row belonging to another workspace and merely be unable to read it back afterwards.
ALTER TABLE conversation_settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE conversation_settings FORCE  ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON conversation_settings;
CREATE POLICY tenant_isolation ON conversation_settings
  USING      (workspace_id = NULLIF(current_setting('app.workspace_id', true), '')::uuid)
  WITH CHECK (workspace_id = NULLIF(current_setting('app.workspace_id', true), '')::uuid);
