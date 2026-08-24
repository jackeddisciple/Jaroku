-- 055_turn_attachments — the SQLite half. Read the Postgres file for every decision: why the row
-- exists at all when the composer already knows what it attached, why `ref` is one JSON column
-- rather than fifteen mostly-NULL ones, why the foreign key is the workspace/turn PAIR, and why
-- `token_estimate` is a number the server computed rather than one a client sent.
--
-- Same translation as every migration on this driver: uuid -> TEXT, timestamptz -> TEXT holding
-- ISO-8601 UTC, jsonb -> TEXT holding JSON. Ids and timestamps Postgres would default are supplied
-- by the repository on both drivers, so a row from either is the same shape in JavaScript.
--
-- `jsonb` BECOMES `TEXT`, AND THAT IS THE TRANSLATION MOST LIKELY TO BITE. On Postgres the driver
-- hands back a parsed object; here it hands back a string. Every read of `ref` goes through
-- `jsonFromColumn(dialect, …)` for exactly that reason — the helper exists because the same query,
-- the same code and a different driver produce different JavaScript types, and a `.path` on a
-- string is `undefined` rather than an error.
--
-- IT ALSO MEANS NO `LIKE` ON THIS COLUMN, EVER. On Postgres `ref` is json and `LIKE` is a string
-- function spelled as an operator, so a search written against SQLite's TEXT would be a runtime
-- error on the production driver and green in every local suite. That is one of the four dialect
-- bugs that cost four red CI runs in a row; `test:timestamp-text` and `test:boolean-literals`
-- stand in for the Postgres this machine does not have.
--
-- The CHECK that is a separate statement on Postgres is inline on the column, as 033, 034, 037,
-- 043 and 054 already do, because SQLite has no `ALTER TABLE ... ADD CONSTRAINT` — which is also
-- why the unique constraint the Postgres file adds to `thread_items` is a UNIQUE INDEX here.
--
-- NO RLS, on this driver, ever — see 009. The repository layer's WHERE is the whole of the
-- enforcement, which is why every method in the attachment store takes a context first.

CREATE UNIQUE INDEX thread_items_ws_id_unique ON thread_items (workspace_id, id);

CREATE TABLE turn_attachments (
  id             TEXT PRIMARY KEY,
  workspace_id   TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  turn_id        TEXT NOT NULL,

  kind           TEXT NOT NULL
    CHECK (kind IN ('file', 'run', 'dataset_case', 'tool_schema', 'github')),

  -- The RESOLVED reference, as JSON text. Shapes per kind are in the Postgres file.
  ref            TEXT NOT NULL,

  resolved_at    TEXT NOT NULL,
  token_estimate INTEGER NOT NULL DEFAULT 0,

  FOREIGN KEY (workspace_id, turn_id)
    REFERENCES thread_items (workspace_id, id) ON DELETE CASCADE
);

CREATE INDEX turn_attachments_turn ON turn_attachments (workspace_id, turn_id, resolved_at);
