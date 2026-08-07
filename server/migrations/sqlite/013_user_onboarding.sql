-- 013_user_onboarding — the SQLite half. See the Postgres file for why this is on `users`.
--
-- TEXT, matching how every other timestamptz column in this schema is stored on this driver:
-- an ISO-8601 string, so a row from either driver is the same shape in JavaScript and the
-- conformance suite has nothing quiet to catch.

ALTER TABLE users ADD COLUMN onboarded_at TEXT;
