-- 026_oauth — a workspace's connections to somebody else's account, and the short-lived rows
-- that get one made.
--
-- WHAT CHANGES ABOUT CONNECTORS HERE. Until now the README's instruction was to paste
-- GMAIL_CLIENT_ID, GMAIL_CLIENT_SECRET and GMAIL_REFRESH_TOKEN into runtime/.env by hand: the
-- user owned the OAuth app, the user did the consent dance, and Jaroku only ever saw the result.
-- Hosted, WE own the OAuth app and the user grants OUR app access to THEIR account. That is a
-- different security posture — a different consent screen, a different party to revoke against,
-- and a token that belongs to a workspace rather than to a machine.
--
-- THERE ARE NO TOKEN COLUMNS IN EITHER TABLE, and that is the point rather than an omission.
-- An access token and a refresh token are credentials, and credentials go through `SecretStore`
-- — sealed per workspace, bound to `<workspace_id>:<name>`, with no method that would hand one
-- back to a request handler. `oauth_connections` records the NAMES they are stored under, in
-- exactly the way `mcp_servers.auth_env_key` records a name and `deployments.env_keys` records
-- a list of them. A column here that held a token would be a second place credentials live, and
-- the second place is always the one that gets logged.
--
-- ONE CONNECTION PER CONNECTOR PER WORKSPACE. `UNIQUE (workspace_id, connector_id)` rather than
-- a key on the external account, because that is the question every consumer asks: an agent
-- generated with the `gmail` connector needs THE workspace's Gmail credential, and a design
-- admitting three would need a rule for picking one and a UI for setting it. Reconnecting under
-- a different Google account replaces the row, which is the behaviour the connections panel
-- describes ("Reconnect"), and the account it is now pointing at is on the row so nobody has to
-- guess which mailbox an agent is reading.
--
-- `scopes` IS WHAT WAS GRANTED, NOT WHAT WAS ASKED FOR. Providers are free to return fewer than
-- you requested — Google's incremental consent lets a user tick one box and not the other — and
-- a row storing the request would say an agent can create drafts when the user only agreed to
-- reading. The connections UI renders this column, so what a user sees is what they consented
-- to rather than what we hoped for.

CREATE TABLE oauth_connections (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id       uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  -- Who we authenticated against: `google`, `slack`. The identity provider, which is not the
  -- same thing as the connector it satisfies — one provider can back several connectors.
  provider           text NOT NULL,
  -- Which catalog entry this connection satisfies: `gmail`, `slack`. The join back to
  -- runtime/tool_templates/catalog.json, and what a run's credential injection looks up by.
  connector_id       text NOT NULL,
  -- Attribution, never authorisation. Which member clicked Connect, so a workspace can tell who
  -- pointed its agents at whose mailbox. Nullable and ON DELETE SET NULL: the connection belongs
  -- to the WORKSPACE and must not vanish when the person who made it leaves.
  connected_by       uuid REFERENCES users(id) ON DELETE SET NULL,
  -- The account on the other side, as the provider names it. Display and drift detection only:
  -- if a reconnect comes back with a different account id, the agents pointed at the old one are
  -- now reading a different mailbox, and somebody has to be told rather than left to notice.
  external_account_id    text,
  external_account_label text,
  -- WHAT WAS GRANTED. See the header. jsonb because it is a list nothing joins against.
  scopes             jsonb NOT NULL DEFAULT '[]',
  -- active          — usable; a run may be given a token from it
  -- reauth_required — the provider rejected our refresh (revoked, expired, password changed).
  --                   NOT an error state to retry out of: retrying into a lockout is how an
  --                   account gets suspended, so this is terminal until a human reconnects.
  -- revoked         — we told the provider to forget it, or the workspace disconnected. Kept
  --                   rather than deleted so the audit trail has something to point at.
  status             text NOT NULL DEFAULT 'active'
                     CHECK (status IN ('active', 'reauth_required', 'revoked')),
  -- THE NAMES, NEVER THE VALUES. What `SecretStore` holds this connection's tokens under.
  access_secret_name  text NOT NULL,
  -- Null for a provider that does not issue one. Slack's bot tokens do not expire and do not
  -- rotate, so a Slack connection legitimately has no refresh token at all — which is why this
  -- is nullable rather than an empty string standing in for absent.
  refresh_secret_name text,
  -- When the access token stops working. What the proactive refresh reads, and what decides
  -- whether a run gets the stored token or a freshly minted one. Null means "does not expire",
  -- which is Slack's case and must not be confused with "expired".
  access_expires_at  timestamptz,
  last_refreshed_at  timestamptz,
  -- The provider's own words when something went wrong, for the panel. Never a token: the
  -- refusal of a credential-bearing URL in mcpClient.ts exists because an error message is a
  -- place values end up, and the same care applies here.
  last_error         text,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now(),
  revoked_at         timestamptz,
  UNIQUE (workspace_id, connector_id)
);

-- workspace_id leading, as on every other index in this schema. The panel lists a workspace's
-- connections and a run looks one up by connector, and both start from the tenant.
CREATE INDEX oauth_connections_ws_connector ON oauth_connections (workspace_id, connector_id);
-- For the refresher, which asks "what is about to expire" across every workspace it drains.
CREATE INDEX oauth_connections_expiring ON oauth_connections (access_expires_at)
  WHERE status = 'active' AND access_expires_at IS NOT NULL;

-- --- the flow rows ----------------------------------------------------------------------------
--
-- WHY A TABLE AND NOT A COOKIE. The value that rides the redirect has to survive a round trip
-- through a third party and come back to a DIFFERENT replica than the one that started it, so it
-- cannot live in memory. A signed cookie would work and would put the flow's state on the
-- browser, where it can be replayed; a row can be deleted, and deleting it is what makes it
-- single-use.
--
-- THE ROW HOLDS A HASH OF THE STATE, NOT THE STATE. Same discipline as `ws_tickets` and for the
-- same reason: whatever the client presents is hashed and looked up by digest, so a copy of this
-- table is not a set of usable flows. Plain SHA-256 rather than a KDF, because the input is 256
-- bits of `randomBytes` and there is no dictionary to make expensive.
--
-- `code_verifier` IS STORED IN PLAINTEXT AND IS NOT AN EXCEPTION TO THE RULE ABOVE. PKCE works
-- by sending a HASH of the verifier to the provider when the flow starts and the verifier itself
-- when the code is exchanged; the server side of a confidential client has to hold the verifier
-- across that gap or there is no proof to present. It is not a credential in the sense the vault
-- protects: it authenticates nothing on its own, it is worthless without the authorization code
-- that arrives at the callback, it is single-use, and it is gone in ten minutes. What it buys is
-- that an intercepted `code` cannot be redeemed by whoever intercepted it.
--
-- NO RLS POLICY, and it is the same reason `ws_tickets` has none. A policy reads
-- `app.workspace_id`, and consuming a state row is the operation that PRODUCES that value —
-- the callback arrives with nothing but the state, and the scope is the answer rather than the
-- input. Creating one is fully scoped: the repository takes a TenantContext and the row it
-- writes is that workspace's.

CREATE TABLE oauth_states (
  state_hash    text PRIMARY KEY,
  workspace_id  uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  -- BOUND TO THE SESSION THAT STARTED IT. The callback resolves to this user, not to whoever
  -- happens to have the browser: without it, a state value leaked out of one person's address
  -- bar could be completed by another and the connection would be attributed to them.
  user_id       uuid REFERENCES users(id) ON DELETE CASCADE,
  provider      text NOT NULL,
  connector_id  text NOT NULL,
  code_verifier text NOT NULL,
  -- Recorded rather than recomputed at the callback. The provider checks the redirect_uri on the
  -- exchange against the one the flow started with, so a deployment whose configuration changed
  -- mid-flow has to present the OLD one or the exchange fails with an error naming neither.
  redirect_uri  text NOT NULL,
  -- What we ASKED for. The granted set lands on the connection; keeping the request here is what
  -- lets the callback say "you granted less than this" rather than silently connecting.
  scopes        jsonb NOT NULL DEFAULT '[]',
  -- Where to send the browser when it is over. Validated against the origin allowlist before it
  -- is written — an open redirect is exactly the shape of hole a `return_to` becomes.
  return_to     text,
  created_at    timestamptz NOT NULL DEFAULT now(),
  expires_at    timestamptz NOT NULL
);

-- For the opportunistic sweep, exactly as `ws_tickets_expiry` is.
CREATE INDEX oauth_states_expiry ON oauth_states (expires_at);

-- --- the backstop -----------------------------------------------------------------------------
--
-- ENABLE + FORCE + policy on the connections, which are ordinary tenant rows. FORCE is the one
-- that matters: ENABLE alone exempts the table owner, and on a small deployment the owner is the
-- app. `oauth_states` is deliberately absent — see its own note above.
ALTER TABLE oauth_connections ENABLE ROW LEVEL SECURITY;
ALTER TABLE oauth_connections FORCE  ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON oauth_connections;
CREATE POLICY tenant_isolation ON oauth_connections
  USING      (workspace_id = NULLIF(current_setting('app.workspace_id', true), '')::uuid)
  WITH CHECK (workspace_id = NULLIF(current_setting('app.workspace_id', true), '')::uuid);

GRANT SELECT, INSERT, UPDATE, DELETE ON oauth_connections, oauth_states TO jaroku_app;
