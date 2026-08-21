-- 053_sign_in — how somebody gets a session, and how far through setting up they are.
--
-- FOUR PRE-AUTHENTICATION TABLES AND SIX COLUMNS ON `users`. The tables are the short-lived
-- secrets three round trips are built out of; the columns are what a person's account remembers
-- about them afterwards.
--
-- THE SPECIFICATION'S DDL IS NOT COPIED VERBATIM, AND EACH DEPARTURE IS A DECISION:
--
--   `users.name` IS NOT ADDED. This schema has had `display_name` since 003 — it is what the
--   session view returns, what the members list renders, what `provisionUser` sets from the
--   provider's claim, and what the workspace's default name is derived from. Adding a second
--   column called `name` would produce two answers to "what is this person called", and the one
--   that is wrong would be whichever the next writer happened to pick. So §3.4's name collection
--   writes `display_name`, and every existing reader keeps working with no change at all.
--
--   `users.onboarding_completed_at` IS NOT ADDED EITHER, for the identical reason: 013 added
--   `onboarded_at` and `markOnboarded` is already idempotent on it. The specification's §5.2
--   definition of "onboarding completed" is a rule about WHEN to set a timestamp, not an argument
--   for a second timestamp beside the one that exists. What IS added is the two facts 013 has no
--   answer for — when somebody STARTED, and which step they stopped on.
--
--   `email_verified` IS NOT NULLABLE AND DEFAULTS FALSE, per the spec, and every row that exists
--   before this migration gets `true` in the backfill below. That is not optimism: every account
--   in this database was provisioned from a verified OIDC claim, because `sessionHandler` refuses
--   a token with no verified email address and always has. Defaulting them to `false` would be
--   recording a doubt about a fact this system has always required.
--
--   `auth_provider` CARRIES NO CHECK CONSTRAINT, which departs from the spec's
--   `CHECK (auth_provider IN ('google','magic_link'))`. This is the same judgement 052 made about
--   `metric` and 020 made about `subscriptions.status`: a closed set in the schema means the day
--   somebody adds GitHub sign-in is a day they write a migration, and a migration for a string is
--   one that gets skipped by adding a value the check does not know about. The set lives in
--   `auth/signIn.ts` where adding to it is a code review. `test:sign-in` is what keeps it closed.
--   It is also NULLABLE and has no default, deliberately: a row provisioned before this migration
--   was created through the local issuer or an external OIDC provider, and stamping either of the
--   two new values onto it would be inventing a fact.
--
-- NONE OF THE FOUR TABLES IS TENANT-SCOPED, AND THAT IS WHY THERE IS NO RLS ON ANY OF THEM. Every
-- row in them exists BEFORE there is a user, let alone a workspace — a magic-link token is minted
-- for an email address that may belong to nobody, and an OAuth state is minted before Google has
-- said who is signing in. There is no `workspace_id` to write a policy against and inventing one
-- would be inventing a tenancy. What protects them instead is that no client can reach them:
-- every route that touches one is in `auth/`, takes no workspace, and returns nothing from the
-- row but the outcome. `db/boundary.test.ts` is what makes "no tenant column" a checked property
-- rather than an omission.
--
-- AND EVERY SECRET IS STORED AS A DIGEST, NEVER RAW. Three of the four tables are keyed by
-- `sha256(secret)`, so a dump of this database is not a set of usable credentials: an attacker
-- holding it can see that a token was issued to an address and cannot produce the token. SHA-256
-- rather than Argon2id, and the difference from password storage is the point — these are 256-bit
-- random values with no dictionary to make expensive, and a slow KDF on a callback a third party
-- drives would be a self-inflicted rate limit on the busiest unauthenticated route in the system.
-- `ws_tickets` in 010 made exactly this argument first.

-- --- what an account remembers ------------------------------------------------------------------

ALTER TABLE users ADD COLUMN email_verified          boolean     NOT NULL DEFAULT false;
ALTER TABLE users ADD COLUMN auth_provider           text        NULL;
ALTER TABLE users ADD COLUMN marketing_emails_opt_in boolean     NOT NULL DEFAULT false;
-- When they first saw step 1. Distinct from `onboarded_at`, which is when they finished: the gap
-- between the two is the only thing that can answer "where do people give up", and a single
-- timestamp cannot.
ALTER TABLE users ADD COLUMN onboarding_started_at   timestamptz NULL;
-- §5.3's resume. 1-5, and it advances as steps complete rather than as they are shown — see
-- §9.3, which distinguishes a SKIP (which advances) from an INTERRUPTION (which does not).
ALTER TABLE users ADD COLUMN onboarding_step         smallint    NOT NULL DEFAULT 1;

-- Every account that exists reached this database through `sessionHandler`, which refuses a token
-- carrying no verified email address. See the header: false would be recording a doubt about
-- something this system has always required.
UPDATE users SET email_verified = true WHERE deleted_at IS NULL;

-- And anybody already onboarded is past the last step. Without this, `onboarding_step` defaults to
-- 1 for the whole existing user base — harmless while `onboarded_at` is what gates the flow, and a
-- trap the moment anything reads the step on its own.
UPDATE users SET onboarding_step = 5 WHERE onboarded_at IS NOT NULL;

-- --- the three short-lived secrets ---------------------------------------------------------------

-- §3.3. One row per link sent, whether or not the address belongs to anybody — the route always
-- answers 200, so a row here says a link was SENT and never that an account exists.
CREATE TABLE magic_link_tokens (
  token_hash text PRIMARY KEY,
  -- Stored lowercased, which is not the same rule `users.email` follows. That column is citext:
  -- it preserves what somebody typed and compares case-insensitively. Here there is nothing to
  -- preserve — nobody reads this address, it is only ever compared — and lowercasing it means the
  -- rate-limit key and the consumption check cannot disagree about which address this was.
  email       text        NOT NULL,
  -- inet, and it must record what ARRIVED including something that is not an address; see 003's
  -- note on `audit_log.ip`. Nullable because a request through a socket with no remote address is
  -- a real case and refusing to send a sign-in link over it would be refusing a person.
  ip_address  inet        NULL,
  user_agent  text        NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  expires_at  timestamptz NOT NULL,
  -- §3.3: "Marks the token consumed atomically (an UPDATE … WHERE consumed_at IS NULL RETURNING *
  -- in one query) — prevents double-use if the user clicks the link twice quickly." The column is
  -- what makes that single statement possible; a DELETE would work too and would lose the ability
  -- to tell "already used" from "never existed", which the sweep below needs.
  consumed_at timestamptz NULL
);

-- The rate-limit lookup, which is `WHERE email = ? AND created_at > ?`. §3.3 asks for three per
-- address per hour, and without this that question is a scan of every link ever sent.
CREATE INDEX magic_link_tokens_email ON magic_link_tokens (email, created_at DESC);
-- And the sweep's, which is `WHERE expires_at < now()`. A daily job over a table with no index on
-- the column it filters by is a daily sequential scan.
CREATE INDEX magic_link_tokens_expiry ON magic_link_tokens (expires_at);

-- §3.2. Minted when somebody presses "Continue with Google", consumed when the browser comes back.
CREATE TABLE oauth_state_tokens (
  -- The DIGEST of the state, not the state. The specification's DDL says `state text PRIMARY KEY`
  -- and that is the one place its own rule — "never store raw tokens, always hashes" — is not
  -- applied to its own table. A raw state in a dump is a login-CSRF that can be replayed against
  -- whoever it was minted for, which is precisely what `state` exists to prevent.
  state_hash    text        PRIMARY KEY,
  provider      text        NOT NULL,
  -- The PKCE verifier, held until the exchange. It is a secret and it is stored RAW, which is the
  -- one exception here and is not an oversight: the verifier has to be SENT to Google's token
  -- endpoint in the clear, so a digest of it is unusable. What bounds the damage is the row's own
  -- lifetime — ten minutes, single use — and the fact that a verifier is worth nothing without the
  -- authorization code it pairs with, which never touches this database at all.
  code_verifier text        NOT NULL,
  -- §3.2 step 2: "Bound to the Tauri app instance via a locally-generated nonce." Hashed for the
  -- same reason the state is: it is the value that says this callback belongs to this app instance.
  nonce_hash    text        NOT NULL,
  -- Where to send the browser when this completes. Held here rather than trusted from the callback
  -- for the reason every scoping decision in this codebase is made server-side: a redirect target
  -- a client can choose is an open redirect, and an open redirect on an auth callback is how a
  -- ticket ends up at somebody else's host.
  redirect_to   text        NULL,
  created_at    timestamptz NOT NULL DEFAULT now(),
  expires_at    timestamptz NOT NULL,
  consumed_at   timestamptz NULL
);

CREATE INDEX oauth_state_tokens_expiry ON oauth_state_tokens (expires_at);

-- §3.2 step 5 and §3.3 step 7 both end here: the sixty-second window between a web callback that
-- knows who signed in and a desktop app that does not yet.
--
-- NOT `ws_tickets`, AND THE TWO MUST NOT BE MERGED. That table's ticket names a WORKSPACE and buys
-- one socket; this one names a USER and buys a session. Sharing a table would mean a value good
-- for one was structurally capable of being the other, and the whole reason either is safe in a
-- URL is that it is worth exactly one narrow thing.
CREATE TABLE session_tickets (
  ticket_hash text        PRIMARY KEY,
  -- Not a foreign key to `users`, deliberately, and for `audit_log.workspace_id`'s reason: a
  -- ticket outliving the account it was minted for is a row worth keeping until the sweep, and a
  -- cascade would silently delete the evidence that a sign-in was in flight when an account went.
  user_id     uuid        NOT NULL,
  provider    text        NOT NULL,
  -- WHICH APP INSTANCE THIS TICKET IS FOR, carried forward from the OAuth state that produced it.
  -- §3.2 step 2 asks for the state to be "bound to the Tauri app instance via a locally-generated
  -- nonce", and this is where that binding survives the round trip: the app generates a nonce,
  -- sends it when it starts the flow, and presents it again when it exchanges the ticket.
  --
  -- THE THREAT IT ACTUALLY CLOSES IS A DESKTOP ONE. `jaroku://` is a URL scheme, and any program
  -- on the machine can register one — so a ticket travelling through the operating system is a
  -- ticket another process may be handed first. It is single-use and sixty seconds either way,
  -- but without this an interceptor that wins the race gets a session; with it, the exchange fails
  -- because the interceptor cannot produce a value that never left the real app's memory.
  --
  -- NULLABLE, AND THE MAGIC-LINK FLOW LEAVES IT NULL ON PURPOSE. §10 is explicit that clicking a
  -- link on a DIFFERENT device is a feature rather than a bug — "the deep-link opens the Jaroku
  -- app on that device" — and there is no app instance on the phone that generated a nonce on the
  -- laptop. Binding it would break the one cross-device path the specification asks for.
  nonce_hash  text        NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  expires_at  timestamptz NOT NULL,
  consumed_at timestamptz NULL
);

CREATE INDEX session_tickets_expiry ON session_tickets (expires_at);

-- §3.3's two limits — three per address per hour, ten per IP per hour — as one table keyed by a
-- string, for the reason 052 made `metric` a row rather than a column: the third dimension anybody
-- wants to bound is a constant in TypeScript rather than a migration.
--
-- A SEPARATE TABLE FROM `magic_link_tokens` EVEN THOUGH THE FIRST LIMIT COULD BE COUNTED FROM IT.
-- The per-IP limit could not: a request from an IP for an address that already hit its own limit
-- writes no token row, so counting rows would let one address's refusals fund another's attempts
-- from the same machine. A counter counts ATTEMPTS; the token table records SUCCESSES.
CREATE TABLE magic_link_rate_limits (
  key          text        PRIMARY KEY,
  window_start timestamptz NOT NULL,
  count        integer     NOT NULL DEFAULT 0
);

-- §8.4. A hard bounce or a spam complaint means this address must not be sent another sign-in
-- link, and the reason is not politeness: continuing to mail an address that bounces is how a
-- sending domain's reputation goes, and a domain with a bad reputation is a product nobody can
-- sign into. Its own table rather than a column on `users`, because the addresses that matter most
-- here have no user row at all — somebody typed an address wrong, it bounced, and there is nobody
-- to put the flag on.
CREATE TABLE blocked_emails (
  email      text        PRIMARY KEY,
  -- 'bounce' or 'complaint'. No CHECK, for `auth_provider`'s reason.
  reason     text        NOT NULL,
  detail     text        NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- --- the grants ---------------------------------------------------------------------------------
--
-- No RLS on any of these; see the header. The grants are still needed, because `jaroku_app` is not
-- the owner and a table nobody granted is a table the application cannot read — which would
-- present as sign-in failing entirely on Postgres and working on SQLite, the exact cross-driver
-- shape the conformance suite exists to catch.

GRANT SELECT, INSERT, UPDATE, DELETE ON magic_link_tokens      TO jaroku_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON oauth_state_tokens     TO jaroku_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON session_tickets        TO jaroku_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON magic_link_rate_limits TO jaroku_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON blocked_emails         TO jaroku_app;
