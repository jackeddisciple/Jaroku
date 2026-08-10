-- 016_secret_refs — the names a workspace has configured, without any of the values.
--
-- WHY THIS IS NOT PART OF THE VAULT. The vault holds ciphertext and is one implementation's
-- business; this holds the answer to "what does this workspace have configured", which every
-- implementation has to answer identically or the client behaves differently depending on how
-- the server was deployed. The local store keeps its credentials in a file and still writes
-- here, so `listNames` is one query on both, and the conformance suite can assert the two are
-- indistinguishable rather than asserting a shape.
--
-- THERE IS NO VALUE COLUMN AND THERE IS NOT GOING TO BE. That is the same property
-- `deployments.env_keys` has and the same one the SecretStore interface has by omitting `get`:
-- a place a plaintext credential could be written is a place one eventually is. Adding one
-- would be a schema change somebody has to defend in review rather than a field that quietly
-- filled up.
--
-- SCOPE, because not every credential belongs to a whole workspace. A provider key does; a
-- connector's token for one agent does not, and Session 7's OAuth connections are per-agent by
-- nature. `agent_id` is null for a workspace-scoped one and set for an agent-scoped one, with a
-- CHECK so the two cannot disagree — a row claiming agent scope with no agent is a row nothing
-- can resolve.
--
-- `configured` IS A COLUMN RATHER THAN "THE ROW EXISTS", and the distinction earns its keep:
-- a name can be DECLARED before it is set. An agent's `required_env` lists what it needs, and
-- the panel that asks the user to fill those in needs to render a name with an empty state
-- beside it. A design where absence meant "not configured" could not tell "this agent needs
-- GMAIL_REFRESH_TOKEN and you have not set it" from "nobody has ever mentioned that name".
--
-- AND `last_used_at` IS WRITTEN BY THE READ PATH, not by the write path. It records when a RUN
-- last received the value, which is the only question worth asking of a credential before
-- deleting it — "when was this last set" tells you nothing about whether anything still needs
-- it.

CREATE TABLE secret_refs (
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  name         text NOT NULL,
  -- anthropic | openai | mcp | railway | connector | null. Display only; nothing branches on it.
  provider     text,
  scope        text NOT NULL DEFAULT 'workspace' CHECK (scope IN ('workspace', 'agent')),
  agent_id     uuid REFERENCES agents(id) ON DELETE CASCADE,
  configured   boolean NOT NULL DEFAULT false,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now(),
  last_used_at timestamptz,
  PRIMARY KEY (workspace_id, name),
  CONSTRAINT secret_refs_scope_agent CHECK (
    (scope = 'agent' AND agent_id IS NOT NULL) OR (scope = 'workspace' AND agent_id IS NULL)
  )
);

CREATE INDEX secret_refs_ws_configured ON secret_refs (workspace_id, configured, name);

-- --- the fact moves, rather than being kept in two places -------------------------------------
--
-- 015 gave `workspace_secrets` a `provider` and a `last_used_at` of its own, one migration
-- before it became clear that both are store-agnostic. Two copies of one fact is how they
-- disagree: a rotation rewrites the vault row and not the ref, a local-store deployment writes
-- the ref and has no vault row at all, and "when was this last used" then depends on which
-- table somebody happened to query.
--
-- Dropping is not editing an applied migration — that is what is forbidden, and for good
-- reason. This is a later migration undoing a decision an earlier one made, which is the only
-- mechanism a forward-only scheme has. The columns are one migration old and hold nothing.
ALTER TABLE workspace_secrets DROP COLUMN provider;
ALTER TABLE workspace_secrets DROP COLUMN last_used_at;

-- --- the backstop -------------------------------------------------------------------------
--
-- The same ENABLE + FORCE + policy every other tenant table carries. It matters here even
-- though there is no value in the table: the NAMES are a description of what a workspace
-- integrates with, which is not something one tenant is entitled to read about another.
ALTER TABLE secret_refs ENABLE ROW LEVEL SECURITY;
ALTER TABLE secret_refs FORCE  ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON secret_refs;
CREATE POLICY tenant_isolation ON secret_refs
  USING      (workspace_id = NULLIF(current_setting('app.workspace_id', true), '')::uuid)
  WITH CHECK (workspace_id = NULLIF(current_setting('app.workspace_id', true), '')::uuid);

GRANT SELECT, INSERT, UPDATE, DELETE ON secret_refs TO jaroku_app;
