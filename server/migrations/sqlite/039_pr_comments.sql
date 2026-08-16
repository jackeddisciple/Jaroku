-- 039_pr_comments — the SQLite half. Read the Postgres file for why a mirror is allowed here when
-- 034 refused one for commits, why the GitHub comment id is the natural key, why `in_reply_to_id`
-- is stored separately from the row's own id, and why `replied_at` is not folded into `resolution`.
--
-- Same translation as everywhere else: uuid -> TEXT, timestamptz -> TEXT ISO-8601. Ids that
-- Postgres defaults with `gen_random_uuid()` are supplied by the application here.
--
-- The resolution CHECK is inline on the column, because SQLite has no `ALTER TABLE ... ADD
-- CONSTRAINT`. The composite FK to `agents (workspace_id, id)` points at the unique index 018
-- created for it.
--
-- NO RLS, on this driver, ever — see 009.

CREATE TABLE pr_comments (
  id                TEXT PRIMARY KEY,
  workspace_id      TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  agent_id          TEXT NOT NULL,
  link_id           TEXT REFERENCES github_links(id) ON DELETE SET NULL,
  pr_number         INTEGER NOT NULL,
  github_comment_id TEXT NOT NULL,
  in_reply_to_id    TEXT,
  author_login      TEXT,
  path              TEXT,
  line              INTEGER,
  body              TEXT NOT NULL DEFAULT '',
  commit_sha        TEXT,
  resolution        TEXT NOT NULL DEFAULT 'open'
    CHECK (resolution IN ('open', 'proposed', 'applied', 'dismissed')),
  resolved_version  INTEGER,
  replied_at        TEXT,
  synced_at         TEXT NOT NULL,
  created_at        TEXT NOT NULL,
  FOREIGN KEY (workspace_id, agent_id) REFERENCES agents (workspace_id, id) ON DELETE CASCADE
);

CREATE UNIQUE INDEX pr_comments_github_id ON pr_comments (workspace_id, github_comment_id);

CREATE INDEX pr_comments_pr ON pr_comments (workspace_id, agent_id, pr_number, created_at);
