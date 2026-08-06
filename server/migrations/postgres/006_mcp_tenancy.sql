-- 006_mcp_tenancy — workspace_id on the MCP registry.
--
-- Same shape as 004 and 005. What is different here is the UNIQUE constraints, and they are
-- the whole point of the migration.
--
-- A SERVER ID IS PER WORKSPACE, NOT GLOBAL. `mcp_servers.id` is a slug derived from the
-- label or the endpoint host — "linear", "github", "mock" — so two workspaces connecting the
-- same service produce the same id, and today the second one would collide with the first.
-- Worse than colliding: `upsertServer` would UPDATE it, so connecting Linear would silently
-- repoint somebody else's Linear server at your endpoint and hand your agents their tools.
--
-- So the primary key becomes (workspace_id, id), and the tool uniqueness follows it. Two
-- workspaces may connect the same URL, under the same slug, with different credentials, and
-- neither can observe the other.
--
-- The credential is unaffected and was already safe: `auth_env_key` holds the NAME of an
-- environment variable, never a value, so there is no column here a token could leak from.
-- Making that name per-workspace is Session 7's job, along with the vault it belongs in.

ALTER TABLE mcp_servers ADD COLUMN workspace_id uuid REFERENCES workspaces(id);
ALTER TABLE mcp_tools   ADD COLUMN workspace_id uuid REFERENCES workspaces(id);

UPDATE mcp_servers SET workspace_id = '00000000-0000-4000-8000-000000000001' WHERE workspace_id IS NULL;
UPDATE mcp_tools   SET workspace_id = '00000000-0000-4000-8000-000000000001' WHERE workspace_id IS NULL;

ALTER TABLE mcp_servers ALTER COLUMN workspace_id SET NOT NULL;
ALTER TABLE mcp_tools   ALTER COLUMN workspace_id SET NOT NULL;

-- The slug stops being a global key.
--
-- mcp_tools.server_id references mcp_servers(id), so the primary key cannot be replaced
-- while that foreign key depends on it. The FK comes off first and goes back on as a
-- composite one — which is the stronger constraint anyway: a tool row can no longer point at
-- a server id in a different workspace.
ALTER TABLE mcp_tools DROP CONSTRAINT IF EXISTS mcp_tools_server_id_fkey;

ALTER TABLE mcp_servers DROP CONSTRAINT mcp_servers_pkey;
ALTER TABLE mcp_servers ADD  CONSTRAINT mcp_servers_pkey PRIMARY KEY (workspace_id, id);

ALTER TABLE mcp_tools DROP CONSTRAINT IF EXISTS mcp_tools_server_id_name_key;
ALTER TABLE mcp_tools ADD  CONSTRAINT mcp_tools_ws_server_name UNIQUE (workspace_id, server_id, name);
ALTER TABLE mcp_tools ADD  CONSTRAINT mcp_tools_ws_server_fkey
  FOREIGN KEY (workspace_id, server_id) REFERENCES mcp_servers (workspace_id, id);

CREATE INDEX mcp_tools_ws_server ON mcp_tools (workspace_id, server_id, name);
DROP INDEX IF EXISTS idx_mcp_tools_server;
