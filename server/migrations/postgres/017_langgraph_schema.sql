-- 017_langgraph_schema — a room for somebody else's tables.
--
-- The checkpointer moves from `runtime/.checkpoints/<run_id>.sqlite` to Postgres, because a file
-- on one machine cannot be resumed by a worker on another. What it does NOT do is move into
-- Jaroku's schema.
--
-- TWO MIGRATION RUNNERS MUST NOT SHARE A SCHEMA. LangGraph's `PostgresSaver.setup()` creates and
-- upgrades its own tables on its own timetable, and this repository's runner is forward-only and
-- checksummed and refuses a file that changed. Put them in one namespace and every LangGraph
-- upgrade is a table Jaroku's migrations did not create, in a schema whose contents they are
-- supposed to describe — with no mechanism for either side to notice.
--
-- AND RLS DOES NOT REACH IN THERE. LangGraph never issues `SET LOCAL app.workspace_id`, so a
-- policy on its tables would match nothing and every checkpoint write would fail. The isolation
-- is in the KEY instead: a thread id is `ws:<workspace_id>:run:<run_id>`, access is mediated
-- entirely by Jaroku's code, and the sweep is a prefix delete. That is a weaker wall than the
-- one every other table has, and it is stated plainly here rather than left to be discovered.
--
-- SO ALL THIS MIGRATION OWNS IS THE SCHEMA AND THE GRANT. Nothing inside it is described here,
-- deliberately: `CREATE TABLE` statements for tables another project owns would be a copy that
-- drifts. The runner creates the schema too, at run time, because a sandbox may reach a database
-- this migration has not been run against — but a deployment should not depend on that, and the
-- grant genuinely cannot be done from there.

CREATE SCHEMA IF NOT EXISTS langgraph;

GRANT USAGE, CREATE ON SCHEMA langgraph TO jaroku_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA langgraph TO jaroku_app;
ALTER DEFAULT PRIVILEGES IN SCHEMA langgraph
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO jaroku_app;
