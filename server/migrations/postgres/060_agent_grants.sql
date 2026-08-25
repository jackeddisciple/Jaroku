-- 060_agent_grants — one person's access to ONE agent, and the ceiling it can never break.
--
-- WHAT THIS TABLE IS. `workspace_members.role` answers "what may this person do in this
-- workspace"; this answers "and what may they do to THIS agent". The second question has never
-- been askable, so the honest answer until now was "whatever their role allows, everywhere" — a
-- contractor brought in to fix one agent held the same authority over every other one in the
-- tenant, and there was no row anybody could write to say otherwise.
--
-- A GRANT NARROWS OR WIDENS **WITHIN** THE ROLE'S CEILING AND NEVER PAST IT. That is enforced in
-- two places on purpose, and the second one is the one that matters: `grantAccess` refuses a set
-- exceeding the target's workspace role at WRITE time, and `resolveCapabilities` intersects with
-- the ceiling again at READ time, every time, even for a row that was validated when it was
-- written. Write-time validation alone is correct for exactly as long as nobody's role changes:
-- demote an admin to member six months later and every grant they hold is suddenly a set of
-- capabilities their role no longer has, sitting in a table that was checked once and is now
-- wrong. The read-time intersection is what makes a demotion take effect on the next command
-- without anybody having to find and rewrite the grant rows.
--
-- THE COMPOSITE FOREIGN KEY IS NOT OPTIONAL, and this is the second table in this schema to learn
-- it the same way. `secret_refs.agent_id` referenced `agents(id)` — a globally unique uuid, so ANY
-- tenant's agent satisfied it — and a workspace could therefore declare a credential scoped to
-- somebody else's agent. Migration 018 fixed it by keying on the PAIR, which is a constraint that
-- expresses tenancy instead of merely expressing existence. Repeating that mistake on an
-- access-control table would be considerably worse than repeating it on a credential
-- declaration: the row would name a real agent in another tenant, and the resolver reading it
-- would be answering a question about an agent this workspace cannot see. The unique key on
-- `agents (workspace_id, id)` that the pair needs already exists — 018 added it.
--
-- ON DELETE CASCADE, so deleting an agent takes its grants with it. The `audit_log` rows recording
-- who was granted what do NOT cascade and are not supposed to: the grant is a live permission and
-- the audit row is the history of one, and history that disappears when its subject does is not
-- history. That asymmetry is the same one 004 argues for `audit_log.workspace_id` being nullable
-- and not a foreign key.
--
-- `expires_at` IS EVALUATED AT RESOLUTION AND NEVER BY A SWEEPER. A cron job that expires grants is
-- a security control with an uptime dependency — it is correct exactly as often as it runs, and
-- the failure is silent in the dangerous direction: a job that did not fire leaves live access in
-- place with nothing on the screen saying so. The resolver compares the column to `now()` on every
-- command, so a grant that has run out is refused by the first command after it does, whether or
-- not anything swept.
--
-- `note` IS NULLABLE HERE AND REQUIRED ABOVE, for `deploy`, `secrets` and `admin`. A CHECK could
-- have expressed that and deliberately does not: the rule is about the three capabilities a person
-- would later have to justify, the set lives in an array column, and a CHECK reaching into an array
-- to conditionally require a text column is a constraint nobody can read. It belongs where the
-- sentence is written — `grantAccess` refuses one without a note — and this column's job is to hold
-- what they wrote.

CREATE TABLE agent_grants (
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  agent_id     uuid NOT NULL,
  user_id      uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  -- The seven agent-level capabilities, as data — see auth/capabilities.ts. An array rather than
  -- seven booleans or a join table, for the reason `turn_feedback.reasons` is one: it is a
  -- multi-select over a closed set of seven fixed strings, and nothing ever queries INTO it. Every
  -- read of this column loads the whole row and intersects it in TypeScript, which is also the only
  -- shape that works on both drivers.
  capabilities text[] NOT NULL,
  -- Who did this. NOT NULL, because there is no path to a grant that nobody made: every one comes
  -- from a person on the access channel, and a `system` context has no business writing one.
  granted_by   uuid NOT NULL REFERENCES users(id),
  granted_at   timestamptz NOT NULL DEFAULT now(),
  -- NULL is "never". See the header for why nothing sweeps this column.
  expires_at   timestamptz,
  -- "Why does this contractor have deploy" needs an answer six months later that is not archaeology.
  note         text,

  -- ONE ROW PER PERSON PER AGENT. A grant is a statement of what somebody's access IS, not a log of
  -- what was added to it, so two admins editing the same grant is last-write-wins on one row and
  -- the history is in `audit_log`. The workspace leads the key because every read of this table
  -- starts from a workspace, which is the same rule every other tenant table here follows.
  PRIMARY KEY (workspace_id, agent_id, user_id),

  FOREIGN KEY (workspace_id, agent_id) REFERENCES agents (workspace_id, id) ON DELETE CASCADE
);

-- WHICH AGENTS ONE PERSON HAS BEEN GRANTED, which the primary key cannot serve because the user is
-- its last column. The People section reads by (workspace, agent) and is covered by the key; this
-- is the other direction, and it is what "you are no longer in this workspace, here is what you
-- still hold" is answered from when somebody is removed.
CREATE INDEX agent_grants_user ON agent_grants (workspace_id, user_id);

-- RLS, enabled and forced, application role only — the same policy every other tenant table in this
-- schema carries, and the argument for it here is the sharpest in the schema: this is the table
-- that decides who may do what, so a row read across the boundary would not merely leak a fact, it
-- would be one tenant's authorisation answering another tenant's question.
--
-- WITH CHECK as well as USING. Without it a tenant can INSERT a row belonging to another workspace
-- and merely be unable to read it back — which on this particular table means writing somebody
-- else's grant.
ALTER TABLE agent_grants ENABLE ROW LEVEL SECURITY;
ALTER TABLE agent_grants FORCE  ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON agent_grants;
CREATE POLICY tenant_isolation ON agent_grants
  USING      (workspace_id = NULLIF(current_setting('app.workspace_id', true), '')::uuid)
  WITH CHECK (workspace_id = NULLIF(current_setting('app.workspace_id', true), '')::uuid);
