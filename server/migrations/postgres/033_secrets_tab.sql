-- 033_secrets_tab — the metadata a Secrets surface needs, and the authorisation that guards it.
--
-- WHY THIS EXTENDS `secret_refs` RATHER THAN CREATING A `secrets` TABLE BESIDE IT.
--
-- The build brief specifies a new table holding workspace_id, agent_id, kind, name, provider,
-- masked_hint, status, expires_at, last_used_at and a pointer into the store. Six of those ten
-- already exist here, on `secret_refs`, carrying the same meaning — and 016 wrote down the reason
-- when it MOVED `provider` and `last_used_at` off `workspace_secrets`: "two copies of one fact is
-- how they disagree." A second table would make every existing reader — the vault, the deploy
-- panel, MCP, connectors, the export, the deleter — answer "is this configured" from whichever of
-- the two it happened to be written against.
--
-- The brief's `store_ref` is the one column with nothing to map onto, and deliberately so: there
-- is no opaque handle in this design. The pointer IS `(workspace_id, name)`, which is the primary
-- key of both `secret_refs` and `workspace_secrets`, and adding a second way to name the same row
-- would be adding the indirection the brief's own rule ("never a value") does not need.
--
-- WHAT `kind` IS FOR. Three origins with genuinely different verbs — a user-pasted provider key
-- can be rotated and tested, a connector's OAuth token can only be reconnected, a custom name can
-- be rotated and revoked and needs a blast-radius view. Existing rows default to 'custom', which
-- is the honest answer for a name nobody has classified, and 034's backfill moves the provider
-- keys across. The CHECK is added with the column rather than later so an unclassified value
-- cannot be written in between.
--
-- `masked_hint` IS STORED, NEVER DERIVED. The last four characters of a key are not sensitive,
-- but computing them on read would mean decrypting on read — which is the one thing this schema
-- exists to make impossible. So the hint is written at the moment the value passes through, as
-- its own non-sensitive column, and a row whose hint could not be derived carries a generic mask
-- rather than opening a decrypt path for cosmetics.
--
-- EVERY NEW COLUMN IS NULLABLE OR DEFAULTED, and every new table is new, so the version currently
-- serving neither reads nor writes any of it. This is an expand step in full.

-- --- the metadata ----------------------------------------------------------------------------

ALTER TABLE secret_refs ADD COLUMN kind              text NOT NULL DEFAULT 'custom';
ALTER TABLE secret_refs ADD COLUMN masked_hint       text;
ALTER TABLE secret_refs ADD COLUMN status            text NOT NULL DEFAULT 'unknown';
ALTER TABLE secret_refs ADD COLUMN expires_at        timestamptz;
ALTER TABLE secret_refs ADD COLUMN rotated_at        timestamptz;
ALTER TABLE secret_refs ADD COLUMN created_by        uuid REFERENCES users(id) ON DELETE SET NULL;
ALTER TABLE secret_refs ADD COLUMN connector_id      text;
ALTER TABLE secret_refs ADD COLUMN rotate_every_days integer;

ALTER TABLE secret_refs
  ADD CONSTRAINT secret_refs_kind_check CHECK (kind IN ('provider_key', 'managed', 'custom'));

-- 'unknown' is the fourth state on purpose, and it is the default. A key that has never been
-- probed is not valid and is not invalid — reporting either would be inventing a fact, and
-- "unknown" is what makes the lazy re-validation in the application honest about what it does
-- not yet know.
ALTER TABLE secret_refs
  ADD CONSTRAINT secret_refs_status_check CHECK (status IN ('valid', 'invalid', 'expiring', 'unknown'));

-- Zero would mean "rotate every no days", which is either an empty form field or a misunderstanding
-- and is an infinite loop for whatever reads it. NULL is how "no schedule" is spelled.
ALTER TABLE secret_refs
  ADD CONSTRAINT secret_refs_rotate_every_days_check
  CHECK (rotate_every_days IS NULL OR rotate_every_days > 0);

-- Answering "what expires soon" and "what is broken" for the whole workspace, which is the badge
-- query and runs without elevation. Leading with workspace_id per the tenancy rule: a trailing
-- tenant column makes the planner scan an index built for a different question.
CREATE INDEX secret_refs_ws_status ON secret_refs (workspace_id, status, expires_at);

-- --- the gate's policy ------------------------------------------------------------------------
--
-- Gating the whole tab means a glance at "which connector is expiring" costs a passcode, and for
-- some teams that is the wrong trade. Both modes are implemented; 'tab' is the default and the
-- one that ships. A column rather than a config file because it is a per-workspace decision, and
-- an admin has to be able to change it without a deploy.
ALTER TABLE workspaces ADD COLUMN secrets_gate text NOT NULL DEFAULT 'tab';

ALTER TABLE workspaces
  ADD CONSTRAINT workspaces_secrets_gate_check CHECK (secrets_gate IN ('tab', 'mutations'));

-- --- the passcode -----------------------------------------------------------------------------
--
-- PER USER, NOT PER WORKSPACE. A shared workspace passcode destroys accountability: `audit_log`
-- must be able to name a person, and it cannot if six people know one secret. The primary key is
-- the pair because the same person may hold different workspaces to different standards.
--
-- NOT IN THE SECRET STORE, and that is a distinction worth stating rather than assuming. The
-- store exists for credentials the SYSTEM must retrieve — it injects them into runs. A passcode
-- must never be retrievable by anything, only comparable, so it is a hash in a table and there is
-- no code path that could return it.
--
-- `algo` AND `params` TRAVEL WITH THE HASH so the cost can be raised later without invalidating
-- anybody's passcode: a verify that succeeds against stored parameters re-hashes under the
-- current ones. Parameters compiled into the application instead would make every historical hash
-- unverifiable the day somebody tuned them.
CREATE TABLE user_secret_passcodes (
  workspace_id     uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  user_id          uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  hash             text NOT NULL,
  salt             text NOT NULL,
  algo             text NOT NULL,
  params           json NOT NULL DEFAULT '{}'::json,
  -- Server-side, and the whole point. A client-side attempt counter is not a control: it is
  -- advice to an attacker, who is not running the client.
  failed_attempts  integer NOT NULL DEFAULT 0,
  locked_until     timestamptz,
  last_verified_at timestamptz,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id, user_id)
);

-- --- elevation --------------------------------------------------------------------------------
--
-- ONE ROW PER ISSUED TOKEN, GROUPED BY SESSION. The brief requires that two tabs of one session
-- share elevation while a different device does not, and that locking in one tab is reflected in
-- the other. Both fall out of this shape: a second tab of the same session is issued its own
-- token row carrying the FIRST one's `expires_at`, and locking revokes every unrevoked row for
-- the session at once.
--
-- INHERITING `expires_at` RATHER THAN GETTING A FRESH TEN MINUTES IS THE LOAD-BEARING PART. The
-- TTL is absolute, not sliding — a sliding window means an idle open tab stays elevated all day,
-- which is the property the whole gate exists to deny. If a second tab renewed the clock, opening
-- one every nine minutes would be an indefinite elevation with no user present.
--
-- `session_id` IS A DIGEST OF THE BEARER TOKEN, not a random id of our own. That gets sign-out for
-- free and correctly: signing out mints a new token, which is a new session, which shares nothing
-- with the elevation the old one held. There is no cookie in this server to hang a session on.
--
-- `method` CARRIES A DISCRIMINATOR FROM THE FIRST DAY even though only 'passcode' is implemented.
-- Retrofitting WebAuthn into a passcode-shaped table is painful; a CHECK with three values in it
-- costs nothing now.
CREATE TABLE secret_elevations (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id  uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  user_id       uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  session_id    text NOT NULL,
  -- SHA-256 of the value handed to the client, never the value. Same discipline as `ws_tickets`:
  -- a database dump is not a drawer of live credentials.
  token_hash    text NOT NULL,
  method        text NOT NULL CHECK (method IN ('passcode', 'webauthn', 'oidc')),
  issued_at     timestamptz NOT NULL DEFAULT now(),
  expires_at    timestamptz NOT NULL,
  revoked_at    timestamptz,
  revoke_reason text,
  -- On the row rather than only in `audit_log`, because "elevated from where" is the question
  -- asked while an incident is open, and joining to an append-only log to answer it is friction
  -- at exactly the wrong moment.
  ip            text,
  user_agent    text
);

CREATE UNIQUE INDEX secret_elevations_token ON secret_elevations (token_hash);
CREATE INDEX secret_elevations_ws_session ON secret_elevations (workspace_id, session_id, expires_at DESC);

-- --- blast radius -----------------------------------------------------------------------------
--
-- What breaks if I revoke this. TWO SOURCES, LABELLED, because neither is sufficient alone: a
-- static scan misses a name built at runtime, and a record of runtime reads misses code that has
-- never run. Showing both and saying which is which is the only honest answer.
--
-- NAMED `secret_usages` RATHER THAN THE BRIEF'S `secret_references`, because `secret_refs` already
-- exists and means something else — the names a workspace has configured. Two tables one letter
-- apart, one meaning "the secret" and one meaning "where the secret is used", is a mistake waiting
-- for whoever reads the second one first.
--
-- THE FOREIGN KEY TO AN AGENT IS ON THE PAIR, never on `agents(id)` alone. 018 fixed exactly this
-- on `secret_refs`: a bare agent uuid is satisfiable by another tenant's agent, which puts this
-- row's lifetime in their hands through ON DELETE CASCADE.
CREATE TABLE secret_usages (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  name         text NOT NULL,
  agent_id     uuid,
  source       text NOT NULL CHECK (source IN ('static_scan', 'runtime_read')),
  -- `file:line` for a static hit; NULL for a runtime read, which knows the run and not the line.
  location     text,
  -- How many times this exact site has been seen. A read path that inserted a row per read would
  -- turn a busy agent's credential into millions of rows saying the same thing.
  hits         integer NOT NULL DEFAULT 1,
  first_seen_at timestamptz NOT NULL DEFAULT now(),
  detected_at  timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (workspace_id, name) REFERENCES secret_refs (workspace_id, name) ON DELETE CASCADE,
  FOREIGN KEY (workspace_id, agent_id) REFERENCES agents (workspace_id, id) ON DELETE CASCADE
);

-- One row per distinct site, so re-running a scan updates rather than accumulates. The COALESCE
-- is what makes that true for the nullable halves: in an ordinary unique index two NULLs are
-- distinct, so a workspace-scoped runtime read would insert a fresh row every single time.
CREATE UNIQUE INDEX secret_usages_site
  ON secret_usages (workspace_id, name, source, COALESCE(agent_id::text, ''), COALESCE(location, ''));

CREATE INDEX secret_usages_ws_name ON secret_usages (workspace_id, name, source);

-- --- rotation history -------------------------------------------------------------------------
--
-- METADATA ONLY. Rotation replaces a value; it does not version one. There is no column here an
-- old ciphertext would fit in, and that is deliberate — "roll back to the previous key" is a
-- feature that would require keeping superseded credentials live, which is the opposite of what
-- rotating one is for. What is worth keeping is that it happened, when, and who did it.
CREATE TABLE secret_rotations (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  name         text NOT NULL,
  rotated_by   uuid REFERENCES users(id) ON DELETE SET NULL,
  -- The mask of the value that replaced the old one, so a history reads as a sequence somebody
  -- can recognise. Never the old value, which is gone.
  masked_hint  text,
  reason       text,
  rotated_at   timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (workspace_id, name) REFERENCES secret_refs (workspace_id, name) ON DELETE CASCADE
);

CREATE INDEX secret_rotations_ws_name ON secret_rotations (workspace_id, name, rotated_at DESC);

-- --- the backstop -----------------------------------------------------------------------------
--
-- The same ENABLE + FORCE + policy every other tenant table carries. FORCE is the one that
-- matters: ENABLE alone exempts the table owner, and on a small deployment the owner is the app.
--
-- `user_secret_passcodes` and `secret_elevations` get it too, even though both are keyed on a user
-- as well as a workspace. The policy is about the workspace half — a member of one workspace must
-- not be able to read another workspace's lockout state, which would say who is being attacked
-- and when.
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['user_secret_passcodes', 'secret_elevations', 'secret_usages', 'secret_rotations']
  LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE  ROW LEVEL SECURITY', t);
    EXECUTE format('DROP POLICY IF EXISTS tenant_isolation ON %I', t);
    EXECUTE format($f$
      CREATE POLICY tenant_isolation ON %I
        USING      (workspace_id = NULLIF(current_setting('app.workspace_id', true), '')::uuid)
        WITH CHECK (workspace_id = NULLIF(current_setting('app.workspace_id', true), '')::uuid)
    $f$, t);
  END LOOP;
END
$$;

-- --- and the one statement that is legitimately about every workspace -------------------------
--
-- Expired elevations are swept across the whole installation, which under `tenant_isolation` alone
-- would delete exactly nothing: with no `app.workspace_id` set the policy is false for every row,
-- so the DELETE would remove no rows, report no error, and pass every test — because a test
-- connects as a superuser and a superuser has no policies. That is the failure 032 was written
-- about, and this is the same remedy in the same shape.
--
-- DELETE ONLY, and only on this table. The platform has no business reading who elevated when —
-- that question is answered per-workspace or from `audit_log` — and a policy that granted SELECT
-- would make the marker a way to enumerate every tenant's secrets activity at once.
DROP POLICY IF EXISTS platform_sweep ON secret_elevations;
CREATE POLICY platform_sweep ON secret_elevations
  FOR DELETE
  USING (current_setting('app.platform', true) = 'on');

-- Explicit, for the same reason 015 was explicit: a migration run by a different role than the one
-- that ran 009 is not covered by that migration's default privileges, and the symptom is a
-- permission error on somebody's first unlock rather than at deploy time.
GRANT SELECT, INSERT, UPDATE, DELETE
  ON user_secret_passcodes, secret_elevations, secret_usages, secret_rotations
  TO jaroku_app;
