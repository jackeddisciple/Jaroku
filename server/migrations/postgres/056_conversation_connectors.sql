-- 056_conversation_connectors — which connectors' tools a conversation may reach.
--
-- A REAL CAPABILITY, NOT A DISPLAY FILTER. §3.2: "Toggling scopes which connectors' tools are
-- offered to the model FOR THIS CONVERSATION ONLY — it does not disconnect the connector at
-- workspace level, and the dropdown must say so. This is a real capability, not cosmetic: it's how
-- a user stops an agent from reaching for Slack while debugging a Postgres path."
--
-- Which is why it is a table rather than a client preference. A toggle that only hid a logo would
-- leave the tool in the dispatch, the model would still call it, and the user would conclude the
-- control does nothing — the same failure the permission shield would have if the client decided.
--
-- THE ROW MEANS "SOMEBODY DECIDED", AND ITS ABSENCE MEANS "EVERYTHING". Same shape as 054, and the
-- same argument: with no row, a conversation sees every connector the workspace has, including one
-- connected after that conversation started. A backfill would freeze each conversation's list at
-- the moment of migration, so connecting Notion tomorrow would reach no existing conversation and
-- nobody would be able to say why.
--
-- `enabled` DEFAULTS TRUE, WHICH LOOKS REDUNDANT AND IS NOT. A row is written when somebody
-- toggles something — usually OFF — and the default matters for the other case: turning one back
-- on writes `true` over a row that already exists rather than deleting it, so "this was
-- deliberately re-enabled" and "nobody has ever touched this" stay distinguishable.
--
-- THE PRIMARY KEY IS THE TRIPLE, and the foreign key to the conversation is the PAIR — §7's rule
-- again. A bare `threads(id)` reference is satisfiable by any tenant's thread.
--
-- `connector_id` CARRIES NO FOREIGN KEY, and that is deliberate rather than an omission. A
-- connector here is either an `oauth_connections.connector_id` (a reviewed template: gmail, slack,
-- postgres) or an `mcp_servers.id` — two tables, one column, and a FK could only point at one of
-- them. What guards it instead is the read path: `conversation_connectors` is only ever JOINed
-- against the connectors a workspace actually has, so a row naming something that does not exist
-- selects nothing rather than granting anything.

CREATE TABLE conversation_connectors (
  workspace_id    uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  conversation_id uuid NOT NULL,
  connector_id    text NOT NULL,
  enabled         boolean NOT NULL DEFAULT true,
  updated_by      uuid REFERENCES users(id) ON DELETE SET NULL,
  updated_at      timestamptz NOT NULL DEFAULT now(),

  PRIMARY KEY (workspace_id, conversation_id, connector_id),
  FOREIGN KEY (workspace_id, conversation_id)
    REFERENCES threads (workspace_id, id) ON DELETE CASCADE
);

-- The read this table exists for, and the only one: every decision for one conversation, fetched
-- in one go at dispatch. There is no query here that asks about one connector across conversations.
CREATE INDEX conversation_connectors_conversation
  ON conversation_connectors (workspace_id, conversation_id);

-- --- the deck's logos -------------------------------------------------------------------------
--
-- §3.2: "Logo assets: each connector record needs a logo_url. Fallback when absent
-- (custom/self-hosted MCP servers) is a monogram tile."
--
-- ON `mcp_servers` ONLY. The reviewed connectors — gmail, slack, postgres — are a fixed catalogue
-- shipped with the product, and their marks already live in the client's icon set with the right
-- brand colours; giving them a nullable URL column would invite somebody to override a brand mark
-- per workspace, which is a support problem rather than a feature. A self-hosted MCP server is the
-- case that genuinely has no mark anybody can predict, and this is for exactly that.
ALTER TABLE mcp_servers ADD COLUMN logo_url text;

ALTER TABLE conversation_connectors ENABLE ROW LEVEL SECURITY;
ALTER TABLE conversation_connectors FORCE  ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON conversation_connectors;
CREATE POLICY tenant_isolation ON conversation_connectors
  USING      (workspace_id = NULLIF(current_setting('app.workspace_id', true), '')::uuid)
  WITH CHECK (workspace_id = NULLIF(current_setting('app.workspace_id', true), '')::uuid);
