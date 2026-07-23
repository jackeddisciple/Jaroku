// Wires the pipeline: ProcessManager (Python agent) -> TraceStore (SQLite) -> WsRelay (browser).
//
//   uv-spawned agent  --stdout JSON-->  ProcessManager  --event-->  { persist + broadcast }
//
// Run:  npm run dev        (in server/)
// Then open http://localhost:4317 to watch traces live.

import { existsSync, readFileSync, rmSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";
import { ProcessManager } from "./processManager.ts";
import { TraceStore } from "./store.ts";
import { WsRelay, type ForwardedCommand, type GenerateCommand } from "./wsRelay.ts";
import { Generator } from "./generator.ts";
import { Editor, editCount } from "./editor.ts";
import { listAgents } from "./agents.ts";
import { loadConnectors } from "./connectors.ts";
import { isSafeAgentId, listProjectFiles } from "./projectFs.ts";
import { introspectGraph, type GraphResult } from "./graphIntrospect.ts";
import { loadRuntimeEnv } from "./env.ts";

const __dirname = dirname(fileURLToPath(import.meta.url));
const SERVER_DIR = resolve(__dirname, "..");
const REPO_DIR = resolve(SERVER_DIR, "..");
const RUNTIME_DIR = join(REPO_DIR, "runtime");
const DB_PATH = process.env.JAROKU_DB ?? join(SERVER_DIR, "jaroku.db");
const PORT = Number(process.env.JAROKU_PORT ?? 4317);

// Provider + generation keys live in runtime/.env. Names only are logged, never values.
const loadedKeys = loadRuntimeEnv(join(RUNTIME_DIR, ".env"));
if (loadedKeys.length) {
  console.log(`[server] loaded ${loadedKeys.length} var(s) from runtime/.env: ${loadedKeys.sort().join(", ")}`);
}

// Stale staging (a proposal or generation interrupted by a previous shutdown) must not
// survive a restart — pending proposals are in-memory, so their staging dirs are orphans.
rmSync(join(RUNTIME_DIR, "agents", ".staging"), { recursive: true, force: true });

const store = new TraceStore(DB_PATH);
const manager = new ProcessManager();
const generator = new Generator();

// True from spawn until run_end (or exit). Deliberately NOT manager.running: the process
// outlives its run_end by a beat while it tears down, and refusing an apply/undo in that
// window is a race the user would hit by clicking right after a run finishes. Once
// run_end is emitted the graph is done and the project files are no longer being read.
let runActive = false;

const editor = new Editor({
  runtimeDir: RUNTIME_DIR,
  canMutate: () => (runActive ? "cannot modify the agent while a run is in progress" : null),
});

/** Current on-disk files of an agent project, connector files flagged read-only. */
function agentProjectFiles(agentId: string): unknown[] {
  if (!isSafeAgentId(agentId)) return [];
  const dir = join(RUNTIME_DIR, "agents", agentId);
  if (!existsSync(dir)) return [];
  let connectors: string[] = [];
  try {
    const meta = JSON.parse(readFileSync(join(dir, "jaroku.json"), "utf8")) as { connectors?: string[] };
    connectors = meta.connectors ?? [];
  } catch {
    /* metadata optional */
  }
  const files = loadConnectors(RUNTIME_DIR)
    .filter((c) => connectors.includes(c.id))
    .map((c) => `tools/${c.file}`);
  return listProjectFiles(dir, files);
}

// Graph topology is derived by spawning the isolated `jaroku_runner.graph` entrypoint. It is
// pure w.r.t. an agent's on-disk code, so it's cached per agent and invalidated on apply/undo.
const graphCache = new Map<string, Promise<GraphResult>>();
function agentGraph(agentId: string): Promise<GraphResult> {
  if (!isSafeAgentId(agentId)) return Promise.resolve({ agent_id: agentId, error: "invalid agent id" });
  let pending = graphCache.get(agentId);
  if (!pending) {
    pending = introspectGraph(RUNTIME_DIR, agentId);
    // Don't cache a failure — let a later request retry (e.g. after a transient import error).
    pending.then((r) => { if (r.error) graphCache.delete(agentId); });
    graphCache.set(agentId, pending);
  }
  return pending;
}

const relay = new WsRelay({
  port: PORT,
  store,
  clientHtmlPath: join(SERVER_DIR, "debug-client.html"),
  listAgents: () =>
    listAgents(RUNTIME_DIR).map((a) => ({
      ...a,
      edit_count: editCount(RUNTIME_DIR, a.agent_id),
    })),
  listAgentFiles: agentProjectFiles,
  getAgentGraph: agentGraph,
  onCommand: (cmd: ForwardedCommand) => {
    if (cmd.cmd === "run") runAgent(cmd.input, cmd.provider, cmd.model, cmd.agentId);
    else if (cmd.cmd === "generate") generateAgent(cmd);
    else if (cmd.cmd === "edit") editAgent(cmd.agentId, cmd.instruction);
    else if (cmd.cmd === "applyEdit") editor.apply(cmd.proposalId);
    else if (cmd.cmd === "undoEdit") editor.undo(cmd.agentId);
    else if (cmd.cmd === "discardEdit") editor.discard(cmd.proposalId);
  },
});

// --- pipeline ---------------------------------------------------------------
manager.on("event", (event) => {
  if (event.kind === "run_end") runActive = false;
  // Persist first (source of truth), then broadcast to live clients.
  try {
    if (event.kind === "run_start" || event.kind === "run_end") {
      store.upsertRun(event.run);
    } else if (event.kind === "step") {
      store.insertStep(event.step);
    }
  } catch (err) {
    console.error("[store] failed to persist event:", (err as Error).message);
  }
  relay.broadcast(event);
});

manager.on("parseError", ({ line, error }) => {
  console.error(`[manager] non-event stdout line (${error}):`, line.slice(0, 200));
  relay.broadcastLog("parseError", `${error}: ${line.slice(0, 200)}`);
});

manager.on("stderr", (line) => {
  console.error("[agent]", line);
  relay.broadcastLog("stderr", line);
});

manager.on("spawnError", (err) => {
  runActive = false;
  console.error("[manager] spawn error:", err.message);
});

manager.on("exit", ({ code, signal }) => {
  runActive = false; // covers a crash before run_end ever arrived
  console.log(`[manager] agent exited (code=${code} signal=${signal})`);
});

// --- generation -------------------------------------------------------------
// Streams into the "gen" channel. Nothing here touches the trace store or the frozen
// event schema; a generation and a run are independent concerns that share only a socket.
let generating = false;

function generateAgent(cmd: GenerateCommand): void {
  if (generating) {
    relay.broadcastGen({ type: "error", message: "a generation is already in progress" });
    return;
  }
  generating = true;
  console.log(`[gen] generating — "${cmd.prompt.slice(0, 80)}"`);
  relay.broadcastGen({ type: "started", prompt: cmd.prompt });

  const onStart = (e: { path: string }) => relay.broadcastGen({ type: "file_start", ...e });
  const onDelta = (e: { path: string; text: string }) => relay.broadcastGen({ type: "file_delta", ...e });
  const onEnd = (e: { path: string }) => relay.broadcastGen({ type: "file_end", ...e });

  const cleanup = () => {
    generating = false;
    generator.off("file_start", onStart);
    generator.off("file_delta", onDelta);
    generator.off("file_end", onEnd);
    generator.off("done", onDone);
    generator.off("error", onError);
  };

  const onDone = (e: { agentId: string; name: string; files: string[]; usage: unknown }) => {
    const usage = e.usage as { cost_usd?: number; output_tokens?: number };
    console.log(
      `[gen] ${e.agentId} ready — ${e.files.length} file(s), ` +
        `${usage?.output_tokens ?? 0} output tokens, $${(usage?.cost_usd ?? 0).toFixed(5)}`,
    );
    relay.broadcastGen({ type: "done", ...e });
    relay.broadcastAgents();
    cleanup();
  };

  const onError = (e: { message: string; problems?: string[] }) => {
    console.error(`[gen] failed: ${e.message}`);
    for (const p of e.problems ?? []) console.error(`  - ${p}`);
    relay.broadcastGen({ type: "error", ...e });
    cleanup();
  };

  generator.on("file_start", onStart);
  generator.on("file_delta", onDelta);
  generator.on("file_end", onEnd);
  generator.once("done", onDone);
  generator.once("error", onError);

  void generator.generate({
    runtimeDir: RUNTIME_DIR,
    prompt: cmd.prompt,
    connectors: cmd.connectors,
    name: cmd.name,
  });
}

// --- editing (fix loop) -----------------------------------------------------
// Streams into the "edit" channel. Like generation, nothing here touches the trace store
// or the frozen event schema. Listeners are permanent — every event carries its ids.
editor.on("file_start", (e) => relay.broadcastEdit({ type: "file_start", ...e }));
editor.on("file_delta", (e) => relay.broadcastEdit({ type: "file_delta", ...e }));
editor.on("file_end", (e) => relay.broadcastEdit({ type: "file_end", ...e }));

editor.on("proposal", (e) => {
  console.log(
    `[edit] proposal for ${e.agentId} — ${e.files.length} file(s): ${e.summary}`,
  );
  relay.broadcastEdit({ type: "proposal", ...e });
});

editor.on("applied", (e) => {
  console.log(`[edit] applied v${e.version} to ${e.agentId}: ${e.summary}`);
  relay.broadcastEdit({ type: "applied", ...e });
  relay.broadcastAgents();
  relay.broadcastAgentFiles(e.agentId);
  // An edit may have changed the graph structure — invalidate and re-push.
  graphCache.delete(e.agentId);
  void relay.broadcastAgentGraph(e.agentId);
});

editor.on("undone", (e) => {
  console.log(`[edit] undid v${e.version} on ${e.agentId}`);
  relay.broadcastEdit({ type: "undone", ...e });
  relay.broadcastAgents();
  relay.broadcastAgentFiles(e.agentId);
  graphCache.delete(e.agentId);
  void relay.broadcastAgentGraph(e.agentId);
});

editor.on("discarded", (e) => relay.broadcastEdit({ type: "discarded", ...e }));

editor.on("error", (e) => {
  console.error(`[edit] failed: ${e.message}`);
  for (const p of e.problems ?? []) console.error(`  - ${p}`);
  relay.broadcastEdit({ type: "error", ...e });
});

function editAgent(agentId: string, instruction: string): void {
  console.log(`[edit] ${agentId} — "${instruction.slice(0, 80)}"`);
  relay.broadcastEdit({ type: "started", agentId, instruction });
  void editor.propose(agentId, instruction);
}

// --- run trigger ------------------------------------------------------------
function runAgent(input?: string, provider?: string, model?: string, agentId?: string): void {
  if (manager.running) {
    console.log("[manager] agent already running; ignoring run request");
    return;
  }
  console.log(`[manager] starting ${agentId ?? "test_agent"}${input ? ` — "${input}"` : ""}`);
  // Model is forwarded explicitly so a real-provider run can't silently fall back to
  // the agent's expensive default; unset means the agent picks its own default.
  const env: NodeJS.ProcessEnv = {};
  if (provider) env.JAROKU_PROVIDER = provider;
  if (model) env.JAROKU_MODEL = model;
  runActive = true;
  manager.start({
    runtimeDir: RUNTIME_DIR,
    input,
    agentId,
    env: Object.keys(env).length ? env : undefined,
  });
}

// Kick off one run on startup unless suppressed (set JAROKU_NO_AUTORUN=1 to just serve).
if (process.env.JAROKU_NO_AUTORUN !== "1") {
  // Small delay so the relay is listening before the first events land.
  setTimeout(() => runAgent(), 300);
}

// --- graceful shutdown ------------------------------------------------------
function shutdown(): void {
  console.log("\n[server] shutting down…");
  manager.stop();
  store.close();
  process.exit(0);
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
