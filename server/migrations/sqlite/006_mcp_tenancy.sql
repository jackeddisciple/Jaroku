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

INSERT OR IGNORE INTO workspaces (id, slug, name, kind, plan, created_at)
VALUES ('00000000-0000-4000-8000-000000000001', 'local', 'Local', 'personal', 'free',
        strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));

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

CREATE TABLE mcp_tools_new (
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

INSERT INTO mcp_tools_new
  (workspace_id, id, server_id, name, description, input_schema, schema_hash, impact,
   impact_reason, impact_override, override_schema_hash, annotations, discovered_at)
SELECT '00000000-0000-4000-8000-000000000001', id, server_id, name, description, input_schema,
       schema_hash, impact, impact_reason, impact_override, override_schema_hash, annotations,
       discovered_at
  FROM mcp_tools;

DROP TABLE mcp_tools;
ALTER TABLE mcp_tools_new RENAME TO mcp_tools;

CREATE INDEX mcp_tools_ws_server ON mcp_tools (workspace_id, server_id, name);
