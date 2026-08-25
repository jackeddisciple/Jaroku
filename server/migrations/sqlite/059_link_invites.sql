-- 059_link_invites — the SQLite half. Read the Postgres file for why NULL rather than ''.
--
-- This driver has no `ALTER TABLE ... ALTER COLUMN`, so the table is rebuilt: the same columns in
-- the same order, the same checks, the same foreign keys, one dropped NOT NULL. It is the idiom
-- migrations 006 and 018 already use here, and the notes on both apply — the copy runs while both
-- tables exist, so `defer_foreign_keys` covers the moment in between, and it is settable inside a
-- transaction where `foreign_keys` is not.
--
-- `workspace_invites` HAS NO CHILDREN, which is what keeps this to one table rather than 006's
-- three-step dance: `invited_by` and `accepted_by` point OUT of it at `users`, and nothing points
-- in. Dropping it takes nothing else with it.
--
-- THE THREE INDEXES ARE RECREATED BY HAND, and that is the part of this idiom that quietly goes
-- wrong: `DROP TABLE` takes its indexes with it, and an index left off the rebuild is not an error
-- — it is a table that works, answers every query, and has lost a UNIQUE constraint. The partial
-- one is the load-bearing member of the three, because it is what stops a workspace holding two
-- live invitations for one address, and after this migration it is also what lets it hold as many
-- link invitations as it likes.

PRAGMA defer_foreign_keys = ON;

CREATE TABLE workspace_invites_new (
  id            TEXT PRIMARY KEY,
  workspace_id  TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  -- NULL is "whoever opens this link". COLLATE NOCASE stays: an addressed invitation still has to
  -- match the address somebody signs in with, and nobody believes Ada@example.com and
  -- ada@example.com are two people.
  email         TEXT COLLATE NOCASE,
  role          TEXT NOT NULL CHECK (role IN ('owner', 'admin', 'member')),
  token_hash    TEXT NOT NULL,
  invited_by    TEXT REFERENCES users(id),
  expires_at    TEXT NOT NULL,
  accepted_at   TEXT,
  accepted_by   TEXT REFERENCES users(id),
  revoked_at    TEXT,
  created_at    TEXT NOT NULL
);

INSERT INTO workspace_invites_new
  (id, workspace_id, email, role, token_hash, invited_by, expires_at, accepted_at, accepted_by,
   revoked_at, created_at)
SELECT id, workspace_id, email, role, token_hash, invited_by, expires_at, accepted_at, accepted_by,
       revoked_at, created_at
  FROM workspace_invites;

DROP TABLE workspace_invites;
ALTER TABLE workspace_invites_new RENAME TO workspace_invites;

CREATE UNIQUE INDEX workspace_invites_token ON workspace_invites (token_hash);

CREATE UNIQUE INDEX workspace_invites_pending
  ON workspace_invites (workspace_id, email)
  WHERE accepted_at IS NULL AND revoked_at IS NULL;

CREATE INDEX workspace_invites_ws ON workspace_invites (workspace_id, created_at DESC);
