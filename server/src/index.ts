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
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";
import { RunPool } from "./runPool.ts";
import { TraceStore } from "./store.ts";
import { migrate } from "./db/migrate.ts";
import { openDb } from "./db/open.ts";
import { newRequestId, systemContext, systemContextFor, type TenantContext } from "./db/tenant.ts";
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
  type MemberCommand,
  type ProviderCommand,
} from "./wsRelay.ts";
import { Router } from "./http/router.ts";
import { healthz, readyz } from "./http/health.ts";
import { AUTH_ENV, resolveAuthConfig } from "./auth/config.ts";
import { LocalIssuer } from "./auth/localIssuer.ts";
import { TokenVerifier } from "./auth/verifier.ts";
import { sessionRoutes } from "./auth/session.ts";
import { ContextResolver } from "./auth/resolve.ts";
import { resolveOriginPolicy } from "./auth/origin.ts";
import { resolveSocketAuth } from "./auth/socketAuth.ts";
import { DbTicketStore } from "./db/repositories/tickets.ts";
import { Generator, type UsageSummary } from "./generator.ts";
import { Planner } from "./planner.ts";
import { Editor } from "./editor.ts";
import { scanAgentDirectory } from "./agents.ts";
import { AgentRepository } from "./db/repositories/agents.ts";
import { IdentityRepository } from "./db/repositories/identity.ts";
import { isMemberRole } from "./db/tenant.ts";
import { resolveDevTenancy, type DevTenancy } from "./devTenancy.ts";
import { loadConnectors } from "./connectors.ts";
import { isSafeAgentId, listProjectFiles, readOnlyPaths, type ProjectFile } from "./projectFs.ts";
import { openObjectStore } from "./storage/open.ts";
import { resolveSigningKey } from "./storage/presign.ts";
import { filesFromDirectory, ProjectStore } from "./storage/projectStore.ts";
import { objectRoutes } from "./http/objects.ts";
import { readAgentFiles, slugsOwnedElsewhere, type AgentFilesDeps } from "./agentFiles.ts";
import {
  CHECKPOINT_SCHEMA, checkpointThreadId, checkpointerKindFromEnv,
} from "./checkpoints/threads.ts";
import { openCheckpointStore } from "./checkpoints/store.ts";
import { introspectGraph, type GraphResult } from "./graphIntrospect.ts";
import { streamExplain } from "./explainer.ts";
import type { DeployChannelCommand, ExplainCommand } from "./wsRelay.ts";
import { loadRuntimeEnv } from "./env.ts";
import { McpStore } from "./mcpStore.ts";
import { McpRegistry } from "./mcpRegistry.ts";
import { fileCredentialWriter } from "./envWriter.ts";
import { openSecretStore } from "./secrets/open.ts";
import { SecretRefRepository } from "./db/repositories/secretRefs.ts";
import { isSecretName } from "./secrets/secretStore.ts";
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

// AND ONE OBJECT STORE, chosen here and nowhere else, exactly like the driver above.
//
// An agent's files stop being a directory this process owns and become objects keyed by
// workspace and agent uuid. Locally that is still a directory — runtime/.objects/ — because
// `npm run dev` has to keep needing nothing installed and nothing running; hosted it is R2 or
// S3, and the application cannot tell which it got. See storage/open.ts for why `fs` refuses to
// run under NODE_ENV=production.
const OBJECT_SIGNING_KEY_PATH = process.env.JAROKU_OBJECT_KEY_PATH ?? join(SERVER_DIR, ".objectkey");
const objectSigningKey = resolveSigningKey(OBJECT_SIGNING_KEY_PATH);
const objects = openObjectStore({
  runtimeDir: RUNTIME_DIR,
  signingKeyPath: OBJECT_SIGNING_KEY_PATH,
});
console.log(
  `[server] object store: ${objects.kind}${objects.kind === "fs" ? ` (${join(RUNTIME_DIR, ".objects")})` : ""}`,
);

// THE WORKSPACE THIS PROCESS ACTS IN.
//
// Resolved once at boot and announced, because a server that silently decides which tenant it
// is acting as is the thing this session exists to make impossible — and this is the last
// place it still happens. `serverContext()` mints a fresh context per call rather than
// sharing one: the request id correlates a log line, an audit row and a trace, and a
// process-wide singleton would make every one of them read as the same request.
//
// Session 2 replaces the resolution with a verified JWT and a membership lookup. The shape
// does not change — a request arrives, a workspace is resolved for it, and everything
// downstream takes that context as a parameter.
let devTenancy: DevTenancy;
const serverContext = (): TenantContext => devTenancy.context();

// MIGRATIONS FIRST, before a single store is built.
//
// They own the schema on both drivers now, so nothing above may touch a table before they
// have run. Boot-time apply is deliberate: a server whose code expects a column the database
// does not have should fail at startup, where somebody is watching, rather than at the first
// request that happens to touch it.
await migrate(db.migrationTarget(), join(SERVER_DIR, "migrations", db.dialect));
devTenancy = await resolveDevTenancy(db);

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
const planner = new Planner();

// Run ids belonging to an in-flight eval job. Their events persist normally but are kept
// OFF the "trace" channel, so a fan-out can't steal the timeline's focus (traceStore
// focuses activeRunId on every run_start). Populated by the orchestrator.
const evalRunIds = new Set<string>();
const isEvalRun = (runId: string): boolean => evalRunIds.has(runId);

// WHICH WORKSPACE A RUN BELONGS TO.
//
// A run outlives the command that started it: its events arrive on the pool's stdout minutes
// later, and every one of them has to be persisted and broadcast in the workspace of the
// person who asked for it — not in whatever context the ingest handler happens to reach for.
// Recorded when the run is dispatched, dropped when the subprocess exits.
//
// The fallback is the server's own context, which covers the two runs nobody asked for: the
// startup autorun, and any run whose id somehow reaches ingestion without having been
// dispatched here.
const runWorkspaces = new Map<string, TenantContext>();
function contextForRun(runId: string): TenantContext {
  return runWorkspaces.get(runId) ?? serverContext();
}

// AND THE INTERFACE THAT WRITER NOW SITS BEHIND.
//
// Constructed FROM the writer above rather than opening its own handle on the file, so there is
// still exactly one thing in this process that writes runtime/.env — the property that module's
// header has claimed since the day it was written. What the store adds is the shape: `set`,
// `getForRun`, `listNames`, `delete`, and deliberately no `get` that would hand a plaintext
// value back to a request handler. See secrets/secretStore.ts for why that absence is the
// design rather than an omission.
//
// The MCP registry and the provider panel keep talking to the writer directly for now; they are
// moved onto this in the commit that gives names a table of their own.
const secretRefs = new SecretRefRepository(db);
const secrets = openSecretStore({
  db,
  refs: secretRefs,
  writer: credentials,
  envPath: join(RUNTIME_DIR, ".env"),
  // How a run id becomes a workspace. The hosted store needs it because a worker assembling a
  // sandbox holds the run and nothing else; the local store ignores it, because a file has no
  // notion of a workspace to resolve to.
  runWorkspace: async (runId) => runWorkspaces.get(runId)?.workspaceId ?? null,
  providerFor: (name) =>
    name.startsWith("JAROKU_MCP_") ? "mcp"
      : name.startsWith("ANTHROPIC") ? "anthropic"
        : name.startsWith("OPENAI") ? "openai"
          : name === RAILWAY_ENV_KEY ? "railway"
            : null,
});
console.log(`[server] secret store: ${secrets.kind}${secrets.kind === "dotenv" ? " (runtime/.env)" : ""}`);

// The same problem for the three orchestrators, which emit through callbacks registered once
// at boot and therefore have no argument to carry a context on.
//
// An eval is keyed, because several can be recorded even though only one runs at a time. A
// build and a deploy are single variables, because the app enforces one of each in flight —
// `generating`, and `deployManager.busy`, both of which refuse a second outright.
//
// Getting this wrong is no longer harmless. Before the broadcasts were scoped, an eval
// started by one workspace was announced to everybody, which was a leak; now it would be
// announced to ONE workspace, and if that is the wrong one the person who started it never
// hears about their own eval.
const evalWorkspaces = new Map<string, TenantContext>();
const contextForEval = (evalId: string): TenantContext => evalWorkspaces.get(evalId) ?? serverContext();

// ONE SCOPE PER SINGLE-FLIGHT SUBSYSTEM, and never one shared between them.
//
// These used to be a single `buildContext` covering planning, generation, editing and
// explaining, and it leaked across tenants in two independent ways:
//
//   * IT WAS ASSIGNED BEFORE THE BUSY GUARD. Workspace B sending a `generate` that was
//     REFUSED still repointed the variable at B — and workspace A's generation, still
//     streaming, then broadcast the rest of its source code into B's build pane.
//   * IT WAS SHARED BY SUBSYSTEMS THAT RUN CONCURRENTLY. `generating`, `editor.inFlight`,
//     `explaining` and `deployManager.busy` are four separate locks, so A generating while B
//     edits is entirely legal — and one variable cannot hold both answers.
//
// So each gets its own, and each is claimed only once its operation has actually STARTED,
// after every guard that could refuse it. A refusal is broadcast to the context of whoever
// asked, which is always in hand at the point of refusal and never needs a variable at all.
let planContext: TenantContext | null = null;
let genContext: TenantContext | null = null;
let editContext: TenantContext | null = null;
let replyContext: TenantContext | null = null;
let deployContext: TenantContext | null = null;
const contextForPlan = (): TenantContext => planContext ?? serverContext();
const contextForGen = (): TenantContext => genContext ?? serverContext();
const contextForEdit = (): TenantContext => editContext ?? serverContext();
const contextForReply = (): TenantContext => replyContext ?? serverContext();
const contextForDeploy = (): TenantContext => deployContext ?? serverContext();

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
// EVERY WORKSPACE, one at a time.
//
// Not one unscoped query: under RLS as the application role — which is what a deployment
// actually connects as — an unscoped query returns nothing, so the reconciliation silently
// did nothing and interrupted evals stayed "running" forever. `workspaces` carries no policy
// precisely so this list is readable, and each workspace is then reconciled in its own scope.
const bootIdentity = new IdentityRepository(db);
const workspaceIds = await bootIdentity.listWorkspaceIds(systemContext(newRequestId()));
const workspaceContexts = workspaceIds.map((id) => systemContextFor(id, newRequestId()));

for (const ctx of workspaceContexts) {
  for (const stale of await evalStore.unfinishedEvalRuns(ctx)) {
    const cancelled = await evalStore.cancelQueuedJobs(ctx, stale.id, "server restarted before this job ran");
    await evalStore.setEvalStatus(ctx, stale.id, "cancelled", "interrupted by a server restart");
    console.log(`[eval] ${stale.id} was interrupted by a restart — ${cancelled} queued job(s) cancelled`);
  }
  // And the runs themselves, which nothing used to close. See reconcileInterruptedRuns.
  for (const id of await store.reconcileInterruptedRuns(ctx)) {
    console.log(`[manager] run ${id} was interrupted by a restart`);
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

// WHERE A RUN'S CHECKPOINTS GO. `sqlite` writes one file per run under .checkpoints/; `postgres`
// writes rows a worker on another machine can read, which is the point. Resolved once and
// announced, so a deployment is never unsure which it got.
const CHECKPOINTER = checkpointerKindFromEnv();
console.log(
  `[server] checkpointer: ${CHECKPOINTER}` +
    (CHECKPOINTER === "sqlite" ? ` (${join(RUNTIME_DIR, ".checkpoints")})` : ` (${CHECKPOINT_SCHEMA} schema)`),
);

const CHECKPOINT_DIR = join(RUNTIME_DIR, ".checkpoints");
// Branching and sweeping, whichever store is holding the checkpoints. See checkpoints/store.ts:
// a fork is a file copy locally and an INSERT … SELECT hosted, and both promise the same thing —
// the parent's checkpoints are only ever read.
const checkpoints = openCheckpointStore(CHECKPOINTER, { checkpointDir: CHECKPOINT_DIR, db });

// Catch checkpoint blobs from evals whose per-eval sweep never ran (a crash, a restart).
// Only runs belonging to FINISHED eval jobs are touched — an interactive run's checkpoint
// is exactly the thing a user might come back to branch from, and is never swept.
{
  const swept = await sweepOrphanedEvalArtifacts(workspaceContexts, evalStore, checkpoints);
  if (swept.removed) {
    console.log(
      `[eval] swept ${swept.removed} orphaned checkpoint artifact(s) from earlier evals, ${fmtBytes(swept.bytesFreed)} freed`,
    );
  }
}

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

// --- deploy -----------------------------------------------------------------
// Control-plane, beside the frozen schema, exactly like the eval and MCP stores. A deploy is
// not an agent run: nothing here goes near `runs`, `steps`, or the trace channel.
//
// The manager gets its dependencies rather than importing them, so it has no idea a WebSocket
// exists — the EvalRunnerDeps shape. Note `token`: a function, not a value, so the credential
// is read from process.env at the moment of use and is never held by the manager.
const deployStore = new DeployStore(store.database());
await deployStore.init();

// The agent list is a table now; the directory is the cache it describes. Reconciled at boot
// and again whenever a generation, an apply or an undo changes what is on disk — those are
// the only three things that do.
const agentRepo = new AgentRepository(store.database());

// THE FILES, AS VERSIONS.
//
// `agents` says which agents exist; this says what each one CONTAINS, at which version, as
// immutable objects. Session 3's whole point: a generation on one replica and the edit that
// follows on another are reading the same bytes, because neither of them is reading a disk.
const projects = new ProjectStore(objects, agentRepo);

// The builder, which now writes a version rather than a directory. Constructed here rather
// than beside the run pool because it needs both of the two things above it: the table that
// says which agents exist, and the store that says what they contain.
const generator = new Generator({ runtimeDir: RUNTIME_DIR, agents: agentRepo, projects });

// The fix loop, for the same reason: an edit reads the current version out of the store and
// applies by publishing the next one.
const editor = new Editor({
  runtimeDir: RUNTIME_DIR,
  agents: agentRepo,
  projects,
  // Pool-aware, not just interactive-aware: an eval job is reading the agent's files from
  // a subprocess right now, and rewriting them mid-flight would make the trace describe
  // code that never ran. `pool.busy` covers every slot.
  canMutate: () =>
    runActive || pool.busy ? "cannot modify the agent while a run is in progress" : null,
});

/**
 * Publish anything on disk that has never been published.
 *
 * Every agent that existed before this session is a directory and nothing else, so the first
 * read through the object store would find an empty project. This is the one-way bridge:
 * disk → objects, once per agent, recorded as `source: "import"` because that is honestly what
 * it is. Idempotent — an agent whose current version is already materialised is skipped — so it
 * runs at every boot and does work only the first time.
 */
async function importAgentFiles(ctx: TenantContext): Promise<void> {
  const connectors = loadConnectors(RUNTIME_DIR);
  for (const agent of await agentRepo.list(ctx)) {
    const dir = join(RUNTIME_DIR, "agents", agent.slug);
    if (!isSafeAgentId(agent.slug) || !existsSync(dir)) continue;
    const connectorFiles = connectors.filter((c) => agent.connectors.includes(c.id)).map((c) => `tools/${c.file}`);
    const onDisk = listProjectFiles(dir, connectorFiles);
    try {
      const result = await projects.importFromDirectory(
        ctx,
        agent.id,
        agent.current_version,
        filesFromDirectory(dir, onDisk.map((f) => f.path)),
      );
      if (result.imported) {
        console.log(`[objects] imported ${agent.slug} as v${result.version} (${onDisk.length} file(s))`);
      }
    } catch (err) {
      // A project that will not import is a project that still runs from disk. Refusing to
      // boot over it would make one unreadable file take the whole server down, and the local
      // path this session is required not to break is exactly the one still reading that disk.
      console.warn(`[objects] could not import ${agent.slug}: ${(err as Error).message}`);
    }
  }
}

async function syncAgents(): Promise<void> {
  // Only the directories that are this workspace's to adopt. See agentFiles.ts.
  const elsewhere = await slugsOwnedElsewhere({ agents: agentRepo, identity: bootIdentity }, serverContext().workspaceId);
  await agentRepo.syncFromDisk(
    serverContext(),
    scanAgentDirectory(RUNTIME_DIR).filter((a) => !elsewhere.has(a.agent_id)).map((a) => ({
      slug: a.agent_id,
      display_name: a.name,
      description: a.description,
      connectors: a.connectors,
      mcp_tools: a.mcp_tools,
      required_env: a.required_env,
      default_provider: a.default_provider,
      hand_written: a.hand_written,
      created_at: a.created_at,
    })),
  );
}
await syncAgents();
await importAgentFiles(serverContext());

// The same reasoning for deploys, with a sharper edge: a deploy in flight was creating real
// resources in the user's Railway account. A row still reading "building" after a restart is
// not building — nothing is watching it — and the honest thing is to say so and point at the
// dashboard, because whatever was already created is still there.
// Per workspace, for the same reason the eval reconciliation is — see above.
for (const stale of (
  await Promise.all(workspaceContexts.map((ctx) => deployStore.reconcileInterrupted(ctx)))
).flat()) {
  console.log(`[deploy] ${stale.id} (${stale.agent_id}) was interrupted by a restart`);
}


const deployDeps: DeployManagerDeps = {
  runtimeDir: RUNTIME_DIR,
  store: deployStore,
  agents: agentRepo,
  projects,
  context: contextForDeploy,
  token: () => process.env[RAILWAY_ENV_KEY],
  // The same pool-aware check the editor uses, and for a sharper version of the reason:
  // deploying WRITES into the project, so doing it while a subprocess is importing those
  // files would change code out from under a run in flight.
  agentBusy: () => runActive || pool.busy,
  onStage: (e) => relay.broadcastDeploy(contextForDeploy(), { type: "stage", ...e }),
  onLog: (e) => relay.broadcastDeploy(contextForDeploy(), { type: "log", ...e }),
  onServeToken: (e) => relay.broadcastDeploy(contextForDeploy(), { type: "serveToken", ...e }),
  onFinished: (d) =>
    relay.broadcastDeploy(contextForDeploy(), {
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
async function deploySnapshot(
  ctx: TenantContext,
): Promise<{ deployments: unknown[]; railwayConfigured: boolean }> {
  return {
    deployments: await deployStore.list(ctx),
    railwayConfigured: Boolean(process.env[RAILWAY_ENV_KEY]),
  };
}

function broadcastDeployments(): void {
  void relay
    .broadcastDeployments()
    .catch((err) => console.error("[deploy] snapshot failed:", (err as Error).message));
}

/**
 * An agent project's files at its current version, connector files flagged read-only.
 *
 * The decision about WHERE that answer may come from is `agentFiles.ts`, not here — it is the
 * one that governs what a workspace may read of an agent's source, and it lived as a closure in
 * this file with a bug nothing could reach.
 */
async function agentProjectFiles(ctx: TenantContext, agentId: string): Promise<ProjectFile[]> {
  if (!isSafeAgentId(agentId)) return [];
  return (await readAgentFiles(agentFilesDeps, ctx, agentId)).files;
}

const agentFilesDeps: AgentFilesDeps = {
  runtimeDir: RUNTIME_DIR,
  agents: agentRepo,
  projects,
  // The read-only set is per project: host-owned files always, plus the connector templates this
  // agent actually has installed. From the row when there is one, and from jaroku.json otherwise,
  // so both paths flag the same files.
  connectorFilesFor: (agent, slug) => {
    const ids = agent?.connectors ?? readDiskConnectors(slug);
    return loadConnectors(RUNTIME_DIR)
      .filter((c) => ids.includes(c.id))
      .map((c) => `tools/${c.file}`);
  },
  serverWorkspaceId: () => serverContext().workspaceId,
  ownedElsewhere: async (slug) =>
    (await slugsOwnedElsewhere({ agents: agentRepo, identity: bootIdentity }, serverContext().workspaceId)).has(slug),
};

/** The connector ids a project's own jaroku.json claims. Only for a project with no row yet. */
function readDiskConnectors(agentId: string): string[] {
  try {
    const meta = JSON.parse(
      readFileSync(join(RUNTIME_DIR, "agents", agentId, "jaroku.json"), "utf8"),
    ) as { connectors?: string[] };
    return meta.connectors ?? [];
  } catch {
    return []; // metadata optional
  }
}

// Graph topology is derived by spawning the isolated `jaroku_runner.graph` entrypoint. It is
// pure with respect to an agent's FILES, so it is cached per agent and version, and a version
// bump — an apply, an undo — is a different cache key rather than an invalidation somebody has
// to remember to perform.
//
// The files it builds from are materialised out of the object store into a temp directory, so a
// replica that has never run this agent answers the graph view identically to the one that
// generated it. That is the Session 3 half. The Python still executes on the control plane;
// moving it into a sandbox is Session 4's, and is why the temp directory exists at all rather
// than the runner being pointed at `runtime/agents/`.
const graphCache = new Map<string, Promise<GraphResult>>();
async function agentGraph(ctx: TenantContext, agentId: string): Promise<GraphResult> {
  if (!isSafeAgentId(agentId)) return { agent_id: agentId, error: "invalid agent id" };
  const agent = await agentRepo.bySlug(ctx, agentId);
  if (!agent) return { agent_id: agentId, error: "no such agent in this workspace" };

  // Keyed by the AGENT UUID and the version, not by the slug: two workspaces may each have a
  // `support_bot`, and one of them must not be shown the other's topology out of a cache.
  const key = `${agent.id}@${agent.current_version}`;
  let pending = graphCache.get(key);
  if (!pending) {
    pending = (async () => {
      const dir = join(tmpdir(), `jaroku-graph-${agent.id}-${agent.current_version}`);
      try {
        const written = await projects.materialise(ctx, agent.id, agent.current_version, dir);
        if (written.includes("agent.py")) return await introspectGraph(RUNTIME_DIR, agentId, dir);
      } catch (err) {
        return { agent_id: agentId, error: `could not read this agent's files: ${(err as Error).message}` };
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }

      // NO FALLBACK TO THE DISK. Same reason as the file list: `runtime/agents/<slug>` belongs
      // to whichever workspace materialised it, and a slug is unique per workspace rather than
      // globally — so building the graph from there would show one tenant the topology of
      // another's agent. Only the workspace this process acts in may read a hand-dropped one.
      if (ctx.workspaceId === serverContext().workspaceId) {
        return await introspectGraph(RUNTIME_DIR, agentId);
      }
      return { agent_id: agentId, error: "this agent has no published version to build a graph from" };
    })();
    // Don't cache a failure — let a later request retry (e.g. after a transient import error).
    void pending.then((r) => {
      if (r.error) graphCache.delete(key);
    });
    graphCache.set(key, pending);
  }
  return pending;
}

// THE HTTP SURFACE.
//
// New in Session 2, and it exists for one structural reason: a browser cannot put an
// `Authorization` header on a WebSocket, so a credential has to be exchanged over HTTP before
// the socket is opened at all. `/healthz` and `/readyz` come along because a process that is
// about to be put behind a load balancer needs to be able to say whether it is alive and
// whether it should be sent traffic, and those are different questions — see http/health.ts.
// Resolved before the router, because the router needs it: the same allowlist decides which
// origins may open a SOCKET and which may read an HTTP RESPONSE. The client is served by Vite
// on another port, so every request it makes here is cross-origin — without this the browser
// blocks the response to the sign-in exchange and the app cannot sign anybody in at all.
const originPolicy = resolveOriginPolicy();
const router = new Router({ cors: originPolicy });
router.get("/healthz", healthz());
router.get(
  "/readyz",
  readyz({ dialect: db.dialect, probe: () => db.get(`SELECT 1 AS ok`) }),
);

// AUTHENTICATION.
//
// Provider-agnostic OIDC: three environment variables point this at Clerk, Auth0, Okta or
// anything else that publishes a JWKS, and nothing in the request path is vendor-specific.
// With none of them set it runs its own issuer instead of skipping verification, so the code
// that authenticates a developer every day is the code that authenticates a user in
// production. See auth/config.ts — it is loud about which of the two it is doing.
const authConfig = resolveAuthConfig(PORT);
const localIssuer =
  authConfig.mode === "local"
    ? new LocalIssuer(
        process.env[AUTH_ENV.devKeyPath] ?? join(SERVER_DIR, ".devauth.json"),
        authConfig.audience,
      )
    : undefined;
const tokenVerifier = new TokenVerifier(authConfig);
const identityRepo = new IdentityRepository(db);
const contextResolver = new ContextResolver({ identity: identityRepo });
// Backed by the database rather than a Map, and rather than Redis. A ticket issued by one
// replica has to be consumable by another, which rules out the Map; and `DELETE … RETURNING`
// against the Postgres already here has exactly the property GETDEL was wanted for. Session 5
// puts Redis behind the same interface when it introduces a client for the queues.
const ticketStore = new DbTicketStore(db);
for (const route of sessionRoutes({
  config: authConfig,
  verifier: tokenVerifier,
  identity: identityRepo,
  localIssuer,
  tickets: ticketStore,
  resolver: contextResolver,
})) {
  if (route.method === "GET") router.get(route.path, route.handler);
  else router.post(route.path, route.handler);
}

// THE OBJECT ROUTE, which is what makes the local store's presigned URLs real.
//
// S3 answers its own URLs; a directory cannot, so the local store's point here. Mounted
// unconditionally rather than only for the `fs` store: `objects` is whichever one was chosen,
// and a deployment on S3 simply never mints a URL that arrives at this path.
//
// `workspaceFor` returns the workspace a request is authenticated for, or null when it presents
// no credential at all. A bad token is a refusal rather than a null — see http/objects.ts for
// why collapsing those two would turn one into access.
for (const route of objectRoutes({
  objects,
  signingKey: objectSigningKey,
  workspaceFor: async (req) => {
    const header = req.header("authorization");
    if (!header) return null;
    const auth = await tokenVerifier.verify(TokenVerifier.bearer(header) ?? "");
    const session = await contextResolver.resolve(
      auth,
      req.url.searchParams.get("workspace"),
      req.requestId,
      req.ip,
    );
    return session.context.workspaceId;
  },
})) {
  router.prefixRoute(route.method, route.prefix, route.handler);
}

const relay = new WsRelay({
  port: PORT,
  store,
  router,
  originPolicy,
  clientHtmlPath: join(SERVER_DIR, "debug-client.html"),
  listAgents: async (ctx) => {
    // One query for the whole list, so the sidebar can show a deploy state per row without
    // N round trips. `deployment` is null for an agent that has never been deployed.
    const deployed = await deployStore.currentByAgent(ctx);
    // `edit_count` is a count of rows now, not of directories under `.history/` — one query
    // for the whole workspace, so the sidebar does not cost a round trip per agent. `runnable`
    // is still "does this project have an agent.py", which the version manifest answers for a
    // published agent and the disk answers for one somebody dropped in by hand.
    const edits = await agentRepo.editCounts(ctx);
    const onDisk = new Map(scanAgentDirectory(RUNTIME_DIR).map((a) => [a.agent_id, a]));
    return (await agentRepo.list(ctx)).map((a) => {
      const d = deployed.get(a.slug);
      return {
        agent_id: a.slug,
        name: a.display_name ?? a.slug,
        description: a.description ?? "",
        connectors: a.connectors,
        mcp_tools: a.mcp_tools,
        required_env: a.required_env,
        default_provider: a.default_provider,
        created_at: a.created_at,
        hand_written: a.hand_written,
        runnable: onDisk.get(a.slug)?.runnable ?? false,
        edit_count: edits.get(a.id) ?? 0,
        deployment: d ? { id: d.id, status: d.status, url: d.url } : null,
      };
    });
  },
  // THE SOCKET'S OWN CONTEXT, resolved when it connected.
  //
  // Session 1 handed every connection the one workspace this process acts in. It now redeems a
  // single-use ticket that an authenticated HTTP request minted after a membership check, so a
  // socket's scope was decided by a `workspace_members` row and cannot be argued with
  // afterwards. `JAROKU_DEV_AUTH=1` is the loud, production-refusing way back to the old
  // behaviour — see auth/socketAuth.ts.
  contextFor: resolveSocketAuth({ tickets: ticketStore, devContext: () => serverContext() }),
  // A SOCKET IS THE ONE THING HERE WITH NO NATURAL EXPIRY.
  //
  // Every HTTP request re-presents its token and is re-checked. A socket is checked once, at
  // the upgrade, and would then run for as long as a browser tab is open — still acting on a
  // membership that may have been revoked in its first ten minutes. This asks again, once a
  // minute, and it is the only thing in the system that ever notices.
  revalidate: async (session) => {
    // The workspace first, because "it is gone" and "you were removed from it" send a client
    // to different places: one reconnects elsewhere, the other signs in again.
    const ctx = systemContext(newRequestId());
    const workspace = await identityRepo.workspaceById(ctx, session.context.workspaceId);
    if (!workspace) return { ok: false, reason: "workspace_gone" };
    // A socket with no user is the JAROKU_DEV_AUTH path or server-side work; there is no
    // membership to re-check, and inventing a failure would close a connection nothing
    // authorised in the first place.
    if (!session.context.actorUserId) return { ok: true, role: session.context.role };
    // Around the cache on purpose — a cached positive is exactly what a revocation has to be
    // seen past. See ContextResolver.stillAMember.
    const role = await contextResolver.stillAMember(session.context, ctx.requestId);
    return role ? { ok: true, role } : { ok: false, reason: "revoked" };
  },
  // These two still read a global directory rather than a scoped table, which is the honest
  // limit of Session 1: runtime/agents/ is one namespace for every workspace, and Session 3's
  // object store is what makes the key itself workspace-scoped. They take the context now so
  // that when the storage moves, the signature does not.
  // An agent's source is read from disk BY ID, so the workspace has to be checked here —
  // the filesystem has no idea who owns what. These were the last two reads that took a
  // context and ignored it; every other one was fixed when the socket's context started
  // being forwarded, and these two were missed because they answer from disk rather than
  // from the database, so nothing about them looked like a query.
  //
  // `bySlug` is the membership check: it is scoped to the caller's workspace, so an agent
  // another tenant owns comes back undefined and this answers empty. Not exploitable across
  // tenants today, because every workspace on a box syncs the same runtime/agents directory
  // at boot and therefore legitimately has a row for each — Session 3 moves the projects to
  // the object store and ends that. It is the shape that matters now: Session 2 hands two
  // workspaces to one process, and on that day this is a client asking for another tenant's
  // generated source code by name and getting it.
  listAgentFiles: async (ctx, agentId) =>
    (await agentRepo.bySlug(ctx, agentId)) ? agentProjectFiles(ctx, agentId) : [],
  getAgentGraph: async (ctx, agentId) =>
    (await agentRepo.bySlug(ctx, agentId))
      ? agentGraph(ctx, agentId)
      : { agent_id: agentId, error: "no such agent in this workspace" },
  listMcpServers: (ctx) => mcpRegistry.list(ctx),
  // By name only. The client learns THAT a key is set, never what it is.
  listProviders: () => providerStatus(),
  // Same: env_keys are names, railwayConfigured is a boolean. No value crosses this.
  listDeployments: (ctx) => deploySnapshot(ctx),
  // THE ASKING SOCKET'S WORKSPACE, forwarded rather than discarded.
  //
  // The relay resolves a context per connection; before this it was thrown away here and
  // every handler reached for the server's own instead. With one workspace the two are the
  // same object, which is exactly why it would have gone unnoticed until it was not.
  onCommand: (cmd: ForwardedCommand, ctx: TenantContext) => {
    if (cmd.cmd === "run") void runAgent(ctx, cmd.input, cmd.provider, cmd.model, cmd.agentId);
    else if (cmd.cmd === "generate") generateAgent(ctx, cmd);
    else if (cmd.cmd === "planAgent") planAgent(ctx, cmd);
    else if (cmd.cmd === "discardPlan") planner.discard(ctx.workspaceId, cmd.planId);
    else if (cmd.cmd === "edit") editAgent(ctx, cmd.agentId, cmd.instruction);
    else if (cmd.cmd === "applyEdit") void editor.apply(ctx, cmd.proposalId);
    else if (cmd.cmd === "undoEdit") void editor.undo(ctx, cmd.agentId);
    else if (cmd.cmd === "discardEdit") void editor.discard(ctx, cmd.proposalId);
    else if (cmd.cmd === "pauseRun") void pauseRun(ctx, cmd.runId);
    else if (cmd.cmd === "resumeRun") void resumeRun(ctx, cmd.runId);
    else if (cmd.cmd === "branchRun") void branchRun(ctx, cmd.fromRunId, cmd.atSeq, cmd.editNode, cmd.editedState);
    else if (cmd.cmd === "explain") explainAgent(ctx, cmd);
    else if (MCP_COMMAND_NAMES.has(cmd.cmd)) void handleMcpCommand(ctx, cmd as McpCommand);
    else if (DEPLOY_COMMAND_NAMES.has(cmd.cmd)) void handleDeployCommand(ctx, cmd as DeployChannelCommand);
    else if (PROVIDER_COMMAND_NAMES.has(cmd.cmd)) void handleProviderCommand(ctx, cmd as ProviderCommand);
    else if (MEMBER_COMMAND_NAMES.has(cmd.cmd)) void handleMemberCommand(ctx, cmd as MemberCommand);
    else void handleEvalCommand(ctx, cmd);
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
  onScored: (e) => relay.broadcastEval(contextForEval(e.evalId), { type: "scored", ...e }),
  onScoringFinished: (e) => {
    console.log(`[eval] ${e.evalId} scoring done — ${e.scored} scored, ${e.unscored} unscored`);
    relay.broadcastEval(contextForEval(e.evalId), { type: "scoringFinished", ...e });
  },
});

evalRunner = new EvalRunner({
  pool,
  store,
  evalStore,
  // One eval runs at a time, so this is the eval in flight.
  context: () => contextForEval(evalRunner?.activeEvalIds()[0] ?? ""),
  // ...which only answers once the eval has a workspace recorded against it. The runner does
  // that itself, between the eval becoming live and its first job, because nothing outside
  // knows the id before then.
  bindWorkspace: (evalId, ctx) => evalWorkspaces.set(evalId, ctx),
  runtimeDir: RUNTIME_DIR,
  // An eval job's run persists like any other but stays off the live "trace" channel.
  markEvalRun: (runId, isEval) => {
    if (isEval) evalRunIds.add(runId);
    else evalRunIds.delete(runId);
  },
  onStarted: (e) => relay.broadcastEval(contextForEval(e.evalId), { type: "evalStarted", ...e }),
  onProgress: (p) => relay.broadcastEval(contextForEval(p.evalId), { type: "evalProgress", ...p }),
  // Score as results land rather than in a batch at the end, so the quality column fills in
  // alongside the rest of the row instead of appearing all at once minutes later.
  onJobFinished: (job) => judge.enqueue(job.eval_id, job),
  onFinished: (e) => {
    relay.broadcastEval(contextForEval(e.evalId), { type: "evalFinished", ...e });
    // The eval's runs are now in history like any other; refresh so drill-down can reach
    // them without a reconnect.
    void relay.broadcastHistory();
    // No more jobs are coming: the judge reports done once its own queue drains.
    judge.seal(e.evalId);
    // Sweep the resumable-checkpoint blobs these runs left behind. The traces stay —
    // only the pause/resume machinery goes, and nobody resumes a finished eval job.
    void sweepEvalArtifacts(contextForEval(e.evalId), evalStore, checkpoints, e.evalId).then((swept) => {
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
  /**
   * The workspace whose run is blocked.
   *
   * Recorded when the ask is raised, so answering it can be checked against who is answering.
   * `resolveMcpConfirm` carries a run id and a nonce and nothing else — and what it does is
   * approve a tool call the registry classified as high-impact, in a run belonging to whoever
   * started it. Without this, holding those two strings was the whole of the authorisation.
   */
  workspaceId: string;
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
    relay.broadcastMcp(contextForRun(p.runId), { type: "confirmResolved", runId: p.runId, nonce: p.nonce, verdict: reason });
  }
}

function broadcastMcpServers(): void {
  void relay
    .broadcastMcpServers()
    .catch((err) => console.error("[mcp] snapshot failed:", (err as Error).message));
}

async function handleMcpCommand(ctx: TenantContext, cmd: McpCommand): Promise<void> {
  try {
    switch (cmd.cmd) {
      case "addMcpServer": {
        if (typeof cmd.endpoint !== "string" || !cmd.endpoint.trim()) {
          relay.broadcastMcp(ctx, { type: "error", message: "an endpoint is required" });
          return;
        }
        // A handshake against someone else's server takes as long as it takes. Saying so
        // is the difference between "connecting" and "the button did nothing".
        relay.broadcastMcp(ctx, { type: "discovering", serverId: null, endpoint: cmd.endpoint });
        const added = await mcpRegistry.addServer(ctx, {
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
          relay.broadcastMcp(ctx, { type: "error", message: added.message, ...(added.server ? { serverId: added.server.id } : {}) });
        } else if (added.message && added.server) {
          relay.broadcastMcp(ctx, { type: "notice", message: added.message, serverId: added.server.id });
        }
        return;
      }

      case "rediscoverMcpServer": {
        if (typeof cmd.serverId !== "string") return;
        relay.broadcastMcp(ctx, {
          type: "discovering",
          serverId: cmd.serverId,
          endpoint: (await mcpRegistry.get(ctx, cmd.serverId))?.endpoint ?? "",
        });
        const res = await mcpRegistry.rediscover(ctx, cmd.serverId);
        console.log(
          `[mcp] rediscover ${cmd.serverId} — ${res.ok ? `${res.server?.tools.length ?? 0} tool(s)` : `failed: ${res.server?.status ?? "unknown"}`}`,
        );
        broadcastMcpServers();
        if (!res.ok && res.message) {
          relay.broadcastMcp(ctx, { type: "error", message: res.message, serverId: cmd.serverId });
        } else if (res.message) {
          relay.broadcastMcp(ctx, { type: "notice", message: res.message, serverId: cmd.serverId });
        }
        return;
      }

      case "removeMcpServer": {
        if (typeof cmd.serverId !== "string") return;
        const removed = await mcpRegistry.removeServer(ctx, cmd.serverId);
        if (removed) console.log(`[mcp] removed ${cmd.serverId}`);
        broadcastMcpServers();
        if (!removed) {
          relay.broadcastMcp(ctx, { type: "error", message: `no server called "${cmd.serverId}"` });
        }
        return;
      }

      case "resolveMcpConfirm": {
        if (typeof cmd.runId !== "string" || typeof cmd.nonce !== "string") return;
        const verdict = cmd.verdict === "once" || cmd.verdict === "run" ? cmd.verdict : "deny";
        const key = confirmKey(cmd.runId, cmd.nonce);
        const pending = pendingConfirms.get(key);
        // An ask belonging to another workspace answers exactly as an absent one does. Same
        // message on purpose: a different answer would tell somebody holding a run id and a
        // nonce that they had guessed a real pair.
        if (!pending || pending.workspaceId !== ctx.workspaceId) {
          // Already answered, timed out, or the run died. Saying so beats silence: two
          // people clicking the same modal should not both think they decided it.
          relay.broadcastMcp(ctx, {
            type: "error",
            message: "that confirmation is no longer waiting — the run moved on without it",
          });
          return;
        }
        pendingConfirms.delete(key);
        writeApproval(cmd.runId, cmd.nonce, verdict);
        console.log(`[mcp] ${pending.server}/${pending.tool} — ${verdict}`);
        relay.broadcastMcp(ctx, { type: "confirmResolved", runId: cmd.runId, nonce: cmd.nonce, verdict });
        return;
      }

      case "setMcpServerAuth": {
        if (typeof cmd.serverId !== "string") return;
        const token = typeof cmd.token === "string" && cmd.token.length ? cmd.token : null;
        const { result, warning } = await mcpRegistry.setCredential(ctx, cmd.serverId, token);
        if (!result.ok) {
          relay.broadcastMcp(ctx, { type: "error", message: result.message ?? "could not store the credential", serverId: cmd.serverId });
          return;
        }
        // Log that a credential changed, never which value it changed to.
        console.log(`[mcp] ${cmd.serverId} credential ${token ? "set" : "cleared"}`);
        // A stored credential is only useful if it works, so prove it immediately rather
        // than leaving the server sitting in auth_required until someone clicks refresh.
        relay.broadcastMcp(ctx, { type: "discovering", serverId: cmd.serverId, endpoint: result.server?.endpoint ?? "" });
        const retried = await mcpRegistry.rediscover(ctx, cmd.serverId);
        broadcastMcpServers();
        if (warning) relay.broadcastMcp(ctx, { type: "notice", message: warning, serverId: cmd.serverId });
        if (!retried.ok && retried.message) {
          relay.broadcastMcp(ctx, { type: "error", message: retried.message, serverId: cmd.serverId });
        }
        return;
      }

      case "setMcpToolImpact": {
        if (typeof cmd.serverId !== "string" || typeof cmd.toolName !== "string") return;
        const impact = cmd.impact === "high" || cmd.impact === "low" ? cmd.impact : null;
        const updated = await mcpRegistry.setToolImpact(ctx, cmd.serverId, cmd.toolName, impact);
        if (!updated) {
          relay.broadcastMcp(ctx, {
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
    relay.broadcastMcp(ctx, { type: "error", message: `${cmd.cmd} failed: ${message}` });
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

function broadcastProviders(ctx: TenantContext): void {
  relay.broadcastProviders(ctx, { type: "providers", providers: providerStatus() });
}

async function handleProviderCommand(ctx: TenantContext, cmd: ProviderCommand): Promise<void> {
  try {
    if (!isProviderId(cmd.provider)) {
      // Named rather than echoed: `cmd.provider` is client-supplied and about to be rendered.
      relay.broadcastProviders(ctx, {
        type: "error",
        message: `"${String(cmd.provider).slice(0, 32)}" is not a provider you can connect — expected anthropic or openai`,
      });
      return;
    }
    const provider = cmd.provider;
    const key = typeof cmd.key === "string" ? cmd.key.trim() : "";
    if (!key) {
      relay.broadcastProviders(ctx, { type: "error", message: "no key was entered", provider });
      return;
    }

    if (cmd.cmd === "testProviderKey") {
      const result = await verifyProviderKey(provider, key);
      // The outcome, never the input. A failure message comes from the provider and names the
      // status, not the credential.
      console.log(`[providers] ${provider} key tested — ${result.ok ? "ok" : "rejected"}`);
      relay.broadcastProviders(ctx, { type: "testResult", provider, ok: result.ok, message: result.message });
      return;
    }

    // setProviderKey. Straight through the one credential writer — the value is used by
    // `set` and nowhere else in this function.
    const written = credentials.set(PROVIDER_ENV_KEY[provider], key);
    if (!written.ok) {
      relay.broadcastProviders(ctx, {
        type: "error",
        message: written.warning ?? "could not store that key",
        provider,
      });
      return;
    }
    // Names only, exactly as loadRuntimeEnv logs them on the way in.
    console.log(`[providers] ${provider} key set (${PROVIDER_ENV_KEY[provider]})`);
    broadcastProviders(ctx);
    // A key shadowed by the server's own shell works now and reverts on restart. Saying so is
    // the difference between a puzzling regression tomorrow and a sentence today.
    if (written.warning) {
      relay.broadcastProviders(ctx, { type: "notice", message: written.warning, provider });
    }
  } catch (err) {
    const message = (err as Error)?.message ?? String(err);
    console.error(`[providers] ${cmd.cmd} failed: ${message}`);
    relay.broadcastProviders(ctx, { type: "error", message: `${cmd.cmd} failed: ${message}` });
  }
}

// --- membership: commands ---------------------------------------------------
//
// Who may act in this workspace, and as what. Every mutation here writes an `audit_log` row
// inside the same transaction that makes the change — the repository does it, so there is no
// path that alters membership without a record of who did it.
//
// The invite LINK is the only credential this file ever sends a browser besides the deploy
// bearer token, and it takes the same shape for the same reason: there is no email sender in
// this product, only a hash is stored, so the one message that carries it is the only chance
// anybody has to see it. It goes to the socket that asked, not to the workspace — broadcasting
// it would hand the link to every admin with a tab open.

const MEMBER_COMMAND_NAMES = new Set([
  "listMembers", "inviteMember", "revokeInvite", "setMemberRole", "removeMember",
]);

async function broadcastMembers(ctx: TenantContext): Promise<void> {
  const [members, invites] = await Promise.all([
    identityRepo.listMembers(ctx),
    identityRepo.listInvites(ctx),
  ]);
  relay.broadcastMembers(ctx, { type: "members", members, invites });
}

async function handleMemberCommand(ctx: TenantContext, cmd: MemberCommand): Promise<void> {
  try {
    if (cmd.cmd === "listMembers") {
      await broadcastMembers(ctx);
      return;
    }

    if (cmd.cmd === "inviteMember") {
      const role = cmd.role;
      if (!isMemberRole(role)) {
        relay.broadcastMembers(ctx, {
          type: "error",
          message: `"${String(role).slice(0, 24)}" is not a role — expected owner, admin or member`,
        });
        return;
      }
      const result = await identityRepo.createInvite(ctx, { email: String(cmd.email ?? ""), role });
      if ("error" in result) {
        relay.broadcastMembers(ctx, { type: "error", message: result.error });
        return;
      }
      console.log(`[members] invited ${result.invite.email} as ${role}`);
      // To the asking socket only. It is a credential.
      relay.sendMembers(ctx, ctx.requestId, {
        type: "inviteLink",
        email: result.invite.email,
        role,
        token: result.token,
        expiresAt: result.invite.expires_at,
      });
      await broadcastMembers(ctx);
      return;
    }

    if (cmd.cmd === "revokeInvite") {
      const ok = await identityRepo.revokeInvite(ctx, String(cmd.inviteId ?? ""));
      if (!ok) {
        relay.broadcastMembers(ctx, { type: "error", message: "that invitation is already gone" });
        return;
      }
      await broadcastMembers(ctx);
      return;
    }

    if (cmd.cmd === "setMemberRole") {
      const role = cmd.role;
      if (!isMemberRole(role)) {
        relay.broadcastMembers(ctx, { type: "error", message: `"${String(role).slice(0, 24)}" is not a role` });
        return;
      }
      const result = await identityRepo.setMemberRole(ctx, String(cmd.userId ?? ""), role);
      if (!result.ok) {
        relay.broadcastMembers(ctx, { type: "error", message: result.reason ?? "could not change that role" });
        return;
      }
      // The membership cache is what every later request reads, and it holds positives for
      // thirty seconds. Exact here rather than waiting it out: a demotion that takes half a
      // minute to bite is a demotion that did not happen when somebody pressed the button.
      contextResolver.invalidate(ctx.workspaceId, String(cmd.userId));
      await broadcastMembers(ctx);
      // ...and the sockets that user already has open pick the new role up on the next
      // revalidation tick, in place, without being disconnected. See relay.revalidateAll.
      return;
    }

    if (cmd.cmd === "removeMember") {
      const userId = String(cmd.userId ?? "");
      const result = await identityRepo.removeMember(ctx, userId);
      if (!result.ok) {
        relay.broadcastMembers(ctx, { type: "error", message: result.reason ?? "could not remove that member" });
        return;
      }
      contextResolver.invalidate(ctx.workspaceId, userId);
      // Their outstanding tickets die with the membership. A ticket minted a second before the
      // removal is otherwise good for another thirty seconds — a small window, and one that
      // opens a socket which then lives until the next revalidation tick.
      await ticketStore.revoke(ctx.workspaceId, userId);
      console.log(`[members] removed ${userId} from ${ctx.workspaceId}`);
      await broadcastMembers(ctx);
      return;
    }
  } catch (err) {
    const message = (err as Error)?.message ?? String(err);
    console.error(`[members] ${cmd.cmd} failed: ${message}`);
    relay.broadcastMembers(ctx, { type: "error", message: `${cmd.cmd} failed: ${message}` });
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

async function handleDeployCommand(ctx: TenantContext, cmd: DeployChannelCommand): Promise<void> {
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
          relay.broadcastDeploy(ctx, { type: "error", message: "no token was entered" });
          return;
        }
        const written = credentials.set(RAILWAY_ENV_KEY, token);
        if (!written.ok) {
          relay.broadcastDeploy(ctx, { type: "error", message: written.warning ?? "could not store that token" });
          return;
        }
        console.log(`[deploy] Railway token set (${RAILWAY_ENV_KEY})`);
        broadcastDeployments();
        if (written.warning) relay.broadcastDeploy(ctx, { type: "notice", message: written.warning });
        return;
      }

      case "testRailwayToken": {
        // Writes nothing, by design — see TestRailwayTokenCommand.
        const token = typeof cmd.token === "string" ? cmd.token.trim() : "";
        if (!token) {
          relay.broadcastDeploy(ctx, { type: "testResult", ok: false, message: "no token was entered" });
          return;
        }
        try {
          const { projectCount } = await new RailwayApi({ token }).verify();
          console.log("[deploy] Railway token tested — ok");
          relay.broadcastDeploy(ctx, {
            type: "testResult",
            ok: true,
            message: projectCount ? "connected" : "connected — no projects yet",
          });
        } catch (err) {
          const detail = err instanceof RailwayError ? err.message : String(err);
          console.log("[deploy] Railway token tested — rejected");
          relay.broadcastDeploy(ctx, { type: "testResult", ok: false, message: detail });
        }
        return;
      }

      case "planDeploy": {
        if (!isSafeAgentId(cmd.agentId)) {
          relay.broadcastDeploy(ctx, { type: "error", message: "invalid agent id" });
          return;
        }
        const plan = await planDeploy(deployDeps, {
          agentId: cmd.agentId,
          provider: typeof cmd.provider === "string" ? cmd.provider : "",
          model: typeof cmd.model === "string" ? cmd.model : "",
          envKeys: [],
        });
        relay.broadcastDeploy(ctx, {
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
          relay.broadcastDeploy(ctx, { type: "error", message: "invalid agent id" });
          return;
        }
        if (deployManager.busy) {
          relay.broadcastDeploy(ctx, { type: "error", message: "a deploy is already running" });
          return;
        }
        // Claimed only now that the deploy is certain to start. Assigned before these guards, a
        // REFUSED deploy redirected the running one's build log — scrubbed of secrets, but
        // still another workspace's build output — into the refuser's deploy panel.
        deployContext = ctx;
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
        if ("error" in result) relay.broadcastDeploy(ctx, { type: "error", message: result.error });
        return;
      }

      case "cancelDeploy": {
        const target = deploymentIdOf(cmd.deploymentId);
        if (!target) {
          relay.broadcastDeploy(ctx, { type: "error", message: "no deployment id to cancel" });
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
          relay.broadcastDeploy(ctx, { type: "error", message: "no deployment id to forget" });
          return;
        }
        const row = await deployStore.get(ctx, target);
        if (!row) {
          relay.broadcastDeploy(ctx, { type: "error", message: "no such deployment" });
          return;
        }
        if (deployManager.activeId === target) {
          relay.broadcastDeploy(ctx, { type: "error", message: "that deploy is still running — cancel it first" });
          return;
        }
        await deployStore.patch(ctx, target, { status: "removed" });
        broadcastDeployments();
        void relay.broadcastAgents();
        relay.broadcastDeploy(ctx, {
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
        relay.broadcastDeploy(ctx, {
          type: "logs",
          deploymentId: target,
          lines: await deployStore.logs(ctx, target, since),
        });
        return;
      }
    }
  } catch (err) {
    const message = (err as Error)?.message ?? String(err);
    console.error(`[deploy] ${cmd.cmd} failed: ${message}`);
    relay.broadcastDeploy(ctx, { type: "error", message: `${cmd.cmd} failed: ${message}` });
  }
}

// --- eval: dataset CRUD -----------------------------------------------------
// Control-plane only. Every mutation answers by re-broadcasting the affected snapshot on
// the "eval" channel, the same shape a fresh `listDatasets` would return — so a client
// never has to reconcile a partial update against local state.

async function broadcastDatasets(ctx: TenantContext, agentId: string | null): Promise<void> {
  relay.broadcastEval(ctx, {
    type: "datasets",
    agentId,
    datasets: await evalStore.listDatasets(ctx, agentId ?? undefined),
  });
}

async function broadcastDataset(ctx: TenantContext, datasetId: string): Promise<void> {
  relay.broadcastEval(ctx, {
    type: "dataset",
    datasetId,
    examples: await evalStore.listExamples(ctx, datasetId),
  });
}

async function handleEvalCommand(ctx: TenantContext, cmd: ForwardedCommand): Promise<void> {
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
        relay.broadcastEval(ctx, { type: "datasetDeleted", datasetId: cmd.datasetId });
        await broadcastDatasets(ctx, cmd.agentId);
        return;
      }
      case "addExample": {
        // An empty input would be a run with nothing to do — reject it here rather than
        // let it become a job that burns a real API call on whitespace.
        const input = (cmd.input ?? "").trim();
        if (!input) {
          relay.broadcastEval(ctx, { type: "error", datasetId: cmd.datasetId, message: "an example needs an input" });
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
          relay.broadcastEval(ctx, { type: "error", message: "an eval is already running" });
          return;
        }
        // Same reason as runAgent: this id ends up as the working directory of every job's
        // subprocess. Refusing it here also keeps a whole eval run and its jobs from being
        // written for an agent that cannot exist.
        if (!isSafeAgentId(cmd.agentId ?? "")) {
          relay.broadcastEval(ctx, { type: "error", message: `invalid agent id: ${cmd.agentId}` });
          return;
        }
        // Recorded before dispatch: its progress arrives on callbacks that have no context
        // of their own, and it belongs to whoever pressed the button.
        const started = await evalRunner.start({
          ctx,
          datasetId: cmd.datasetId,
          agentId: cmd.agentId,
          rubricId: await rubricIdFor(ctx, cmd.datasetId),
          targets: cmd.targets ?? [],
          budgetUsd: cmd.budgetUsd ?? null,
        });
        // The workspace was bound inside `start`, before the first job — see bindWorkspace.
        // Binding it here, on the way back, left a window in which the eval was already
        // dispatching and `contextForEval` still answered with the server's workspace.
        if ("error" in started) relay.broadcastEval(ctx, { type: "error", message: started.error });
        return;
      }
      case "cancelEval": {
        await evalRunner.cancel(cmd.evalId);
        return;
      }
      case "estimateEval": {
        relay.broadcastEval(ctx, {
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
          relay.broadcastEval(ctx, { type: "error", message: "unknown eval" });
          return;
        }
        relay.broadcastEval(ctx, { type: "evalResults", evalId: cmd.evalId, results });
        return;
      }
      case "listEvals": {
        const all = await evalStore.listEvalRuns(ctx);
        relay.broadcastEval(ctx, {
          type: "evals",
          evals: cmd.datasetId ? all.filter((e) => e.dataset_id === cmd.datasetId) : all,
        });
        return;
      }
      case "loadRubric": {
        const r = await rubricFor(ctx, cmd.datasetId);
        relay.broadcastEval(ctx, {
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
          relay.broadcastEval(ctx, { type: "error", message: "a rubric needs at least one criterion" });
          return;
        }
        if (!criteria.some((c) => c.weight > 0)) {
          relay.broadcastEval(ctx, { type: "error", message: "a rubric needs at least one criterion with weight above zero" });
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
        relay.broadcastEval(ctx, { type: "rubric", datasetId: cmd.datasetId, rubric: saved, isDefault: false });
        return;
      }
      case "promoteTestInput": {
        const input = (cmd.input ?? "").trim();
        if (!input) {
          relay.broadcastEval(ctx, { type: "error", message: "nothing to promote — the test input is empty" });
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
        relay.broadcastEval(ctx, { type: "promoted", datasetId: ds.id, datasetName: ds.name, duplicate });
        await broadcastDatasets(ctx, cmd.agentId);
        await broadcastDataset(ctx, ds.id);
        return;
      }
    }
  } catch (err) {
    const message = (err as Error).message;
    console.error(`[eval] ${cmd.cmd} failed:`, message);
    relay.broadcastEval(ctx, { type: "error", message: `${cmd.cmd} failed: ${message}` });
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
  // The workspace of whoever asked for this run — recorded at dispatch, not read from
  // whatever context is nearest. A run's events arrive minutes after the command that
  // started it, and they belong to the person who started it.
  const runCtx = contextForRun(runId);
  ingest(async () => {
    // Persist first (source of truth), then broadcast to live clients. A persist failure is
    // logged and the event still goes out — the client showing a step the database lost is
    // better than the client showing nothing and no one knowing why.
    try {
      if (event.kind === "run_start" || event.kind === "run_end") {
        await store.upsertRun(runCtx, event.run);
      } else if (event.kind === "step") {
        await store.insertStep(runCtx, event.step);
      }
    } catch (err) {
      console.error("[store] failed to persist event:", (err as Error).message);
    }
    if (!isEvalRun(runId)) relay.broadcastTrace(runCtx, event);
  });
});

pool.on("parseError", ({ runId, line, error }) => {
  console.error(`[manager] non-event stdout line (${error}):`, line.slice(0, 200));
  if (!isEvalRun(runId)) relay.broadcastLog(contextForRun(runId), "parseError", `${error}: ${line.slice(0, 200)}`);
});

pool.on("stderr", ({ runId, line }) => {
  console.error("[agent]", line);
  // An agent's stderr is its workspace's: it can carry a stack trace over the user's own data.
  if (!isEvalRun(runId)) relay.broadcastLog(contextForRun(runId), "stderr", line);
});

// Debug-depth control events (off the trace stream). A `boundary` correlates the durable
// checkpoint to the steps it covers (for later branching); a `paused` flips the run to the
// store-only 'paused' status so history shows it as resumable, without any run_end.
pool.on("control", ({ runId: slotRunId, ctrl }) => {
  // THE RUN IS THE SLOT'S, NOT THE LINE'S.
  //
  // This used to read `ctrl.run_id` — a field in text a subprocess printed — and every branch
  // below then acted in `contextForRun` of it. Agent code is model-written and user-editable,
  // and its stdout is this parser's input, so a single crafted control line let one run reach
  // into another workspace: `paused` flipped somebody else's run's status, `boundary` rewrote
  // the checkpoint pointer their branching depends on, and `tool_confirm` put a modal with
  // attacker-chosen server, tool and argument text in front of another tenant.
  //
  // The pool already attributes every line to the slot that produced it, which is how the
  // event path has always been safe (see runPool.makeSlot). The two now agree. A line whose
  // own id disagrees is a forgery or a runner bug; either way it is dropped and said out loud,
  // because a legitimate one always matches — a resume and a branch both run under the id the
  // slot was started with.
  const claimed = typeof ctrl.run_id === "string" ? ctrl.run_id : null;
  if (claimed && claimed !== slotRunId) {
    console.warn(
      `[debug] dropped a control line from run ${slotRunId} claiming to be run ${claimed}`,
    );
    return;
  }
  const runId = slotRunId;
  if (!runId) return;
  const seqHigh = typeof ctrl.seq_high === "number" ? ctrl.seq_high : -1;
  const checkpointId = typeof ctrl.checkpoint_id === "string" ? ctrl.checkpoint_id : null;
  const next = Array.isArray(ctrl.next) ? (ctrl.next as string[]) : [];
  const runCtx = contextForRun(runId);
  try {
    if (ctrl.ctrl === "boundary") {
      // On the ingest chain, behind the steps this stamps. A boundary that overtook them
      // would stamp nothing, and the run would silently stop being branchable.
      ingest(async () => {
        if (checkpointId && seqHigh >= 0) {
          await store.setCheckpointUpto(runCtx, runId, seqHigh, checkpointId);
        }
        relay.broadcastDebug(runCtx, { type: "boundary", runId, seq: seqHigh, next });
      });
    } else if (ctrl.ctrl === "paused") {
      // The id is recorded immediately — resume reads it, and a pause the process does not
      // know about yet is a pause the user cannot undo. Only the status write is queued.
      pausedRunId = runId;
      ingest(async () => {
        await store.setRunStatus(runCtx, runId, "paused");
        relay.broadcastDebug(runCtx, { type: "paused", runId, seq: seqHigh });
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
        runId, workspaceId: runCtx.workspaceId, nonce, server, tool, requestedAt: Date.now(),
      });
      console.log(`[mcp] ${runId} is waiting for confirmation of ${server}/${tool}`);
      relay.broadcastMcp(runCtx, {
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
  // A paused run is coming back — resume re-registers it, and dropping it here would send
  // the resumed segment's events to the server's workspace instead of its own.
  if (runId !== pausedRunId) runWorkspaces.delete(runId);
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
planner.on("started", (e) => relay.broadcastGen(contextForPlan(), { type: "plan_started", ...e }));
planner.on("delta", (e) => relay.broadcastGen(contextForPlan(), { type: "plan_delta", ...e }));
planner.on("discarded", (e) => relay.broadcastGen(contextForPlan(), { type: "plan_discarded", ...e }));

planner.on("plan", (e) => {
  const usage = e.usage as { cost_usd?: number; output_tokens?: number };
  console.log(
    `[plan] ${e.planId} (rev ${e.revision}) — ${e.plan.tools.length} tool(s), ` +
      `${e.warnings.length} warning(s), ${usage?.output_tokens ?? 0} output tokens, ` +
      `$${(usage?.cost_usd ?? 0).toFixed(5)}`,
  );
  for (const w of e.warnings) console.log(`  ! ${w}`);
  relay.broadcastGen(contextForPlan(), { type: "plan", ...e });
});

planner.on("error", (e) => {
  console.error(`[plan] failed: ${e.message}`);
  relay.broadcastGen(contextForPlan(), { type: "plan_error", message: e.message });
});

async function planAgent(ctx: TenantContext, cmd: PlanAgentCommand): Promise<void> {
  // A generation in flight owns the pipeline; planning the next agent mid-build would put two
  // plans and one generation on the same single-slot state.
  //
  // REFUSED TO THE ASKER, and the plan scope is not touched: a refusal belongs to whoever
  // asked, and repointing the scope here would send the in-flight plan's remaining deltas to
  // them instead of to the workspace that started it.
  if (generating) {
    relay.broadcastGen(ctx, { type: "plan_error", message: "a generation is already in progress" });
    return;
  }
  if (planner.inFlight) {
    relay.broadcastGen(ctx, { type: "plan_error", message: "a plan is already being written" });
    return;
  }
  planContext = ctx;
  console.log(
    `[plan] planning${cmd.revisePlanId ? " (revision)" : ""} — "${cmd.prompt.slice(0, 80)}"`,
  );
  void planner.plan({
    runtimeDir: RUNTIME_DIR,
    workspaceId: ctx.workspaceId,
    prompt: cmd.prompt,
    connectors: cmd.connectors,
    // Resolved here rather than in the planner, so the planner keeps its single dependency
    // on the connector catalogue. Refs naming a server or tool that has since gone away
    // resolve to nothing rather than to a guess — the same posture as resolveSelected.
    mcpTools: await mcpRegistry.resolve(ctx, cmd.mcpTools ?? []),
    name: cmd.name,
    revisePlanId: cmd.revisePlanId,
  });
}

// --- generation -------------------------------------------------------------
// Streams into the "gen" channel. Nothing here touches the trace store or the frozen
// event schema; a generation and a run are independent concerns that share only a socket.
let generating = false;

async function generateAgent(ctx: TenantContext, cmd: GenerateCommand): Promise<void> {
  if (generating) {
    // On the planned path this must NOT be the plain "error" member: that one paints the
    // build pane as a failed generation, and the pending plan is still perfectly good. The
    // check also comes before take(), so a refused click doesn't spend the plan.
    //
    // Answered to `ctx` — the asker — and NOT via the generation scope, which still belongs to
    // the workspace whose build is running. This refusal repointing that scope is precisely
    // how one tenant's generated source ended up streaming into another's build pane.
    if (cmd.planId) {
      relay.broadcastGen(ctx, {
        type: "plan_error",
        message: "a generation is already in progress — this plan is still here when it finishes",
      });
    } else {
      relay.broadcastGen(ctx, { type: "error", message: "a generation is already in progress" });
    }
    return;
  }
  genContext = ctx;

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
    const rec = planner.peek(ctx.workspaceId);
    if (!rec || rec.planId !== cmd.planId) {
      // Never fall through to an unplanned generation here. The user approved a specific
      // plan; quietly building something they never reviewed is the exact failure this gate
      // exists to prevent.
      relay.broadcastGen(contextForGen(), {
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
      relay.broadcastGen(contextForGen(), {
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
      (await mcpRegistry.resolve(ctx, approvedRefs)).map((t) => `${t.server_id}/${t.name}`),
    );
    const goneMcp = approvedRefs.filter((r) => !stillThere.has(r));
    if (goneMcp.length) {
      relay.broadcastGen(contextForGen(), {
        type: "plan_error",
        message:
          `the plan uses the MCP tool${goneMcp.length > 1 ? "s" : ""} ${goneMcp.join(", ")}, which ` +
          `${goneMcp.length > 1 ? "are" : "is"} no longer available — reconnect the server, or ` +
          `say what you want and it will be re-planned`,
      });
      return;
    }

    planner.take(ctx.workspaceId, cmd.planId); // spend it: this generation is now certain to start
    ({ prompt, connectors, name } = rec);
    mcpRefs = approvedRefs;
    plan = rec.plan.raw;
    planUsage = rec.usage;
  }

  generating = true;
  console.log(`[gen] generating${plan ? " from an approved plan" : ""} — "${prompt.slice(0, 80)}"`);
  relay.broadcastGen(contextForGen(), { type: "started", prompt });

  const onStart = (e: { path: string }) => relay.broadcastGen(contextForGen(), { type: "file_start", ...e });
  const onDelta = (e: { path: string; text: string }) => relay.broadcastGen(contextForGen(), { type: "file_delta", ...e });
  const onEnd = (e: { path: string }) => relay.broadcastGen(contextForGen(), { type: "file_end", ...e });

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
    relay.broadcastGen(contextForGen(), { type: "done", ...e });
    void syncAgents().then(() => relay.broadcastAgents());
    cleanup();
  };

  const onError = (e: { message: string; problems?: string[] }) => {
    console.error(`[gen] failed: ${e.message}`);
    for (const p of e.problems ?? []) console.error(`  - ${p}`);
    relay.broadcastGen(contextForGen(), { type: "error", ...e });
    cleanup();
  };

  generator.on("file_start", onStart);
  generator.on("file_delta", onDelta);
  generator.on("file_end", onEnd);
  generator.once("done", onDone);
  generator.once("error", onError);

  // Resolved fresh at build time, so the manifest carries the schemas and impact ratings as
  // they stand now rather than as they stood when the plan was written.
  const genCtx = ctx;
  const mcpTools = await mcpRegistry.resolve(genCtx, mcpRefs);
  const mcpServers = await mcpRegistry.list(genCtx);
  void generator.generate({
    runtimeDir: RUNTIME_DIR, ctx: genCtx, prompt, connectors, mcpTools, mcpServers, name, plan, planUsage,
  });
}

// --- editing (fix loop) -----------------------------------------------------
// Streams into the "edit" channel. Like generation, nothing here touches the trace store
// or the frozen event schema. Listeners are permanent — every event carries its ids.
editor.on("file_start", (e) => relay.broadcastEdit(contextForEdit(), { type: "file_start", ...e }));
editor.on("file_delta", (e) => relay.broadcastEdit(contextForEdit(), { type: "file_delta", ...e }));
editor.on("file_end", (e) => relay.broadcastEdit(contextForEdit(), { type: "file_end", ...e }));

editor.on("proposal", (e) => {
  console.log(
    `[edit] proposal for ${e.agentId} — ${e.files.length} file(s): ${e.summary}`,
  );
  relay.broadcastEdit(contextForEdit(), { type: "proposal", ...e });
});

editor.on("applied", (e) => {
  console.log(`[edit] applied v${e.version} to ${e.agentId}: ${e.summary}`);
  relay.broadcastEdit(contextForEdit(), { type: "applied", ...e });
  void syncAgents().then(() => relay.broadcastAgents());
  relay.broadcastAgentFiles(contextForEdit(), e.agentId);
  // An edit changed the version, and the graph cache is keyed by it — so there is nothing to
  // invalidate, and re-pushing simply builds the new one.
  void relay.broadcastAgentGraph(contextForEdit(), e.agentId);
});

editor.on("undone", (e) => {
  console.log(`[edit] undid v${e.version} on ${e.agentId}`);
  relay.broadcastEdit(contextForEdit(), { type: "undone", ...e });
  void syncAgents().then(() => relay.broadcastAgents());
  relay.broadcastAgentFiles(contextForEdit(), e.agentId);
  // Same as apply: the pointer moved, so the cache key did too.
  void relay.broadcastAgentGraph(contextForEdit(), e.agentId);
});

editor.on("discarded", (e) => relay.broadcastEdit(contextForEdit(), { type: "discarded", ...e }));

editor.on("error", (e) => {
  console.error(`[edit] failed: ${e.message}`);
  for (const p of e.problems ?? []) console.error(`  - ${p}`);
  relay.broadcastEdit(contextForEdit(), { type: "error", ...e });
});

function editAgent(ctx: TenantContext, agentId: string, instruction: string): void {
  // Refused here rather than inside `propose`, so the refusal is answered to the asker and the
  // edit scope is left pointing at the workspace whose edit is actually running. The editor
  // refuses a second edit either way; what this adds is that a refused one cannot redirect the
  // in-flight edit's diff — which is another workspace's source — to whoever asked second.
  if (editor.inFlight) {
    relay.broadcastEdit(ctx, { type: "error", message: "an edit is already in progress", agentId });
    return;
  }
  editContext = ctx;
  console.log(`[edit] ${agentId} — "${instruction.slice(0, 80)}"`);
  relay.broadcastEdit(contextForEdit(), { type: "started", agentId, instruction });
  void editor.propose(ctx, agentId, instruction);
}

// --- run trigger ------------------------------------------------------------
async function runAgent(
  ctx: TenantContext,
  input?: string,
  provider?: string,
  model?: string,
  agentId?: string,
): Promise<void> {
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
    relay.broadcastDebug(ctx, { type: "error", message: `invalid agent id: ${agentId}` });
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
  const env: NodeJS.ProcessEnv = {
    JAROKU_RUN_ID: runId,
    JAROKU_CONTROL_DIR: CHECKPOINT_DIR,
    // WHICH WORKSPACE THIS RUN'S CHECKPOINTS BELONG TO.
    //
    // On the Postgres checkpointer every tenant's threads share one table and there is no RLS
    // in that schema — LangGraph never issues SET LOCAL, so a policy there would match nothing.
    // The isolation is the key: `ws:<workspace_id>:run:<run_id>`. The SQLite path ignores it,
    // because one file per run is already a namespace.
    JAROKU_WORKSPACE_ID: ctx.workspaceId,
  };
  if (provider) env.JAROKU_PROVIDER = provider;
  if (model) env.JAROKU_MODEL = model;

  // THE CREDENTIALS THIS RUN NEEDS, RESOLVED BY NAME, THROUGH THE SECRET STORE.
  //
  // A no-op today and the whole point tomorrow. The subprocess still inherits this process's
  // environment, so locally these values were already reachable — what changes is that the run
  // now says WHICH names it needs and gets them from the store rather than from whatever
  // happens to be ambient. Session 4's sandbox spec has an explicit `env` and no inheritance
  // at all, and this is the seam it fills: the same call, a different store behind it, and a
  // list of names that came from the agent's own declaration rather than from the box.
  //
  // Failure here is not fatal. A credential that cannot be resolved is one the agent reports at
  // the point of use, with the name in the message, which is a far better error than a run that
  // refuses to start for a variable it might not have needed.
  try {
    const agent = agentId ? await agentRepo.bySlug(ctx, agentId) : undefined;
    const names = (agent?.required_env ?? []).filter(isSecretName);
    if (names.length) Object.assign(env, await secrets.getForRun(runId, names));
  } catch (err) {
    console.warn(`[manager] could not resolve credentials for ${runId}: ${(err as Error).message}`);
  }
  runActive = true;
  activeRunId = runId;
  pausedRunId = null;
  runWorkspaces.set(runId, ctx);
  pool.startInteractive({ runId, runtimeDir: RUNTIME_DIR, input, agentId, env });
}

// Pause the live run at its next node boundary (the runner honours the control file there).
async function pauseRun(ctx: TenantContext, runId: string): Promise<void> {
  if (!runActive || activeRunId !== runId) {
    console.log(`[debug] pauseRun ignored — ${runId} is not the active run`);
    return;
  }
  // WHOSE RUN, and not merely which run. Every other command on this socket is answered in the
  // caller's workspace; this one took a run id and acted on it, so a workspace holding another
  // tenant's run id could halt their run mid-execution. `getRun` is scoped, so a run that is
  // not this workspace's simply is not there — the same answer `resumeRun` gives.
  if (!(await store.getRun(ctx, runId))) {
    console.log(`[debug] pauseRun refused — ${runId} is not this workspace's run`);
    return;
  }
  console.log(`[debug] pause requested for run ${runId}`);
  requestPause(runId);
}

// Resume a paused run from its durable checkpoint: a fresh subprocess continues the SAME run id,
// its seq starting where the paused segment left off (no run_start, no re-run of done nodes).
async function resumeRun(ctx: TenantContext, runId: string): Promise<void> {
  // WAIT FOR THE SLOT, rather than refusing the moment it looks busy.
  //
  // A pause is announced when the runner writes its control line; the subprocess exits a
  // few milliseconds later. In between, `interactiveRunning` is still true — so a user who
  // presses Resume as soon as the UI says "paused", which is exactly what the UI invites,
  // hits a slot that is about to free and was told nothing at all. The wait is bounded and
  // short because a paused run is always on its way out.
  if (pool.interactiveRunning && pausedRunId === runId) {
    for (let i = 0; i < 40 && pool.interactiveRunning; i++) {
      await new Promise((r) => setTimeout(r, 50));
    }
  }
  if (pool.interactiveRunning) {
    // A genuinely different run is executing. Say so ON THE CHANNEL: a console.log is
    // invisible to the client, so the Resume button simply appeared to do nothing.
    const message =
      activeRunId && activeRunId !== runId
        ? "another run is active — stop it before resuming this one"
        : "the previous run has not finished shutting down yet — try again in a moment";
    console.log(`[debug] resumeRun refused for ${runId}: ${message}`);
    relay.broadcastDebug(ctx, { type: "error", runId, message });
    return;
  }
  const run = await store.getRun(ctx, runId);
  if (!run) {
    relay.broadcastDebug(ctx, { type: "error", runId, message: "unknown run" });
    return;
  }
  // 'paused' is a store-only status (never an emitted event), so it's outside the frozen
  // RunStatus mirror — compare as a plain string rather than widening that type.
  if ((run.status as string) !== "paused") {
    relay.broadcastDebug(ctx, { type: "error", runId, message: `run is ${run.status}, not paused` });
    return;
  }
  const seqOffset = (await store.maxSeqForRun(ctx, runId)) + 1;
  clearControl(runId); // drop the pause request so it doesn't immediately re-pause
  await store.setRunStatus(ctx, runId, "running");
  console.log(`[debug] resuming run ${runId} from seq ${seqOffset} (agent ${run.agent_id})`);
  const env: NodeJS.ProcessEnv = {
    JAROKU_RESUME_RUN_ID: runId,
    // The same workspace the run was dispatched in — a resume continues the SAME thread, so it
    // has to compute the same thread id. See runAgent.
    JAROKU_WORKSPACE_ID: ctx.workspaceId,
    JAROKU_SEQ_OFFSET: String(seqOffset),
    JAROKU_PROVIDER: run.provider,
    JAROKU_MODEL: run.model,
  };
  runActive = true;
  activeRunId = runId;
  pausedRunId = null;
  runWorkspaces.set(runId, ctx);
  relay.broadcastDebug(ctx, { type: "resumed", runId, seqOffset });
  pool.startInteractive({ runId, runtimeDir: RUNTIME_DIR, agentId: run.agent_id, env });
}

// Fork a NEW run from a parent run's checkpoint at a step's node boundary, optionally with a
// validated domain-field edit. The parent is only read: its checkpoint db is copied (never
// written), and its step rows are copied verbatim into the branch — both stay fully inspectable.
async function branchRun(
  ctx: TenantContext,
  fromRunId: string,
  atSeq: number,
  editNode?: string,
  editedState?: Record<string, unknown>,
): Promise<void> {
  if (pool.interactiveRunning) {
    relay.broadcastDebug(ctx, { type: "error", runId: fromRunId, message: "a run is active — stop it before branching" });
    return;
  }
  const parent = await store.getRun(ctx, fromRunId);
  if (!parent) {
    relay.broadcastDebug(ctx, { type: "error", runId: fromRunId, message: "unknown run to branch from" });
    return;
  }
  // Resolve the node boundary containing `atSeq` — we fork at a whole-node boundary, never mid-node.
  const boundary = await store.boundaryForStep(ctx, fromRunId, atSeq);
  if (!boundary || !(await checkpoints.has(ctx, fromRunId))) {
    relay.broadcastDebug(ctx, { type: "error", runId: fromRunId, message: "no durable checkpoint for that step (branching needs a checkpointed run)" });
    return;
  }

  const branchId = randomUUID();
  const { checkpointId, seqHigh } = boundary;
  try {
    // Copy the parent's step prefix (0..boundary) and its checkpoints up to the same boundary,
    // so the parent is never mutated and the branch is self-contained and independently
    // inspectable. What "copy the checkpoints" means is the store's business: a file copy
    // locally, a scoped row copy hosted, and the parent read-only in both.
    await store.copyRunPrefix(ctx, fromRunId, branchId, seqHigh, seqHigh);
    await checkpoints.fork(ctx, { fromRunId, toRunId: branchId, checkpointId });
  } catch (err) {
    relay.broadcastDebug(ctx, { type: "error", runId: fromRunId, message: `branch prep failed: ${(err as Error).message}` });
    return;
  }

  const env: NodeJS.ProcessEnv = {
    JAROKU_RUN_ID: branchId,
    JAROKU_CONTROL_DIR: CHECKPOINT_DIR,
    JAROKU_WORKSPACE_ID: ctx.workspaceId,
    // The parent's thread, spelled the same way the parent spelled it. A branch re-enters an
    // existing thread, so this is the parent's full id rather than its run id — computing it
    // here rather than in the runner keeps one definition of what a thread is called.
    JAROKU_BRANCH_THREAD_ID: checkpointThreadId(ctx.workspaceId, fromRunId),
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
  // The branch belongs to the same workspace as its parent, which is the one that could see
  // the parent in order to branch from it.
  runWorkspaces.set(branchId, ctx);
  console.log(`[debug] branching ${fromRunId} @seq ${seqHigh} -> ${branchId} (agent ${parent.agent_id})`);
  void relay.broadcastHistory(); // surface the new branch run in history immediately
  relay.broadcastDebug(ctx, { type: "branched", parentRunId: fromRunId, branchId, fromSeq: seqHigh });
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

async function buildExplainContext(ctx: TenantContext, cmd: ExplainCommand): Promise<string> {
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
  const files = await agentProjectFiles(ctx, agentId);
  const prompt = files.find((f) => /prompt/i.test(f.path) && f.path.endsWith(".md"))?.content ?? "(no system prompt file)";
  const toolFiles = files.filter((f) => /(^|\/)tools\//.test(f.path) && f.path.endsWith(".py") && !f.path.endsWith("__init__.py"));
  const tools = toolFiles.length
    ? toolFiles.map((f) => `- ${f.path}:\n${f.content.slice(0, 500)}`).join("\n")
    : "(no bespoke tools)";
  const head = subject.kind === "node" ? `Graph node: "${subject.nodeId}" of agent ${agentId}.` : `Agent: ${agentId}.`;
  return [head, `System prompt:\n${prompt.slice(0, 1500)}`, `Tools:\n${tools}`].join("\n\n");
}

async function explainAgent(ctx: TenantContext, cmd: ExplainCommand): Promise<void> {
  if (explaining) {
    // To the asker, not to the scope: the answer still streaming belongs to somebody else, and
    // an explanation quotes the agent's system prompt and tool source back to the reader.
    relay.broadcastReply(ctx, { type: "error", agentId: cmd.agentId, message: "already answering — one at a time" });
    return;
  }
  replyContext = ctx;
  explaining = true;
  relay.broadcastReply(contextForReply(), { type: "started", agentId: cmd.agentId, question: cmd.question });
  const context = await buildExplainContext(ctx, cmd);
  void streamExplain(context, cmd.question, {
    onDelta: (text) => relay.broadcastReply(contextForReply(), { type: "delta", agentId: cmd.agentId, text }),
    onDone: () => { explaining = false; relay.broadcastReply(contextForReply(), { type: "done", agentId: cmd.agentId }); },
    onError: (message) => { explaining = false; relay.broadcastReply(contextForReply(), { type: "error", agentId: cmd.agentId, message }); },
  });
}

// Kick off one run on startup unless suppressed (set JAROKU_NO_AUTORUN=1 to just serve).
if (process.env.JAROKU_NO_AUTORUN !== "1") {
  // Small delay so the relay is listening before the first events land.
  // Nobody asked for this one, so it runs in the server's own workspace.
  setTimeout(() => void runAgent(serverContext()), 300);
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
