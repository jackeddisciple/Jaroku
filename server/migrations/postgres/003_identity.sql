-- 003_identity — who exists, and which workspace they belong to.
--
-- The first tables that are not about a run. Everything after this migration hangs off
-- `workspaces.id`: runs, steps, the eval control plane, the MCP registry, deploy records and
-- agents all gain a workspace_id referencing it, so this is the root of the tenancy tree.
--
-- WORKSPACE, NOT USER, is the tenancy unit, and that is the decision this file encodes.
-- Every scoping column in the codebase is workspace_id and never user_id; user_id appears
-- only here, in audit rows, and in "who did this" attribution. A personal workspace is
-- auto-created at signup so a single user is just a workspace with one member — which means
-- adding a second member later is a row, not a migration of every table and every query.
--
-- TIMESTAMPS ARE timestamptz, unlike every table that came before them.
--
--   The existing tables store ISO-8601 text, which came from the frozen event schema, where
--   a timestamp is a string in a JSON document. These are new and nothing reads them as
--   text, so they get the type that means "an instant" — Session 8 wants to partition and
--   sweep by month, and doing date arithmetic against a string column is how you get a
--   sequential scan over the biggest table in the system.
--
--   The driver hands them back as ISO-8601 strings anyway, via a type parser, so a row from
--   Postgres and a row from SQLite are the same shape in JavaScript. Without that, one
--   driver returns a Date and the other a string, which is exactly the quiet cross-driver
--   difference the conformance suite exists to catch.
--
-- SOFT DELETE, via deleted_at. A user or workspace that is gone still has audit rows,
-- deploy records and traces pointing at it, and a hard DELETE would either cascade those
-- away — destroying the record of what happened — or fail on the foreign key. Session 8
-- owns real deletion, where "gone" has to mean gone across Postgres, the object store and
-- the provider's own token endpoints, with a receipt. Until then, gone means invisible.

CREATE TABLE users (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  -- The auth provider's `sub`. Opaque, and never parsed: whatever Clerk puts here is a
  -- string this system compares and nothing more.
  external_id  text UNIQUE NOT NULL,
  -- citext, because nobody believes Ada@example.com and ada@example.com are two people, and
  -- a UNIQUE over plain text lets both sign up.
  email        citext UNIQUE NOT NULL,
  display_name text,
  created_at   timestamptz NOT NULL DEFAULT now(),
  deleted_at   timestamptz
);

CREATE TABLE workspaces (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  -- citext for the same reason as email: this appears in URLs.
  slug       citext UNIQUE NOT NULL,
  name       text NOT NULL,
  -- 'personal' is the one created at signup and cannot be left or deleted while its owner
  -- exists; 'team' is everything else. Stored rather than inferred from the member count,
  -- because a team workspace that happens to have one member is still a team workspace.
  kind       text NOT NULL CHECK (kind IN ('personal', 'team')),
  plan       text NOT NULL DEFAULT 'free',
  created_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz
);

CREATE TABLE workspace_members (
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  user_id      uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  -- No 'system' here. That is a role a REQUEST can have, never a membership — a background
  -- job acts on a workspace's behalf without being a member of it, and a row saying
  -- otherwise would show up in the members list as a user nobody can account for.
  role         text NOT NULL CHECK (role IN ('owner', 'admin', 'member')),
  created_at   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id, user_id)
);

-- The membership lookup runs on every authenticated request, in both directions: "may this
-- user touch this workspace" and "which workspaces does this user have". The primary key
-- serves the first; this index serves the second.
CREATE INDEX workspace_members_user ON workspace_members (user_id);

-- Every cross-tenant denial, every membership change, every deletion. Session 8 alerts on
-- the first of those and expects the count to be zero.
CREATE TABLE audit_log (
  id            bigserial PRIMARY KEY,
  -- Nullable, and deliberately not a foreign key. An audit row about a workspace that was
  -- later deleted must survive it; a row recording a denied attempt to reach a workspace
  -- that never existed has nothing valid to point at, and that attempt is the most
  -- interesting one in the table.
  workspace_id  uuid,
  actor_user_id uuid,
  action        text NOT NULL,
  target_type   text,
  target_id     text,
  metadata      json NOT NULL DEFAULT '{}'::json,
  ip            inet,
  created_at    timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX audit_log_workspace ON audit_log (workspace_id, created_at DESC);
CREATE INDEX audit_log_action    ON audit_log (action, created_at DESC);
