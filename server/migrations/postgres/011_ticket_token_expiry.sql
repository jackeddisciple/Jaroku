-- 011_ticket_token_expiry — when the TOKEN behind a ticket expires.
--
-- A separate migration rather than an edit to 010, which shipped an hour ago. That is the
-- whole point of forward-only and checksummed: "it only just landed" is exactly the reasoning
-- that produces two databases with the same version number and different schemas, and
-- `npm run test:migrate` refuses an edited file by name for precisely this case.
--
-- WHY THE COLUMN. A socket outlives the request that opened it by hours, and the ticket is the
-- only moment the token and the socket are in the same place. Without this the revalidation
-- timer knows a socket's workspace and role but not when its credential ran out — so a
-- connection authorised by a token that expired at lunchtime keeps working until somebody
-- closes the tab.
--
-- Unix SECONDS, matching a JWT's `exp` rather than JavaScript's milliseconds, so nothing has to
-- remember which unit this one is. NULL means the socket was opened without a token at all,
-- which is the JAROKU_DEV_AUTH path — and null is "no expiry known", never "expired".
--
-- Deliberately unrelated to `expires_at`, which is the ticket's own thirty seconds.

ALTER TABLE ws_tickets ADD COLUMN token_expires_at bigint;
