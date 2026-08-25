-- 058_turn_notes_pins_feedback — the SQLite half. Read the Postgres file for every decision: why
-- notes are shared and pins are personal, why the user id is in the pin's primary key rather than
-- in a WHERE somebody has to remember, why a note is soft-deleted, why notes hang off the TURN and
-- never off a variant, why `rating` is a checked smallint rather than a boolean, and what RLS does
-- and does not do here.
--
-- Same translation as every migration on this driver: uuid -> TEXT, timestamptz -> TEXT holding
-- ISO-8601 UTC, smallint -> INTEGER. Ids and timestamps Postgres would default are supplied by the
-- repository, because SQLite has no `now()` that writes the same string shape the rest of the
-- schema stores.
--
-- `text[]` HAS NO SQLITE EQUIVALENT AND BECOMES JSON TEXT, which is the one translation here that
-- is not mechanical. `reasons` is a multi-select of five fixed strings, so on this driver it is a
-- JSON array in a TEXT column, read back through `jsonFromColumn` exactly as `turn_attachments.ref`
-- is — the helper exists because the same query and the same code produce a parsed value on one
-- driver and a string on the other, and a `.length` on a string is a number that means nothing.
--
-- WHICH ALSO MEANS NO `LIKE` AND NO array containment ON THIS COLUMN, EVER. Postgres has `= ANY`
-- and SQLite has neither; a query written against one is a runtime error on the other and green in
-- every local suite. That is one of the four dialect bugs that cost four red CI runs in a row.
-- Filtering by reason happens in TypeScript, over a list that is at most five long.
--
-- The CHECK that is a separate statement on Postgres is inline on the column, because SQLite has
-- no `ALTER TABLE ... ADD CONSTRAINT`.
--
-- NO RLS, on this driver, ever — see 009. The repository layer's WHERE is the whole of the
-- enforcement, which is why every method in these stores takes a context first — and why the pin's
-- per-user privacy is a primary key and a WHERE rather than a policy.

-- --- §5.2 notes -------------------------------------------------------------------------------

CREATE TABLE turn_notes (
  id           TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  turn_id      TEXT NOT NULL,
  author_id    TEXT REFERENCES users(id) ON DELETE SET NULL,
  body         TEXT NOT NULL,
  created_at   TEXT NOT NULL,
  updated_at   TEXT NOT NULL,
  deleted_at   TEXT,

  FOREIGN KEY (workspace_id, turn_id)
    REFERENCES thread_items (workspace_id, id) ON DELETE CASCADE
);

CREATE INDEX turn_notes_turn ON turn_notes (workspace_id, turn_id, created_at);

-- --- §5.3 pins: the user is in the key --------------------------------------------------------

CREATE TABLE turn_pins (
  workspace_id    TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  conversation_id TEXT NOT NULL,
  turn_id         TEXT NOT NULL,
  user_id         TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at      TEXT NOT NULL,

  PRIMARY KEY (workspace_id, turn_id, user_id),
  FOREIGN KEY (workspace_id, turn_id)
    REFERENCES thread_items (workspace_id, id) ON DELETE CASCADE,
  FOREIGN KEY (workspace_id, conversation_id)
    REFERENCES threads (workspace_id, id) ON DELETE CASCADE
);

CREATE INDEX turn_pins_rail ON turn_pins (workspace_id, conversation_id, user_id, created_at);

-- --- §5.5 feedback ----------------------------------------------------------------------------

CREATE TABLE turn_feedback (
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  turn_id      TEXT NOT NULL,
  user_id      TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  rating       INTEGER NOT NULL CHECK (rating IN (-1, 1)),
  -- A JSON array as TEXT — see the header for why, and for why nothing ever queries into it.
  reasons      TEXT NOT NULL DEFAULT '[]',
  comment      TEXT,
  created_at   TEXT NOT NULL,
  updated_at   TEXT NOT NULL,

  PRIMARY KEY (workspace_id, turn_id, user_id),
  FOREIGN KEY (workspace_id, turn_id)
    REFERENCES thread_items (workspace_id, id) ON DELETE CASCADE
);

CREATE INDEX turn_feedback_turn ON turn_feedback (workspace_id, turn_id);
