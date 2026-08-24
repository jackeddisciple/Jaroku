-- 056_conversation_connectors — the SQLite half. Read the Postgres file for every decision: why
-- this is a table rather than a client preference, why no row means "everything" and nothing is
-- backfilled, why `enabled` defaults true when a row is usually written to turn something OFF, why
-- the foreign key is the workspace/conversation PAIR, and why `connector_id` carries no foreign
-- key of its own.
--
-- Same translation as every migration on this driver: uuid -> TEXT, timestamptz -> TEXT holding
-- ISO-8601 UTC, boolean -> INTEGER 0/1. The timestamps Postgres defaults with `now()` are supplied
-- by the repository, because SQLite has no `now()` that writes the same string shape.
--
-- `boolean NOT NULL DEFAULT true` BECOMES `INTEGER NOT NULL DEFAULT 1`, and the value written must
-- be 0 or 1 rather than the string 'false'. `test:boolean-literals` exists because that mistake
-- shipped once: a literal 0 is not a false, and only Postgres says so — SQLite accepts the string,
-- stores it, and every read of it is truthy forever. Which for THIS table would mean a connector
-- somebody switched off staying reachable by the model, with the UI showing it dimmed.
--
-- NO RLS, on this driver, ever — see 009. The repository layer's WHERE is the whole of the
-- enforcement here, which is why every method in the connector store takes a context first.

CREATE TABLE conversation_connectors (
  workspace_id    TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  conversation_id TEXT NOT NULL,
  connector_id    TEXT NOT NULL,
  enabled         INTEGER NOT NULL DEFAULT 1,
  updated_by      TEXT REFERENCES users(id) ON DELETE SET NULL,
  updated_at      TEXT NOT NULL,

  PRIMARY KEY (workspace_id, conversation_id, connector_id),
  FOREIGN KEY (workspace_id, conversation_id)
    REFERENCES threads (workspace_id, id) ON DELETE CASCADE
);

CREATE INDEX conversation_connectors_conversation
  ON conversation_connectors (workspace_id, conversation_id);

-- The deck's fallback mark for a self-hosted MCP server. See the Postgres file for why the
-- reviewed connectors deliberately do NOT get one.
ALTER TABLE mcp_servers ADD COLUMN logo_url TEXT;
