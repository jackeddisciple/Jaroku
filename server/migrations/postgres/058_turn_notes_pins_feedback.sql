-- 058_turn_notes_pins_feedback — §5.2, §5.3 and §5.5.
--
-- Three tables in one migration because they are one feature: the things a person does to a turn
-- after reading it. They are also three deliberately DIFFERENT shapes, and the differences are the
-- design rather than an inconsistency.
--
-- NOTES ARE SHARED. PINS ARE PERSONAL. §5.3 states it and gives the reason: "Two people debugging
-- the same thread care about different anchors. (Notes are shared; pins are personal — keep this
-- distinction, it's the reason both exist.)" So `turn_notes` has an author and is visible to the
-- workspace, while `turn_pins` has `user_id` IN ITS PRIMARY KEY. §12.20 is the assertion: "user A's
-- pin is invisible to user B in the same conversation."
--
-- WHY NOTES EXIST AT ALL, since Jaroku has real multi-tenancy and no collaboration layer inside a
-- conversation: "A teammate opening a thread has no way to know 'we tried this prompt shape, it
-- broke the retry path, don't redo it.' That knowledge currently lives in Slack, detached from the
-- artifact it's about." This table is that, and only that — §13 puts mentions, threading and
-- reactions explicitly out of scope, because "a comment system is a product, and this is
-- deliberately an annotation."
--
-- `deleted_at` RATHER THAN A DELETE. A note is somebody's words about a turn, and §5.2 gives
-- Edit/Delete to the author — but a hard delete would take the row out from under a teammate who
-- is reading it, mid-sentence, with no trace that anything was there. Soft delete also keeps "was
-- there ever a warning on this turn?" answerable, which is the question asked after something went
-- wrong.
--
-- NOTES SURVIVE REGENERATION (§5.2, §12.19): "a note is attached to the turn, not to a specific
-- response variant." So the foreign key is to `thread_items` and NOT to `turn_variants`. That is
-- the whole of the mechanism — annotating variant 2 and having the note vanish when somebody
-- switched back to variant 1 would be the failure, and a FK to the variant is how it would happen.
--
-- FEEDBACK IS ONE ROW PER (TURN, USER), which is §5.5's "Mutually exclusive; clicking the active
-- one clears it. One record per (turn, user)." The primary key is that sentence. `rating` is a
-- smallint checked to -1 or 1 rather than a boolean, because a boolean has no way to spell
-- "cleared" other than deleting the row — which is exactly what clearing does here, and a boolean
-- would have made "no opinion" and "thumbs down" the same absence.
--
-- `reasons` IS AN ARRAY BECAUSE THE PICKER IS MULTI-SELECT (§5.5). A join table for five fixed
-- strings would be a table, an index and a join to answer a question one column answers.
--
-- THE FOREIGN KEY IS THE PAIR ON ALL THREE — §7's rule. A bare `thread_items(id)` reference is
-- satisfiable by any tenant's turn.

-- --- §5.2 notes: shared, workspace-visible, RLS-enforced ---------------------------------------

CREATE TABLE turn_notes (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  turn_id      uuid NOT NULL,
  author_id    uuid REFERENCES users(id) ON DELETE SET NULL,
  -- Plain text plus inline code, per §5.2. Not markdown, and not HTML: a note is an annotation,
  -- and a renderer here would be a second content pipeline to keep safe.
  body         text NOT NULL,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now(),
  -- Soft delete — see the header.
  deleted_at   timestamptz,

  FOREIGN KEY (workspace_id, turn_id)
    REFERENCES thread_items (workspace_id, id) ON DELETE CASCADE
);

-- §5.2: "Multiple notes per turn, ascending by time." The index is that read.
CREATE INDEX turn_notes_turn ON turn_notes (workspace_id, turn_id, created_at);

-- --- §5.3 pins: PERSONAL, and the user is in the key -------------------------------------------

CREATE TABLE turn_pins (
  workspace_id    uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  conversation_id uuid NOT NULL,
  turn_id         uuid NOT NULL,
  user_id         uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at      timestamptz NOT NULL DEFAULT now(),

  -- THE USER IS IN THE PRIMARY KEY, which is §5.3's "Pins are per user, not shared" expressed as a
  -- constraint rather than as a WHERE somebody has to remember. Two people can pin the same turn
  -- and neither can see the other's.
  PRIMARY KEY (workspace_id, turn_id, user_id),
  FOREIGN KEY (workspace_id, turn_id)
    REFERENCES thread_items (workspace_id, id) ON DELETE CASCADE,
  FOREIGN KEY (workspace_id, conversation_id)
    REFERENCES threads (workspace_id, id) ON DELETE CASCADE
);

-- The rail's read: one person's pins in one conversation. `conversation_id` is denormalised onto
-- this table for exactly that — the alternative is joining through `thread_items` on every render
-- of a rail that is drawn at the top of every thread.
CREATE INDEX turn_pins_rail ON turn_pins (workspace_id, conversation_id, user_id, created_at);

-- --- §5.5 feedback: one row per (turn, user) ---------------------------------------------------

CREATE TABLE turn_feedback (
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  turn_id      uuid NOT NULL,
  user_id      uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  -- -1 or 1. See the header for why this is not a boolean.
  rating       smallint NOT NULL CHECK (rating IN (-1, 1)),
  -- §5.5's multi-select picker. Empty for a thumbs up, which asks nothing.
  reasons      text[] NOT NULL DEFAULT '{}',
  -- The optional free-text line. §5.5: visible to workspace admins and the author only, which is
  -- enforced at the route rather than here — RLS scopes to the workspace, and "admins only" is a
  -- capability question the policy layer cannot see.
  comment      text,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now(),

  PRIMARY KEY (workspace_id, turn_id, user_id),
  FOREIGN KEY (workspace_id, turn_id)
    REFERENCES thread_items (workspace_id, id) ON DELETE CASCADE
);

-- §5.5: "Feedback is workspace-visible in aggregate (counts on the turn)". This is that count.
CREATE INDEX turn_feedback_turn ON turn_feedback (workspace_id, turn_id);

-- --- RLS ---------------------------------------------------------------------------------------
--
-- The workspace's own policy on all three, because the workspace id is a column on each rather
-- than something reached through a parent. WITH CHECK as well as USING: without it a tenant can
-- INSERT a row belonging to another workspace and merely be unable to read it back.
--
-- NOTE WHAT THIS DOES NOT DO. RLS scopes to the WORKSPACE; it does not make a pin private to a
-- user. That is the primary key's job and the repository's WHERE, and §12.20 is asserted against
-- those rather than against a policy — a policy keyed on the current user would need the user id
-- in a session variable, which this schema deliberately does not carry.
ALTER TABLE turn_notes ENABLE ROW LEVEL SECURITY;
ALTER TABLE turn_notes FORCE  ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON turn_notes;
CREATE POLICY tenant_isolation ON turn_notes
  USING      (workspace_id = NULLIF(current_setting('app.workspace_id', true), '')::uuid)
  WITH CHECK (workspace_id = NULLIF(current_setting('app.workspace_id', true), '')::uuid);

ALTER TABLE turn_pins ENABLE ROW LEVEL SECURITY;
ALTER TABLE turn_pins FORCE  ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON turn_pins;
CREATE POLICY tenant_isolation ON turn_pins
  USING      (workspace_id = NULLIF(current_setting('app.workspace_id', true), '')::uuid)
  WITH CHECK (workspace_id = NULLIF(current_setting('app.workspace_id', true), '')::uuid);

ALTER TABLE turn_feedback ENABLE ROW LEVEL SECURITY;
ALTER TABLE turn_feedback FORCE  ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON turn_feedback;
CREATE POLICY tenant_isolation ON turn_feedback
  USING      (workspace_id = NULLIF(current_setting('app.workspace_id', true), '')::uuid)
  WITH CHECK (workspace_id = NULLIF(current_setting('app.workspace_id', true), '')::uuid);
