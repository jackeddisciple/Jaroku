// Graph introspection (Week 5, Graph View): run the isolated Python entrypoint
// `jaroku_runner.graph`, which builds the agent's compiled LangGraph with the free dry-run
// model and prints its topology as a SINGLE JSON object on stdout. This is deliberately NOT
// the trace pipeline: it never runs the graph, never touches the frozen trace schema/stream,
// and rides its own "graph" channel — same separation as gen/edit/agentFiles.
//
// SESSION 3: WHICH FILES IT BUILDS FROM. It used to import `agents.<slug>` out of
// `runtime/agents/`, which is a directory a replica that has never run this agent does not
// have. It is now given a project DIRECTORY — materialised out of the object store by the
// caller — and `JAROKU_AGENT_DIR` tells the runner to import from there instead.
//
// SESSION 4: WHERE IT RUNS. Building a compiled graph imports the agent's module — model-written
// code — so this now goes through CodeCheckSandbox exactly as validator.ts's import check does,
// rather than a direct child_process.spawn. See codeCheck.ts for why introspection and the
// import check share one interface instead of RunSandbox's: neither is "run an agent".
//
// CACHING (see db/repositories/agents.ts:getGraphCache/setGraphCache): a version's topology is
// derived purely from agent.py, which cannot change without the version itself changing — so
// this module also exposes a caching wrapper the caller uses to introspect a given version at
// most once, ever, rather than once per graph view.

import { LocalCodeCheckSandbox, type CodeCheckSandbox } from "./sandbox/codeCheck.ts";

export interface GraphNode {
  id: string;
  type: string; // "start" | "end" | "tool" | "agent"
}
export interface GraphEdge {
  source: string;
  target: string;
  conditional: boolean;
  label: string | null;
}
export interface GraphResult {
  agent_id: string;
  nodes?: GraphNode[];
  edges?: GraphEdge[];
  error?: string;
}

const TIMEOUT_MS = 20_000;

const defaultCodeCheckSandbox: CodeCheckSandbox = new LocalCodeCheckSandbox();

/** Run `python -m jaroku_runner.graph <agentId>` and parse its one-shot JSON. Never rejects —
 *  any failure comes back as `{ agent_id, error }` so the client always gets a definite answer. */
export async function introspectGraph(
  runtimeDir: string,
  agentId: string,
  /**
   * The project to build from, when it is not `runtime/agents/<agentId>/`.
   *
   * What the object store materialised. Absent, the runner resolves the agent the way it always
   * has — which is what a copied-out project and a hand-dropped one both need.
   */
  projectDir?: string,
  sandbox: CodeCheckSandbox = defaultCodeCheckSandbox,
): Promise<GraphResult> {
  const env: NodeJS.ProcessEnv = {};
  if (projectDir) env.JAROKU_AGENT_DIR = projectDir;

  const { stdout, stderr, spawnError, timedOut } = await sandbox.run({
    runtimeDir,
    args: ["-m", "jaroku_runner.graph", agentId],
    timeoutMs: TIMEOUT_MS,
    env,
  });

  if (spawnError) return { agent_id: agentId, error: `spawn failed: ${spawnError}` };
  if (timedOut) return { agent_id: agentId, error: "graph introspection timed out" };

  // The entrypoint prints exactly one JSON line; take the last non-empty stdout line so a
  // stray print (should be redirected to stderr, but be defensive) can't break parsing.
  const line = stdout.trim().split("\n").filter(Boolean).pop() ?? "";
  try {
    const parsed = JSON.parse(line) as GraphResult;
    if (parsed && typeof parsed === "object") return parsed;
  } catch {
    /* fall through to error below */
  }
  const detail = stderr.trim().split("\n").slice(-3).join(" | ").slice(0, 300);
  return { agent_id: agentId, error: `could not read graph${detail ? `: ${detail}` : ""}` };
}

/** What introspectGraphCached needs from the store — narrowed to exactly two methods so a
 *  caller (or a test) does not have to construct a whole AgentRepository to use this. */
export interface GraphCacheStore {
  getGraphCache(agentId: string, version: number): Promise<unknown | undefined>;
  setGraphCache(agentId: string, version: number, graph: unknown): Promise<void>;
}

/**
 * introspectGraph, but at most once per (agentId, version) ever — a version's topology cannot
 * change without the version changing, so a cached result is never stale.
 *
 * A cached ERROR is not cached. Only a genuine result (nodes/edges present, no error) is worth
 * remembering — a transient sandbox failure ("spawn failed", a timeout under load) caching
 * itself would turn one bad moment into a permanently broken graph view for that version.
 */
export async function introspectGraphCached(
  runtimeDir: string,
  agentId: string,
  version: number,
  store: GraphCacheStore,
  projectDir?: string,
  sandbox: CodeCheckSandbox = defaultCodeCheckSandbox,
): Promise<GraphResult> {
  const cached = await store.getGraphCache(agentId, version);
  if (cached && typeof cached === "object") return cached as GraphResult;

  const result = await introspectGraph(runtimeDir, agentId, projectDir, sandbox);
  if (!result.error) {
    // Best-effort: a failed cache write must not turn a successful introspection into a
    // reported failure. The next view simply pays the cost again.
    await store.setGraphCache(agentId, version, result).catch(() => {});
  }
  return result;
}
