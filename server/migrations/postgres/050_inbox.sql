-- 050_inbox — what is waiting on somebody, as rows that die on their own.
--
-- THE FOURTH DESTINATION, AND THE ONLY ONE THAT SHRINKS. Threads is the conversation, Agents is the
-- artifact, Activity is what happened. This is what is waiting on you, and the difference from
-- Activity is the whole reason it is a table rather than a query over one: Activity is passive,
-- chronological and complete, so it can be a view over rows that already exist. An Inbox is
-- prioritised and actionable and gets SMALLER as somebody works, which means it has to hold a state
-- nothing else in this schema holds — "this problem is still true" — and has to be able to stop
-- holding it without anybody pressing anything.
--
-- LAW 3 IS THE UNIQUE CONSTRAINT, and it is the reason `dedupe_key` is a column rather than a
-- derivation. Forty failed runs of one agent is ONE item with a count of forty, never forty rows,
-- and the collapse happens at WRITE time in the database rather than at render time in a client.
-- Grouping in the client would mean every connected browser deriving the same grouping from the same
-- forty rows, forty rows crossing every socket to say one thing, and — the part that actually bites —
-- two clients disagreeing about the count the sidebar badge is drawn from. `UNIQUE (workspace_id,
-- dedupe_key)` turns the collapse into an ON CONFLICT clause: the generator writes the same key every
-- time and the row's `count` moves.
--
-- IT IS SCOPED BY WORKSPACE AND NOT GLOBAL, which matters because a dedupe key is a string somebody
-- composes out of a type and a subject — `unreviewed_failures:<agent uuid>` — and a uuid collision
-- across tenants is not the risk. The risk is the key that legitimately does not carry an id at all:
-- `setup_api_key` is one per workspace and its key is the type name. Unscoped, the first workspace to
-- be seeded would own it for everybody.
--
-- TWO TABLES, BECAUSE RESOLUTION IS SHARED AND DISMISSAL IS PERSONAL. A missing credential is a fact
-- about the workspace: it is missing for everybody, it is fixed for everybody, and a teammate setting
-- it has to clear it from every board in the workspace without any of those people having touched it.
-- Dismissing is the opposite — "I don't care about this instance" is one person's judgement, and
-- writing it onto the shared row would hide the item from a colleague who does care. So `state` lives
-- on the item and `dismissed_at` / `snoozed_until` live per user, and no column is on both.
--
-- `state` IS TWO VALUES AND NOT THREE. A dismissed item is not a third state, because dismissal is
-- per user and there is no such thing as a row that is dismissed; there is a row somebody has
-- dismissed. Putting `dismissed` in this CHECK would make the shared row carry one person's decision,
-- which is the exact confusion the second table exists to prevent.
--
-- `payload` CARRIES NAMES, IDS, COUNTS AND SHORT SUMMARIES — never a value. It is stored here and
-- rendered into every connected client's snapshot, so it travels the same path that made unbounded
-- MCP advertisement text a problem in v0.2.1, and the same discipline applies: bounded, stripped of
-- raw newlines, and put through the redaction filter build logs already use. A credential item
-- carries the NAME of the missing credential, which is what the card has to render, and there is no
-- field on the shape a value could live in — the same property `AgentCardView` has.
--
-- WHY THERE IS NO `dismissed_by_everyone` OR ANY OTHER ROLL-UP. The count of what is open is per
-- person by construction — it is the shared rows minus this person's dismissals minus this person's
-- live snoozes — and a cached total would be a second answer that goes stale the moment anybody
-- dismisses anything. The sidebar badge is drawn from the same per-person read the board is.

CREATE TABLE inbox_items (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id  uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  -- The registry's key. Deliberately not a CHECK constraint over the sixteen names: the registry in
  -- `inbox/registry.ts` is the one definition of what a type IS — its trigger, its resolve predicate,
  -- its severity, its icon and its actions — and a CHECK here would be a seventeenth copy of the list
  -- that a migration has to be written to extend. The registry is what refuses an unknown type, at
  -- the one place a row is written.
  type          text NOT NULL,
  severity      text NOT NULL CHECK (severity IN ('blocking','attention','proposal')),
  -- What the item is ABOUT — 'agent', 'mcp_server', 'deployment', 'eval', 'workspace'. Nullable as a
  -- pair, because two of the sixteen types are about the workspace itself and have nothing to point
  -- at: an onboarding item's subject is the workspace, which is already `workspace_id`.
  subject_type  text,
  subject_id    uuid,
  dedupe_key    text NOT NULL,
  payload       jsonb NOT NULL DEFAULT '{}',
  state         text NOT NULL CHECK (state IN ('open','resolved')),
  -- Law 3's number. One row, forty failures. `1` rather than `0` because a row exists because
  -- something happened once.
  count         integer NOT NULL DEFAULT 1,
  first_seen_at timestamptz NOT NULL DEFAULT now(),
  -- Moved by every re-observation, and the reason it is separate from `first_seen_at`: the age bar
  -- under a card fills from when the problem STARTED, and the board's secondary sort is by when it
  -- was last true. A single timestamp would have to be one or the other.
  last_seen_at  timestamptz NOT NULL DEFAULT now(),
  -- Set when the resolve predicate stopped being true. Kept rather than deleted so a resolution can
  -- be undone within the toast's window, and so "cleared 14 items this week" is a count of rows
  -- rather than of nothing.
  resolved_at   timestamptz,
  UNIQUE (workspace_id, dedupe_key)
);

-- The board's read, and the column order is the read's: one workspace, what is open, by severity,
-- newest first. `state` before `severity` because every query filters on it and only the column
-- rail groups by severity — an index that led with severity would be scanned three times to answer
-- a board that asks once.
CREATE INDEX inbox_ws_state_sev ON inbox_items (workspace_id, state, severity, last_seen_at DESC);

-- §5.7's pointer strip and the left rail's per-agent breakdown: every item about one subject. Scoped,
-- like every index in this schema, because the count rendered on an agent's detail header is a count
-- inside the workspace whose socket asked for it.
CREATE INDEX inbox_ws_subject ON inbox_items (workspace_id, subject_type, subject_id);

-- --- per-user state ---------------------------------------------------------------------------
--
-- NO `workspace_id` OF ITS OWN, and that is the same decision `agent_versions` made in 009: the
-- column would be a second copy of a fact the parent row already carries, and a copy that can
-- disagree with its parent is worse than a join. The policy below follows the parent rather than
-- duplicating the scope, so a dismissal can never out-scope the item it is about.

CREATE TABLE inbox_item_user_state (
  item_id       uuid NOT NULL REFERENCES inbox_items(id) ON DELETE CASCADE,
  user_id       uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  -- "I don't care about this instance." Never returns for this person, and never hides it from
  -- anybody else. Cleared by undo.
  dismissed_at  timestamptz,
  -- "Not now." Returns on the timer, which is the whole difference from dismissal — and the reason
  -- snooze is not optional: without it people dismiss things they actually care about, and the board
  -- starts hiding real problems.
  snoozed_until timestamptz,
  PRIMARY KEY (item_id, user_id)
);

-- The snooze tray's read: one person's snoozed rows, and which returns next. The primary key leads
-- with `item_id`, which answers the board's join and cannot answer this one — a tray that scanned
-- every dismissal in the workspace to find four snoozes would be a strip at the bottom of the screen
-- costing a table scan on every render.
CREATE INDEX inbox_user_state_snoozed ON inbox_item_user_state (user_id, snoozed_until);

-- --- row-level security -----------------------------------------------------------------------

ALTER TABLE inbox_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE inbox_items FORCE  ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON inbox_items;
CREATE POLICY tenant_isolation ON inbox_items
  USING      (workspace_id = NULLIF(current_setting('app.workspace_id', true), '')::uuid)
  WITH CHECK (workspace_id = NULLIF(current_setting('app.workspace_id', true), '')::uuid);

-- The child's policy is its parent's, reached through the foreign key — exactly the shape
-- `agent_versions` takes, and for the same reason. WITH CHECK as well as USING, because without it
-- somebody could write a dismissal against another workspace's item and simply not be able to read
-- it back, which is a write across the boundary and still a hole.
ALTER TABLE inbox_item_user_state ENABLE ROW LEVEL SECURITY;
ALTER TABLE inbox_item_user_state FORCE  ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON inbox_item_user_state;
CREATE POLICY tenant_isolation ON inbox_item_user_state
  USING (EXISTS (
    SELECT 1 FROM inbox_items i
     WHERE i.id = inbox_item_user_state.item_id
       AND i.workspace_id = NULLIF(current_setting('app.workspace_id', true), '')::uuid))
  WITH CHECK (EXISTS (
    SELECT 1 FROM inbox_items i
     WHERE i.id = inbox_item_user_state.item_id
       AND i.workspace_id = NULLIF(current_setting('app.workspace_id', true), '')::uuid));

GRANT SELECT, INSERT, UPDATE, DELETE ON inbox_items           TO jaroku_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON inbox_item_user_state TO jaroku_app;
