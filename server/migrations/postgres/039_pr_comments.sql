-- 039_pr_comments — review comments, mirrored, and what Jaroku did about each one.
--
-- THIS IS A MIRROR, AND 034'S HEADER ARGUED AGAINST EXACTLY THAT — so the difference is worth
-- stating rather than leaving to be noticed. 034 refused a `github_commits` table because GitHub is
-- the authority on its own lineage and a cached copy goes stale the moment somebody pushes from a
-- laptop. Every word of that still holds for commits. It does not hold here, because this table
-- does not store the comment to answer "what did the reviewer say" — GitHub answers that, and the
-- text column is a convenience the panel refreshes. It stores the RESOLUTION STATE, which is a fact
-- about Jaroku that GitHub has no column for: was this comment turned into an edit, was it applied,
-- and which version came out. Nothing on GitHub's side can answer that, so nothing here is a second
-- copy of an answer that already exists.
--
-- `github_comment_id` IS THE NATURAL KEY AND IS UNIQUE PER WORKSPACE. A sync runs on every panel
-- open and must be idempotent: the same comment arriving twice updates one row rather than adding a
-- second, and the resolution state on it survives the update. That is an upsert, and an upsert needs
-- something to conflict on.
--
-- `in_reply_to_id` IS STORED SO A REPLY CAN BE THREADED. §B.5.3 requires the reply to be a real
-- threaded reply to the specific review comment, not a general pull request comment, because a
-- teammate who never opens Jaroku still sees the conversation resolve in place. Posting that needs
-- the id of the comment being replied to, which is this column and not the row's own id.
--
-- WHY `path` AND `line` ARE COLUMNS RATHER THAN JSON. They are what the routing signal in §B.5.2
-- reads: a comment pinned to a file and a line is unambiguous in the way v0.1.7's "a failed step is
-- selected → fix" already is, and a router that had to parse a blob to decide would be a router
-- that fails open when the blob shape changes.
--
-- NOTHING HERE IS A WRITE PATH. §B.5.1 is explicit that a review comment is context and not an
-- instruction — clicking Fix in Jaroku attaches a chip, and the edit that follows goes through the
-- ordinary edit loop, the diff card and Apply. The `resolution` column records which of those
-- happened; it does not cause any of them.

CREATE TABLE pr_comments (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id      uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  agent_id          uuid NOT NULL,
  link_id           uuid REFERENCES github_links(id) ON DELETE SET NULL,
  pr_number         integer NOT NULL,
  -- GitHub's own id for the review comment. The natural key; see the header.
  github_comment_id text NOT NULL,
  -- The comment this one replies to, when it is itself a reply. NULL for a thread's first comment.
  in_reply_to_id    text,
  author_login      text,
  -- Repository-relative, as GitHub spells it. Translated to a project-relative path by the reader,
  -- not here, because the translation needs the link's subdirectory and a stored translation would
  -- be wrong the moment somebody changed it.
  path              text,
  line              integer,
  body              text NOT NULL DEFAULT '',
  -- The commit the comment was left against, so a chip can say what it was looking at.
  commit_sha        text,
  -- What Jaroku did. `open` is the default and the overwhelming majority; the other three are the
  -- three honest endings, and `dismissed` exists so somebody can close a comment they have decided
  -- not to act on without that being indistinguishable from never having read it.
  resolution        text NOT NULL DEFAULT 'open',
  -- The version an applied edit produced, when one did. Null for every other resolution — and
  -- null, not zero, for an edit that was proposed and never applied.
  resolved_version  integer,
  -- Whether the threaded reply made it back to GitHub. Separate from `resolution` because the two
  -- fail independently: an edit can land and the reply can 500, and a row that conflated them would
  -- either claim the work was not done or claim the teammate was told.
  replied_at        timestamptz,
  synced_at         timestamptz NOT NULL DEFAULT now(),
  created_at        timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (workspace_id, agent_id) REFERENCES agents (workspace_id, id) ON DELETE CASCADE
);

ALTER TABLE pr_comments
  ADD CONSTRAINT pr_comments_resolution_check
  CHECK (resolution IN ('open', 'proposed', 'applied', 'dismissed'));

-- What the upsert conflicts on. Per workspace rather than globally: two workspaces may legitimately
-- link the same repository — 034's `linksForRepo` says so at length — and a globally unique index
-- would make the second one's sync fail on the first one's rows.
CREATE UNIQUE INDEX pr_comments_github_id ON pr_comments (workspace_id, github_comment_id);

-- The REVIEW region's read: this agent's comments on this pull request, oldest first, which is the
-- order a conversation is read in.
CREATE INDEX pr_comments_pr ON pr_comments (workspace_id, agent_id, pr_number, created_at);

ALTER TABLE pr_comments ENABLE ROW LEVEL SECURITY;
ALTER TABLE pr_comments FORCE  ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON pr_comments;
CREATE POLICY tenant_isolation ON pr_comments
  USING      (workspace_id = NULLIF(current_setting('app.workspace_id', true), '')::uuid)
  WITH CHECK (workspace_id = NULLIF(current_setting('app.workspace_id', true), '')::uuid);

GRANT SELECT, INSERT, UPDATE, DELETE ON pr_comments TO jaroku_app;
