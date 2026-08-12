-- 027_abuse_signals — what a workspace, or an address with no workspace, has been observed doing.
--
-- WHY A TABLE AND NOT A LOG LINE. Hosted agent execution attracts three specific things — crypto
-- miners, proxy and scraping farms, and spam senders — and none of them is identifiable from one
-- event. A miner looks exactly like a slow agent until you notice it burned four minutes of CPU
-- and made no model calls, twice an hour, all week. That is a shape over time, and a shape over
-- time needs rows: something to accumulate into, something to decay, and something an appeal can
-- be argued against six weeks later when the log has rotated.
--
-- SIGNALS ARE OBSERVATIONS, NOT VERDICTS. Nothing in this table decides anything. Each row says
-- "this happened, and here is what it weighed"; the ladder that acts on an accumulated score is
-- the next migration and the next commit, deliberately separate. Recording and enforcing being
-- one step is how a threshold nobody reviewed starts suspending people, and how there turns out
-- to be no record of why.
--
-- `workspace_id` IS NULLABLE, and that is the whole point of the `subject` column beside it.
-- Signup velocity is the earliest signal there is and it is observed BEFORE a workspace exists:
-- the actor is an address. So a row is keyed by whichever of the two identifies the actor, the
-- other is null, and the score functions ask by the one they hold. This mirrors `audit_log`,
-- whose workspace_id is nullable for exactly the same reason — the rows that matter most are the
-- ones with no valid workspace to hang off.
--
-- `subject` IS A HASH, NOT AN ADDRESS. An IP address is personal data in most of the places this
-- will run, and this table is retained for longer than a request log. What the scorer needs is
-- "the same actor as last time", which a keyed digest answers exactly as well as the address
-- does — and a digest cannot be joined back to a person by whoever ends up with a copy.

CREATE TABLE abuse_signals (
  id            bigserial PRIMARY KEY,
  -- One of these two is set. See the header.
  workspace_id  uuid REFERENCES workspaces(id) ON DELETE CASCADE,
  subject       text,
  -- Which observation this is: `sandbox.cpu_without_llm`, `signup.velocity`, and the rest of
  -- abuse/signals.ts's table. Text rather than an enum because the set grows as the platform
  -- learns what abuse looks like here, and a CHECK constraint on it would make adding one a
  -- migration — which is exactly the friction that makes people log instead of record.
  kind          text NOT NULL,
  -- What this observation weighed WHEN IT WAS MADE, copied from the code's table rather than
  -- joined to it. Deliberate: re-weighting a signal must not silently re-sentence every
  -- workspace that already tripped it, and an appeal has to be arguable against the numbers that
  -- were actually applied.
  weight        numeric NOT NULL,
  -- The evidence, in whatever shape the detector produced. Never a payload: an agent's trace is
  -- the user's data and does not belong in a table the platform reads about them.
  detail        jsonb NOT NULL DEFAULT '{}',
  -- What the signal was about, when there is something to point at — a run id, a connector.
  target_type   text,
  target_id     text,
  observed_at   timestamptz NOT NULL DEFAULT now()
);

-- The scorer's query: one workspace, recent first, within a window.
CREATE INDEX abuse_signals_ws_time ON abuse_signals (workspace_id, observed_at DESC);
-- And the same question asked of an address that has no workspace yet.
CREATE INDEX abuse_signals_subject_time ON abuse_signals (subject, observed_at DESC)
  WHERE subject IS NOT NULL;
-- For the platform-wide view: what kind of abuse is happening right now, across everybody.
CREATE INDEX abuse_signals_kind_time ON abuse_signals (kind, observed_at DESC);

-- --- the backstop -----------------------------------------------------------------------------
--
-- ENABLE + FORCE + policy, like every other tenant table. Worth stating why it applies to a table
-- ABOUT a workspace rather than belonging to one: what a tenant has been observed doing is a
-- description of that tenant, and one workspace reading another's is both a leak and a map of
-- which thresholds are near.
--
-- THE ROWS WITH A NULL workspace_id ARE INVISIBLE UNDER THIS POLICY, and that is correct rather
-- than a gap. A signup-velocity row belongs to no tenant and must never be readable by one; the
-- platform-side scorer that reads it runs as the migration role, not as `jaroku_app` acting for
-- a workspace. `audit_log` carries no policy at all for a related reason — see 004.
ALTER TABLE abuse_signals ENABLE ROW LEVEL SECURITY;
ALTER TABLE abuse_signals FORCE  ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON abuse_signals;
CREATE POLICY tenant_isolation ON abuse_signals
  USING      (workspace_id = NULLIF(current_setting('app.workspace_id', true), '')::uuid)
  WITH CHECK (workspace_id = NULLIF(current_setting('app.workspace_id', true), '')::uuid);

-- The subject-scoped rows are written and read outside any workspace scope, so the policy above
-- would refuse them. A second policy rather than a looser first one: "a row with no tenant" is a
-- different case from "a row of this tenant's", and collapsing them into one expression is how a
-- workspace ends up able to write rows nobody can attribute.
DROP POLICY IF EXISTS platform_subject_rows ON abuse_signals;
CREATE POLICY platform_subject_rows ON abuse_signals
  USING      (workspace_id IS NULL AND NULLIF(current_setting('app.workspace_id', true), '') IS NULL)
  WITH CHECK (workspace_id IS NULL AND NULLIF(current_setting('app.workspace_id', true), '') IS NULL);

GRANT SELECT, INSERT, DELETE ON abuse_signals TO jaroku_app;
GRANT USAGE, SELECT ON SEQUENCE abuse_signals_id_seq TO jaroku_app;
