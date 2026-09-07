-- 069_magic_link_poll — how the device that ASKED for a magic link finds out it was used.
--
-- THE FLOW WAS DEVICE-LOCAL AND EMAIL IS NOT. A magic link is requested on a laptop and opened on
-- a phone, because that is where mail gets read — and everything after the click assumed one
-- machine. `/magic` consumes the token, mints a session ticket and redirects to
-- `jaroku://auth/complete?ticket=…`, which is a scheme only a device with Jaroku installed can
-- answer. On a phone nothing happens; on the laptop the screen says "check your email" forever.
-- The sign-in SUCCEEDED — the token is spent, the account is real — and the only device that
-- wanted the session is the one device that never hears about it.
--
-- THE SERVER WAS ALREADY BUILT FOR THIS. `auth/session.ts` says so where it checks the nonce: "A
-- magic-link ticket carries no digest at all — §10 wants a link clicked on a second device to
-- work — and that branch requires nothing." The rule was right and the DELIVERY was the part that
-- assumed otherwise.
--
-- SO THE WAITING DEVICE POLLS, and these two columns are what it polls against.
--
-- `poll_hash` IS NEVER IN THE EMAIL, which is the whole of its security. The raw value is returned
-- once, to the device that made the request, and lives in that page's memory; the digest is what
-- is stored. So possession of the mailbox lets somebody COMPLETE a sign-in — which is the point of
-- a magic link — and possession of the link alone does not let them collect the session onto a
-- device that never asked for one. Hashed at rest for `tickets.ts`'s reason: a copy of this table
-- must not be a set of credentials.
--
-- `claimed_user_id` IS WRITTEN AT CLICK TIME AND READ AT POLL TIME, and it is a user id rather than
-- a ticket on purpose. Storing a raw session ticket here would put a live credential in a table
-- that is otherwise all digests; the poll mints a fresh ticket instead, which is single-use and
-- sixty seconds old, exactly like the one the deep link carries.
--
-- BOTH NULLABLE, per `db/expandContract.ts`: the running version's INSERTs do not name either
-- column, so NOT NULL without a DEFAULT would fail `migrate:check` between build and migrate.

ALTER TABLE magic_link_tokens ADD COLUMN poll_hash text;
ALTER TABLE magic_link_tokens ADD COLUMN claimed_user_id uuid;

-- The poll looks a row up by this and by nothing else, on every tick of a waiting screen.
CREATE INDEX IF NOT EXISTS magic_link_tokens_poll_hash_idx ON magic_link_tokens (poll_hash);

-- AND WHEN IT WAS COLLECTED, which is a third column rather than a clever UPDATE.
--
-- The obvious shape is one statement that clears the claim and RETURNS it, the way
-- `consumeMagicLink` spends a token. It does not work: RETURNING gives the row AFTER the update, so
-- a statement that sets `claimed_user_id = NULL` returns NULL every time — the claim is collected
-- and the caller is told there was nothing to collect. That was written, tested, and caught here.
--
-- So the claim is left alone and THIS is what makes the collect single-use: `collected_at IS NULL`
-- in the WHERE, set in the same statement, with the claim returned untouched. Atomic for the reason
-- every other secret in this schema is — two tabs polling one secret must not both be told yes.
ALTER TABLE magic_link_tokens ADD COLUMN collected_at timestamptz;
