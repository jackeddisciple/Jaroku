-- 060_agent_grants — the SQLite half. Read the Postgres file for every decision: why a grant can
-- narrow or widen within a role's ceiling and never past it, why the intersection happens again at
-- read time even for a row validated at write time, why the foreign key is the PAIR rather than a
-- bare `agents(id)`, why the audit rows deliberately do not cascade with the grant, and why nothing
-- ever sweeps `expires_at`.
--
-- The same translation as every migration on this driver: uuid -> TEXT, timestamptz -> TEXT holding
-- ISO-8601 UTC. Ids and timestamps that Postgres would default are supplied by the repository,
-- because SQLite has no `now()` that writes the same string shape the rest of the schema stores.
--
-- `text[]` HAS NO SQLITE EQUIVALENT AND BECOMES JSON TEXT, exactly as `turn_feedback.reasons` did in
-- 058, and the same warning applies with more force here: NOTHING MAY EVER QUERY INTO THIS COLUMN.
-- Postgres has `= ANY` and array containment; SQLite has neither, so a `WHERE 'deploy' = ANY(
-- capabilities)` written against one driver is a runtime error on the other and green in every
-- local suite — which is one of the four dialect bugs that cost four red CI runs in a row. Every
-- read here loads the row and intersects the set in TypeScript, over a list that is at most seven
-- long. `resolveCapabilities` does that anyway, because the intersection with the role's ceiling
-- cannot be expressed in SQL on either driver.
--
-- THE COMPOSITE FOREIGN KEY WORKS ON THIS DRIVER TOO, and it is enforced: `node:sqlite` enables
-- foreign keys by default. The unique index on the parent's pair that a composite key needs is
-- already there — migration 018 created `agents_workspace_id_id` for `secret_refs`, for the same
-- reason and against the same bug.
--
-- NO RLS, on this driver, ever — see 009. The repository layer's WHERE is the whole of the
-- enforcement, which is why every method on the grants repository takes a context first.

CREATE TABLE agent_grants (
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  agent_id     TEXT NOT NULL,
  user_id      TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  -- A JSON array as TEXT — see the header for why, and for why nothing ever queries into it.
  capabilities TEXT NOT NULL,
  granted_by   TEXT NOT NULL REFERENCES users(id),
  granted_at   TEXT NOT NULL,
  -- NULL is "never".
  expires_at   TEXT,
  note         TEXT,

  PRIMARY KEY (workspace_id, agent_id, user_id),

  FOREIGN KEY (workspace_id, agent_id) REFERENCES agents (workspace_id, id) ON DELETE CASCADE
);

CREATE INDEX agent_grants_user ON agent_grants (workspace_id, user_id);
