-- 001_extensions — the capabilities every later migration assumes Postgres already has.
--
-- citext, because two identity columns are compared case-insensitively and must be UNIQUE
-- that way too. An email is not a case-sensitive string: nobody believes Ada@example.com
-- and ada@example.com are two people, and a UNIQUE constraint over plain text cheerfully
-- lets both sign up. The same goes for a workspace slug, which appears in URLs. Doing this
-- with lower() functional indexes instead means every query that forgets the lower() reads
-- past the index and, worse, past the uniqueness.
--
-- pgcrypto is belt and braces. gen_random_uuid() has been core since Postgres 13 and that
-- is what the DEFAULTs use, but the extension supplies it on older servers and the digest
-- functions are cheap to have available.

CREATE EXTENSION IF NOT EXISTS citext;
CREATE EXTENSION IF NOT EXISTS pgcrypto;
