-- 015_secret_vault — where a credential lives when it cannot live in a file.
--
-- `runtime/.env` is one file, on one machine, owned by the person sitting at it. That is the
-- whole of the local trust boundary and it is fine: the worst case of a leak there is showing
-- somebody their own key. Hosted, it is ~6,000 people's keys in one file that every replica
-- would have to share, and there is no version of that which is acceptable.
--
-- ENVELOPE ENCRYPTION, AND WHY IT IS TWO TABLES.
--
-- A per-workspace DATA KEY encrypts that workspace's secrets. A MASTER KEY encrypts the data
-- key. Nothing here ever holds the master key: it is supplied by configuration today and by a
-- cloud KMS later, behind one interface, which is the whole reason the wrapped key carries a
-- `master_key_id` — rotating the master key means rewrapping N data keys rather than
-- re-encrypting every secret on the platform.
--
-- And rotating a WORKSPACE's key means re-encrypting only that workspace's secrets, which is
-- why the data key is versioned and retired rather than replaced. A row still pointing at
-- version 1 is readable while version 2 is being written, so a rotation is not an outage.
--
-- THE CIPHERTEXT IS BOUND TO ITS ROW. Each value is sealed with AES-256-GCM using
-- `<workspace_id>:<name>` as additional authenticated data. That is not belt and braces — it
-- is what makes a copied row useless. A ciphertext moved to another workspace, or renamed to
-- another variable, fails to authenticate and decrypts to nothing at all, so a mistake in the
-- application layer (or a hand-run UPDATE) cannot quietly hand one tenant another's key under a
-- name they chose. RLS is the wall; this is the thing that makes going around it pointless.
--
-- THERE IS NO COLUMN A PLAINTEXT VALUE WOULD FIT IN, in either table, deliberately — the same
-- property `deployments.env_keys` has. A future column that stored one would be a schema change
-- somebody has to defend in review, rather than a field that quietly filled up.
--
-- WHAT IS NOT HERE. The names a workspace has configured, and whether each is set: those are a
-- store-agnostic fact — the local store has them too — and they get their own table in the next
-- migration. This one is only for the implementation that holds ciphertext.

CREATE TABLE workspace_data_keys (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id  uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  -- Bumped on rotation. The newest un-retired version is what new writes use.
  version       integer NOT NULL,
  -- WHICH master key wrapped this one. A deployment whose master key changed can tell a data
  -- key it can still unwrap from one it cannot, and say so, rather than failing to decrypt a
  -- secret and reporting it as corrupt.
  master_key_id text NOT NULL,
  -- base64(iv || tag || ciphertext) of the 32-byte data key. Never the data key itself.
  wrapped_key   text NOT NULL,
  created_at    timestamptz NOT NULL DEFAULT now(),
  -- Set when a newer version supersedes this one. Kept, not deleted: rows encrypted under it
  -- are readable until they have been re-encrypted, and a rotation that took the key away first
  -- would be a rotation that lost every secret it had not reached yet.
  retired_at    timestamptz,
  UNIQUE (workspace_id, version)
);

CREATE INDEX workspace_data_keys_ws_version ON workspace_data_keys (workspace_id, version DESC);

CREATE TABLE workspace_secrets (
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  -- The environment variable name a run will see it under. Validated against
  -- ^[A-Z][A-Z0-9_]{0,127}$ by the application before it ever reaches here.
  name         text NOT NULL,
  -- Which data key version sealed this value. Not "the workspace's current key": during a
  -- rotation those differ, and reading a row means using the key it was actually sealed with.
  data_key_id  uuid NOT NULL REFERENCES workspace_data_keys(id),
  -- base64(iv || tag || ciphertext), AAD = '<workspace_id>:<name>'.
  ciphertext   text NOT NULL,
  provider     text,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now(),
  -- When a run last received this value. A usage signal, and the first thing anybody asks when
  -- deciding whether a credential is still needed.
  last_used_at timestamptz,
  PRIMARY KEY (workspace_id, name)
);

-- --- the backstop ---------------------------------------------------------------------------
--
-- The same ENABLE + FORCE + policy 009 applies to every other tenant table, extended to these
-- two. FORCE is the one that matters: ENABLE alone exempts the table owner, and on a small
-- deployment the owner is the app.
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['workspace_data_keys', 'workspace_secrets']
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

-- 009 granted on ALL TABLES as they stood then, and set default privileges for tables created
-- afterwards BY THE SAME ROLE. A migration run by a different role than the one that ran 009
-- would not be covered by that default, and the symptom is a permission error on the first
-- secret rather than at deploy time. Granting explicitly costs nothing and removes the case.
GRANT SELECT, INSERT, UPDATE, DELETE ON workspace_data_keys, workspace_secrets TO jaroku_app;
