-- 010_ws_tickets — the single-use credential a WebSocket is opened with.
--
-- WHY THIS TABLE EXISTS AT ALL. A browser cannot set an `Authorization` header on a
-- WebSocket. The two things people reach for instead are both wrong: a long-lived JWT in the
-- query string lands in every access log, proxy log and Referer on the path, where it stays
-- for as long as logs are kept; and a cookie makes the connection a cross-site-request target,
-- because WebSockets are not covered by CORS and a cookie is attached to an upgrade from any
-- origin. So the credential that DOES go in the URL is one that is worth nothing thirty
-- seconds later and worth nothing twice.
--
-- THE ROW HOLDS A HASH, NOT A TICKET. Whatever a client presents is hashed and looked up by
-- the digest, so a copy of this table is not a set of usable credentials. It is a plain
-- SHA-256 rather than a slow KDF on purpose: the input is 256 bits of `randomBytes`, not a
-- password, so there is no dictionary to make expensive — and a KDF on the socket-open path
-- would be a self-inflicted rate limit.
--
-- NO RLS POLICY, and it is the same reason `workspace_members` has none. A policy reads
-- `app.workspace_id`, and consuming a ticket is the operation that PRODUCES that value —
-- there is nothing to scope the lookup by, because the scope is the answer. Issuing one is
-- fully scoped (the repository takes a TenantContext and the row it writes is that
-- workspace's); consuming one is a SystemContext operation, exactly like mapping a provider
-- `sub` to a user. The rows are worthless in under a minute and hold nothing but a digest, an
-- id and a role.

CREATE TABLE ws_tickets (
  -- The PRIMARY KEY is the digest, so consuming is a single index lookup and a duplicate
  -- ticket cannot exist.
  token_hash   text PRIMARY KEY,
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  user_id      uuid REFERENCES users(id) ON DELETE CASCADE,
  -- Captured at issue time. The socket revalidation timer re-reads the membership row anyway,
  -- so this is the starting position rather than the authority — but a ticket that carried no
  -- role would make the first moments of a connection unauthorised or over-authorised, and
  -- neither is acceptable even briefly.
  role         text NOT NULL CHECK (role IN ('owner', 'admin', 'member', 'system')),
  expires_at   timestamptz NOT NULL,
  created_at   timestamptz NOT NULL DEFAULT now()
);

-- For the sweep. Expired rows are deleted opportunistically rather than by a background job:
-- there are few of them, they are tiny, and a scheduled task for this would be a moving part
-- with nothing to do.
CREATE INDEX ws_tickets_expiry ON ws_tickets (expires_at);

-- A workspace's tickets, for the cascade when a membership is revoked. workspace_id leads,
-- as it does on every other index in this schema.
CREATE INDEX ws_tickets_ws_user ON ws_tickets (workspace_id, user_id);
