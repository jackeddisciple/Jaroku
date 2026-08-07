-- 012_invites — how somebody who is not a member becomes one.
--
-- THIS TABLE KEEPS ITS RLS POLICY, and getting that to work is the only interesting thing
-- about the design. `ws_tickets` had to go without one because redeeming a ticket is what
-- PRODUCES the workspace scope, so a policy reading `app.workspace_id` could only be satisfied
-- by already knowing the answer. Accepting an invite is the same shape of operation — the
-- accepter is by definition not yet a member — so it looks like the same exemption.
--
-- It is not, and the difference matters: a ticket row holds an id and a digest, while an
-- invite row holds an EMAIL ADDRESS. A policy-free table of who has been invited where is a
-- much worse thing to get wrong, so it is worth a little work to keep the backstop.
--
-- The work is in the token, which is `<workspace_id>.<secret>`. Accepting parses the workspace
-- id out of it, scopes the query to that workspace, and looks the row up by the hash of the
-- secret. The workspace id in the token is NOT trusted for anything — it selects which rows to
-- search, and the 256-bit secret is what proves the searcher was invited. So there is no
-- unscoped read of this table anywhere, and the policy holds for every operation including the
-- one performed by somebody with no membership at all.
--
-- ONLY A HASH IS STORED, exactly as with `ws_tickets`: a copy of this table is not a set of
-- usable invitations. There is no email sender in this product, so the link is shown to the
-- inviter once and they send it however they like — the same "shown once, never persisted"
-- shape the deploy bearer token already has.

CREATE TABLE workspace_invites (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id  uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  -- citext, for the reason `users.email` is: nobody believes Ada@example.com and
  -- ada@example.com are two people, and an invite that does not match the address somebody
  -- signs in with is an invite that silently never works.
  email         citext NOT NULL,
  role          text NOT NULL CHECK (role IN ('owner', 'admin', 'member')),
  -- The secret half only. Unique so a digest collision cannot produce two live invites.
  token_hash    text NOT NULL UNIQUE,
  invited_by    uuid REFERENCES users(id),
  expires_at    timestamptz NOT NULL,
  -- Three terminal states, kept as separate timestamps rather than one status column: they
  -- answer different questions ("when did they join", "who withdrew this and when"), and a
  -- status column would lose the one that was not asked about.
  accepted_at   timestamptz,
  accepted_by   uuid REFERENCES users(id),
  revoked_at    timestamptz,
  created_at    timestamptz NOT NULL DEFAULT now()
);

-- One live invite per address per workspace. A partial index rather than a plain UNIQUE,
-- because re-inviting somebody who declined last month is an ordinary thing to do and a
-- constraint that forbade it would be a bug reported as "invites stop working".
CREATE UNIQUE INDEX workspace_invites_pending
  ON workspace_invites (workspace_id, email)
  WHERE accepted_at IS NULL AND revoked_at IS NULL;

-- workspace_id leading, as everywhere.
CREATE INDEX workspace_invites_ws ON workspace_invites (workspace_id, created_at DESC);

ALTER TABLE workspace_invites ENABLE ROW LEVEL SECURITY;
ALTER TABLE workspace_invites FORCE  ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON workspace_invites
  USING      (workspace_id = NULLIF(current_setting('app.workspace_id', true), '')::uuid)
  WITH CHECK (workspace_id = NULLIF(current_setting('app.workspace_id', true), '')::uuid);
