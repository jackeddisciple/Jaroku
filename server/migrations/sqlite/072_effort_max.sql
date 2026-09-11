-- The fifth reasoning effort, `max` — the SQLite half. See postgres/072 for why the level exists.
--
-- SQLITE CANNOT ALTER A CHECK, so each table that constrains a level is written out again with the
-- wider one: create, copy every row, drop, rename, and put the indexes back. 066 does the same for
-- `thread_items` and has to hold five tables' rows aside while it does, because they cascade from
-- it. Nothing references either table here and neither carries a trigger or a view, so the copy is
-- the whole of it.
--
-- `workspaces.default_reasoning_effort` was added without a CHECK on this dialect, so it already
-- takes the word and is left alone.

CREATE TABLE conversation_settings_new (
  workspace_id     TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  conversation_id  TEXT NOT NULL,
  reasoning_effort TEXT CHECK (reasoning_effort IN ('low', 'medium', 'high', 'xhigh', 'max')),
  permission_mode  TEXT CHECK (permission_mode  IN ('strict', 'smart', 'fast')),
  updated_by       TEXT REFERENCES users(id) ON DELETE SET NULL,
  updated_at       TEXT NOT NULL,
  PRIMARY KEY (workspace_id, conversation_id),
  FOREIGN KEY (workspace_id, conversation_id)
    REFERENCES threads (workspace_id, id) ON DELETE CASCADE
);

INSERT INTO conversation_settings_new
  (workspace_id, conversation_id, reasoning_effort, permission_mode, updated_by, updated_at)
SELECT workspace_id, conversation_id, reasoning_effort, permission_mode, updated_by, updated_at
  FROM conversation_settings;

DROP TABLE conversation_settings;
ALTER TABLE conversation_settings_new RENAME TO conversation_settings;

CREATE TABLE turn_variants_new (
  id               TEXT PRIMARY KEY,
  workspace_id     TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  turn_id          TEXT NOT NULL,
  ordinal          INTEGER NOT NULL,
  model_id         TEXT,
  provider         TEXT,
  effort_requested TEXT CHECK (effort_requested IN ('low', 'medium', 'high', 'xhigh', 'max')),
  effort_applied   TEXT CHECK (effort_applied   IN ('low', 'medium', 'high', 'xhigh', 'max')),
  duration_ms      INTEGER,
  tokens_in        INTEGER,
  tokens_out       INTEGER,
  cost_usd         REAL,
  agent_version_id TEXT,
  created_at       TEXT NOT NULL,
  FOREIGN KEY (workspace_id, turn_id)
    REFERENCES thread_items (workspace_id, id) ON DELETE CASCADE
);

INSERT INTO turn_variants_new
  (id, workspace_id, turn_id, ordinal, model_id, provider, effort_requested, effort_applied,
   duration_ms, tokens_in, tokens_out, cost_usd, agent_version_id, created_at)
SELECT id, workspace_id, turn_id, ordinal, model_id, provider, effort_requested, effort_applied,
       duration_ms, tokens_in, tokens_out, cost_usd, agent_version_id, created_at
  FROM turn_variants;

DROP TABLE turn_variants;
ALTER TABLE turn_variants_new RENAME TO turn_variants;

CREATE UNIQUE INDEX turn_variants_turn_ordinal
  ON turn_variants (workspace_id, turn_id, ordinal);
CREATE INDEX turn_variants_turn ON turn_variants (workspace_id, turn_id, ordinal);
