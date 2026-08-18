-- 050_inbox — the SQLite half. Read the Postgres file for why the unique constraint on
-- `(workspace_id, dedupe_key)` is what makes forty failures one row, why resolution lives on the item
-- and dismissal lives per user, why `state` has two values rather than three, and why the child table
-- carries no `workspace_id` of its own.
--
-- Same translation as every migration on this driver: uuid -> TEXT, timestamptz -> TEXT ISO-8601,
-- jsonb -> TEXT holding JSON. Ids that Postgres defaults with `gen_random_uuid()` are supplied by the
-- store here, and so are the timestamps, because SQLite has no `now()` that writes the same string
-- shape the rest of the schema stores.
--
-- The CHECKs that are separate statements on Postgres are inline on the column, as 033, 034, 037 and
-- 043 already do, because SQLite has no `ALTER TABLE ... ADD CONSTRAINT`.
--
-- `count` IS A KEYWORD-SHAPED COLUMN NAME ON BOTH DRIVERS AND IS FINE ON BOTH. It is a function name,
-- not a reserved word, so neither dialect needs it quoted — worth stating because the instinct is to
-- rename it, and the name is the one the specification uses on the badge it renders as `×40`.
--
-- NO RLS, on this driver, ever — see 009. The repository layer's WHERE is the whole of the
-- enforcement here, which is why every method in the inbox store takes a context first.

CREATE TABLE inbox_items (
  id            TEXT PRIMARY KEY,
  workspace_id  TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  type          TEXT NOT NULL,
  severity      TEXT NOT NULL CHECK (severity IN ('blocking','attention','proposal')),
  subject_type  TEXT,
  subject_id    TEXT,
  dedupe_key    TEXT NOT NULL,
  payload       TEXT NOT NULL DEFAULT '{}',
  state         TEXT NOT NULL CHECK (state IN ('open','resolved')),
  count         INTEGER NOT NULL DEFAULT 1,
  first_seen_at TEXT NOT NULL,
  last_seen_at  TEXT NOT NULL,
  resolved_at   TEXT,
  UNIQUE (workspace_id, dedupe_key)
);

CREATE INDEX inbox_ws_state_sev ON inbox_items (workspace_id, state, severity, last_seen_at DESC);

CREATE INDEX inbox_ws_subject ON inbox_items (workspace_id, subject_type, subject_id);

CREATE TABLE inbox_item_user_state (
  item_id       TEXT NOT NULL REFERENCES inbox_items(id) ON DELETE CASCADE,
  user_id       TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  dismissed_at  TEXT,
  snoozed_until TEXT,
  PRIMARY KEY (item_id, user_id)
);

CREATE INDEX inbox_user_state_snoozed ON inbox_item_user_state (user_id, snoozed_until);
