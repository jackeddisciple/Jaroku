// What a run's checkpoint thread is called, and which checkpointer is holding it.
//
// The Node half of a name the Python runner also computes (jaroku_runner/debug.py). Two
// spellings of one key would disagree exactly once — on a branch, which re-enters the parent's
// thread — and the symptom would be a fork that finds no checkpoint at a checkpoint id the
// server just read out of its own database. So both sides derive it from the same rule and the
// rule is written down twice, in the two languages, with this comment on both.
//
// THE WORKSPACE IS IN THE NAME, AND ONLY WHERE IT HAS TO BE.
//
// On Postgres, every tenant's threads share one table in a schema that has no row-level
// security — LangGraph never issues `SET LOCAL app.workspace_id`, so a policy there would match
// nothing and every checkpoint write would fail. The isolation is therefore the KEY:
// `ws:<workspace_id>:run:<run_id>`, access mediated entirely by Jaroku's code, and a sweep that
// is a prefix delete.
//
// On SQLite it is one file per run, which is already a namespace, and adding a prefix there
// would buy nothing and cost something real: every checkpoint written before this session is
// named by its bare run id, and a branch from one of those runs would go looking for a thread
// that does not exist. So the local path keeps the old name, and the difference is a
// consequence of the two stores rather than an inconsistency.

export type CheckpointerKind = "sqlite" | "postgres";

export const CHECKPOINTER_ENV = "JAROKU_CHECKPOINTER";
export const CHECKPOINT_PG_URL_ENV = "JAROKU_CHECKPOINT_PG_URL";

/** The schema LangGraph's tables live in. Jaroku owns the schema; LangGraph owns the tables. */
export const CHECKPOINT_SCHEMA = "langgraph";

export function checkpointerKindFromEnv(
  override?: string,
  env: NodeJS.ProcessEnv = process.env,
): CheckpointerKind {
  const raw = (override ?? env[CHECKPOINTER_ENV] ?? "sqlite").trim().toLowerCase();
  if (raw !== "sqlite" && raw !== "postgres") {
    // Refuse rather than fall back, for the same reason `JAROKU_DB_DRIVER` does: falling back
    // means a server that runs, works, and writes checkpoints nobody will look for.
    throw new Error(`${CHECKPOINTER_ENV} must be "sqlite" or "postgres", not "${raw}"`);
  }
  return raw;
}

/** The thread a run writes its checkpoints to. Mirrors `thread_id_for` in debug.py. */
export function checkpointThreadId(
  workspaceId: string,
  runId: string,
  kind: CheckpointerKind = checkpointerKindFromEnv(),
): string {
  if (kind === "sqlite" || !workspaceId) return runId;
  return `ws:${workspaceId}:run:${runId}`;
}

/**
 * Every thread belonging to one workspace, as a prefix.
 *
 * What makes the sweep a `LIKE 'ws:<id>:%'` delete rather than a join against a table in a
 * schema Jaroku does not own. The trailing colon matters: without it, one workspace's prefix
 * would match another whose uuid merely started the same way — which uuids do not do by
 * accident, and which a sweep must not depend on.
 */
export function workspaceThreadPrefix(workspaceId: string): string {
  return `ws:${workspaceId}:run:`;
}

/** The run a thread belongs to, whichever spelling it is in. */
export function runIdFromThread(threadId: string): string {
  const m = /^ws:[^:]*:run:(.+)$/.exec(threadId);
  return m ? m[1]! : threadId;
}
