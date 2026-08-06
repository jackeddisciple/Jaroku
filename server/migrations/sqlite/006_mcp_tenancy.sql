-- 006_mcp_tenancy — workspace_id on the MCP registry.
--
-- Read the Postgres version for why a server id has to stop being a global key. This driver
-- cannot express the change in place: SQLite has no ALTER TABLE ... DROP CONSTRAINT, so
-- moving the primary key from (id) to (workspace_id, id) means rebuilding the table.
--
-- These two are worth rebuilding rather than working around, which is the opposite of the
-- call made for `runs` in 004. The difference is what the constraint does: on runs it was
-- only about NOT NULL, and the sentinel default covers that. Here it is about UNIQUENESS,
-- and leaving `id` globally unique would mean the second workspace to connect Linear cannot
-- connect it at all — a constraint failure the user sees, not a property a test can defend.
-- These tables are also small: a handful of servers and their advertised tools.
--
-- THE ORDER BELOW IS THE WHOLE DIFFICULTY, and a real database is what taught it.
--
-- `node:sqlite` turns foreign keys ON by default — unlike the sqlite3 CLI, and unlike what a
-- comment in the driver used to claim. So the obvious rebuild fails twice over:
--
--   * `DROP TABLE mcp_servers` fails while the old mcp_tools still references it.
--   * Worse, renaming the new servers table into place leaves the OLD mcp_tools carrying
--     `REFERENCES mcp_servers(id)` — against a table whose key is now (workspace_id, id) and
--     which has no unique index on `id` alone. The child's constraint is not violated so much
--     as no longer meaningful, and SQLite says so at COMMIT.
--
-- SQLite's own recipe says to set `PRAGMA foreign_keys = OFF` first, but that pragma is a
-- no-op inside a transaction and the runner puts every migration in one, on purpose.
--
-- So: the CHILD moves out of the way first, into a plain holding table with no constraints
-- at all. Then the parent is rebuilt with nothing pointing at it. Then the child is recreated
-- in its final shape — composite key, composite foreign key — and refilled. Every
-- intermediate state is legal, and the final one is checked rather than skipped.
--
-- `defer_foreign_keys` covers the moments in between. Unlike `foreign_keys` it IS settable
-- inside a transaction, it postpones enforcement to COMMIT rather than disabling it, and it
-- resets itself when the transaction ends.

PRAGMA defer_foreign_keys = ON;

INSERT OR IGNORE INTO workspaces (id, slug, name, kind, plan, created_at)
VALUES ('00000000-0000-4000-8000-000000000001', 'local', 'Local', 'personal', 'free',
        strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));

-- 1. The child, out of the way. No constraints: this is a holding table, not a schema.
CREATE TABLE mcp_tools_hold AS SELECT * FROM mcp_tools;
DROP TABLE mcp_tools;

-- 2. The parent, rebuilt with nothing pointing at it.
CREATE TABLE mcp_servers_new (
  workspace_id     TEXT NOT NULL,
  id               TEXT NOT NULL,
  label            TEXT NOT NULL,
  endpoint         TEXT NOT NULL,
  transport        TEXT NOT NULL,
  auth_env_key     TEXT,
  server_name      TEXT,
  server_version   TEXT,
  protocol_version TEXT,
  status           TEXT NOT NULL,
  last_error       TEXT,
  discovered_at    TEXT,
  created_at       TEXT NOT NULL,
  PRIMARY KEY (workspace_id, id)
);

INSERT INTO mcp_servers_new
  (workspace_id, id, label, endpoint, transport, auth_env_key, server_name, server_version,
   protocol_version, status, last_error, discovered_at, created_at)
SELECT '00000000-0000-4000-8000-000000000001', id, label, endpoint, transport, auth_env_key,
       server_name, server_version, protocol_version, status, last_error, discovered_at, created_at
  FROM mcp_servers;

DROP TABLE mcp_servers;
ALTER TABLE mcp_servers_new RENAME TO mcp_servers;

-- 3. The child, in its final shape, refilled from the holding table.
CREATE TABLE mcp_tools (
  workspace_id         TEXT NOT NULL,
  id                   TEXT NOT NULL,
  server_id            TEXT NOT NULL,
  name                 TEXT NOT NULL,
  description          TEXT,
  input_schema         TEXT NOT NULL,
  schema_hash          TEXT NOT NULL,
  impact               TEXT NOT NULL,
  impact_reason        TEXT NOT NULL,
  impact_override      TEXT,
  override_schema_hash TEXT,
  annotations          TEXT,
  discovered_at        TEXT NOT NULL,
  PRIMARY KEY (workspace_id, id),
  UNIQUE (workspace_id, server_id, name),
  FOREIGN KEY (workspace_id, server_id) REFERENCES mcp_servers(workspace_id, id)
);

INSERT INTO mcp_tools
  (workspace_id, id, server_id, name, description, input_schema, schema_hash, impact,
   impact_reason, impact_override, override_schema_hash, annotations, discovered_at)
SELECT '00000000-0000-4000-8000-000000000001', id, server_id, name, description, input_schema,
       schema_hash, impact, impact_reason, impact_override, override_schema_hash, annotations,
       discovered_at
  FROM mcp_tools_hold;

DROP TABLE mcp_tools_hold;

CREATE INDEX mcp_tools_ws_server ON mcp_tools (workspace_id, server_id, name);
