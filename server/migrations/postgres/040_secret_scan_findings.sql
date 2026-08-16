-- 040_secret_scan_findings — what the pre-push scanner found, and whether somebody pushed anyway.
--
-- APPEND-ONLY, AND IT MIRRORS `github_events` DELIBERATELY. 034 gave that table `outcome` with
-- `refused` as a first-class value, and argued that a pull validation turned away is the most
-- informative row it holds. A push a secret scan turned away is the same shape of fact one feature
-- over, and the same argument applies unchanged: it is the moment Jaroku's own bar was applied to
-- what was about to leave the machine.
--
-- WHY IT IS NOT SIMPLY A `github_events` ROW. Two reasons, and neither is tidiness. A finding names
-- a PATH and a RULE, and `github_events.detail` is one free-text column that the panel already
-- renders as a sentence — putting `runtime/.env.local matches AWS secret key shape` in there makes
-- the finding unqueryable, so "has this repository ever been pushed over a finding?" becomes a
-- LIKE scan. And one push produces N findings; an event row per finding would put N rows in the
-- history for one action, which is exactly the noise §3.5's refusal card exists to avoid. So: one
-- event for the push, N rows here, joined by `event_id`.
--
-- NO VALUE IS EVER STORED, and this is the column list's most important property. A finding records
-- the path, the rule that matched, and a byte offset — never the matched text, never a prefix of
-- it, never a hash of it. A table of "here is where the credentials are, and here is a bit of each
-- one" would be a strictly worse leak than the push it prevented. `masked_hint` on `secret_refs`
-- exists because a user has to recognise their own key in a list; nobody has to recognise anything
-- here, so nothing is kept.
--
-- `overridden` IS A COLUMN AND NOT A SEPARATE TABLE. §B.6.1 puts "Ignore & push anyway" under a
-- kebab — available, never the path of least resistance, and recorded. The row is written when the
-- scan refuses; the flag is set if somebody then overrides. Two tables would make "was this finding
-- overridden?" a join that returns nothing for the ordinary case, and the ordinary case is the one
-- the panel reads on every push.

CREATE TABLE secret_scan_findings (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  agent_id     uuid NOT NULL,
  link_id      uuid REFERENCES github_links(id) ON DELETE SET NULL,
  -- The `github_events` row for the push this scan ran during, so one action reads as one history
  -- row with its findings hanging off it. NULL only if the event write failed, which is recorded
  -- rather than allowed to lose the finding.
  event_id     uuid REFERENCES github_events(id) ON DELETE SET NULL,
  -- Repository-relative, as the file would have been written. The path the user has to go and look
  -- at is the path the tree would have carried, not the project-relative one.
  path         text NOT NULL,
  -- Which of §B.6.1's four surfaces matched. Named rather than numbered, because this string is
  -- rendered: "matches AWS secret key shape" is the sentence, and a code would need a lookup table
  -- somebody would forget to extend.
  rule         text NOT NULL,
  -- `secret` and `artifact` get different sentences in the UI, because "this repo isn't meant for
  -- binary assets" and "this file might be a credential" are different problems. Stored, so a later
  -- reader does not have to infer the category from the rule name.
  kind         text NOT NULL DEFAULT 'secret',
  -- Where in the file, one-based, for the "View file" action. NULL for a whole-file finding — an
  -- `.env` present at all is a finding about the file's existence, and pointing at line 1 would
  -- imply the first line was the problem.
  line         integer,
  -- Never the matched text. See the header.
  overridden   boolean NOT NULL DEFAULT false,
  overridden_by uuid REFERENCES users(id) ON DELETE SET NULL,
  overridden_at timestamptz,
  created_at   timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (workspace_id, agent_id) REFERENCES agents (workspace_id, id) ON DELETE CASCADE
);

ALTER TABLE secret_scan_findings
  ADD CONSTRAINT secret_scan_findings_kind_check CHECK (kind IN ('secret', 'artifact'));

-- The panel's read: this agent's findings, newest first.
CREATE INDEX secret_scan_findings_agent
  ON secret_scan_findings (workspace_id, agent_id, created_at DESC);

-- The question a security review asks: what has been pushed over, across the workspace. Partial,
-- because the overwhelming majority of rows are refusals nobody overrode and an index carrying
-- them all would be an index of the uninteresting case.
CREATE INDEX secret_scan_findings_overridden
  ON secret_scan_findings (workspace_id, created_at DESC)
  WHERE overridden;

ALTER TABLE secret_scan_findings ENABLE ROW LEVEL SECURITY;
ALTER TABLE secret_scan_findings FORCE  ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON secret_scan_findings;
CREATE POLICY tenant_isolation ON secret_scan_findings
  USING      (workspace_id = NULLIF(current_setting('app.workspace_id', true), '')::uuid)
  WITH CHECK (workspace_id = NULLIF(current_setting('app.workspace_id', true), '')::uuid);

GRANT SELECT, INSERT, UPDATE, DELETE ON secret_scan_findings TO jaroku_app;
