-- 018_secret_ref_agent_tenancy — a secret can only be scoped to an agent of its own workspace.
--
-- 016 gave `secret_refs.agent_id` a foreign key to `agents(id)`, and that key is satisfied by
-- ANY agent in the installation, because `agents.id` is a globally unique uuid. So a workspace
-- could declare a credential scoped to somebody else's agent: the row lands in its own tenant's
-- table, passes RLS, passes the CHECK, and points across the boundary.
--
-- Nothing leaks OUT of that — a listing is still filtered by workspace, and the declarer has to
-- know the other agent's uuid already. What it does is put a row's lifetime in another tenant's
-- hands: ON DELETE CASCADE means their deleting that agent silently deletes this workspace's
-- declaration, and the panel then stops asking for a credential the user's own agent needs.
--
-- The fix is to make the reference say what it means. A foreign key on (workspace_id, agent_id)
-- can only be satisfied by an agent row carrying the same workspace, so the constraint expresses
-- tenancy instead of merely existence. That needs a unique key on the parent's pair, which is
-- what the first statement adds — redundant with the primary key in the strict sense, and the
-- price of being able to reference the pair at all.
--
-- MATCH SIMPLE, the default, is the behaviour wanted for the workspace-scoped case: a row with
-- `agent_id IS NULL` is exempt from the key entirely, and the CHECK from 016 already forbids the
-- half-filled combination the mode would otherwise let through.

ALTER TABLE agents ADD CONSTRAINT agents_workspace_id_id_key UNIQUE (workspace_id, id);

ALTER TABLE secret_refs DROP CONSTRAINT secret_refs_agent_id_fkey;

ALTER TABLE secret_refs ADD CONSTRAINT secret_refs_workspace_agent_fkey
  FOREIGN KEY (workspace_id, agent_id) REFERENCES agents (workspace_id, id) ON DELETE CASCADE;
