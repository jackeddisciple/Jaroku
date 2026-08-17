-- 044_thread_items — the SQLite half. Read the Postgres file for why this is a join table and not a
-- copy, why it has no `state` column, why only the user's own turns are stored as messages, and why
-- `usage_events` gains a column instead of this table gaining a total.
--
-- Same translation as every migration on this driver: uuid -> TEXT, timestamptz -> TEXT ISO-8601.
-- The CHECK that is a separate statement on Postgres is inline on the column.
--
-- NO RLS, on this driver, ever — see 009. Which is also why the backfill below needs no `FORCE`
-- toggle: there is no policy to lift, and the repository layer's WHERE is the whole of the
-- enforcement.
--
-- THE ONE THING THAT LOOKS DIFFERENT AND IS NOT. Postgres defaults `id` with `gen_random_uuid()`;
-- SQLite has no uuid function, so the backfill builds one out of `randomblob`. It is the standard
-- expression, laid out over four lines so it can be read: eight hex bytes, four, four with the
-- version nibble forced to 4, four with the variant nibble forced to 8–b, twelve. Every id this
-- migration writes is therefore a real v4 uuid rather than something that merely looks like one in
-- a listing — which matters because the Postgres column is a `uuid` and shapeParity compares the
-- two drivers' rows.

CREATE TABLE thread_items (
  id           TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  thread_id    TEXT NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
  kind         TEXT NOT NULL
    CHECK (kind IN ('message', 'plan', 'generation', 'proposal', 'run', 'eval')),
  ref_id       TEXT,
  role         TEXT,
  body         TEXT,
  created_at   TEXT NOT NULL
);

CREATE INDEX thread_items_thread ON thread_items (workspace_id, thread_id, created_at);

CREATE INDEX thread_items_ref ON thread_items (workspace_id, kind, ref_id);

ALTER TABLE usage_events ADD COLUMN thread_id TEXT;

INSERT INTO threads (id, workspace_id, agent_id, agent_name_snapshot, title, title_is_custom,
                     created_by, created_at, last_activity_at, status)
SELECT lower(hex(randomblob(4))) || '-' || lower(hex(randomblob(2))) || '-4'
         || substr(lower(hex(randomblob(2))), 2) || '-'
         || substr('89ab', abs(random()) % 4 + 1, 1)
         || substr(lower(hex(randomblob(2))), 2) || '-' || lower(hex(randomblob(6))),
       a.workspace_id,
       a.id,
       COALESCE(a.display_name, a.slug),
       COALESCE(a.display_name, a.slug),
       0,
       a.created_by,
       a.created_at,
       COALESCE((SELECT MAX(r.started_at) FROM runs r
                  WHERE r.workspace_id = a.workspace_id AND r.agent_id = a.slug),
                a.created_at),
       'idle'
  FROM agents a
 WHERE NOT EXISTS (SELECT 1 FROM threads t
                    WHERE t.workspace_id = a.workspace_id AND t.agent_id = a.id);

INSERT INTO thread_items (id, workspace_id, thread_id, kind, ref_id, created_at)
SELECT lower(hex(randomblob(4))) || '-' || lower(hex(randomblob(2))) || '-4'
         || substr(lower(hex(randomblob(2))), 2) || '-'
         || substr('89ab', abs(random()) % 4 + 1, 1)
         || substr(lower(hex(randomblob(2))), 2) || '-' || lower(hex(randomblob(6))),
       r.workspace_id, t.id, 'run', r.id, r.started_at
  FROM runs r
  JOIN agents a ON a.workspace_id = r.workspace_id AND a.slug = r.agent_id
  JOIN threads t ON t.id = (SELECT t2.id FROM threads t2
                             WHERE t2.workspace_id = a.workspace_id AND t2.agent_id = a.id
                             ORDER BY t2.created_at ASC, t2.id ASC
                             LIMIT 1);
