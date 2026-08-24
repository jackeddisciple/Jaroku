-- 055_turn_attachments — the context somebody attached to a turn, snapshotted at the moment they
-- sent it.
--
-- WHY A ROW AT ALL, when the composer already knows what it attached. §4.4: "A turn's context must
-- be reconstructible from turn_attachments alone." The composer's copy dies with the tab; this is
-- what makes a turn from three weeks ago answerable to "what was the model actually looking at" —
-- which is the first question asked when an agent did something nobody can explain.
--
-- SNAPSHOT AT SEND, NOT AT ATTACH, and `ref` is where that lives. A file attachment stores
-- {path, version_id}, not {path}: the file changes, and a turn that resolved "whatever
-- tools/weather.py says now" would describe a conversation that never happened. Same for a commit
-- sha, a run id, a dataset case. The rule is one sentence — store the RESOLVED ref — and the whole
-- reproducibility claim rests on it.
--
-- `ref` IS jsonb AND NOT FIVE NULLABLE COLUMNS. Five kinds with five different shapes would be
-- fifteen columns, fourteen of them NULL on every row, and a sixth kind would be a migration. The
-- shape per kind is documented in the CHECK's own comment and validated in TypeScript, where a
-- malformed ref is a 400 rather than a constraint violation nobody can read.
--
-- THE FOREIGN KEY IS THE PAIR. §7's rule, and here the parent is `thread_items` — Jaroku's durable
-- per-turn row (migration 044). A bare `thread_items(id)` FK is satisfiable by any tenant's turn,
-- which is the class of bug the tenancy hunt turned up, so `thread_items` gains a unique
-- constraint on the pair for this to point at.
--
-- `token_estimate` IS A NUMBER WE COMPUTED, NOT ONE A CLIENT SENT. §4.4's budget check blocks a
-- send that would exceed the model's context window, and a client-supplied estimate would make
-- that check advisory — the exact "silent truncation" the spec calls "the worst possible behavior
-- here, because it produces a confident answer grounded in half a file."

ALTER TABLE thread_items ADD CONSTRAINT thread_items_ws_id_unique UNIQUE (workspace_id, id);

CREATE TABLE turn_attachments (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id  uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  turn_id       uuid NOT NULL,

  -- §4.2's five sources. A closed set, unlike `usage_events.kind`: adding a sixth means writing a
  -- picker, a resolver and a chip for it, so the schema is not the thing standing in the way.
  kind          text NOT NULL
    CHECK (kind IN ('file', 'run', 'dataset_case', 'tool_schema', 'github')),

  -- The RESOLVED reference, by kind:
  --   file         {"path": "tools/weather.py", "version_id": "…"}
  --   run          {"run_id": "…"}
  --   dataset_case {"case_id": "…", "dataset_id": "…"}
  --   tool_schema  {"tool_id": "…", "server_id": "…"}
  --   github       {"commit_sha": "…"} | {"pr": 12} | {"path": "…", "ref": "main"}
  ref           jsonb NOT NULL,

  -- When the ref was pinned. Not `created_at`: the distinction is the feature. This says when the
  -- thing being pointed at was what it was, which is what makes the row a snapshot rather than a
  -- bookmark.
  resolved_at   timestamptz NOT NULL DEFAULT now(),

  -- What it cost the context window, as the SERVER measured it. See the header.
  token_estimate integer NOT NULL DEFAULT 0,

  FOREIGN KEY (workspace_id, turn_id)
    REFERENCES thread_items (workspace_id, id) ON DELETE CASCADE
);

-- The read this table exists for: everything attached to one turn, in the order it was attached.
CREATE INDEX turn_attachments_turn ON turn_attachments (workspace_id, turn_id, resolved_at);

ALTER TABLE turn_attachments ENABLE ROW LEVEL SECURITY;
ALTER TABLE turn_attachments FORCE  ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON turn_attachments;
CREATE POLICY tenant_isolation ON turn_attachments
  USING      (workspace_id = NULLIF(current_setting('app.workspace_id', true), '')::uuid)
  WITH CHECK (workspace_id = NULLIF(current_setting('app.workspace_id', true), '')::uuid);
