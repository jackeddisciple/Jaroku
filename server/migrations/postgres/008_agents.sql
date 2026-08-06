-- 008_agents — the agent list stops being a directory listing.
--
-- Today `listAgents` reads runtime/agents/ and parses each jaroku.json. That cannot survive
-- either half of this migration: object storage has no directory to list, and several server
-- replicas have no shared disk to list it from. The table becomes the source of truth and
-- the directory becomes a cache it describes.
--
-- THE UNIQUENESS CHANGE THAT WILL BITE. An agent slug is globally unique today —
-- ^[a-z][a-z0-9_]{0,63}$, one directory under runtime/agents/. It becomes unique PER
-- WORKSPACE, so two tenants may both have a `support_bot`. Everything that treats a slug as
-- a global key has to carry (workspace_id, slug) or, better, the uuid: graphIntrospect, the
-- connector registry, the run pool's attribution, the JAROKU_* env plumbing.
--
-- The honest limit of THIS commit: the filesystem is still a single global namespace. Two
-- workspaces with a `support_bot` would collide on runtime/agents/support_bot/, and nothing
-- here fixes that — Session 3's object store does, with keys built from the workspace id and
-- the agent uuid. What lands now is the table, the uuid, and the per-workspace uniqueness the
-- storage layer will need, so that when the directory goes there is nothing left to redesign.
--
-- agent_versions is written now and read later. Session 3 turns projectFs.atomicSwap into
-- "write a version row, bump current_version in the same transaction" — which makes undo a
-- pointer move rather than a snapshot copy, and makes both work across replicas. The manifest
-- is {path: {sha256, bytes}} so a version can be verified without fetching it.

CREATE TABLE agents (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id    uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  -- The old agent id. Still the on-disk directory name, and still validated against the same
  -- pattern on both sides of the process boundary.
  slug            text NOT NULL,
  display_name    text,
  description     text,
  -- Everything the sidebar renders, which the spec's column list did not carry: without
  -- these the agent list is a regression the moment it stops reading jaroku.json.
  connectors      json NOT NULL DEFAULT '[]'::json,
  mcp_tools       json NOT NULL DEFAULT '[]'::json,
  required_env    json NOT NULL DEFAULT '[]'::json,
  default_provider text NOT NULL DEFAULT 'fake',
  -- A hand-written reference implementation (example_agent) rather than a generated project.
  -- Sorted last, and never offered for deletion.
  hand_written    boolean NOT NULL DEFAULT false,
  current_version integer NOT NULL DEFAULT 1,
  -- From jaroku.json. NULL means unknown, and never 0 — the same rule cost follows everywhere.
  creation_cost   double precision,
  created_by      uuid REFERENCES users(id),
  created_at      timestamptz NOT NULL DEFAULT now(),
  deleted_at      timestamptz,
  UNIQUE (workspace_id, slug)
);

CREATE INDEX agents_ws_created ON agents (workspace_id, created_at DESC);

CREATE TABLE agent_versions (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_id   uuid NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  version    integer NOT NULL,
  -- {path: {sha256, bytes}} for every file in the project.
  manifest   json NOT NULL,
  created_by uuid REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (agent_id, version)
);
