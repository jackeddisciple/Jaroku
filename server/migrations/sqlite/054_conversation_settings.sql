-- 054_conversation_settings — the SQLite half. Read the Postgres file for every decision: why no
-- row is backfilled, why the primary key and the foreign key are both the workspace/conversation
-- PAIR, why NULL is a real value distinct from every effort level, why the CHECK constraints are
-- here when 052 deliberately left `usage_events.kind` unconstrained, and why the workspace
-- defaults live on `workspaces` rather than in a table of their own.
--
-- Same translation as every migration on this driver: uuid -> TEXT, timestamptz -> TEXT holding
-- ISO-8601 UTC, boolean -> INTEGER 0/1. The timestamps Postgres defaults with `now()` are supplied
-- by the repository here, because SQLite has no `now()` that writes the same string shape the rest
-- of the schema stores.
--
-- THE BOOLEAN COLUMNS ARE `INTEGER NOT NULL DEFAULT 0`, and the value written must be 0 or 1
-- rather than the string 'false'. `test:boolean-literals` exists because that mistake shipped
-- once: a literal 0 is not a false, and only Postgres says so — SQLite accepts the string, stores
-- it, and every read of it is truthy forever.
--
-- THE CHECK THAT IS A SEPARATE STATEMENT ON POSTGRES IS INLINE ON THE COLUMN, as 033, 034, 037 and
-- 043 already do, because SQLite has no `ALTER TABLE ... ADD CONSTRAINT`. Which is also why the
-- unique constraint the Postgres file adds to `threads` is a UNIQUE INDEX here — the same
-- guarantee, spelled the way this driver spells it.
--
-- AND THE COMPOSITE FOREIGN KEY IS DECLARED EVEN THOUGH SQLITE ONLY ENFORCES IT WITH
-- `PRAGMA foreign_keys = ON`. It is declared for the same reason the RLS policies are written on
-- the other side and not here: the schema is the documented shape of the data on both drivers, and
-- shapeParity compares them. A constraint present on one driver and absent on the other is a
-- difference that shows up as a passing test and a broken production write.
--
-- NO RLS, on this driver, ever — see 009. The repository layer's WHERE is the whole of the
-- enforcement here, which is why every method in the settings store takes a context first.

CREATE UNIQUE INDEX threads_ws_id_unique ON threads (workspace_id, id);

CREATE TABLE conversation_settings (
  workspace_id     TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  conversation_id  TEXT NOT NULL,

  -- NULL means "inherit the workspace default", which is not the same as any of the four levels.
  reasoning_effort TEXT CHECK (reasoning_effort IN ('low', 'medium', 'high', 'xhigh')),
  permission_mode  TEXT CHECK (permission_mode  IN ('strict', 'smart', 'fast')),

  updated_by       TEXT REFERENCES users(id) ON DELETE SET NULL,
  updated_at       TEXT NOT NULL,

  PRIMARY KEY (workspace_id, conversation_id),
  FOREIGN KEY (workspace_id, conversation_id)
    REFERENCES threads (workspace_id, id) ON DELETE CASCADE
);

-- --- workspace defaults ---------------------------------------------------------------------

ALTER TABLE workspaces ADD COLUMN default_reasoning_effort   TEXT;
ALTER TABLE workspaces ADD COLUMN default_permission_mode    TEXT;
ALTER TABLE workspaces ADD COLUMN permission_mode_pinned     INTEGER NOT NULL DEFAULT 0;
ALTER TABLE workspaces ADD COLUMN permission_fast_disallowed INTEGER NOT NULL DEFAULT 0;
