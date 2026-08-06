// Wires the pipeline: RunPool (Python agents) -> TraceStore (SQLite) -> WsRelay (browser).
//
//   uv-spawned agent  --stdout JSON-->  RunPool slot  --event-->  { persist + broadcast }
//
// The pool reserves slot 0 for the interactive run — the one the user drives, and the only
// one pause/resume/branch address — and lends the rest to the eval fan-out.
//
// Run:  npm run dev        (in server/)
// Then open http://localhost:4317 to watch traces live.

import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";
import { RunPool } from "./runPool.ts";
import { TraceStore } from "./store.ts";
import { migrate } from "./db/migrate.ts";
import { openDb } from "./db/open.ts";
import {
  LOCAL_WORKSPACE_ID, newRequestId, systemContext, systemContextFor,
  type TenantContext,
} from "./db/tenant.ts";
import { EvalStore, type Rubric, type RubricCriterion } from "./evalStore.ts";
import { EvalRunner } from "./evalRunner.ts";
import { DEFAULT_CRITERIA } from "./judge/rubric.ts";
import { JudgeScorer } from "./judge/score.ts";
import { aggregateEval } from "./evalAggregate.ts";
import { estimateEval } from "./evalEstimate.ts";
import { fmtBytes, sweepEvalArtifacts, sweepOrphanedEvalArtifacts } from "./evalCleanup.ts";
import {
  WsRelay,
  type ForwardedCommand,
  type GenerateCommand,
  type McpCommand,
  type PlanAgentCommand,
  type ProviderCommand,
} from "./wsRelay.ts";
import { Generator, type UsageSummary } from "./generator.ts";
import { Planner } from "./planner.ts";
import { Editor, editCount } from "./editor.ts";
import { listAgents } from "./agents.ts";
import { loadConnectors } from "./connectors.ts";
import { isSafeAgentId, listProjectFiles } from "./projectFs.ts";
import { introspectGraph, type GraphResult } from "./graphIntrospect.ts";
import { streamExplain } from "./explainer.ts";
import type { DeployChannelCommand, ExplainCommand } from "./wsRelay.ts";
import { loadRuntimeEnv } from "./env.ts";
import { McpStore } from "./mcpStore.ts";
import { McpRegistry } from "./mcpRegistry.ts";
import { fileCredentialWriter } from "./envWriter.ts";
import { PROVIDER_ENV_KEY, isProviderId, providerStatus, verifyProviderKey } from "./providers.ts";
import { DeployStore } from "./deployStore.ts";
import { DeployManager, planDeploy, type DeployManagerDeps } from "./deployManager.ts";
import { RailwayApi, RailwayError, RAILWAY_ENV_KEY } from "./railwayApi.ts";

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

// One database, four stores. The driver is chosen here and nowhere else — everything below
// this line talks to the `Db` interface and cannot tell which it got. SQLite by default, so
// `npm run dev` still needs nothing installed and nothing running.
const db = openDb({ sqlitePath: DB_PATH });
console.log(`[server] database: ${db.dialect}${db.dialect === "sqlite" ? ` (${DB_PATH})` : ""}`);

// THE WORKSPACE THIS PROCESS ACTS IN.
//
// Every store method takes a TenantContext, and until there is authentication there is one
// context: the local workspace migration 004 created and backfilled every pre-tenancy row
// into. A single-user install is a workspace with one member who has not signed in yet.
//
// Deliberately a function rather than a constant, and deliberately minted per call rather
// than shared. The requestId is what correlates a log line, an audit row and a trace, so a
// process-wide singleton would make every one of them read as the same request. Session 2
// replaces the body; nothing above it changes.
const serverContext = (): TenantContext => systemContextFor(LOCAL_WORKSPACE_ID, newRequestId());

// MIGRATIONS FIRST, before a single store is built.
//
// They own the schema on both drivers now, so nothing above may touch a table before they
// have run. Boot-time apply is deliberate: a server whose code expects a column the database
// does not have should fail at startup, where somebody is watching, rather than at the first
// request that happens to touch it.
await migrate(db.migrationTarget(), join(SERVER_DIR, "migrations", db.dialect));

const store = new TraceStore(db);
await store.init();
// Eval's control-plane tables live in the same database file, on the same connection
// (single writer; aggregation JOINs eval_jobs against the frozen `steps` table). Nothing
// here touches schema/events.md — an eval is a batch of ordinary runs.
const evalStore = new EvalStore(store.database());
await evalStore.init();
// The MCP registry shares the same file and connection for the same reason: additive
// control-plane tables beside the frozen schema, one writer. An MCP tool call is still an
// ordinary tool_call Step and still goes through the trace store like everything else.
//
// The credential writer is the only thing in the process that writes runtime/.env. It logs
// key names, never values, exactly as loadRuntimeEnv does when reading them back.
//
// One instance, shared. MCP server tokens and model-provider API keys are the same kind of
// secret going to the same file, and the rule is that there is exactly one path to it — so
// they get the same writer object rather than two constructed from the same path.
const credentials = fileCredentialWriter(join(RUNTIME_DIR, ".env"));
const mcpStore = new McpStore(store.database());
const mcpRegistry = new McpRegistry(mcpStore, credentials);
// Slot 0 is the interactive run; the rest are the eval fan-out's. Modest by default —
// each slot is a Python subprocess with a LangGraph import, and oversubscribing the machine
// inflates every run's latency, which the comparison dashboard then reports as if it were
// the provider's.
const EVAL_CONCURRENCY = Math.max(1, Number(process.env.JAROKU_EVAL_CONCURRENCY ?? 4));
const pool = new RunPool(EVAL_CONCURRENCY);
const generator = new Generator();
const planner = new Planner();

// Run ids belonging to an in-flight eval job. Their events persist normally but are kept
// OFF the "trace" channel, so a fan-out can't steal the timeline's focus (traceStore
// focuses activeRunId on every run_start). Populated by the orchestrator.
const evalRunIds = new Set<string>();
const isEvalRun = (runId: string): boolean => evalRunIds.has(runId);

// The orchestrator. Constructed after the relay exists (it broadcasts progress), so it's
// declared here and assigned below.
let evalRunner: EvalRunner;

/**
 * The rubric a dataset scores against: its own if customized, else the workspace's default.
 *
 * There used to be a `DEFAULT_RUBRIC_ID` constant naming one row shared by everybody. One
 * row shared by everybody is a cross-tenant object — two workspaces editing "the default
 * rubric" would be editing each other's — so the default is now per workspace, identified by
 * having no dataset rather than by a well-known id, and created on first use.
 */
async function rubricFor(ctx: TenantContext, datasetId: string): Promise<Rubric> {
  return (
    (await evalStore.rubricForDataset(ctx, datasetId)) ??
    (await evalStore.defaultRubricFor(ctx, DEFAULT_CRITERIA))
  );
}
const rubricIdFor = async (ctx: TenantContext, datasetId: string): Promise<string> =>
  (await rubricFor(ctx, datasetId)).id;

// An eval left 'running' by a shutdown has no orchestrator behind it any more. Mark those
// interrupted at startup rather than leaving rows that claim to be in flight forever —
// the jobs and whatever they spent stay on record and remain inspectable.
// Every workspace's, not just this process's — a restart has to reconcile them all, and an
// interrupted eval left claiming to be running forever is the bug the isolation would cause.
for (const stale of await evalStore.unfinishedEvalRuns(systemContext(newRequestId()))) {
  const ctx = systemContextFor(stale.workspace_id, newRequestId());
  const cancelled = await evalStore.cancelQueuedJobs(ctx, stale.id, "server restarted before this job ran");
  await evalStore.setEvalStatus(ctx, stale.id, "cancelled", "interrupted by a server restart");
  console.log(`[eval] ${stale.id} was interrupted by a restart — ${cancelled} queued job(s) cancelled`);
}

// Catch checkpoint blobs from evals whose per-eval sweep never ran (a crash, a restart).
// Only runs belonging to FINISHED eval jobs are touched — an interactive run's checkpoint
// is exactly the thing a user might come back to branch from, and is never swept.
{
  const swept = await sweepOrphanedEvalArtifacts(
    systemContext(newRequestId()),
    evalStore,
    join(RUNTIME_DIR, ".checkpoints"),
  );
  if (swept.removed) {
    console.log(
      `[eval] swept ${swept.removed} orphaned checkpoint artifact(s) from earlier evals, ${fmtBytes(swept.bytesFreed)} freed`,
    );
  }
}

// True from spawn until run_end (or exit) of the INTERACTIVE run. Deliberately NOT
// pool.interactiveRunning: the process outlives its run_end by a beat while it tears down,
// and refusing an apply/undo in that window is a race the user would hit by clicking right
// after a run finishes. Once run_end is emitted the graph is done and the project files are
// no longer being read.
let runActive = false;

// Debug depth (Week 6). The server mints each run's id up front so it can address a live run
// (e.g. to pause it) before run_start races back. `activeRunId` is the current subprocess's run;
// `pausedRunId` remembers a run that halted at a boundary so exit-handling leaves it 'paused'
// rather than clobbering the status. Both are control-plane only.
let activeRunId: string | null = null;
let pausedRunId: string | null = null;

const CHECKPOINT_DIR = join(RUNTIME_DIR, ".checkpoints");
const controlFile = (runId: string): string => join(CHECKPOINT_DIR, `${runId}.control`);
/** Ask the runner to pause: it reads this file at its next node boundary. */
function requestPause(runId: string): void {
  mkdirSync(CHECKPOINT_DIR, { recursive: true });
  writeFileSync(controlFile(runId), "pause");
}
/** Clear any stale pause request (before a fresh run of, or a resume of, this run id). */
function clearControl(runId: string): void {
  rmSync(controlFile(runId), { force: true });
}

const editor = new Editor({
  runtimeDir: RUNTIME_DIR,
  // Pool-aware, not just interactive-aware: an eval job is reading the agent's files from
  // a subprocess right now, and rewriting them mid-flight would make the trace describe
  // code that never ran. `pool.busy` covers every slot.
  canMutate: () =>
    runActive || pool.busy ? "cannot modify the agent while a run is in progress" : null,
});

// --- deploy -----------------------------------------------------------------
// Control-plane, beside the frozen schema, exactly like the eval and MCP stores. A deploy is
// not an agent run: nothing here goes near `runs`, `steps`, or the trace channel.
//
// The manager gets its dependencies rather than importing them, so it has no idea a WebSocket
// exists — the EvalRunnerDeps shape. Note `token`: a function, not a value, so the credential
// is read from process.env at the moment of use and is never held by the manager.
const deployStore = new DeployStore(store.database());
await deployStore.init();

// The same reasoning for deploys, with a sharper edge: a deploy in flight was creating real
// resources in the user's Railway account. A row still reading "building" after a restart is
// not building — nothing is watching it — and the honest thing is to say so and point at the
// dashboard, because whatever was already created is still there.
for (const stale of await deployStore.reconcileInterrupted()) {
  console.log(`[deploy] ${stale.id} (${stale.agent_id}) was interrupted by a restart`);
}


const deployDeps: DeployManagerDeps = {
  runtimeDir: RUNTIME_DIR,
  store: deployStore,
  token: () => process.env[RAILWAY_ENV_KEY],
  // The same pool-aware check the editor uses, and for a sharper version of the reason:
  // deploying WRITES into the project, so doing it while a subprocess is importing those
  // files would change code out from under a run in flight.
  agentBusy: () => runActive || pool.busy,
  onStage: (e) => relay.broadcastDeploy({ type: "stage", ...e }),
  onLog: (e) => relay.broadcastDeploy({ type: "log", ...e }),
  onServeToken: (e) => relay.broadcastDeploy({ type: "serveToken", ...e }),
  onFinished: (d) =>
    relay.broadcastDeploy({
      type: "finished",
      deploymentId: d.id,
      status: d.status,
      url: d.url,
      error: d.error,
    }),
  onChanged: () => {
    broadcastDeployments();
    // An agent's row in the sidebar carries its deployment, so the agent list is stale too.
    void relay.broadcastAgents();
  },
};

const deployManager = new DeployManager(deployDeps);

/** The full snapshot: every deployment, plus whether a Railway token is set. Names only. */
async function deploySnapshot(): Promise<{ deployments: unknown[]; railwayConfigured: boolean }> {
  return {
    deployments: await deployStore.list(),
    railwayConfigured: Boolean(process.env[RAILWAY_ENV_KEY]),
  };
}

function broadcastDeployments(): void {
  void deploySnapshot()
    .then((snapshot) => relay.broadcastDeploy({ type: "deployments", ...snapshot }))
    .catch((err) => console.error("[deploy] snapshot failed:", (err as Error).message));
}

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
  context: serverContext,
  clientHtmlPath: join(SERVER_DIR, "debug-client.html"),
  listAgents: async () => {
    // One query for the whole list, so the sidebar can show a deploy state per row without
    // N round trips. `deployment` is null for an agent that has never been deployed.
    const deployed = await deployStore.currentByAgent();
    return listAgents(RUNTIME_DIR).map((a) => {
      const d = deployed.get(a.agent_id);
      return {
        ...a,
        edit_count: editCount(RUNTIME_DIR, a.agent_id),
        deployment: d ? { id: d.id, status: d.status, url: d.url } : null,
      };
    });
  },
  listAgentFiles: agentProjectFiles,
  getAgentGraph: agentGraph,
  listMcpServers: () => mcpRegistry.list(),
  // By name only. The client learns THAT a key is set, never what it is.
  listProviders: () => providerStatus(),
  // Same: env_keys are names, railwayConfigured is a boolean. No value crosses this.
  listDeployments: () => deploySnapshot(),
  onCommand: (cmd: ForwardedCommand) => {
    if (cmd.cmd === "run") runAgent(cmd.input, cmd.provider, cmd.model, cmd.agentId);
    else if (cmd.cmd === "generate") generateAgent(cmd);
    else if (cmd.cmd === "planAgent") planAgent(cmd);
    else if (cmd.cmd === "discardPlan") planner.discard(cmd.planId);
    else if (cmd.cmd === "edit") editAgent(cmd.agentId, cmd.instruction);
    else if (cmd.cmd === "applyEdit") editor.apply(cmd.proposalId);
    else if (cmd.cmd === "undoEdit") editor.undo(cmd.agentId);
    else if (cmd.cmd === "discardEdit") editor.discard(cmd.proposalId);
    else if (cmd.cmd === "pauseRun") pauseRun(cmd.runId);
    else if (cmd.cmd === "resumeRun") resumeRun(cmd.runId);
    else if (cmd.cmd === "branchRun") branchRun(cmd.fromRunId, cmd.atSeq, cmd.editNode, cmd.editedState);
    else if (cmd.cmd === "explain") explainAgent(cmd);
    else if (MCP_COMMAND_NAMES.has(cmd.cmd)) void handleMcpCommand(cmd as McpCommand);
    else if (DEPLOY_COMMAND_NAMES.has(cmd.cmd)) void handleDeployCommand(cmd as DeployChannelCommand);
    else if (PROVIDER_COMMAND_NAMES.has(cmd.cmd)) void handleProviderCommand(cmd as ProviderCommand);
    else handleEvalCommand(cmd);
  },
});

// The orchestrator: expands (examples × providers) into persisted jobs and drains them
// through the pool under per-provider caps. Every job runs the ordinary path — there is no
// second way to execute an agent.
// The judge. Scoring is a SEPARATE phase from execution: a job is scored once its run is
// already terminal and recorded, so a broken judge costs the quality column and nothing
// else. Its cost accrues to the eval, never to a provider.
const judge = new JudgeScorer({
  store,
  evalStore,
  context: serverContext,
  onScored: (e) => relay.broadcastEval({ type: "scored", ...e }),
  onScoringFinished: (e) => {
    console.log(`[eval] ${e.evalId} scoring done — ${e.scored} scored, ${e.unscored} unscored`);
    relay.broadcastEval({ type: "scoringFinished", ...e });
  },
});

evalRunner = new EvalRunner({
  pool,
  store,
  evalStore,
  context: serverContext,
  runtimeDir: RUNTIME_DIR,
  // An eval job's run persists like any other but stays off the live "trace" channel.
  markEvalRun: (runId, isEval) => {
    if (isEval) evalRunIds.add(runId);
    else evalRunIds.delete(runId);
  },
  onStarted: (e) => relay.broadcastEval({ type: "evalStarted", ...e }),
  onProgress: (p) => relay.broadcastEval({ type: "evalProgress", ...p }),
  // Score as results land rather than in a batch at the end, so the quality column fills in
  // alongside the rest of the row instead of appearing all at once minutes later.
  onJobFinished: (job) => judge.enqueue(job.eval_id, job),
  onFinished: (e) => {
    relay.broadcastEval({ type: "evalFinished", ...e });
    // The eval's runs are now in history like any other; refresh so drill-down can reach
    // them without a reconnect.
    void relay.broadcastHistory();
    // No more jobs are coming: the judge reports done once its own queue drains.
    judge.seal(e.evalId);
    // Sweep the resumable-checkpoint blobs these runs left behind. The traces stay —
    // only the pause/resume machinery goes, and nobody resumes a finished eval job.
    void sweepEvalArtifacts(serverContext(), evalStore, CHECKPOINT_DIR, e.evalId).then((swept) => {
      if (swept.removed) {
        console.log(
          `[eval] ${e.evalId} swept ${swept.removed} checkpoint artifact(s), ${fmtBytes(swept.bytesFreed)} freed` +
            (swept.failed ? ` (${swept.failed} could not be removed)` : ""),
        );
      }
    });
  },
});

// --- MCP: server registry ---------------------------------------------------
// Control-plane only, on its own channel. Every mutation answers by re-broadcasting the
// whole server list — the same shape a fresh `listMcpServers` returns — so a client never
// merges a delta into a view of what an unreviewed third party said.
//
// Nothing broadcast here carries a credential: a server reports `configured: true/false`,
// which is the name of a key being set, and never the value behind it.

const MCP_COMMAND_NAMES = new Set([
  "addMcpServer", "removeMcpServer", "rediscoverMcpServer", "setMcpToolImpact",
  "setMcpServerAuth", "resolveMcpConfirm",
]);

// Confirmations a run is currently blocked on, keyed `<runId>.<nonce>`.
//
// Control-plane only, and in memory only: a pending ask belongs to a live subprocess, and a
// server restart means that process is gone and its question is moot. Persisting it would
// resurrect a prompt for a run that no longer exists.
interface PendingConfirm {
  runId: string;
  nonce: string;
  server: string;
  tool: string;
  requestedAt: number;
}
const pendingConfirms = new Map<string, PendingConfirm>();
const confirmKey = (runId: string, nonce: string): string => `${runId}.${nonce}`;
const approvalFile = (runId: string, nonce: string): string =>
  join(CHECKPOINT_DIR, `${runId}.${nonce}.approval`);

/**
 * Answer the runner by writing the file it is polling for — the same file-based direction
 * pause already uses (requestPause). Nothing is written to the subprocess's stdin, which
 * stays clear for the same reason stdout does.
 */
function writeApproval(runId: string, nonce: string, verdict: string): void {
  mkdirSync(CHECKPOINT_DIR, { recursive: true });
  writeFileSync(approvalFile(runId, nonce), verdict, "utf8");
}

/**
 * Drop every pending ask for a run, telling clients so their modals close.
 *
 * Called when a run ends by any route. Without it a run that crashed while blocked would
 * leave a modal on screen asking about a process that no longer exists — and answering it
 * would write an approval file nobody will ever read.
 */
function clearConfirms(runId: string, reason: string, nonce?: string): void {
  for (const [key, p] of [...pendingConfirms]) {
    if (p.runId !== runId) continue;
    // Scoped to one ask when the caller knows which one. A graph node can fire several tool
    // calls in a turn and each high-impact one blocks independently (the client keeps them as
    // a queue), so one of them timing out must not close the modals for the others — those
    // are still being waited on, and answering them still means something.
    if (nonce !== undefined && p.nonce !== nonce) continue;
    pendingConfirms.delete(key);
    rmSync(approvalFile(p.runId, p.nonce), { force: true });
    relay.broadcastMcp({ type: "confirmResolved", runId: p.runId, nonce: p.nonce, verdict: reason });
  }
}

function broadcastMcpServers(): void {
  void mcpRegistry
    .list()
    .then((servers) => relay.broadcastMcp({ type: "servers", servers }))
    .catch((err) => console.error("[mcp] snapshot failed:", (err as Error).message));
}

async function handleMcpCommand(cmd: McpCommand): Promise<void> {
  try {
    switch (cmd.cmd) {
      case "addMcpServer": {
        if (typeof cmd.endpoint !== "string" || !cmd.endpoint.trim()) {
          relay.broadcastMcp({ type: "error", message: "an endpoint is required" });
          return;
        }
        // A handshake against someone else's server takes as long as it takes. Saying so
        // is the difference between "connecting" and "the button did nothing".
        relay.broadcastMcp({ type: "discovering", serverId: null, endpoint: cmd.endpoint });
        const added = await mcpRegistry.addServer({
          endpoint: cmd.endpoint,
          label: cmd.label,
          token: cmd.token,
        });
        // The endpoint may carry a path or query a user would not want echoed, and the
        // server's own name is a claim; log the id we assigned and what happened to it.
        console.log(
          `[mcp] add ${added.server?.id ?? "?"} — ${added.ok ? `connected, ${added.server?.tools.length ?? 0} tool(s)` : `failed: ${added.server?.status}`}`,
        );
        broadcastMcpServers();
        if (!added.ok && added.message) {
          relay.broadcastMcp({ type: "error", message: added.message, ...(added.server ? { serverId: added.server.id } : {}) });
        } else if (added.message && added.server) {
          relay.broadcastMcp({ type: "notice", message: added.message, serverId: added.server.id });
        }
        return;
      }

      case "rediscoverMcpServer": {
        if (typeof cmd.serverId !== "string") return;
        relay.broadcastMcp({
          type: "discovering",
          serverId: cmd.serverId,
          endpoint: (await mcpRegistry.get(cmd.serverId))?.endpoint ?? "",
        });
        const res = await mcpRegistry.rediscover(cmd.serverId);
        console.log(
          `[mcp] rediscover ${cmd.serverId} — ${res.ok ? `${res.server?.tools.length ?? 0} tool(s)` : `failed: ${res.server?.status ?? "unknown"}`}`,
        );
        broadcastMcpServers();
        if (!res.ok && res.message) {
          relay.broadcastMcp({ type: "error", message: res.message, serverId: cmd.serverId });
        } else if (res.message) {
          relay.broadcastMcp({ type: "notice", message: res.message, serverId: cmd.serverId });
        }
        return;
      }

      case "removeMcpServer": {
        if (typeof cmd.serverId !== "string") return;
        const removed = await mcpRegistry.removeServer(cmd.serverId);
        if (removed) console.log(`[mcp] removed ${cmd.serverId}`);
        broadcastMcpServers();
        if (!removed) {
          relay.broadcastMcp({ type: "error", message: `no server called "${cmd.serverId}"` });
        }
        return;
      }

      case "resolveMcpConfirm": {
        if (typeof cmd.runId !== "string" || typeof cmd.nonce !== "string") return;
        const verdict = cmd.verdict === "once" || cmd.verdict === "run" ? cmd.verdict : "deny";
        const key = confirmKey(cmd.runId, cmd.nonce);
        const pending = pendingConfirms.get(key);
        if (!pending) {
          // Already answered, timed out, or the run died. Saying so beats silence: two
          // people clicking the same modal should not both think they decided it.
          relay.broadcastMcp({
            type: "error",
            message: "that confirmation is no longer waiting — the run moved on without it",
          });
          return;
        }
        pendingConfirms.delete(key);
        writeApproval(cmd.runId, cmd.nonce, verdict);
        console.log(`[mcp] ${pending.server}/${pending.tool} — ${verdict}`);
        relay.broadcastMcp({ type: "confirmResolved", runId: cmd.runId, nonce: cmd.nonce, verdict });
        return;
      }

      case "setMcpServerAuth": {
        if (typeof cmd.serverId !== "string") return;
        const token = typeof cmd.token === "string" && cmd.token.length ? cmd.token : null;
        const { result, warning } = await mcpRegistry.setCredential(cmd.serverId, token);
        if (!result.ok) {
          relay.broadcastMcp({ type: "error", message: result.message ?? "could not store the credential", serverId: cmd.serverId });
          return;
        }
        // Log that a credential changed, never which value it changed to.
        console.log(`[mcp] ${cmd.serverId} credential ${token ? "set" : "cleared"}`);
        // A stored credential is only useful if it works, so prove it immediately rather
        // than leaving the server sitting in auth_required until someone clicks refresh.
        relay.broadcastMcp({ type: "discovering", serverId: cmd.serverId, endpoint: result.server?.endpoint ?? "" });
        const retried = await mcpRegistry.rediscover(cmd.serverId);
        broadcastMcpServers();
        if (warning) relay.broadcastMcp({ type: "notice", message: warning, serverId: cmd.serverId });
        if (!retried.ok && retried.message) {
          relay.broadcastMcp({ type: "error", message: retried.message, serverId: cmd.serverId });
        }
        return;
      }

      case "setMcpToolImpact": {
        if (typeof cmd.serverId !== "string" || typeof cmd.toolName !== "string") return;
        const impact = cmd.impact === "high" || cmd.impact === "low" ? cmd.impact : null;
        const updated = await mcpRegistry.setToolImpact(cmd.serverId, cmd.toolName, impact);
        if (!updated) {
          relay.broadcastMcp({
            type: "error",
            message: `no tool "${cmd.toolName}" on "${cmd.serverId}"`,
            serverId: cmd.serverId,
          });
          return;
        }
        console.log(
          `[mcp] ${cmd.serverId}/${cmd.toolName} impact ${impact ? `overridden to ${impact}` : "override cleared"} (classifier says ${updated.computed_impact})`,
        );
        broadcastMcpServers();
        return;
      }
    }
  } catch (err) {
    const message = (err as Error)?.message ?? String(err);
    console.error(`[mcp] ${cmd.cmd} failed: ${message}`);
    relay.broadcastMcp({ type: "error", message: `${cmd.cmd} failed: ${message}` });
  }
}

// --- providers: model credentials -------------------------------------------
// The bring-your-own-key surface, on its own channel. Two commands, deliberately:
// `testProviderKey` proves a key works and writes NOTHING, `setProviderKey` stores it. Folding
// them would mean the "Test connection" button put a credential on disk before the user
// pressed Save.
//
// Nothing broadcast here carries a key. A provider reports `configured: true/false`, which is
// the name of a variable being set, and never the value behind it — the same guarantee the MCP
// registry gives, through the same credential writer.

const PROVIDER_COMMAND_NAMES = new Set(["setProviderKey", "testProviderKey"]);

function broadcastProviders(): void {
  relay.broadcastProviders({ type: "providers", providers: providerStatus() });
}

async function handleProviderCommand(cmd: ProviderCommand): Promise<void> {
  try {
    if (!isProviderId(cmd.provider)) {
      // Named rather than echoed: `cmd.provider` is client-supplied and about to be rendered.
      relay.broadcastProviders({
        type: "error",
        message: `"${String(cmd.provider).slice(0, 32)}" is not a provider you can connect — expected anthropic or openai`,
      });
      return;
    }
    const provider = cmd.provider;
    const key = typeof cmd.key === "string" ? cmd.key.trim() : "";
    if (!key) {
      relay.broadcastProviders({ type: "error", message: "no key was entered", provider });
      return;
    }

    if (cmd.cmd === "testProviderKey") {
      const result = await verifyProviderKey(provider, key);
      // The outcome, never the input. A failure message comes from the provider and names the
      // status, not the credential.
      console.log(`[providers] ${provider} key tested — ${result.ok ? "ok" : "rejected"}`);
      relay.broadcastProviders({ type: "testResult", provider, ok: result.ok, message: result.message });
      return;
    }

    // setProviderKey. Straight through the one credential writer — the value is used by
    // `set` and nowhere else in this function.
    const written = credentials.set(PROVIDER_ENV_KEY[provider], key);
    if (!written.ok) {
      relay.broadcastProviders({
        type: "error",
        message: written.warning ?? "could not store that key",
        provider,
      });
      return;
    }
    // Names only, exactly as loadRuntimeEnv logs them on the way in.
    console.log(`[providers] ${provider} key set (${PROVIDER_ENV_KEY[provider]})`);
    broadcastProviders();
    // A key shadowed by the server's own shell works now and reverts on restart. Saying so is
    // the difference between a puzzling regression tomorrow and a sentence today.
    if (written.warning) {
      relay.broadcastProviders({ type: "notice", message: written.warning, provider });
    }
  } catch (err) {
    const message = (err as Error)?.message ?? String(err);
    console.error(`[providers] ${cmd.cmd} failed: ${message}`);
    relay.broadcastProviders({ type: "error", message: `${cmd.cmd} failed: ${message}` });
  }
}

// --- deploy: commands -------------------------------------------------------
// Every mutation answers by re-broadcasting the affected snapshot on the "deploy" channel,
// the same shape a fresh `listDeployments` would return — so a client never reconciles a
// partial update against local state.
//
// The credential discipline is the provider handler's, unchanged: the Railway token goes
// through the one shared writer, the log line names the variable and never the value, and
// what the browser learns is `railwayConfigured: true`.

const DEPLOY_COMMAND_NAMES = new Set([
  "planDeploy", "deploy", "cancelDeploy", "forgetDeployment", "loadDeployLogs",
  "setRailwayToken", "testRailwayToken",
]);

/**
 * A deployment id off the wire, or null.
 *
 * The commands that take one used to hand it straight to the store, so a null arrived as
 * "Provided value cannot be bound to SQLite parameter 1" — a message about our database,
 * shown to someone who cannot act on it, from a command that should simply have said no.
 */
function deploymentIdOf(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 && value.length <= 64 ? value : null;
}

async function handleDeployCommand(cmd: DeployChannelCommand): Promise<void> {
  try {
    switch (cmd.cmd) {
      case "setRailwayToken": {
        // null clears it — the same "remove the key entirely" shape setMcpServerAuth has.
        if (cmd.token === null) {
          credentials.clear(RAILWAY_ENV_KEY);
          console.log(`[deploy] Railway token cleared (${RAILWAY_ENV_KEY})`);
          broadcastDeployments();
          return;
        }
        const token = typeof cmd.token === "string" ? cmd.token.trim() : "";
        if (!token) {
          relay.broadcastDeploy({ type: "error", message: "no token was entered" });
          return;
        }
        const written = credentials.set(RAILWAY_ENV_KEY, token);
        if (!written.ok) {
          relay.broadcastDeploy({ type: "error", message: written.warning ?? "could not store that token" });
          return;
        }
        console.log(`[deploy] Railway token set (${RAILWAY_ENV_KEY})`);
        broadcastDeployments();
        if (written.warning) relay.broadcastDeploy({ type: "notice", message: written.warning });
        return;
      }

      case "testRailwayToken": {
        // Writes nothing, by design — see TestRailwayTokenCommand.
        const token = typeof cmd.token === "string" ? cmd.token.trim() : "";
        if (!token) {
          relay.broadcastDeploy({ type: "testResult", ok: false, message: "no token was entered" });
          return;
        }
        try {
          const { projectCount } = await new RailwayApi({ token }).verify();
          console.log("[deploy] Railway token tested — ok");
          relay.broadcastDeploy({
            type: "testResult",
            ok: true,
            message: projectCount ? "connected" : "connected — no projects yet",
          });
        } catch (err) {
          const detail = err instanceof RailwayError ? err.message : String(err);
          console.log("[deploy] Railway token tested — rejected");
          relay.broadcastDeploy({ type: "testResult", ok: false, message: detail });
        }
        return;
      }

      case "planDeploy": {
        if (!isSafeAgentId(cmd.agentId)) {
          relay.broadcastDeploy({ type: "error", message: "invalid agent id" });
          return;
        }
        const plan = await planDeploy(deployDeps, {
          agentId: cmd.agentId,
          provider: typeof cmd.provider === "string" ? cmd.provider : "",
          model: typeof cmd.model === "string" ? cmd.model : "",
          envKeys: [],
        });
        relay.broadcastDeploy({
          type: "plan",
          agentId: plan.agentId,
          secrets: plan.secrets,
          problems: plan.problems,
          warnings: plan.warnings,
          redeploy: plan.redeploy,
        });
        return;
      }

      case "deploy": {
        if (!isSafeAgentId(cmd.agentId)) {
          relay.broadcastDeploy({ type: "error", message: "invalid agent id" });
          return;
        }
        if (deployManager.busy) {
          relay.broadcastDeploy({ type: "error", message: "a deploy is already running" });
          return;
        }
        const envKeys = Array.isArray(cmd.envKeys)
          ? (cmd.envKeys as unknown[]).filter((k): k is string => typeof k === "string")
          : [];
        const result = await deployManager.start({
          agentId: cmd.agentId,
          provider: String(cmd.provider ?? ""),
          model: String(cmd.model ?? ""),
          envKeys,
          allowMissing: cmd.allowMissing === true,
          publicEndpoint: cmd.publicEndpoint === true,
        });
        if ("error" in result) relay.broadcastDeploy({ type: "error", message: result.error });
        return;
      }

      case "cancelDeploy": {
        const target = deploymentIdOf(cmd.deploymentId);
        if (!target) {
          relay.broadcastDeploy({ type: "error", message: "no deployment id to cancel" });
          return;
        }
        await deployManager.cancel(target);
        return;
      }

      case "forgetDeployment": {
        // Detaches the record from Jaroku and touches NOTHING in the user's account. Deleting
        // somebody's live service because they tidied a list is not a trade this makes; the
        // notice says where the real thing still is.
        const target = deploymentIdOf(cmd.deploymentId);
        if (!target) {
          relay.broadcastDeploy({ type: "error", message: "no deployment id to forget" });
          return;
        }
        const row = await deployStore.get(target);
        if (!row) {
          relay.broadcastDeploy({ type: "error", message: "no such deployment" });
          return;
        }
        if (deployManager.activeId === target) {
          relay.broadcastDeploy({ type: "error", message: "that deploy is still running — cancel it first" });
          return;
        }
        await deployStore.patch(target, { status: "removed" });
        broadcastDeployments();
        void relay.broadcastAgents();
        relay.broadcastDeploy({
          type: "notice",
          message: row.url
            ? `removed from Jaroku. The service is still running at ${row.url} — delete it in Railway if you want it gone.`
            : "removed from Jaroku. Anything created in your Railway account is still there.",
        });
        return;
      }

      case "loadDeployLogs": {
        const target = deploymentIdOf(cmd.deploymentId);
        if (!target) return;
        // A non-finite `since` would come back out of SQLite as a comparison against NaN and
        // quietly return nothing, which reads as "this deploy produced no output".
        const since = Number.isFinite(cmd.sinceSeq) ? Number(cmd.sinceSeq) : -1;
        relay.broadcastDeploy({
          type: "logs",
          deploymentId: target,
          lines: await deployStore.logs(target, since),
        });
        return;
      }
    }
  } catch (err) {
    const message = (err as Error)?.message ?? String(err);
    console.error(`[deploy] ${cmd.cmd} failed: ${message}`);
    relay.broadcastDeploy({ type: "error", message: `${cmd.cmd} failed: ${message}` });
  }
}

// --- eval: dataset CRUD -----------------------------------------------------
// Control-plane only. Every mutation answers by re-broadcasting the affected snapshot on
// the "eval" channel, the same shape a fresh `listDatasets` would return — so a client
// never has to reconcile a partial update against local state.

async function broadcastDatasets(ctx: TenantContext, agentId: string | null): Promise<void> {
  relay.broadcastEval({
    type: "datasets",
    agentId,
    datasets: await evalStore.listDatasets(ctx, agentId ?? undefined),
  });
}

async function broadcastDataset(ctx: TenantContext, datasetId: string): Promise<void> {
  relay.broadcastEval({
    type: "dataset",
    datasetId,
    examples: await evalStore.listExamples(ctx, datasetId),
  });
}

async function handleEvalCommand(cmd: ForwardedCommand): Promise<void> {
  const ctx = serverContext();
  try {
    switch (cmd.cmd) {
      case "listDatasets":
        await broadcastDatasets(ctx, cmd.agentId ?? null);
        return;
      case "loadDataset":
        await broadcastDataset(ctx, cmd.datasetId);
        return;
      case "createDataset": {
        const ds = await evalStore.createDataset(ctx, cmd.agentId, cmd.name);
        console.log(`[eval] dataset "${ds.name}" created for ${cmd.agentId}`);
        await broadcastDatasets(ctx, cmd.agentId);
        await broadcastDataset(ctx, ds.id);
        return;
      }
      case "renameDataset": {
        await evalStore.renameDataset(ctx, cmd.datasetId, cmd.name);
        await broadcastDatasets(ctx, (await evalStore.getDataset(ctx, cmd.datasetId))?.agent_id ?? null);
        return;
      }
      case "deleteDataset": {
        await evalStore.deleteDataset(ctx, cmd.datasetId);
        relay.broadcastEval({ type: "datasetDeleted", datasetId: cmd.datasetId });
        await broadcastDatasets(ctx, cmd.agentId);
        return;
      }
      case "addExample": {
        // An empty input would be a run with nothing to do — reject it here rather than
        // let it become a job that burns a real API call on whitespace.
        const input = (cmd.input ?? "").trim();
        if (!input) {
          relay.broadcastEval({ type: "error", datasetId: cmd.datasetId, message: "an example needs an input" });
          return;
        }
        await evalStore.addExample(ctx, cmd.datasetId, input, cmd.expected ?? null, cmd.notes ?? null);
        await broadcastDataset(ctx, cmd.datasetId);
        await broadcastDatasets(ctx, (await evalStore.getDataset(ctx, cmd.datasetId))?.agent_id ?? null);
        return;
      }
      case "updateExample": {
        await evalStore.updateExample(ctx, cmd.exampleId, {
          ...(cmd.input !== undefined ? { input: cmd.input } : {}),
          ...(cmd.expected !== undefined ? { expected: cmd.expected } : {}),
          ...(cmd.notes !== undefined ? { notes: cmd.notes } : {}),
        });
        await broadcastDataset(ctx, cmd.datasetId);
        return;
      }
      case "deleteExample": {
        await evalStore.deleteExample(ctx, cmd.exampleId);
        await broadcastDataset(ctx, cmd.datasetId);
        await broadcastDatasets(ctx, (await evalStore.getDataset(ctx, cmd.datasetId))?.agent_id ?? null);
        return;
      }
      case "startEval": {
        // One eval at a time. Two concurrent fan-outs would contend for the same pool
        // slots and each would report latency inflated by the other — a comparison the
        // numbers can't support.
        if (evalRunner.active) {
          relay.broadcastEval({ type: "error", message: "an eval is already running" });
          return;
        }
        // Same reason as runAgent: this id ends up as the working directory of every job's
        // subprocess. Refusing it here also keeps a whole eval run and its jobs from being
        // written for an agent that cannot exist.
        if (!isSafeAgentId(cmd.agentId ?? "")) {
          relay.broadcastEval({ type: "error", message: `invalid agent id: ${cmd.agentId}` });
          return;
        }
        const started = await evalRunner.start({
          datasetId: cmd.datasetId,
          agentId: cmd.agentId,
          rubricId: await rubricIdFor(ctx, cmd.datasetId),
          targets: cmd.targets ?? [],
          budgetUsd: cmd.budgetUsd ?? null,
        });
        if ("error" in started) relay.broadcastEval({ type: "error", message: started.error });
        return;
      }
      case "cancelEval": {
        await evalRunner.cancel(cmd.evalId);
        return;
      }
      case "estimateEval": {
        relay.broadcastEval({
          type: "estimate",
          estimate: await estimateEval(ctx, store, evalStore, {
            datasetId: cmd.datasetId,
            agentId: cmd.agentId,
            targets: cmd.targets ?? [],
            judgeEnabled: JudgeScorer.available(),
          }),
        });
        return;
      }
      case "loadEvalResults": {
        const results = await aggregateEval(ctx, evalStore, cmd.evalId);
        if (!results) {
          relay.broadcastEval({ type: "error", message: "unknown eval" });
          return;
        }
        relay.broadcastEval({ type: "evalResults", evalId: cmd.evalId, results });
        return;
      }
      case "listEvals": {
        const all = await evalStore.listEvalRuns(ctx);
        relay.broadcastEval({
          type: "evals",
          evals: cmd.datasetId ? all.filter((e) => e.dataset_id === cmd.datasetId) : all,
        });
        return;
      }
      case "loadRubric": {
        const r = await rubricFor(ctx, cmd.datasetId);
        relay.broadcastEval({
          type: "rubric", datasetId: cmd.datasetId, rubric: r, isDefault: r.dataset_id === null,
        });
        return;
      }
      case "saveRubric": {
        // Validated here rather than trusted: a rubric with no criteria, or with all-zero
        // weights, produces scores that look real and mean nothing.
        const criteria = (cmd.criteria ?? []).filter(
          (c): c is RubricCriterion =>
            typeof c?.id === "string" && c.id.trim() !== "" && typeof c.description === "string",
        );
        if (!criteria.length) {
          relay.broadcastEval({ type: "error", message: "a rubric needs at least one criterion" });
          return;
        }
        if (!criteria.some((c) => c.weight > 0)) {
          relay.broadcastEval({ type: "error", message: "a rubric needs at least one criterion with weight above zero" });
          return;
        }
        const existing = await evalStore.rubricForDataset(ctx, cmd.datasetId);
        const saved = await evalStore.putRubric(ctx, {
          id: existing?.id,
          dataset_id: cmd.datasetId, // dataset-scoped: never overwrites the shared default
          name: cmd.name ?? existing?.name ?? "Custom",
          criteria,
        });
        console.log(`[eval] rubric saved for dataset ${cmd.datasetId} — ${criteria.length} criteria`);
        relay.broadcastEval({ type: "rubric", datasetId: cmd.datasetId, rubric: saved, isDefault: false });
        return;
      }
      case "promoteTestInput": {
        const input = (cmd.input ?? "").trim();
        if (!input) {
          relay.broadcastEval({ type: "error", message: "nothing to promote — the test input is empty" });
          return;
        }
        const ds = await evalStore.defaultDatasetFor(ctx, cmd.agentId, cmd.agentName);
        // Adding the same input twice silently doubles what an eval over this dataset
        // costs, for zero extra signal. Report it instead.
        const duplicate = await evalStore.hasExampleWithInput(ctx, ds.id, input);
        if (!duplicate) await evalStore.addExample(ctx, ds.id, input, cmd.expected ?? null, null);
        console.log(
          `[eval] promote → "${ds.name}"${duplicate ? " (already present)" : ""}: ${input.slice(0, 60)}`,
        );
        relay.broadcastEval({ type: "promoted", datasetId: ds.id, datasetName: ds.name, duplicate });
        await broadcastDatasets(ctx, cmd.agentId);
        await broadcastDataset(ctx, ds.id);
        return;
      }
    }
  } catch (err) {
    const message = (err as Error).message;
    console.error(`[eval] ${cmd.cmd} failed:`, message);
    relay.broadcastEval({ type: "error", message: `${cmd.cmd} failed: ${message}` });
  }
}

// --- pipeline ---------------------------------------------------------------
// Every run in the pool — interactive or eval job — persists identically. Persisting is
// unconditional and un-special-cased on purpose: an eval job IS an ordinary run, and its
// trace has to be as complete and as inspectable as one the user triggered by hand.
//
// What differs is only the LIVE broadcast. An eval job's events are not put on the "trace"
// channel, because traceStore.applyEvent focuses activeRunId on every run_start and a
// fan-out would yank the timeline away from whatever the user is reading. Drill-down loads
// those runs on demand through the existing loadRun path.
// INGESTION IS A QUEUE, and it has to be.
//
// Persisting used to be synchronous, so a stdout line was fully written before the next one
// could be read: run_start landed before its steps, steps landed in seq order, and the
// boundary that stamps them ran after the steps it stamps. None of that was arranged — it
// was a property of the store being unable to yield.
//
// It can yield now. Left as bare calls, three things break at once and all of them quietly:
// a step can be written before the run_start whose foreign key it needs, two steps can
// commit out of order, and `setCheckpointUpto` can run before the steps it is meant to
// stamp — which is not a display bug, it is a run you can no longer branch from, discovered
// weeks later when somebody tries.
//
// So every write that must observe the arrival order goes on one chain, control-plane
// writes included. The broadcast rides the same chain, which keeps "persist first, then
// broadcast" true rather than merely intended.
//
// The queue is unbounded, which is correct for a local subprocess and is not a hosted
// answer: a run that emits faster than the database accepts grows it without limit. Session
// 4 caps bytes, lines and line length per run, and that is where the cap belongs — here it
// would be a limit on a pipe nobody can flood.
let ingestChain: Promise<void> = Promise.resolve();
function ingest(work: () => Promise<void>): void {
  ingestChain = ingestChain.then(work, work).catch((err) => {
    console.error("[store] failed to persist event:", (err as Error)?.message ?? String(err));
  });
}

pool.on("event", ({ runId, event }) => {
  // Read synchronously: this flag gates whether a NEW run may start, and deferring it would
  // leave a window in which the finished run still looks active.
  if (runId === activeRunId && event.kind === "run_end") runActive = false;
  ingest(async () => {
    // Persist first (source of truth), then broadcast to live clients. A persist failure is
    // logged and the event still goes out — the client showing a step the database lost is
    // better than the client showing nothing and no one knowing why.
    try {
      if (event.kind === "run_start" || event.kind === "run_end") {
        await store.upsertRun(serverContext(), event.run);
      } else if (event.kind === "step") {
        await store.insertStep(serverContext(), event.step);
      }
    } catch (err) {
      console.error("[store] failed to persist event:", (err as Error).message);
    }
    if (!isEvalRun(runId)) relay.broadcast(event);
  });
});

pool.on("parseError", ({ runId, line, error }) => {
  console.error(`[manager] non-event stdout line (${error}):`, line.slice(0, 200));
  if (!isEvalRun(runId)) relay.broadcastLog("parseError", `${error}: ${line.slice(0, 200)}`);
});

pool.on("stderr", ({ runId, line }) => {
  console.error("[agent]", line);
  if (!isEvalRun(runId)) relay.broadcastLog("stderr", line);
});

// Debug-depth control events (off the trace stream). A `boundary` correlates the durable
// checkpoint to the steps it covers (for later branching); a `paused` flips the run to the
// store-only 'paused' status so history shows it as resumable, without any run_end.
pool.on("control", ({ ctrl }) => {
  const runId = typeof ctrl.run_id === "string" ? ctrl.run_id : null;
  if (!runId) return;
  const seqHigh = typeof ctrl.seq_high === "number" ? ctrl.seq_high : -1;
  const checkpointId = typeof ctrl.checkpoint_id === "string" ? ctrl.checkpoint_id : null;
  const next = Array.isArray(ctrl.next) ? (ctrl.next as string[]) : [];
  try {
    if (ctrl.ctrl === "boundary") {
      // On the ingest chain, behind the steps this stamps. A boundary that overtook them
      // would stamp nothing, and the run would silently stop being branchable.
      ingest(async () => {
        if (checkpointId && seqHigh >= 0) {
          await store.setCheckpointUpto(serverContext(), runId, seqHigh, checkpointId);
        }
        relay.broadcastDebug({ type: "boundary", runId, seq: seqHigh, next });
      });
    } else if (ctrl.ctrl === "paused") {
      // The id is recorded immediately — resume reads it, and a pause the process does not
      // know about yet is a pause the user cannot undo. Only the status write is queued.
      pausedRunId = runId;
      ingest(async () => {
        await store.setRunStatus(serverContext(), runId, "paused");
        relay.broadcastDebug({ type: "paused", runId, seq: seqHigh });
      });
    } else if (ctrl.ctrl === "tool_confirm") {
      // A run has stopped before a high-impact MCP tool's first call. It is blocked right
      // now, on a timer, so this goes out immediately and unconditionally — including for
      // eval runs, whose ordinary events are kept off the live channels. A silent eval that
      // stalls for two minutes and then reports a denial explains nothing.
      const nonce = typeof ctrl.nonce === "string" ? ctrl.nonce : "";
      if (!nonce) return;
      const server = String(ctrl.server ?? "unknown");
      const tool = String(ctrl.tool ?? "unknown");
      pendingConfirms.set(confirmKey(runId, nonce), {
        runId, nonce, server, tool, requestedAt: Date.now(),
      });
      console.log(`[mcp] ${runId} is waiting for confirmation of ${server}/${tool}`);
      relay.broadcastMcp({
        type: "confirmRequest",
        runId,
        nonce,
        server,
        tool,
        impactReason: String(ctrl.impact_reason ?? "it is classified high-impact"),
        args: String(ctrl.args ?? "{}"),
        timeoutS: typeof ctrl.timeout_s === "number" ? ctrl.timeout_s : 120,
        requestedAt: new Date().toISOString(),
      });
    } else if (ctrl.ctrl === "tool_confirm_closed") {
      // The runner gave up waiting (or was denied) and has moved on. Close the ask so a
      // modal cannot linger over a question nobody is listening for any more.
      const nonce = typeof ctrl.nonce === "string" ? ctrl.nonce : "";
      if (nonce) clearConfirms(runId, "expired", nonce);
    }
  } catch (err) {
    console.error("[debug] control handling failed:", (err as Error).message);
  }
});

pool.on("spawnError", ({ runId, error }) => {
  if (runId === activeRunId) {
    runActive = false;
    activeRunId = null;
  }
  console.error(`[manager] spawn error (run ${runId}):`, error.message);
});

pool.on("exit", ({ runId, code, signal, timedOut }) => {
  // The subprocess is gone, so any question it was waiting on is moot. Left standing, a run
  // that crashed while blocked would leave a modal asking about a process that no longer
  // exists, and answering it would write a file nobody will ever read.
  clearConfirms(runId, "run ended");
  // Only the interactive run owns the interactive flags; an eval job finishing must not
  // clear them out from under a run the user is driving.
  if (runId === activeRunId) {
    runActive = false; // covers a crash before run_end ever arrived
    // A run that halted at a boundary keeps its 'paused' status (set from the control
    // event); a normal completion already updated the run via run_end. Either way this
    // subprocess is gone.
    activeRunId = null;
  }
  console.log(
    `[manager] agent exited (run=${runId} code=${code} signal=${signal}${timedOut ? " TIMED OUT" : ""})`,
  );
});

// --- planning (the pre-generation gate) --------------------------------------
// Rides the "gen" channel too: a plan is an earlier phase of the same generation, not a
// separate feature. Listeners are permanent — a plan has no agent id to scope them to, and
// the planner holds a single pending slot, so there is nothing per-request to clean up.
//
// Every failure here goes out as plan_error, never as the gen channel's plain "error". That
// one is wired to buildStore.fail() on the client and paints the build pane as a failed
// generation — which, at plan time, would be reporting a failure that never happened.
planner.on("started", (e) => relay.broadcastGen({ type: "plan_started", ...e }));
planner.on("delta", (e) => relay.broadcastGen({ type: "plan_delta", ...e }));
planner.on("discarded", (e) => relay.broadcastGen({ type: "plan_discarded", ...e }));

planner.on("plan", (e) => {
  const usage = e.usage as { cost_usd?: number; output_tokens?: number };
  console.log(
    `[plan] ${e.planId} (rev ${e.revision}) — ${e.plan.tools.length} tool(s), ` +
      `${e.warnings.length} warning(s), ${usage?.output_tokens ?? 0} output tokens, ` +
      `$${(usage?.cost_usd ?? 0).toFixed(5)}`,
  );
  for (const w of e.warnings) console.log(`  ! ${w}`);
  relay.broadcastGen({ type: "plan", ...e });
});

planner.on("error", (e) => {
  console.error(`[plan] failed: ${e.message}`);
  relay.broadcastGen({ type: "plan_error", message: e.message });
});

async function planAgent(cmd: PlanAgentCommand): Promise<void> {
  // A generation in flight owns the pipeline; planning the next agent mid-build would put two
  // plans and one generation on the same single-slot state.
  if (generating) {
    relay.broadcastGen({ type: "plan_error", message: "a generation is already in progress" });
    return;
  }
  console.log(
    `[plan] planning${cmd.revisePlanId ? " (revision)" : ""} — "${cmd.prompt.slice(0, 80)}"`,
  );
  void planner.plan({
    runtimeDir: RUNTIME_DIR,
    prompt: cmd.prompt,
    connectors: cmd.connectors,
    // Resolved here rather than in the planner, so the planner keeps its single dependency
    // on the connector catalogue. Refs naming a server or tool that has since gone away
    // resolve to nothing rather than to a guess — the same posture as resolveSelected.
    mcpTools: await mcpRegistry.resolve(cmd.mcpTools ?? []),
    name: cmd.name,
    revisePlanId: cmd.revisePlanId,
  });
}

// --- generation -------------------------------------------------------------
// Streams into the "gen" channel. Nothing here touches the trace store or the frozen
// event schema; a generation and a run are independent concerns that share only a socket.
let generating = false;

async function generateAgent(cmd: GenerateCommand): Promise<void> {
  if (generating) {
    // On the planned path this must NOT be the plain "error" member: that one paints the
    // build pane as a failed generation, and the pending plan is still perfectly good. The
    // check also comes before take(), so a refused click doesn't spend the plan.
    if (cmd.planId) {
      relay.broadcastGen({
        type: "plan_error",
        message: "a generation is already in progress — this plan is still here when it finishes",
      });
    } else {
      relay.broadcastGen({ type: "error", message: "a generation is already in progress" });
    }
    return;
  }

  // The confirmed plan, if there is one. Everything downstream comes from the RECORD, not
  // from this command: the composer draft and the plan card's Generate button are separate
  // entry points that can disagree (the user can retype the prompt or toggle a connector chip
  // after planning). Building what was approved is the whole point of the gate.
  let plan: string | undefined;
  let planUsage: UsageSummary | undefined;
  let mcpRefs: string[] = cmd.mcpTools ?? [];
  let { prompt, connectors, name } = cmd;
  if (cmd.planId) {
    // Everything that can refuse this generation is checked against peek() FIRST, so a
    // refusal never burns the plan. take() happens only once the build is certain to start —
    // a user told "no" should still have their plan on screen to revise.
    const rec = planner.peek();
    if (!rec || rec.planId !== cmd.planId) {
      // Never fall through to an unplanned generation here. The user approved a specific
      // plan; quietly building something they never reviewed is the exact failure this gate
      // exists to prevent.
      relay.broadcastGen({
        type: "plan_error",
        message: "that plan is no longer available — describe the agent again",
      });
      return;
    }
    // resolveSelected() silently drops ids that aren't in the catalog. That is the right
    // behaviour for a client's unvalidated list, but not here: the plan NAMED these connectors
    // and the user approved that. Dropping one quietly would build an agent missing a tool the
    // plan promised — a plan that turned into a lie. Catalog drift between planning and
    // confirming is rare, and this refusal is loud on purpose. The plan survives it, so the
    // next message re-plans against the catalog as it now stands.
    const known = new Set(loadConnectors(RUNTIME_DIR).map((c) => c.id));
    const missing = (rec.connectors ?? []).filter((id) => !known.has(id));
    if (missing.length) {
      relay.broadcastGen({
        type: "plan_error",
        message:
          `the plan uses ${missing.join(", ")}, which ${missing.length > 1 ? "are" : "is"} no ` +
          `longer in the connector catalog — say what you want and it will be re-planned`,
      });
      return;
    }

    // The same refusal, for the MCP side. A tool the plan named that has since been
    // disconnected — or that the server stopped advertising — cannot be quietly dropped:
    // the manifest IS the agent's grant, and building with a smaller one than the user
    // approved produces an agent that silently cannot do what its plan promised.
    const approvedRefs = rec.mcpTools ?? [];
    const stillThere = new Set(
      (await mcpRegistry.resolve(approvedRefs)).map((t) => `${t.server_id}/${t.name}`),
    );
    const goneMcp = approvedRefs.filter((r) => !stillThere.has(r));
    if (goneMcp.length) {
      relay.broadcastGen({
        type: "plan_error",
        message:
          `the plan uses the MCP tool${goneMcp.length > 1 ? "s" : ""} ${goneMcp.join(", ")}, which ` +
          `${goneMcp.length > 1 ? "are" : "is"} no longer available — reconnect the server, or ` +
          `say what you want and it will be re-planned`,
      });
      return;
    }

    planner.take(cmd.planId); // spend it: this generation is now certain to start
    ({ prompt, connectors, name } = rec);
    mcpRefs = approvedRefs;
    plan = rec.plan.raw;
    planUsage = rec.usage;
  }

  generating = true;
  console.log(`[gen] generating${plan ? " from an approved plan" : ""} — "${prompt.slice(0, 80)}"`);
  relay.broadcastGen({ type: "started", prompt });

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

  const onDone = (e: {
    agentId: string; name: string; files: string[]; usage: unknown; planUsage: unknown;
  }) => {
    const usage = e.usage as { cost_usd?: number; output_tokens?: number };
    const planCost = (e.planUsage as { cost_usd?: number })?.cost_usd ?? 0;
    console.log(
      `[gen] ${e.agentId} ready — ${e.files.length} file(s), ` +
        `${usage?.output_tokens ?? 0} output tokens, $${(usage?.cost_usd ?? 0).toFixed(5)}` +
        // The plan is part of what this agent cost. Reporting only the generation would
        // understate it every single time.
        (planCost ? ` + $${planCost.toFixed(5)} plan = $${(planCost + (usage?.cost_usd ?? 0)).toFixed(5)}` : ""),
    );
    relay.broadcastGen({ type: "done", ...e });
    void relay.broadcastAgents();
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

  // Resolved fresh at build time, so the manifest carries the schemas and impact ratings as
  // they stand now rather than as they stood when the plan was written.
  const mcpTools = await mcpRegistry.resolve(mcpRefs);
  const mcpServers = await mcpRegistry.list();
  void generator.generate({
    runtimeDir: RUNTIME_DIR, prompt, connectors, mcpTools, mcpServers, name, plan, planUsage,
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
  void relay.broadcastAgents();
  relay.broadcastAgentFiles(e.agentId);
  // An edit may have changed the graph structure — invalidate and re-push.
  graphCache.delete(e.agentId);
  void relay.broadcastAgentGraph(e.agentId);
});

editor.on("undone", (e) => {
  console.log(`[edit] undid v${e.version} on ${e.agentId}`);
  relay.broadcastEdit({ type: "undone", ...e });
  void relay.broadcastAgents();
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
  if (pool.interactiveRunning) {
    console.log("[manager] agent already running; ignoring run request");
    return;
  }
  // The same check loadAgentGraph and agentProjectFiles already make. Without it a
  // client-supplied id went straight into a subprocess spawn, and the Python contract — the
  // last line of defence, not the first — was what turned it away. By then a process had been
  // started and a run row written, so `../../etc/passwd` became a permanent errored run in the
  // history that the sidebar renders like any other. Refuse it here instead.
  if (agentId !== undefined && !isSafeAgentId(agentId)) {
    console.log(`[manager] refusing run — invalid agent id ${JSON.stringify(agentId)}`);
    relay.broadcastDebug({ type: "error", message: `invalid agent id: ${agentId}` });
    return;
  }
  // Mint the run id server-side so we can address the run (e.g. pause it) before run_start races
  // back. The runner uses JAROKU_RUN_ID when present, else mints its own — back-compatible.
  const runId = randomUUID();
  clearControl(runId); // no stale pause request from a prior life
  console.log(`[manager] starting ${agentId ?? "test_agent"}${input ? ` — "${input}"` : ""} (run ${runId})`);
  // Model is forwarded explicitly so a real-provider run can't silently fall back to
  // the agent's expensive default; unset means the agent picks its own default.
  // JAROKU_CONTROL_DIR is where tools/mcp_bridge.py exchanges confirmation approvals with
  // this process. Its ABSENCE is how a copied-out project knows nobody is watching — see the
  // gate's standalone branch. Set on every interactive run, so the gate always has a route.
  const env: NodeJS.ProcessEnv = { JAROKU_RUN_ID: runId, JAROKU_CONTROL_DIR: CHECKPOINT_DIR };
  if (provider) env.JAROKU_PROVIDER = provider;
  if (model) env.JAROKU_MODEL = model;
  runActive = true;
  activeRunId = runId;
  pausedRunId = null;
  pool.startInteractive({ runId, runtimeDir: RUNTIME_DIR, input, agentId, env });
}

// Pause the live run at its next node boundary (the runner honours the control file there).
function pauseRun(runId: string): void {
  if (!runActive || activeRunId !== runId) {
    console.log(`[debug] pauseRun ignored — ${runId} is not the active run`);
    return;
  }
  console.log(`[debug] pause requested for run ${runId}`);
  requestPause(runId);
}

// Resume a paused run from its durable checkpoint: a fresh subprocess continues the SAME run id,
// its seq starting where the paused segment left off (no run_start, no re-run of done nodes).
async function resumeRun(runId: string): Promise<void> {
  if (pool.interactiveRunning) {
    console.log("[debug] resumeRun ignored — a run is already active");
    return;
  }
  const run = await store.getRun(serverContext(), runId);
  if (!run) {
    relay.broadcastDebug({ type: "error", runId, message: "unknown run" });
    return;
  }
  // 'paused' is a store-only status (never an emitted event), so it's outside the frozen
  // RunStatus mirror — compare as a plain string rather than widening that type.
  if ((run.status as string) !== "paused") {
    relay.broadcastDebug({ type: "error", runId, message: `run is ${run.status}, not paused` });
    return;
  }
  const seqOffset = (await store.maxSeqForRun(serverContext(), runId)) + 1;
  clearControl(runId); // drop the pause request so it doesn't immediately re-pause
  await store.setRunStatus(serverContext(), runId, "running");
  console.log(`[debug] resuming run ${runId} from seq ${seqOffset} (agent ${run.agent_id})`);
  const env: NodeJS.ProcessEnv = {
    JAROKU_RESUME_RUN_ID: runId,
    JAROKU_SEQ_OFFSET: String(seqOffset),
    JAROKU_PROVIDER: run.provider,
    JAROKU_MODEL: run.model,
  };
  runActive = true;
  activeRunId = runId;
  pausedRunId = null;
  relay.broadcastDebug({ type: "resumed", runId, seqOffset });
  pool.startInteractive({ runId, runtimeDir: RUNTIME_DIR, agentId: run.agent_id, env });
}

// Fork a NEW run from a parent run's checkpoint at a step's node boundary, optionally with a
// validated domain-field edit. The parent is only read: its checkpoint db is copied (never
// written), and its step rows are copied verbatim into the branch — both stay fully inspectable.
async function branchRun(
  fromRunId: string,
  atSeq: number,
  editNode?: string,
  editedState?: Record<string, unknown>,
): Promise<void> {
  if (pool.interactiveRunning) {
    relay.broadcastDebug({ type: "error", runId: fromRunId, message: "a run is active — stop it before branching" });
    return;
  }
  const parent = await store.getRun(serverContext(), fromRunId);
  if (!parent) {
    relay.broadcastDebug({ type: "error", runId: fromRunId, message: "unknown run to branch from" });
    return;
  }
  // Resolve the node boundary containing `atSeq` — we fork at a whole-node boundary, never mid-node.
  const boundary = await store.boundaryForStep(serverContext(), fromRunId, atSeq);
  const parentDb = join(CHECKPOINT_DIR, `${fromRunId}.sqlite`);
  if (!boundary || !existsSync(parentDb)) {
    relay.broadcastDebug({ type: "error", runId: fromRunId, message: "no durable checkpoint for that step (branching needs a checkpointed run)" });
    return;
  }

  const branchId = randomUUID();
  const { checkpointId, seqHigh } = boundary;
  try {
    // Copy the parent's step prefix (0..boundary) + a physical copy of its checkpoint db, so the
    // parent is never mutated and the branch is self-contained + independently inspectable.
    await store.copyRunPrefix(serverContext(), fromRunId, branchId, seqHigh, seqHigh);
    copyFileSync(parentDb, join(CHECKPOINT_DIR, `${branchId}.sqlite`));
  } catch (err) {
    relay.broadcastDebug({ type: "error", runId: fromRunId, message: `branch prep failed: ${(err as Error).message}` });
    return;
  }

  const env: NodeJS.ProcessEnv = {
    JAROKU_RUN_ID: branchId,
    JAROKU_CONTROL_DIR: CHECKPOINT_DIR,
    JAROKU_BRANCH_THREAD_ID: fromRunId, // the checkpoint thread lives under the parent's id
    JAROKU_BRANCH_CHECKPOINT_ID: checkpointId,
    JAROKU_SEQ_OFFSET: String(seqHigh + 1),
    JAROKU_PROVIDER: parent.provider,
    JAROKU_MODEL: parent.model,
  };
  if (editedState && Object.keys(editedState).length) {
    const editFile = join(CHECKPOINT_DIR, `${branchId}.edit.json`);
    writeFileSync(editFile, JSON.stringify(editedState));
    env.JAROKU_BRANCH_EDIT_FILE = editFile;
    if (editNode) env.JAROKU_BRANCH_EDIT_NODE = editNode;
  }

  runActive = true;
  activeRunId = branchId;
  pausedRunId = null;
  console.log(`[debug] branching ${fromRunId} @seq ${seqHigh} -> ${branchId} (agent ${parent.agent_id})`);
  void relay.broadcastHistory(); // surface the new branch run in history immediately
  relay.broadcastDebug({ type: "branched", parentRunId: fromRunId, branchId, fromSeq: seqHigh });
  pool.startInteractive({ runId: branchId, runtimeDir: RUNTIME_DIR, agentId: parent.agent_id, env });
}

// --- explain (unified composer) --------------------------------------------
// A prose answer about a step / node / the agent, streamed to the conversation. Reuses only
// already-available context (the step the client selected, the agent's on-disk prompt/tools);
// never a code change, never on the trace stream.
let explaining = false;

function truncateJson(v: unknown, cap = 800): string {
  let s: string;
  try {
    s = JSON.stringify(v, null, 2) ?? String(v);
  } catch {
    s = String(v);
  }
  return s.length > cap ? `${s.slice(0, cap)}\n…(truncated)` : s;
}

function buildExplainContext(cmd: ExplainCommand): string {
  const { agentId, subject } = cmd;
  if (subject.kind === "step") {
    const st = subject.step;
    const parts = [
      `Agent: ${agentId}`,
      `Trace step #${st.seq}: "${st.name}" (${st.type}), status: ${st.error ? "FAILED" : "ok"}.`,
    ];
    if (st.error) parts.push(`Error:\n${st.error}`);
    parts.push(`Input:\n${truncateJson(st.input)}`, `Output:\n${truncateJson(st.output)}`);
    return parts.join("\n\n");
  }
  // node / agent — ground in the agent's on-disk prompt + tools (already served to the client too).
  const files = agentProjectFiles(agentId) as { path: string; content: string }[];
  const prompt = files.find((f) => /prompt/i.test(f.path) && f.path.endsWith(".md"))?.content ?? "(no system prompt file)";
  const toolFiles = files.filter((f) => /(^|\/)tools\//.test(f.path) && f.path.endsWith(".py") && !f.path.endsWith("__init__.py"));
  const tools = toolFiles.length
    ? toolFiles.map((f) => `- ${f.path}:\n${f.content.slice(0, 500)}`).join("\n")
    : "(no bespoke tools)";
  const head = subject.kind === "node" ? `Graph node: "${subject.nodeId}" of agent ${agentId}.` : `Agent: ${agentId}.`;
  return [head, `System prompt:\n${prompt.slice(0, 1500)}`, `Tools:\n${tools}`].join("\n\n");
}

function explainAgent(cmd: ExplainCommand): void {
  if (explaining) {
    relay.broadcastReply({ type: "error", agentId: cmd.agentId, message: "already answering — one at a time" });
    return;
  }
  explaining = true;
  relay.broadcastReply({ type: "started", agentId: cmd.agentId, question: cmd.question });
  const context = buildExplainContext(cmd);
  void streamExplain(context, cmd.question, {
    onDelta: (text) => relay.broadcastReply({ type: "delta", agentId: cmd.agentId, text }),
    onDone: () => { explaining = false; relay.broadcastReply({ type: "done", agentId: cmd.agentId }); },
    onError: (message) => { explaining = false; relay.broadcastReply({ type: "error", agentId: cmd.agentId, message }); },
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
  pool.stopAll();
  // Drain the ingest chain before closing. Events already read off a subprocess's stdout are
  // events the user watched happen, and closing the database out from under the last few
  // would lose the end of a trace that visibly ran. Bounded, so a wedged write cannot make
  // Ctrl-C do nothing.
  const drained = Promise.race([
    ingestChain,
    new Promise<void>((r) => setTimeout(r, 2000).unref?.()),
  ]);
  void drained.then(() => store.close()).finally(() => process.exit(0));
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
