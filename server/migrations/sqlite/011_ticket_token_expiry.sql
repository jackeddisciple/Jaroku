-- 011_ticket_token_expiry — the SQLite half. See the Postgres file.
--
-- INTEGER rather than bigint: SQLite's INTEGER is already 64-bit, and it is the spelling every
-- other numeric column in this schema uses.

ALTER TABLE ws_tickets ADD COLUMN token_expires_at INTEGER;
