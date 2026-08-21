-- 053_sign_in — the SQLite half.
--
-- Read the Postgres file for every decision: why `users.name` and `users.onboarding_completed_at`
-- are deliberately NOT added, why `email_verified` is backfilled to true, why `auth_provider`
-- carries no CHECK constraint, why the state and the ticket are stored as digests while the PKCE
-- verifier is not, why the rate-limit counter is a separate table from the token table, and why
-- none of these four tables is tenant-scoped.
--
-- Same translation as every migration on this driver: uuid -> TEXT, timestamptz -> TEXT holding
-- ISO-8601 UTC, boolean -> INTEGER, inet -> TEXT, smallint -> INTEGER. Ids and timestamps that
-- Postgres would default are supplied by the repository on both drivers already, so a row from
-- either is the same shape in JavaScript.
--
-- TWO TRANSLATIONS ARE WORTH NAMING BECAUSE GETTING THEM WRONG IS SILENT:
--
--   `boolean NOT NULL DEFAULT false` BECOMES `INTEGER NOT NULL DEFAULT 0`, and the value written
--   must be 0/1 rather than the string 'false'. `test:boolean-literals` exists because that
--   mistake shipped once: a literal 0 is not a false, and only Postgres says so — SQLite accepts
--   the string, stores it, and every read of it is truthy forever.
--
--   `timestamptz` BECOMES `TEXT`, so a comparison like `expires_at > now()` has to be done against
--   an ISO-8601 string rather than in SQL date arithmetic. Every query in `auth/` passes the
--   instant as a parameter for exactly that reason; ISO-8601 UTC sorts lexicographically, which is
--   what makes the string comparison correct rather than merely accidental.
--
-- No RLS here and there never will be; see 052's note. On this driver the repository's WHERE is
-- the whole of the enforcement — and for these five tables there is no tenant to enforce.

-- --- what an account remembers ------------------------------------------------------------------

ALTER TABLE users ADD COLUMN email_verified          INTEGER NOT NULL DEFAULT 0;
ALTER TABLE users ADD COLUMN auth_provider           TEXT;
ALTER TABLE users ADD COLUMN marketing_emails_opt_in INTEGER NOT NULL DEFAULT 0;
ALTER TABLE users ADD COLUMN onboarding_started_at   TEXT;
ALTER TABLE users ADD COLUMN onboarding_step         INTEGER NOT NULL DEFAULT 1;

UPDATE users SET email_verified = 1 WHERE deleted_at IS NULL;
UPDATE users SET onboarding_step = 5 WHERE onboarded_at IS NOT NULL;

-- --- the three short-lived secrets ---------------------------------------------------------------

CREATE TABLE magic_link_tokens (
  token_hash  TEXT PRIMARY KEY,
  -- Plain TEXT rather than `COLLATE NOCASE`, and unlike `users.email` that is correct here: this
  -- column is written already-lowercased and only ever compared to an already-lowercased value.
  -- A NOCASE collation would make the comparison right for the wrong reason and would hide a
  -- caller that forgot to normalise — which would then behave differently on Postgres, where the
  -- column is plain text and the comparison really is case-sensitive.
  email       TEXT NOT NULL,
  ip_address  TEXT,
  user_agent  TEXT,
  created_at  TEXT NOT NULL,
  expires_at  TEXT NOT NULL,
  consumed_at TEXT
);

CREATE INDEX magic_link_tokens_email  ON magic_link_tokens (email, created_at DESC);
CREATE INDEX magic_link_tokens_expiry ON magic_link_tokens (expires_at);

CREATE TABLE oauth_state_tokens (
  state_hash    TEXT PRIMARY KEY,
  provider      TEXT NOT NULL,
  code_verifier TEXT NOT NULL,
  nonce_hash    TEXT NOT NULL,
  redirect_to   TEXT,
  created_at    TEXT NOT NULL,
  expires_at    TEXT NOT NULL,
  consumed_at   TEXT
);

CREATE INDEX oauth_state_tokens_expiry ON oauth_state_tokens (expires_at);

CREATE TABLE session_tickets (
  ticket_hash TEXT PRIMARY KEY,
  user_id     TEXT NOT NULL,
  provider    TEXT NOT NULL,
  -- Which app instance this is for; see the Postgres file for the desktop threat it closes and
  -- for why the magic-link flow deliberately leaves it NULL.
  nonce_hash  TEXT,
  created_at  TEXT NOT NULL,
  expires_at  TEXT NOT NULL,
  consumed_at TEXT
);

CREATE INDEX session_tickets_expiry ON session_tickets (expires_at);

CREATE TABLE magic_link_rate_limits (
  key          TEXT PRIMARY KEY,
  window_start TEXT NOT NULL,
  count        INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE blocked_emails (
  email      TEXT PRIMARY KEY,
  reason     TEXT NOT NULL,
  detail     TEXT,
  created_at TEXT NOT NULL
);
