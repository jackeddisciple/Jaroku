// Graph introspection (Week 5, Graph View): spawn the isolated Python entrypoint
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
// What has NOT changed, and is Session 4's job rather than this one's: the Python still runs on
// the control plane. Building a compiled graph imports the agent's module, which is model-written
// code, and no amount of routing the FILES through an object store makes executing them here
// safe. The spec is explicit that both this and the validator's import check move into the
// sandbox in Session 4; what this commit does is make the file access replica-independent so
// that when they move, the call sites do not change.

import { spawn } from "node:child_process";

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

/** Run `python -m jaroku_runner.graph <agentId>` and parse its one-shot JSON. Never rejects —
 *  any failure comes back as `{ agent_id, error }` so the client always gets a definite answer. */
export function introspectGraph(
  runtimeDir: string,
  agentId: string,
  /**
   * The project to build from, when it is not `runtime/agents/<agentId>/`.
   *
   * What the object store materialised. Absent, the runner resolves the agent the way it always
   * has — which is what a copied-out project and a hand-dropped one both need.
   */
  projectDir?: string,
): Promise<GraphResult> {
  return new Promise((resolve) => {
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      PATH: `/opt/homebrew/bin:${process.env.PATH ?? ""}`,
    };
    if (projectDir) env.JAROKU_AGENT_DIR = projectDir;
    const child = spawn("uv", ["run", "python", "-m", "jaroku_runner.graph", agentId], {
      cwd: runtimeDir,
      env,
    });

    let stdout = "";
    let stderr = "";
    let settled = false;
    const done = (r: GraphResult) => {
      if (settled) return;
      settled = true;
      resolve(r);
    };

    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      done({ agent_id: agentId, error: "graph introspection timed out" });
    }, TIMEOUT_MS);

    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (c: string) => (stdout += c));
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (c: string) => (stderr += c));

    child.on("error", (err) => {
      clearTimeout(timer);
      done({ agent_id: agentId, error: `spawn failed: ${err.message}` });
    });

    child.on("exit", () => {
      clearTimeout(timer);
      // The entrypoint prints exactly one JSON line; take the last non-empty stdout line so a
      // stray print (should be redirected to stderr, but be defensive) can't break parsing.
      const line = stdout.trim().split("\n").filter(Boolean).pop() ?? "";
      try {
        const parsed = JSON.parse(line) as GraphResult;
        if (parsed && typeof parsed === "object") return done(parsed);
      } catch {
        /* fall through to error below */
      }
      const detail = stderr.trim().split("\n").slice(-3).join(" | ").slice(0, 300);
      done({ agent_id: agentId, error: `could not read graph${detail ? `: ${detail}` : ""}` });
    });
  });
}
