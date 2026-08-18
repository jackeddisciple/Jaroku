// Wires the pipeline: RunPool (Python agents) -> TraceStore (SQLite) -> WsRelay (browser).
//
//   uv-spawned agent  --stdout JSON-->  RunPool slot  --event-->  { persist + broadcast }
//
// Two pools, since Session 5: `interactivePool` for the run the user drives — the only one
// pause/resume/branch address — and `evalPool` for the eval fan-out, so neither can starve
// the other of a slot. See the pools' own construction below for why.
//
// Run:  npm run dev        (in server/)
// Then open http://localhost:4317 to watch traces live.

import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { randomUUID, timingSafeEqual } from "node:crypto";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";
import { RunPool, type RunPoolEvents } from "./runPool.ts";
import { TraceStore } from "./store.ts";
// The one answer to "which run does this event claim to be about" — see the ingest boundary's
// reconciliation of the body's id against the slot that produced it.
import { runIdOf } from "./types.ts";
import { migrate } from "./db/migrate.ts";
import { describePartitions, ensurePartitions } from "./lifecycle/partitions.ts";
import { RetentionSweeper, describeSweep } from "./lifecycle/retention.ts";
import { openDb } from "./db/open.ts";
import { newRequestId, systemContext, systemContextFor, type TenantContext } from "./db/tenant.ts";
import { EvalStore, type Rubric, type RubricCriterion } from "./evalStore.ts";
import { EvalRunner } from "./evalRunner.ts";
import { DEFAULT_CRITERIA } from "./judge/rubric.ts";
import { JudgeScorer } from "./judge/score.ts";
import { aggregateEval, bestByQuality } from "./evalAggregate.ts";
import { estimateEval, estimateRun } from "./evalEstimate.ts";
import { fmtBytes, sweepEvalArtifacts, sweepOrphanedEvalArtifacts } from "./evalCleanup.ts";
import {
  WsRelay,
  HISTORY_WINDOW_MAX,
  type ForwardedCommand,
  type GenerateCommand,
  type McpCommand,
  type PlanAgentCommand,
  type MemberCommand,
  type ProviderCommand,
  type AgentCardView,
  type AgentCommand,
  type AgentDetailView,
  type AgentFileView,
  type AgentGridSnapshot,
  type ThreadCommand,
  type ThreadCounts,
  type ThreadSnapshot,
  type ThreadView,
  type EditEvent,
  type GenEvent,
  type ReplyEvent,
} from "./wsRelay.ts";
import { Router, forbidden, tooMany, unauthorized } from "./http/router.ts";
import { securityHeaders } from "./http/security.ts";
import {
  clientAddress, ipRuleFor, openRateLimiter, rateRefusal, retryAfterSeconds, type RateAction,
} from "./http/rateLimit.ts";
import { SIGNALS, signalsFromRun, subjectDigest, type DetectedSignal } from "./abuse/signals.ts";
import { AbuseRepository } from "./db/repositories/abuse.ts";
import { AbuseGate } from "./abuse/gate.ts";
import { enforcementRefusal, limitsUnderEnforcement, refusesWork } from "./abuse/enforcement.ts";
import { EnforcementRepository } from "./db/repositories/enforcement.ts";
import { healthz, readyz } from "./http/health.ts";
import { AUTH_ENV, resolveAuthConfig } from "./auth/config.ts";
import { LocalIssuer } from "./auth/localIssuer.ts";
import { TokenVerifier } from "./auth/verifier.ts";
import { authenticate, sessionRoutes } from "./auth/session.ts";
import { ContextResolver } from "./auth/resolve.ts";
import { resolveOriginPolicy } from "./auth/origin.ts";
import { resolveSocketAuth } from "./auth/socketAuth.ts";
import { DbTicketStore } from "./db/repositories/tickets.ts";
import { Generator, type UsageSummary } from "./generator.ts";
import { Planner } from "./planner.ts";
import { Editor } from "./editor.ts";
import { scanAgentDirectory } from "./agents.ts";
import { AgentRepository, nextForkSlug } from "./db/repositories/agents.ts";
// The Agents grid's derivations, in their own module because every one of them is a rule that looks
// obviously right in a screenshot and is wrong in the case nobody had that day — see agentHealth.ts.
import {
  OUTCOME_WINDOW, activityOf, driftOf, healthOf, missingCredentials, percentiles, runtimeOf,
} from "./agentHealth.ts";
import { IdentityRepository } from "./db/repositories/identity.ts";
import { isMemberRole } from "./db/tenant.ts";
import { resolveDevTenancy, type DevTenancy } from "./devTenancy.ts";
import { loadConnectors, templatesDir } from "./connectors.ts";
import { buildArtifacts } from "./dockerfile.ts";
import {
  isSafeAgentId, listProjectFiles, readOnlyPaths, readOnlyReason, type ProjectFile,
} from "./projectFs.ts";
import { validateProject } from "./validator.ts";
import { liveDiagnostics } from "./liveDiagnostics.ts";
import { resolveSecretValues } from "./deploySecrets.ts";
import { ShadowRunRepository, hasReadableTrace, shouldSweep } from "./shadowRuns.ts";
import { ShadowRunner } from "./shadowRunner.ts";
import { ChecksRepository } from "./db/repositories/checks.ts";
import { CheckRunner } from "./checkRunner.ts";
import { PrCommentsRepository } from "./db/repositories/prComments.ts";
import { diffShapes, readShape } from "./semanticDiff.ts";
import { inSubdirectory, repoPrefix } from "./githubPush.ts";
import { MANIFEST_FILE } from "./mcpManifest.ts";
import type { McpImpact } from "./mcpStore.ts";
import { openObjectStore } from "./storage/open.ts";
import { resolveSigningKey } from "./storage/presign.ts";
import { filesFromDirectory, ProjectStore } from "./storage/projectStore.ts";
import { objectRoutes } from "./http/objects.ts";
import { billingRoutes } from "./http/billing.ts";
import { githubWebhookRoutes } from "./http/githubWebhook.ts";
import { githubAppRoutes } from "./http/githubApp.ts";
import { APP_ENV, RoundTripStates, githubAppConfig } from "./githubApp.ts";
import { paymentsConfigured, stripeConfigFromEnv } from "./billing/stripe.ts";
import { readAgentFiles, slugsOwnedElsewhere, type AgentFilesDeps } from "./agentFiles.ts";
import {
  CHECKPOINT_SCHEMA, checkpointThreadId, checkpointerKindFromEnv,
} from "./checkpoints/threads.ts";
import { openCheckpointStore } from "./checkpoints/store.ts";
import { introspectGraph, introspectGraphCached, type GraphResult } from "./graphIntrospect.ts";
import { streamExplain } from "./explainer.ts";
import type { ConnectionCommand, ConnectionView, DeployChannelCommand, ExplainCommand, ProviderSnapshot } from "./wsRelay.ts";
import { loadRuntimeEnv } from "./env.ts";
import { installLogRedaction, protectEnv, protectSecret } from "./obs/log.ts";
import { currentTraceparent, formatTraceparent, openTracer, parseTraceparent } from "./obs/trace.ts";
import { metrics, routeLabel, statusClass } from "./obs/metrics.ts";
import { McpStore } from "./mcpStore.ts";
import {
  ThreadStore,
  TITLE_MAX,
  type Thread,
  type ThreadItem,
  type ThreadItemKind,
  type ThreadStatus,
} from "./threadStore.ts";
import { threadTitle } from "./threadTitle.ts";
import { InboxStore } from "./inbox/inboxStore.ts";
import {
  noteDeployFailed,
  noteEvalFinished,
  noteEvalResultsOpened,
  noteMcpStatus,
  noteMemoryProposal,
  noteRunFailed,
  noteTraceOpened,
  type GeneratorDeps,
} from "./inbox/generators.ts";
import { NO_FACTS, activePerAgent, deriveThreadStatus } from "./threadStatus.ts";
import {
  collectThreadFacts, type EvalFact, type RunFact, type ThreadDerivation,
} from "./threadFacts.ts";
import { McpRegistry } from "./mcpRegistry.ts";
import { MCP_DISCOVER_CLASS, McpDiscoveryQueue } from "./mcpDiscovery.ts";
import { WorkspaceExporter } from "./lifecycle/export.ts";
import { lifecycleRoutes } from "./http/lifecycle.ts";
import { mountSecretsRoutes, type SecretsCaller } from "./http/secrets.ts";
import { GithubRepository } from "./db/repositories/github.ts";
import { GithubIdentity } from "./githubIdentity.ts";
import { GithubService } from "./githubService.ts";
import { GithubPusher, type StageReport } from "./githubPushRunner.ts";
import { GithubPuller } from "./githubPullRunner.ts";
import type { GithubCommand } from "./wsRelay.ts";
import { ELEVATION_HEADER, SecretElevations, sessionIdFor } from "./secrets/elevation.ts";
import { SecretPasscodes } from "./secrets/passcode.ts";
import { SecretElevationRepository } from "./db/repositories/secretElevations.ts";
import { SecretPasscodeRepository } from "./db/repositories/secretPasscodes.ts";
import { SecretUsageRepository } from "./db/repositories/secretUsages.ts";
import { SecretsManager } from "./secrets/manager.ts";
import { WorkspaceDeleter } from "./lifecycle/deletion.ts";
import { endAllGrants } from "./oauth/revoke.ts";
import { buildIdempotencyKey, type JobClass, type QueueJob } from "./queue/jobs.ts";
import { mcpEgressRules } from "./mcpUrl.ts";
import { WorkerLoop } from "./queue/workerLoop.ts";
import { fileCredentialWriter } from "./envWriter.ts";
import { openSecretStore } from "./secrets/open.ts";
import { GENERIC_MASK } from "./secrets/mask.ts";
import { SecretRefRepository } from "./db/repositories/secretRefs.ts";
import { OAuthRepository } from "./db/repositories/oauth.ts";
import { OAuthError, OAuthService } from "./oauth/service.ts";
import { TokenRefresher } from "./oauth/refresh.ts";
import { ConnectionRevoker } from "./oauth/revoke.ts";
import { resolveClientConfig } from "./oauth/provider.ts";
import { oauthRoutes } from "./http/oauth.ts";
import { GOOGLE } from "./oauth/google.ts";
import { SLACK } from "./oauth/slack.ts";
import { connectorRunEnv } from "./oauth/injection.ts";
import { ConnectorSecrets } from "./connectorSecrets.ts";
import { buildEgressPolicy, EgressPolicyError, type EgressPolicy } from "./sandbox/egressPolicy.ts";
import { BillingRepository } from "./db/repositories/billing.ts";
import { assertPlanRegistry, planFor } from "./billing/plans.ts";
import { UsageMeter, usageKey, type Payer } from "./billing/usage.ts";
import { SAMPLE_INTERVAL_MS, sampleStorage } from "./billing/storage.ts";
import { Balances } from "./billing/balances.ts";
import { BudgetGate, billingPeriod, ceilingRefusal } from "./billing/gate.ts";
import { WorkspaceProviderKeys } from "./billing/providerKeys.ts";
import { PlatformKeyGate } from "./billing/platformKey.ts";
import { GENERATION_MODEL } from "./claude.ts";
import { isSecretName } from "./secrets/secretStore.ts";
import {
  PROVIDER_ENV_KEY, isProviderId, isRealProvider, providerLabel, providerStatus, verifyProviderKey,
  type ProviderId,
} from "./providers.ts";
import { allPrices } from "./pricing.ts";
import { DeployStore, isInFlight as isDeployInFlight } from "./deployStore.ts";
import { DeployManager, planDeploy, type DeployManagerDeps } from "./deployManager.ts";
import { RailwayApi, RailwayError, RAILWAY_ENV_KEY } from "./railwayApi.ts";
import { sandboxKind } from "./sandbox/runSandbox.ts";
import { RunEventBus } from "./sandbox/eventBus.ts";
import { resolveRunTokenSigningKey, RunTokenRevocationList } from "./sandbox/runTokens.ts";
import { registerControlPlaneRoutes } from "./sandbox/controlPlaneRoutes.ts";
import { sandboxImageRef } from "./sandbox/image.ts";
import { FlyMachinesSandbox } from "./sandbox/flySandbox.ts";
import { TraceIngestMetrics } from "./sandbox/traceIngestMetrics.ts";
import { BackpressureTracker } from "./sandbox/backpressure.ts";
import { Dispatcher, defaultQueueBackend } from "./queue/dispatcher.ts";
import { InteractiveSlots } from "./interactiveSlot.ts";
import { EventBridge } from "./queue/eventBridge.ts";

const __dirname = dirname(fileURLToPath(import.meta.url));
const SERVER_DIR = resolve(__dirname, "..");
const REPO_DIR = resolve(SERVER_DIR, "..");
const RUNTIME_DIR = join(REPO_DIR, "runtime");
const DB_PATH = process.env.JAROKU_DB ?? join(SERVER_DIR, "jaroku.db");
const PORT = Number(process.env.JAROKU_PORT ?? 4317);

// THE FILTER OVER EVERY LOG SINK, BEFORE ANYTHING IS LOGGED.
//
// Session 8. `console` is replaced here, first, so that the hundreds of existing calls in this
// codebase — and every one written in a hurry during an incident — go through a redactor rather
// than through review. See obs/log.ts on why owning the sink is the only version of this promise
// that holds for code nobody has written yet.
installLogRedaction();

// Provider + generation keys live in runtime/.env. Names only are logged, never values.
const loadedKeys = loadRuntimeEnv(join(RUNTIME_DIR, ".env"));
// AND THE VALUES THEMSELVES, REGISTERED AS SECRETS. Names only are LOGGED, which has always been
// true; this makes it true of the values as well, wherever they end up — a provider's error
// message quoting the key it rejected, a stack frame carrying a connection string, a debugging
// line somebody adds next year.
protectEnv(process.env, loadedKeys);
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

// AND ONE RUN SANDBOX, chosen here and nowhere else, exactly like the driver and the object
// store above. `local` spawns exactly the subprocess this codebase has always spawned — see
// sandbox/runSandbox.ts's own note on why `npm run dev` needs nothing installed and nothing
// running for this either. `fly` is the hosted path, and it is the only one that ever mints a
// run token or needs a control plane for a sandboxed run to call home to.
const RUN_TOKEN_KEY_PATH = process.env.JAROKU_RUN_TOKEN_KEY_PATH ?? join(SERVER_DIR, ".runtokenkey");
const runTokenSigningKey = resolveRunTokenSigningKey(RUN_TOKEN_KEY_PATH);
const runEventBus = new RunEventBus();
const runTokenRevocations = new RunTokenRevocationList();
setInterval(() => runTokenRevocations.sweep(), 10 * 60_000).unref();
// The URL a sandboxed run's OWN control-plane HTTP client is told to call — this server's own
// public address, not something derivable from inside the process. Unset locally: LOCAL sandbox
// runs mint no token at all (see runPool.ts's launch()), so nothing ever needs this.
const CONTROL_PLANE_URL = process.env.JAROKU_CONTROL_PLANE_URL;
const RUN_SANDBOX_KIND = sandboxKind();
const FLY_APP = process.env.JAROKU_FLY_APP;
if (RUN_SANDBOX_KIND === "fly" && !CONTROL_PLANE_URL) {
  throw new Error(
    "JAROKU_RUN_SANDBOX=fly needs JAROKU_CONTROL_PLANE_URL — a hosted run has to be told where " +
      "to push its trace and poll for control, and there is no address to guess it from.",
  );
}
if (RUN_SANDBOX_KIND === "fly" && !FLY_APP) {
  throw new Error("JAROKU_RUN_SANDBOX=fly needs JAROKU_FLY_APP — which Fly app a run's machine is created in.");
}
console.log(`[server] run sandbox: ${RUN_SANDBOX_KIND}`);
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

// AND THE MONTHS AHEAD OF THE TRACE.
//
// Migration 029 made `steps` one table per month, which is what turns retention into a catalogue
// update instead of a multi-hour DELETE — and which introduces the one failure this call exists
// to prevent: an INSERT with no matching partition FAILS, and the row it fails on is a trace
// step. So the months are created ahead of time, at boot and then daily, and the DEFAULT
// partition catches anything that still falls through. A no-op on SQLite. Unref'd: maintenance
// must never be the reason a process will not exit.
const ensureStepPartitions = async (): Promise<void> => {
  const created = await ensurePartitions(db);
  if (created.length) console.log(`[lifecycle] ${created.length} step partition(s) ensured through ${created.at(-1)}`);
  const { defaultRows } = await describePartitions(db);
  metrics.set("steps_default_partition_rows", defaultRows);
  if (defaultRows > 0) {
    // Not fatal, and not silent. Rows here cannot be dropped by month, so a filling default is a
    // retention promise quietly not being kept — see lifecycle/partitions.ts.
    console.warn(`[lifecycle] ${defaultRows} step(s) are in the DEFAULT partition and cannot be dropped by month`);
  }
};
await ensureStepPartitions().catch((err) =>
  console.error("[lifecycle] could not ensure step partitions:", (err as Error)?.message ?? err),
);
setInterval(() => {
  void ensureStepPartitions().catch((err) =>
    console.error("[lifecycle] could not ensure step partitions:", (err as Error)?.message ?? err),
  );
}, 24 * 3_600_000).unref();

// WHAT THIS DEPLOYMENT SELLS, CHECKED AGAINST WHAT THE CODE THINKS EACH PLAN MEANS.
//
// The `plans` table holds only what varies per deployment — a price id, and whether a plan can
// be bought today. Every number a plan implies is in billing/plans.ts. A row with no definition
// there resolves through `planFor` to the FREE limits, so a workspace that paid for Scale would
// silently get a free workspace's ceiling and concurrency, and nothing anywhere would say so.
// Checked here for the same reason the migrations are applied here: a mismatch is a deployment
// mistake, and the useful moment to learn about one is during the deployment.
const billing = new BillingRepository(db);
assertPlanRegistry(await billing.listPlans(systemContext(newRequestId())));

const store = new TraceStore(db);
await store.init();

// WHAT A RUN COSTS, WRITTEN DOWN AS IT HAPPENS.
//
// Fed from the ingest chain below, one row per llm_call step, keyed by the step's own id so a
// redelivered batch cannot bill twice. It records; it decides nothing. Whether a workspace may
// start the next run is a separate question asked against these rows, and keeping the two apart
// is what lets metering be unconditional while billing is not — which is exactly what BYOK
// needs, since a BYOK workspace wants the dashboard and does not want the invoice.
const meter = new UsageMeter(billing, async (ctx, runId) => {
  const run = await store.getRun(ctx, runId);
  return run ? { provider: run.provider, model: run.model } : null;
});

// The other half: what may be STARTED, as opposed to what is recorded once it has been.
// `balances` is the mechanism (an atomic claim against a balance, and a row that can be given
// back); `budgetGate` is the policy that decides whether to use it. See billing/gate.ts for why
// the ceiling applies to every workspace and the reservation only to those with platform credit.
const balances = new Balances(db, billing);

/**
 * Meter a call the platform made on somebody's behalf, without ever being able to break it.
 *
 * Floating and caught, deliberately. Every call site below is on a request path a user is
 * watching — a generation streaming into the build pane, an explanation streaming into the
 * composer — and none of them may be made to wait on, or fail because of, a ledger write. A
 * missed usage row is money we did not charge for; a generation that died recording one is the
 * product. `void p.catch(...)` rather than a bare `void` for the reason EvalRunner.guard
 * exists: an unhandled rejection ends the process.
 */
function meterPlatformCall(
  ctx: TenantContext,
  kind: "llm.generation" | "llm.plan" | "llm.edit" | "llm.explain" | "llm.judge",
  call: {
    model: string;
    inputTokens: number;
    outputTokens: number;
    cacheReadTokens?: number;
    cacheWriteTokens?: number;
    idempotencyKey?: string;
    /** `workspace` when the call went out on the workspace's own key. Defaults to us. */
    payer?: Payer;
    /**
     * The build session that caused the call, for §4.3's per-thread cost.
     *
     * All four kinds this function meters — plan, generation, edit, explain — carry no run id, so
     * without this they are money a thread spent that no per-thread total can find. Every other
     * kind attributes through its run; see migration 044.
     */
    threadId?: string | null;
  },
): void {
  void meter.meterModelCall(ctx, kind, call).catch((err) => {
    console.error(`[billing] failed to meter a ${kind} call:`, (err as Error)?.message ?? err);
  });
}

/**
 * runId -> the hold taken for it, so the run's exit knows what to give back.
 *
 * In memory, and that is not the safety mechanism. A gateway that dies takes this map with it
 * and the holds it describes are left standing — which is precisely why a hold is a row with an
 * expiry and why `sweepExpired` runs below. This map is the FAST path: a run that ends normally
 * settles in milliseconds instead of waiting out an hour-long lease.
 */
const runHolds = new Map<string, string>();

/**
 * runId -> whose key that run spends.
 *
 * Recorded where the run's environment is built, which is the only place that knows, and read
 * where its first trace event lands. It cannot be derived from the run row: whether a run used
 * its workspace's key depends on what was configured at the time, and a workspace that connects
 * a key tomorrow would retroactively change what today's rows mean.
 */
const runPayers = new Map<string, Payer>();

/**
 * Whose key the one in-flight plan / generation / edit is spending.
 *
 * Module state beside `planContext`, `genContext` and `editContext`, and safe for the same
 * reason those are: each of the three is single-slot and refuses a second while one is running.
 * Recorded where the key is resolved and read where the usage row is written, because the
 * emitter in between carries a UsageSummary and no notion of who paid for it.
 */
let planPayer: Payer = "platform";
let genPayer: Payer = "platform";
let editPayer: Payer = "platform";

/**
 * evalId -> the hold taken for it. Same shape and same caveat as `runHolds`.
 *
 * Separate from it rather than one map with a prefixed key, because the two settle from
 * different places: a run's real cost is the sum of its own usage rows, an eval's is
 * `trueSpend` — every attempt of every job plus the judge, which is a figure the eval store
 * already computes and which no per-run query would reproduce.
 */
const evalHolds = new Map<string, string>();

/** Give an eval's hold back, settled against its true spend. Idempotent, like every release. */
async function settleEval(ctx: TenantContext, evalId: string): Promise<void> {
  const holdId = evalHolds.get(evalId);
  if (!holdId) return;
  evalHolds.delete(evalId);
  try {
    // TRUE spend: every attempt, succeeded or not, plus judge cost. Never the comparison
    // figure, which excludes failures — settling on that would hand back money a retry storm
    // had already spent, which is exactly when the difference is largest.
    await balances.release(ctx, holdId, { settleUsd: await evalStore.trueSpend(ctx, evalId) });
  } catch (err) {
    console.error(`[billing] failed to settle eval ${evalId}:`, (err as Error)?.message ?? err);
  }
}

/**
 * Give a run's hold back, and take what it really spent out of the balance.
 *
 * SETTLED FROM `usage_events`, never from the estimate the hold was sized with. The hold is a
 * projection; the ledger is what the run actually did, assembled from its steps by the ingest
 * chain. Deducting the hold would charge every run its estimate — which is wrong in both
 * directions and wrong most often for the agents whose cost varies, which is all of them.
 *
 * Idempotent because `release` is: a run whose exit fires while a sweeper has already decided
 * the lease lapsed settles exactly once, whichever gets there first.
 */
async function settleRun(ctx: TenantContext, runId: string): Promise<void> {
  const holdId = runHolds.get(runId);
  if (!holdId) return;
  runHolds.delete(runId);
  try {
    const spent = await billing.runSpend(ctx, runId);
    await balances.release(ctx, holdId, { settleUsd: spent.usd });
  } catch (err) {
    // Left standing rather than force-released: the sweeper will reclaim it, and reclaiming
    // late is better than releasing a hold whose spend we failed to read.
    console.error(`[billing] failed to settle run ${runId}:`, (err as Error)?.message ?? err);
  }
}

/** The shape claude.ts's `UsageSummary` has, narrowed to what the ledger needs from it. */
function tokensOf(usage: unknown): {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
} {
  const u = (usage ?? {}) as Partial<UsageSummary>;
  return {
    inputTokens: u.input_tokens ?? 0,
    outputTokens: u.output_tokens ?? 0,
    cacheReadTokens: u.cache_read_input_tokens ?? 0,
    cacheWriteTokens: u.cache_creation_input_tokens ?? 0,
  };
}
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

// Threads share the same file and connection for the same reason the two above do: an additive
// control-plane table beside the frozen schema, one writer. A thread is not a trace event and
// never becomes one.
const threadStore = new ThreadStore(store.database());

// And the Inbox, on the same connection for the same reason. Two additive control-plane tables
// beside the frozen schema; nothing here is a trace event and nothing here changes one.
const inboxStore = new InboxStore(store.database());

/**
 * What the event-driven generators need, in one object.
 *
 * `onChanged` IS ABSENT UNTIL THERE IS A CHANNEL TO PUSH DOWN. The generators call it after a write
 * so a board updates without a refresh (§5.6), and until the `inbox` channel exists there is nothing
 * for it to do — an empty hook now is a hook nobody has to remember to add later, which is the
 * failure the members list had for the whole life of a tab.
 */
const inboxDeps: GeneratorDeps = { inbox: inboxStore };

/**
 * Write an Inbox item, and never let doing so break what was actually happening.
 *
 * FLOATING AND CAUGHT, exactly as `meterPlatformCall` and `noteThreadItem` are, and for a sharper
 * version of the same reason: every call site below is a handler for something that HAS ALREADY
 * HAPPENED. The deploy failed, the eval finished, the run ended. A card that could not be written is
 * a card missing from a board; an exception thrown back into one of those handlers is the event
 * itself being lost.
 */
function noteInbox(what: string, write: Promise<unknown>): void {
  void write.catch((err) => {
    console.error(`[inbox] could not record ${what}:`, (err as Error)?.message ?? err);
  });
}

// TWO POOLS, SESSION 5. Before this, one pool reserved slot 0 for the interactive run and
// lent the rest to the eval fan-out — a single, process-wide reservation, because there was
// only ever one workspace to reserve it for. That protection is now structural instead of a
// carved-out index: interactivePool and evalPool are separate RunPool instances with
// separate capacity, so an eval fan-out can saturate its own pool completely without ever
// touching a slot an interactive run could have used. Both share the same sandbox factory,
// event bus and run-token machinery — a run token only has to verify, not be unique to a
// pool, and sharing them is simpler than two separate control-plane wiring paths.
const sandboxFactory =
  RUN_SANDBOX_KIND === "fly"
    ? () => new FlyMachinesSandbox({ app: FLY_APP!, bus: runEventBus, image: sandboxImageRef() })
    : undefined;
const poolOpts = {
  controlPlaneUrl: CONTROL_PLANE_URL,
  bus: runEventBus,
  signingKey: runTokenSigningKey,
  revocations: runTokenRevocations,
  sandbox: sandboxFactory,
};
// How many DIFFERENT workspaces' interactive runs this pool has ROOM for. Defaults to one,
// and raising it is not yet meaningful: `runActive`/`activeRunId` below are still a single
// process-wide pair, not a per-workspace map, so runAgent refuses a second interactive run
// for ANY workspace the moment interactivePool.busy is true — that check, not this pool's
// own capacity, is what still limits this gateway to one live interactive run at a time.
// The per-workspace RESERVATION (see acquireInteractiveSlot below) is real infrastructure
// today regardless; widening activeRunId into a per-workspace map, so this number starts
// doing something, is the documented next step — not delivered this session.
const INTERACTIVE_CONCURRENCY = Math.max(1, Number(process.env.JAROKU_INTERACTIVE_CONCURRENCY ?? 1));
const interactivePool = new RunPool(INTERACTIVE_CONCURRENCY, poolOpts);
const EVAL_CONCURRENCY = Math.max(1, Number(process.env.JAROKU_EVAL_CONCURRENCY ?? 4));
const evalPool = new RunPool(EVAL_CONCURRENCY, poolOpts);
const planner = new Planner();

// WHERE A run.eval JOB ACTUALLY GOES, per Session 5. Redis when JAROKU_REDIS_URL is set, so a
// separate `npm run worker` process could drain the same queue; in-memory otherwise, so
// `npm run dev` keeps needing nothing installed. Either way, this gateway process still drains
// its own admissions locally today — see evalRunner.ts's drainAvailable() — a genuinely
// separate worker process is available (worker.ts) but is not this dev topology's default.
// The second argument is where a job's `traceparent` comes from when nothing passes one, which
// is every enqueue in this codebase — see the dispatcher. It joins an eval fan-out, a discovery
// job and an export to the request that asked for them, across the process boundary a worker
// picks them up on.
const dispatcher = new Dispatcher(defaultQueueBackend(), currentTraceparent);

// THE CROSS-REPLICA EVENT BRIDGE. undefined with no JAROKU_REDIS_URL — see
// queue/eventBridge.ts's own header for why that is the whole story for a single-replica
// `npm run dev`, not a degraded mode of a feature that is otherwise on.
const eventBridge = EventBridge.create();

// THE PER-WORKSPACE INTERACTIVE RESERVATION — the descendant of the single reserved slot 0
// used to be. Acquired before interactivePool.tryStart() in runAgent/resumeRun/branchRun,
// released the moment that run's process actually exits (or fails to spawn). Its cap
// defaults to one per workspace (queue/jobs.ts's run.interactive config) — same ceiling
// `runActive` already enforces process-wide today, so nothing observable changes for a
// single active run; what changes is that the ceiling is now an explicit, named, leased
// reservation instead of an implicit side effect of there having been only one slot.
// Reserving and STARTING are one call (interactiveSlot.ts): the reservation is released by the
// run's own exit event, so a start that never happened has nothing coming to release it — and
// the cap is one per workspace with an hour-long lease. See that module's header.
const interactiveSlots = new InteractiveSlots(dispatcher.backend, randomUUID);
const releaseInteractiveSlot = (workspaceId: string, runId: string): Promise<void> =>
  interactiveSlots.release(workspaceId, runId);

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

/**
 * runId -> the span covering that run, ended when the process exits.
 *
 * Beside `runWorkspaces` and for the same reason: a run outlives the command that started it, and
 * the thing that knows it is over is the pool's exit event minutes later. A span nobody ends is a
 * span that never leaves this process, so the map is the only way the two moments can meet.
 */
const runSpans = new Map<string, { set: (k: string, v: string | number | boolean | undefined) => void; end: () => void }>();
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
/** Filled in once the secrets manager exists — see `onRuntimeRead` on the store below. */
let recordRuntimeRead: ((workspaceId: string, names: string[]) => Promise<void>) | null = null;
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
          : name.startsWith("GOOGLE") ? "google"
            : name === RAILWAY_ENV_KEY ? "railway"
              : null,
  // LATE-BOUND ON PURPOSE. The store is built here, near the top, because half the server needs
  // it; the manager that records usage is built much later, because it needs the repositories that
  // need the router. Rather than move one of them and disturb an ordering that works, the hook is
  // a hole this fills in once both exist. Before then it is a no-op, which is correct: nothing has
  // read a credential yet.
  onRuntimeRead: (workspaceId, names) => recordRuntimeRead?.(workspaceId, names) ?? Promise.resolve(),
});
console.log(`[server] secret store: ${secrets.kind}${secrets.kind === "dotenv" ? " (runtime/.env)" : ""}`);

// AND THE MCP REGISTRY, WHICH NOW READS ITS CREDENTIALS THROUGH THAT STORE RATHER THAN THE
// PROCESS ENVIRONMENT.
//
// Constructed HERE rather than beside `mcpStore` above, purely because it needs the store that
// is built on this line — the note two hundred lines up said the registry "keeps talking to the
// writer directly for now" and would move onto this in the commit that gives credentials a
// workspace. This is that commit.
//
// What changes: `JAROKU_MCP_<SERVER>_TOKEN` stops being one process-wide value and becomes one
// value PER WORKSPACE. Two workspaces connecting the same service derive the same env key —
// a server id is a slug — and before this the second to save a token silently replaced the
// first's, so both then authenticated as whoever wrote last.
const mcpRegistry = new McpRegistry(mcpStore, secrets);

// AND DISCOVERY MOVES OFF THE REQUEST PATH.
//
// A handshake is a round trip to a third party nobody here controls, bounded by mcpClient's own
// timeouts and by nothing else — which is fine at one user and is a hundred concurrent pending
// fetches when a popular endpoint has a bad afternoon and every workspace that connected it
// retries at once. See mcpDiscovery.ts.
//
// DRAINED IN THIS PROCESS, and that is a choice rather than a stopgap. Session 5's worker.ts
// exists for classes that genuinely need a separate process — long-running sandboxed executions
// competing for scarce capacity. A discovery is seconds of waiting on somebody else's socket and
// holds nothing but a connection, so what it needs is a per-workspace CONCURRENCY LIMIT, which
// the dispatcher gives it either way. The loop runs here so `npm run dev` keeps working with no
// worker process and no Redis, exactly as every other local default in this file does.
const mcpDiscovery = new McpDiscoveryQueue({
  dispatcher,
  registry: mcpRegistry,
  onResult: (ctx, payload, result) => {
    console.log(
      `[mcp] ${payload.kind} ${payload.serverId} — ` +
        (result.ok ? `connected, ${result.server?.tools.length ?? 0} tool(s)` : `failed: ${result.server?.status}`),
    );
    // The snapshot first, then the message: a client that got a notice before the list it is
    // about would render an error against a row that still says "discovering".
    broadcastMcpServers();
    if (!result.ok && result.message) {
      relay.broadcastMcp(ctx, { type: "error", message: result.message, serverId: payload.serverId });
    } else if (result.message) {
      relay.broadcastMcp(ctx, { type: "notice", message: result.message, serverId: payload.serverId });
    }
    // §2.1'S `mcp_auth_required`, RAISED WHERE THE STATUS IS ALREADY KNOWN rather than by teaching
    // the registry what an Inbox is. A server asking for a credential is Blocking the moment
    // discovery says so — every agent scoped to it can call nothing — and this is the one place both
    // a first registration and a rediscovery arrive at.
    //
    // `unreachable` DELIBERATELY RAISES NOTHING HERE. §2.2's trigger is not "unreachable" but
    // "unreachable for over 24 hours", which is a question about how long a state has held and only
    // the reconciler can ask it. Raised on the event, it would put a card on the board every time a
    // third party restarted.
    if (result.server) noteInbox("an MCP server needing a credential", noteMcpStatus(inboxDeps, ctx, result.server));
  },
  onError: (ctx, payload, err) => {
    console.error(`[mcp] ${payload.kind} ${payload.serverId} threw:`, err);
    relay.broadcastMcp(ctx, {
      type: "error",
      // Not the exception's text. Everything below a thrown error here is a bug in this
      // codebase, and its message describes the inside of the server — the same rule the HTTP
      // router applies to a 500.
      message: "that discovery could not be completed",
      serverId: payload.serverId,
    });
    broadcastMcpServers();
  },
});
// AND THE OTHER CLASS THIS PROCESS DRAINS ITSELF: a workspace asking for everything it has.
//
// Here rather than in worker.ts for the same reason discovery is: it holds a database connection
// and waits, rather than competing for the scarce capacity a run needs. Its own global cap of
// four (queue/jobs.ts) is what stops six thousand workspaces exporting at once from taking every
// connection in the pool.
const exporter = new WorkspaceExporter({
  db,
  objects,
  // The current version of every agent's source. An export listing agents without their code
  // would be a description of somebody's work rather than their work.
  agentFiles: async (ctx) => {
    const out: { path: string; body: Buffer }[] = [];
    for (const agent of await agentRepo.list(ctx)) {
      for (const file of await agentProjectFiles(ctx, agent.slug)) {
        out.push({ path: `${agent.slug}/${file.path}`, body: Buffer.from(file.content ?? "", "utf8") });
      }
    }
    return out;
  },
});
/**
 * The run id a control-plane path names, or undefined.
 *
 * `/v1/runs/<id>/trace` and its siblings are the sandbox tier's own requests, and tagging them
 * with the run makes "everything that happened for this run" one query rather than a join
 * somebody performs by eye.
 */
function runIdFromPath(path: string): string | undefined {
  if (!path.startsWith("/v1/runs/")) return undefined;
  const rest = path.slice("/v1/runs/".length);
  const slash = rest.indexOf("/");
  return slash > 0 ? rest.slice(0, slash) : undefined;
}

/** The class an export runs under. Named once, so the route and the loop cannot disagree. */
const EXPORT_CLASS: JobClass = "workspace.export";
const exportLoop = new WorkerLoop({
  dispatcher,
  classes: [EXPORT_CLASS],
  handlers: {
    [EXPORT_CLASS]: async (job: QueueJob) => {
      // A system context scoped to the JOB's workspace, never the requester's — a job outlives
      // the request that enqueued it, and the workspace is what authorises the work.
      const ctx = systemContextFor(job.workspaceId, newRequestId());
      const exportId = String((job.payload as { exportId?: string } | undefined)?.exportId ?? "");
      const result = await exporter.export(ctx, exportId);
      console.log(`[export] ${job.workspaceId} ${exportId} ready — ${result.bytes} byte(s)`);
    },
  },
  onHandlerError: (_class, job, error) =>
    console.error(`[export] ${job.workspaceId} failed:`, (error as Error)?.message ?? error),
  // TIER THREE. The job carries the traceparent of whatever enqueued it, so an export that took
  // four minutes is a span under the request that asked for it rather than an orphan.
  trace: (job, run) =>
    tracer.in(
      `job ${job.class}`,
      {
        tier: "worker",
        parent: parseTraceparent(job.traceparent),
        attributes: { "jaroku.workspace_id": job.workspaceId, "jaroku.job_id": job.id },
      },
      run,
    ),
});
void exportLoop.run();

const mcpDiscoveryLoop = new WorkerLoop({
  dispatcher,
  classes: [MCP_DISCOVER_CLASS],
  handlers: { [MCP_DISCOVER_CLASS]: mcpDiscovery.handler() as never },
  trace: (job, run) =>
    tracer.in(
      `job ${job.class}`,
      { tier: "worker", parent: parseTraceparent(job.traceparent), attributes: { "jaroku.workspace_id": job.workspaceId } },
      run,
    ),
});
void mcpDiscoveryLoop.run();

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

// Every event a piece of work emits goes out with the SESSION it belongs to as well as the
// workspace, which is what lets a client file the turns under the right thread (§3.1, §4.5).
//
// Four wrappers rather than a `threadId` argument at forty call sites, and function declarations
// rather than consts because the listeners below are registered above where `planThread` and its
// siblings are declared. Each pairs the scope with the session that scope's work is filed under, so
// the two can never be given from different operations — which is the same reason each subsystem
// has its own context in the first place.
//
// A refusal answered to whoever asked still calls `relay.broadcast*` directly with their own ctx
// and no session: it belongs to no thread, and attaching one would file somebody else's error in it.
function genOut(e: GenEvent): void { relay.broadcastGen(contextForGen(), e, genThread); }
function planOut(e: GenEvent): void { relay.broadcastGen(contextForPlan(), e, planThread); }
function editOut(e: EditEvent): void { relay.broadcastEdit(contextForEdit(), e, editThread); }
function replyOut(e: ReplyEvent): void { relay.broadcastReply(contextForReply(), e, replyThread); }

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
const budgetGate = new BudgetGate(billing, balances, bootIdentity);
// The other gate, and a different question: not "may this workspace spend" but "may it spend
// OURS". Separate from the budget gate because the two protect different people — see
// billing/platformKey.ts.
const platformKeyGate = new PlatformKeyGate(billing, bootIdentity, async (ctx) => (await abuseGate.check(ctx)).level);
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

// HOLDS NOBODY RELEASED. The safety net, not the release path — a run that ends normally gives
// its own hold back in milliseconds. This is for the run whose gateway died holding one, which
// is exactly the case a restart is evidence of. Swept at boot and then on a timer, workspace by
// workspace for the reason the reconciliations above are: an unscoped query returns nothing at
// all as the application role, so a "platform-wide" sweep would reclaim nothing in the one
// deployment that needs it. Unref'd — reclaiming money must never hold a process open.
const sweepHolds = async (): Promise<void> => {
  for (const id of await bootIdentity.listWorkspaceIds(systemContext(newRequestId()))) {
    await balances.sweepExpired(systemContextFor(id, newRequestId()));
  }
};
await sweepHolds().catch((err) => console.error("[billing] hold sweep failed:", (err as Error)?.message ?? err));
setInterval(() => {
  void sweepHolds().catch((err) => console.error("[billing] hold sweep failed:", (err as Error)?.message ?? err));
}, 5 * 60_000).unref();


// True from spawn until run_end (or exit) of the INTERACTIVE run. Deliberately NOT
// interactivePool.busy: the process outlives its run_end by a beat while it tears down, and
// refusing an apply/undo in that window is a race the user would hit by clicking right after
// a run finishes. Once run_end is emitted the graph is done and the project files are no
// longer being read.
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

// A WORKSPACE'S OWN PROVIDER KEYS.
//
// The one place that knows where a key is stored, which run may receive it, and whether it is
// allowed to pay for the platform's own thinking. Everything else asks this rather than reading
// `process.env` — which locally is the same answer and hosted is the PLATFORM's key, and a panel
// that read it would tell six thousand workspaces they have a provider connected because the
// server does.
const providerKeys = new WorkspaceProviderKeys(secrets, billing);

// A WORKSPACE'S CONNECTIONS TO SOMEBODY ELSE'S ACCOUNT.
//
// The same shape as the provider keys above and for the same reasons: one module knows where a
// connector's credential lives, which run may receive it, and what a client is allowed to learn
// about it (a status and an account label, never a token).
//
// Both providers are registered unconditionally, and neither needs configuration to be REGISTERED
// — `configured()` is what says whether this deployment could actually run the flow, and locally
// the answer is no. Registering them anyway is what lets the connections panel list Gmail and
// Slack with a sentence naming the two environment variables somebody has to set, rather than
// showing an empty page that looks like the feature does not exist.
const oauthRepo = new OAuthRepository(store.database());
const oauth = new OAuthService({
  repo: oauthRepo,
  secrets,
  providers: [GOOGLE, SLACK],
  // Read per call, not captured — the same rule the Stripe config and the billing rates follow.
  // A deployment that registers an OAuth app should not need a restart to start using it.
  config: (providerId) => resolveClientConfig(providerId, process.env, PORT),
  audit: async (ctx, action, detail) => {
    await identityRepo.appendAudit(ctx, {
      action,
      targetType: "connector",
      targetId: typeof detail["connector"] === "string" ? detail["connector"] : null,
      metadata: detail,
    });
  },
  // A CONNECTOR'S TOKEN BELONGS TO THE CONNECTOR, and the Secrets tab has to be told: without
  // this, `GMAIL_ACCESS_TOKEN` and `SLACK_BOT_TOKEN` were classified `custom` — the default that
  // is correct for a value somebody typed — and rendered in the Custom group with Rotate, Revoke
  // and Reveal, none of which can end well on a credential Google issued.
  //
  // A GENERIC MASK, NEVER A DERIVED ONE. The real hint would need the plaintext, and there is no
  // reason to reach for a token's value to decorate a row nobody may act on anyway.
  classify: async (ctx, name, detail) => {
    await secretRefs.setMetadata(ctx, name, {
      kind: "managed",
      connectorId: detail.connectorId,
      maskedHint: GENERIC_MASK,
      status: "valid",
      expiresAt: detail.expiresAt,
    });
  },
});
// AND THE ONE CONNECTOR NOBODY CAN CONNECT FOR YOU.
//
// Postgres has no consent screen: the connection string IS the credential, so it stays a
// `user_secret` in the vault. Which also makes it the only connector whose HOST a user chooses,
// and therefore the SSRF vector the migration spec names — validated on the way in and re-resolved
// and pinned on the way out. See connectorSecrets.ts for why doing it once would be doing it at
// the moment it proves nothing.
const connectorSecrets = new ConnectorSecrets({ secrets });

// AND ENDING A GRANT, WHICH IS NOT THE SAME OPERATION AS FORGETTING ONE.
//
// Deleting our copy of a credential is housekeeping. Revoking it is what the Disconnect button
// appears to promise, and without it a user who pressed it still appears in their own Google
// account's connected apps, with a refresh token that still works. See oauth/revoke.ts.
const connectionRevoker = new ConnectionRevoker({
  repo: oauthRepo,
  secrets,
  providers: [GOOGLE, SLACK],
  config: (providerId) => resolveClientConfig(providerId, process.env, PORT),
});

/**
 * Everything one run may talk to, denied by default.
 *
 * NEVER THROWS, and that is a decision worth stating. An egress policy that could not be built is
 * a run with no policy, which on the hosted path is a configuration error the sandbox itself
 * refuses — and locally is the situation every run has been in since the product was written.
 * Failing the run here instead would mean a DNS blip stops somebody working, and would put the
 * refusal in the least informative possible place. The reason is logged and the run proceeds
 * exactly as it did before this existed.
 *
 * The postgres rule is the one that can legitimately refuse: a workspace whose DATABASE_URL now
 * resolves to a private address gets a policy WITHOUT that host rather than one that admits it,
 * because `buildEgressPolicy` refuses to build a postgres run with no validated URL — so the
 * whole policy comes back undefined and the log says which connector caused it.
 */
async function buildRunEgress(
  ctx: TenantContext,
  runId: string,
  provider: string | undefined,
  connectors: string[],
  mcpRefs: string[],
): Promise<EgressPolicy | undefined> {
  try {
    // Resolved fresh at policy-build time and pinned. Reading something the save path recorded
    // would be the DNS-rebinding hole this exists to close — see connectorSecrets.ts.
    const databaseUrl = connectors.includes("postgres")
      ? ((await connectorSecrets.postgresEgress(runId)) ?? undefined)
      : undefined;
    // THE MCP SERVERS THIS AGENT WAS GRANTED, validated and pinned at policy-build time.
    //
    // From the AGENT's own manifest refs, never from anything a client sent — the same rule the
    // credential resolution follows one function up. A server it was not generated with does not
    // appear in the policy, so a generated project that somehow reached for one would find the
    // socket closed rather than the tool missing.
    //
    // Re-validated HERE rather than trusted from registration, because a hostname is not a
    // promise: `mcp.example.com` can be repointed at the metadata endpoint between the day it was
    // added and the moment a run connects. An endpoint that no longer validates contributes no
    // rule and is logged — see mcpUrl.mcpEgressRules on why that beats refusing the whole run.
    const grantedServers = [
      ...new Set(mcpRefs.map((ref) => ref.slice(0, ref.indexOf("/"))).filter(Boolean)),
    ];
    const endpoints: { id: string; endpoint: string }[] = [];
    for (const id of grantedServers) {
      const server = await mcpStore.getServer(ctx, id);
      if (server) endpoints.push({ id: server.id, endpoint: server.endpoint });
    }
    const mcp = await mcpEgressRules(endpoints);
    for (const bad of mcp.refused) {
      console.warn(`[sandbox] run ${runId} was not granted egress to the ${bad.id} MCP server: ${bad.reason}`);
    }

    return await buildEgressPolicy({
      runId,
      provider: provider ?? "fake",
      connectors,
      databaseUrl,
      mcpRules: mcp.rules,
      controlPlaneHost: CONTROL_PLANE_URL ? new URL(CONTROL_PLANE_URL).hostname : undefined,
      controlPlanePort: CONTROL_PLANE_URL ? Number(new URL(CONTROL_PLANE_URL).port || 443) : undefined,
    });
  } catch (err) {
    const why = err instanceof EgressPolicyError ? err.message : (err as Error).message;
    console.warn(`[sandbox] no egress policy for run ${runId}: ${why}`);
    return undefined;
  }
}

/**
 * Expired OAuth `state` rows, swept.
 *
 * ONE ROW PER STARTED-AND-ABANDONED FLOW, and every product has those: somebody presses Connect,
 * reads the consent screen, and closes the tab. `sweepStates` was written to remove them and nothing
 * ever called it on a timer, so the table only grew — slowly, invisibly, and with a row per
 * abandonment holding a `code_verifier` and a return path long past the ten minutes either means
 * anything for.
 *
 * IT IS NOT A SECURITY BOUNDARY and must not be mistaken for one: an expired state is already
 * refused by `expires_at` at redemption, which is where the check that matters lives. This is
 * housekeeping — the same shape and the same reasoning as the ticket sweep and the hold sweep it
 * sits beside, unref'd so tidying up can never hold a process open.
 *
 * Hourly rather than every few minutes, because nothing depends on the row being gone: the only
 * cost of a stale one is a row.
 */
const sweepOauthStates = async (): Promise<void> => {
  const removed = await oauthRepo.sweepStates();
  if (removed > 0) console.log(`[connections] swept ${removed} expired OAuth state(s)`);
};
await sweepOauthStates().catch((err) =>
  console.error("[connections] state sweep failed:", (err as Error)?.message ?? err),
);
setInterval(() => {
  void sweepOauthStates().catch((err) =>
    console.error("[connections] state sweep failed:", (err as Error)?.message ?? err),
  );
}, 3_600_000).unref();

const tokenRefresher = new TokenRefresher({
  repo: oauthRepo,
  secrets,
  providers: [GOOGLE, SLACK],
  config: (providerId) => resolveClientConfig(providerId, process.env, PORT),
  // The same service, so client authentication and the token endpoint's timeout are one
  // implementation rather than two that drift.
  service: oauth,
  // A connection that needs a human is told to the workspace on the channel it already watches
  // for what it is connected to. A banner beats a run failing with somebody else's 401.
  onReauthRequired: (ctx, connection, reason) =>
    relay.broadcastProviders(ctx, {
      type: "notice",
      message: `the ${connection.connector_id} connection needs reconnecting — ${reason}`,
    }),
});

// WHAT EACH WORKSPACE IS HOLDING, SAMPLED HOURLY.
//
// The one billable thing here that is not an event: a stored object just sits there costing
// money for every hour nobody deletes it, so the only honest way to put it in an event log is
// to ask on a schedule and write down the cost of the interval. See billing/storage.ts for why
// metering bytes as they are WRITTEN — the version publish is an event, so it looks like it
// fits — bills the opposite of what an object store does.
//
// Once at boot and then hourly. The boot sample is what makes a restarting deployment still
// bill the hour it restarted in; the row is keyed by (workspace, clock hour), so a process that
// restarts four times in one hour records that hour once. Unref'd — a billing sampler must
// never be the reason a process will not exit.
const sampleStoredBytes = (): void => {
  void sampleStorage({
    meter,
    workspaceIds: () => bootIdentity.listWorkspaceIds(systemContext(newRequestId())),
    bytesHeld: (ctx) => agentRepo.storedBytes(ctx),
  }).catch((err) => console.error("[billing] storage sampling failed:", (err as Error)?.message ?? err));
};
sampleStoredBytes();
setInterval(sampleStoredBytes, SAMPLE_INTERVAL_MS).unref();

// AND WHAT EACH WORKSPACE HAS STOPPED BEING ENTITLED TO KEEP.
//
// `retentionDays` has been on every plan since Session 6, with a note saying Session 8 would
// enforce it; until this line it was a promise nothing kept. A trace holds the body of somebody's
// email and rows out of somebody's database, so "we keep it for fourteen days" has to be a thing
// that happens rather than a thing on a pricing page.
//
// DAILY, AND NOT AT BOOT. Every other sweeper in this file runs once at startup because it is
// reconciling something a crash left behind — this one is deleting data, and a deployment that
// restarts twenty times during an incident should not delete twenty times while somebody is
// trying to read a trace to work out what happened. Unref'd, like all of them.
const retention = new RetentionSweeper({
  db,
  workspaces: async (ctx) => {
    const ids = await bootIdentity.listWorkspaceIds(ctx);
    const out: { id: string; plan: string }[] = [];
    for (const id of ids) {
      const ws = await bootIdentity.workspaceById(systemContextFor(id, newRequestId()), id);
      out.push({ id, plan: ws?.plan ?? "free" });
    }
    return out;
  },
  // A workspace may have negotiated a longer retention than its plan gives. The same overrides
  // the budget gate reads, from the same row — two places deciding how long data lives would
  // eventually give two answers, and one of them would be the one somebody was promised.
  overridesFor: async (ctx) => (await billing.balance(ctx)).limit_overrides,
  checkpoints,
  objects,
  log: (line) => console.log(line),
});
const sweepRetention = (): void => {
  void retention
    .sweep()
    .then((report) => {
      const line = describeSweep(report);
      if (line) console.log(line);
    })
    .catch((err) => console.error("[retention] sweep failed:", (err as Error)?.message ?? err));
};
setInterval(sweepRetention, 24 * 3_600_000).unref();

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
  // BOTH pools, not just the interactive one: an eval job is reading the agent's files from
  // a subprocess right now, and rewriting them mid-flight would make the trace describe
  // code that never ran. `.busy` covers every slot in whichever pool it's asked of.
  canMutate: () =>
    runActive || interactivePool.busy || evalPool.busy
      ? "cannot modify the agent while a run is in progress"
      : null,
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
    {
      // §3.2. THE AGENT'S FILES AND RUNS GO; ITS THREADS DO NOT.
      //
      // The link is KEPT, and the row reads `stripe_webhook (deleted)` because the agents table
      // says the agent is deleted — see `noteAgentDeleted`. This used to null the foreign key, which
      // made a reversible cause (a soft delete `upsertFromDisk` undoes) trigger an irreversible
      // effect, so a directory that was briefly missing detached a live agent's sessions forever.
      // The snapshot name is still written here, because a HARD delete cascades the link away and
      // after that there is nowhere left to read the name from.
      //
      // This is the same discipline the rest of the product already holds to: a branch never mutates
      // its parent, an undo restores from a snapshot, an eval job persists before dispatch. Nothing
      // is destroyed as a side effect of something else being destroyed — a thread holds what was
      // thought, what was generated and what it cost, and that record outlives the artefact.
      onRemoved: async (agent) => {
        const kept = await threadStore.noteAgentDeleted(
          serverContext(),
          agent.id,
          agent.display_name ?? agent.slug,
        );
        if (kept > 0) {
          console.log(`[threads] kept ${kept} thread(s) of the removed agent ${agent.slug}`);
        }
      },
    },
  );
}
/**
 * Put an agent away, or bring it back — PS-01's missing lifecycle.
 *
 * WHY ARCHIVE AND NOT DELETE. An agent's versions, runs, traces, evals and costs are the record every
 * past comparison, every invoice line and every thread points at. A delete that took them would make
 * "tidy the sidebar" and "destroy the history" the same button; a delete that left them would leave
 * rows pointing at an agent that no longer exists, which is the state §3.2's `(deleted)` chip exists
 * to render and not one to manufacture on purpose. So this is the same answer threads got, for the
 * same reasons, and it is reversible in one command.
 *
 * NOTHING ELSE MOVES, and that is what makes it safe: no version is dropped, no run is closed, no
 * deployment is torn down, no thread is detached. An archived agent simply stops appearing in the
 * lists that offer work — the sidebar, the eval picker, the composer's targets, the deploy form —
 * because `AgentRepository.list` excludes it by default.
 *
 * A DEPLOYED AGENT IS REFUSED. Archiving one would take it out of every list while it is still
 * serving traffic in somebody's Railway account, which is precisely the "forgetting a record does not
 * stop the thing it described" trap the deploy panel is careful about. Cancel or forget the
 * deployment first — the refusal says so.
 */
async function setAgentArchived(ctx: TenantContext, agentId: string, archived: boolean): Promise<void> {
  const slug = String(agentId ?? "");
  // `includeArchived`, because restoring one has to be able to find it. `bySlug` cannot serve here:
  // it is the read every other command uses and it must keep meaning "a live agent".
  const agent = (await agentRepo.list(ctx, { includeArchived: true })).find((a) => a.slug === slug);
  if (!agent) {
    // ON THE `agents` CHANNEL, TO THE SOCKET THAT ASKED, and both halves changed with the Agents
    // tab. It was `broadcastLog`, which put a refusal about one person's click into the status bar
    // of every tab in the workspace — and left the surface that asked (the sidebar row, and now the
    // grid) waiting on an answer that had gone somewhere else entirely.
    refuseAgent(ctx, `no agent called ${slug} in this workspace`, slug);
    return;
  }
  if (archived) {
    const live = (await deployStore.currentByAgent(ctx)).get(agent.slug);
    if (live && live.status === "live") {
      refuseAgent(
        ctx,
        `${slug} is still serving at ${live.url ?? "a public URL"} — forget or cancel the deployment first`,
        slug,
      );
      return;
    }
  }
  if (!(await agentRepo.setArchived(ctx, agent.id, archived))) {
    // The row was already in the state that was asked for. Not an error — two tabs, or a second
    // click — and saying nothing is right, because the snapshot below already says the truth.
    await relay.broadcastAgents();
    await relay.broadcastAgentGrid();
    return;
  }
  console.log(`[agents] ${slug} ${archived ? "archived" : "restored"}`);
  await relay.broadcastAgents();
  await relay.broadcastAgentGrid();
  // The threads of this agent render its name and its chip, so their snapshot is stale the moment
  // this changes. Coalesced on the same timer every other thread-affecting transition uses.
  scheduleListRefresh(ctx);
}

/**
 * Give an agent a name a person chose.
 *
 * THE SLUG DOES NOT MOVE. It is the directory on disk, the key `datasets.agent_id` and
 * `eval_runs.agent_id` hold, the working directory of every job's subprocess, and the id every past
 * run row names — a rename that changed it would orphan all of that to change a label. What changes
 * is `display_name`, which is what the sidebar and every thread row actually render.
 *
 * Bounded by the same `TITLE_MAX` a thread title is, and for the same reason: it is rendered in a
 * sidebar row, a chip and a snapshot, and one definition of "a storable name" beats three.
 */
async function renameAgent(ctx: TenantContext, agentId: string, name: unknown): Promise<void> {
  const slug = String(agentId ?? "");
  const next = typeof name === "string" ? name.trim().slice(0, TITLE_MAX).trim() : "";
  if (!next) {
    refuseAgent(ctx, "an agent needs a name — Escape cancels the edit", slug);
    return;
  }
  const agent = (await agentRepo.list(ctx, { includeArchived: true })).find((a) => a.slug === slug);
  if (!agent) {
    refuseAgent(ctx, `no agent called ${slug} in this workspace`, slug);
    return;
  }
  await agentRepo.rename(ctx, agent.id, next);
  console.log(`[agents] ${slug} renamed to "${next}"`);
  await relay.broadcastAgents();
  await relay.broadcastAgentGrid();
  // Every thread of this agent renders the name. BUG-17 was exactly this going stale: a rename left
  // every thread row showing the old name beside a sidebar showing the new one.
  scheduleListRefresh(ctx);
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
  // NAMES, from the vault, for THIS workspace — not `process.env`, which asks whether the server
  // has a variable when the question is whether this tenant has the credential. The Secrets tab
  // makes the two visible side by side, which is what turned a latent divergence into one somebody
  // would report: a workspace whose key is plainly listed as configured, and a deploy refusing to
  // start because it could not see it.
  configuredNames: async () =>
    new Set((await secrets.listNames(contextForDeploy())).map((s) => s.name)),
  // The same pool-aware check the editor uses, and for a sharper version of the reason:
  // deploying WRITES into the project, so doing it while a subprocess is importing those
  // files would change code out from under a run in flight.
  agentBusy: () => runActive || interactivePool.busy || evalPool.busy,
  onStage: (e) => relay.broadcastDeploy(contextForDeploy(), { type: "stage", ...e }),
  onLog: (e) => relay.broadcastDeploy(contextForDeploy(), { type: "log", ...e }),
  onServeToken: (e) => relay.broadcastDeploy(contextForDeploy(), { type: "serveToken", ...e }),
  onFinished: (d) => {
    relay.broadcastDeploy(contextForDeploy(), {
      type: "finished",
      deploymentId: d.id,
      status: d.status,
      url: d.url,
      error: d.error,
    });
    // §4.3's `deployed` fragment is derived from the deploy store, so a deployment going live (or
    // stopping) changes what an idle thread on that agent says about itself — and nothing was
    // pushing a snapshot for it.
    scheduleListRefresh(contextForDeploy());

    // A BUILD OR A HEALTH GATE THAT FAILED IS WORK THAT IS STOPPED — §2.1, and Blocking. Raised
    // here rather than in the manager because this is where the outcome is already in hand, and
    // because the manager knows nothing about the Inbox and should not start to.
    //
    // ONE CARD PER DEPLOYMENT rather than per agent, which is the exception to the shape everything
    // else takes: a deploy is an attempt with its own build log, and `view logs` on a card that
    // collapsed two attempts could only ever show one of them.
    if (d.status === "failed") {
      const ctx = contextForDeploy();
      noteInbox(
        "a failed deploy",
        agentRepo.bySlug(ctx, d.agent_id).then((agent) =>
          noteDeployFailed(inboxDeps, ctx, {
            deploymentId: d.id,
            agentUuid: agent?.id ?? d.agent_id,
            agentName: agent?.display_name ?? d.agent_id,
            error: d.error,
          }),
        ),
      );
    }
  },
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
// generated it. That is the Session 3 half. Session 4 adds two more: the Python now runs through
// CodeCheckSandbox rather than a direct spawn (see graphIntrospect.ts), and the result is cached
// on the version row itself (introspectGraphCached), not only in this process's memory — a
// version's topology cannot change without the version changing, so a replica that has never
// even SEEN this agent before can still answer instantly once any replica has introspected it
// once.
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
        if (written.includes("agent.py")) {
          const store = {
            getGraphCache: (id: string, v: number) => agentRepo.getGraphCache(ctx, id, v),
            setGraphCache: (id: string, v: number, g: unknown) => agentRepo.setGraphCache(ctx, id, v, g),
          };
          return await introspectGraphCached(RUNTIME_DIR, agentId, agent.current_version, store, dir);
        }
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
// AND THE HEADERS EVERY ANSWER CARRIES. Session 8: CORS says which origins may READ a response,
// and this says what a browser may do with one once it has. They are different questions with
// different failure modes — see http/security.ts, including why HSTS rides on an explicit
// JAROKU_PUBLIC_TLS rather than on NODE_ENV.
const securityResponseHeaders = securityHeaders();
if (securityResponseHeaders["strict-transport-security"]) {
  console.log(`[server] HSTS: ${securityResponseHeaders["strict-transport-security"]}`);
}

// AND HOW OFTEN ANY OF IT MAY BE ASKED FOR.
//
// Redis when there is one, a Map when there is not — see http/rateLimit.ts, including why the
// in-memory version is honest rather than adequate once there are six replicas, and why
// `/healthz` and the sandbox control plane are deliberately not IP-limited.
const rateLimiter = openRateLimiter();
console.log(`[server] rate limiter: ${rateLimiter.kind}`);

// AND THE THING THAT JOINS FOUR PROCESSES INTO ONE STORY.
//
// A gateway replica answers the request, a queue holds the work, a worker on another machine
// picks it up, and a sandbox on a third machine calls home. Four request ids in four log streams
// describe the same second of somebody's afternoon and nothing joins them; a trace is the join.
// Inert with no JAROKU_OTLP_ENDPOINT — see obs/trace.ts on why inert rather than absent.
const { tracer, exporter: traceExporter } = openTracer("gateway");
if (traceExporter) console.log(`[server] tracing: exporting to ${process.env["JAROKU_OTLP_ENDPOINT"]}`);

// AND WHAT THE PLATFORM HAS OBSERVED, WHICH IS A DIFFERENT QUESTION FROM WHAT IT REFUSED.
//
// A rate limit answers one request. This accumulates a SHAPE — the four-minute sandbox that made
// no model calls, twice an hour, all week — because that is what a miner, a proxy farm and a
// spam sender each look like, and none of them is identifiable from a single event. It decides
// nothing: see abuse/signals.ts on why recording and enforcing are deliberately separate.
const abuse = new AbuseRepository(db);
// The key that turns an address into a subject digest. Reuses the object store's signing key,
// which every replica already has to share for presigned URLs to verify across them — a second
// key with the same requirement would be a second thing to get wrong at deploy time, and this
// one is never used to authenticate anything an attacker can present.
const abuseSubject = (address: string): string => subjectDigest(address, objectSigningKey);

/**
 * Write an observation down, and never let doing so break what was being observed.
 *
 * Floating and caught, exactly as `meterPlatformCall` is: every call site is on a path somebody
 * is waiting on, and a detector that could fail a run would be a detector that costs more than
 * the abuse. A missed signal is a slower detection; a run that died recording one is the product.
 */
function observe(ctx: TenantContext, signal: DetectedSignal): void {
  metrics.increment("abuse_signals_total", { kind: signal.kind });
  console.warn(`[abuse] ${ctx.workspaceId} ${signal.kind} (+${signal.weight}) ${JSON.stringify(signal.detail)}`);
  void abuse
    .record(ctx, signal)
    // AND THEN RE-DECIDE, but only after the row is in. Evaluating first would score the state
    // before the thing that just happened, which is exactly one signal short every time and
    // means the rung is always applied one observation late.
    .then(() => abuseGate.evaluate(ctx))
    .catch((err) => {
      console.error(`[abuse] failed to record ${signal.kind}:`, (err as Error)?.message ?? err);
    });
}

// AND WHAT IS DONE ABOUT AN ACCUMULATED SCORE — see abuse/enforcement.ts for the ladder, and in
// particular for why the machine may climb only as far as a reversible inconvenience. The two
// rungs that stop somebody working require a person, recorded by name on the row.
const enforcementRepo = new EnforcementRepository(db);
const abuseGate = new AbuseGate({
  signals: abuse,
  enforcement: enforcementRepo,
  // Told on the providers channel, which is where a workspace already learns what it may spend
  // and what it is connected with. A limit nobody is told about is a workspace whose runs simply
  // stop working, and a support ticket that begins with "is it broken".
  notify: (ctx, e) => relay.broadcastProviders(ctx, { type: "notice", message: e.message }),
  log: (line) => console.warn(line),
});

// HOW MANY WORKSPACES ARE UNDER A RUNG, WHICH NOTHING WAS ANSWERING.
//
// `workspaces_enforced` has been declared since commit 12 and carries an alert, and nothing had
// ever set it — so the alert could not fire and the panel was permanently empty, which is the
// state metrics.ts's own header calls "worse than no alert because it looks like cover".
//
// EVERY LEVEL IS SET, INCLUDING THE ZEROES. A gauge that is only written when it is non-zero
// never comes back DOWN: the last value stands forever, so a workspace that was suspended in
// March reads as suspended in June. Writing every rung each pass is what makes the series
// describe now rather than the last time something happened.
//
// Through `asPlatform`, because this is the query that returns nothing unscoped — see migration
// 032. It is also the reason this gauge is worth having: the number it reports is the one an
// operator would otherwise get by asking the database a question that silently answers "none".
const REPORTED_RUNGS = ["watch", "soft_limit", "verify", "suspended", "blocked"] as const;
const sampleEnforcement = async (): Promise<void> => {
  const rows = await enforcementRepo.workspacesAt(systemContext(newRequestId()), REPORTED_RUNGS);
  const byLevel = new Map<string, number>(REPORTED_RUNGS.map((l) => [l, 0]));
  for (const row of rows) byLevel.set(row.level, (byLevel.get(row.level) ?? 0) + 1);
  for (const [level, n] of byLevel) metrics.set("workspaces_enforced", n, { level });
};
await sampleEnforcement().catch((err) =>
  console.error("[abuse] could not sample enforcement:", (err as Error)?.message ?? err),
);
setInterval(() => {
  void sampleEnforcement().catch((err) =>
    console.error("[abuse] could not sample enforcement:", (err as Error)?.message ?? err),
  );
}, 5 * 60_000).unref();

const router = new Router({
  cors: originPolicy,
  securityHeaders: securityResponseHeaders,
  // TIER ONE. Continues an incoming `traceparent` when there is one — a browser or a sandbox
  // that already has a trace — and starts a root when there is not. The run id goes on when the
  // path names one, because that is the attribute the other three tiers are correlated by.
  trace: async (req, run) =>
    tracer.in(
      `${req.method} ${req.path}`,
      {
        parent: parseTraceparent(req.header("traceparent")),
        attributes: {
          "http.method": req.method,
          "http.route": req.path,
          "jaroku.request_id": req.requestId,
          "jaroku.run_id": runIdFromPath(req.path),
        },
      },
      async (span) => {
        const startedAt = Date.now();
        const out = await run();
        span.set("http.status_code", out.status);
        if (out.status >= 500) span.set("error", true);
        // AND THE AGGREGATE, beside the trace. The span explains this request; these two explain
        // all of them. `routeLabel` collapses the ids out of the path — a run id as a label is
        // the standard way a metrics backend falls over.
        const route = routeLabel(req.path);
        metrics.increment("http_requests_total", { route, status: statusClass(out.status) });
        metrics.observe("http_request_seconds", (Date.now() - startedAt) / 1000, { route });
        return out;
      },
    ),
  // THE PER-IP LAYER. Per-workspace-per-action is the other half and lives on the socket, where
  // the workspace is — see the command gate below.
  beforeHandle: async (req) => {
    const action = ipRuleFor(req.path);
    if (!action) return;
    const address = clientAddress(
      { forwardedFor: req.header("x-forwarded-for"), realIp: req.header("x-real-ip") },
      req.ip,
    );
    // FAILS OPEN, exactly as the socket path does and for the same reason — see `admitCommand`.
    // This half did not: `take` was awaited bare, so a limiter that could not answer turned every
    // request into a 500 rather than letting it through. Worse before the limiter grew a timeout,
    // because it did not answer at ALL and this line runs OUTSIDE the router's handler deadline:
    // one unreachable Redis and the gateway stops responding to anything.
    //
    // A limiter is a protection against volume, not a boundary against a person. Every actual
    // authorisation happens further in and is untouched by this.
    let decision;
    try {
      decision = await rateLimiter.take(action, address);
    } catch (err) {
      console.error(`[rate] limiter failed for ${action}, admitting:`, (err as Error)?.message ?? err);
      return;
    }
    if (decision.ok) return;
    console.warn(`[rate] ${address} refused ${action} for ${retryAfterSeconds(decision)}s`);
    metrics.increment("rate_limited_total", { action });
    // SIGNUP VELOCITY IS THE ONE OBSERVATION MADE BEFORE A WORKSPACE EXISTS, so it is recorded
    // against a keyed digest of the address rather than a tenant. Recorded only for the signup
    // bucket: a browser reconnecting too fast is a client with a loop, not a farm.
    if (action === "auth.signup" || action === "auth.session") {
      const sys = systemContext(req.requestId);
      void abuse
        .recordForSubject(sys, abuseSubject(address), {
          kind: "signup.velocity",
          weight: SIGNALS["signup.velocity"].weight,
          detail: { action },
        })
        .catch((err) => console.error("[abuse] failed to record signup velocity:", (err as Error)?.message ?? err));
    }
    throw tooMany(rateRefusal(decision), retryAfterSeconds(decision), {
      "x-ratelimit-limit": String(decision.limit),
      "x-ratelimit-remaining": "0",
    });
  },
});
router.get("/healthz", healthz());
// THE SCRAPE ENDPOINT.
//
// Bearer-authenticated when JAROKU_METRICS_TOKEN is set, and refused entirely in production when
// it is not. The numbers here are not secrets in the way a credential is — but queue depths,
// spend and enforcement counts are a description of the business, and an unauthenticated
// `/metrics` on a public origin is that description published. Constant-time comparison for the
// same reason the deployed agent's bearer check is: a token compared with `===` leaks its prefix.
router.get("/metrics", (req) => {
  const expected = process.env["JAROKU_METRICS_TOKEN"];
  if (!expected) {
    if (process.env["NODE_ENV"] === "production") {
      throw forbidden("set JAROKU_METRICS_TOKEN to expose metrics on this deployment");
    }
  } else {
    const presented = (req.header("authorization") ?? "").replace(/^Bearer\s+/i, "");
    const a = Buffer.from(presented);
    const b = Buffer.from(expected);
    if (a.length !== b.length || !timingSafeEqual(a, b)) throw unauthorized("bad metrics token");
  }
  return {
    body: Buffer.from(metrics.render(), "utf8"),
    // The exposition format's own content type, version and all — a scraper checks it.
    headers: { "content-type": "text/plain; version=0.0.4; charset=utf-8" },
  };
});
router.get(
  "/readyz",
  readyz({ dialect: db.dialect, probe: () => db.get(`SELECT 1 AS ok`) }),
);

// THE CONTROL PLANE A HOSTED SANDBOX'S RUNNER CALLS HOME TO — see sandbox/controlPlaneRoutes.ts.
// Registered unconditionally, not only under JAROKU_RUN_SANDBOX=fly: the routes are inert
// without a run token to present (runEventBus has no entries for a local-only server, since
// runPool.ts never registers one without both a workspaceId and a configured control plane), so
// there is nothing to gain and a live/ready toggle to lose by making this conditional.
// Both pools share this SAME bus (see poolOpts above), so there is exactly one to register.
const traceIngestMetrics = new TraceIngestMetrics();
const traceBackpressure = new BackpressureTracker();
registerControlPlaneRoutes(router, {
  bus: runEventBus,
  signingKey: runTokenSigningKey,
  revocations: runTokenRevocations,
  metrics: traceIngestMetrics,
  backpressure: traceBackpressure,
  onBackpressureViolation: (runId, reason) => {
    console.warn(`[trace-ingest] ${runId} ${reason} — stopping the run`);
    // Which pool the offending run is in isn't known here — stop() on the wrong one is
    // already a documented no-op (runPool.ts), so asking both is simpler than tracking it.
    interactivePool.stop(runId);
    evalPool.stop(runId);
  },
  // The hosted twin of the local "tool_confirm" control-line handler further down this file —
  // same pendingConfirms registration, same broadcast shape, so the UI's modal cannot tell
  // which kind of run it is looking at. Deferred to a function so it can close over
  // pendingConfirms/confirmKey/relay, all declared later in this module but not called before
  // the server actually starts accepting requests.
  onMcpConfirmRequested: (runId, payload) => handleHostedMcpConfirmRequest(runId, payload),
});

function handleHostedMcpConfirmRequest(runId: string, payload: Record<string, unknown>): void {
  const nonce = typeof payload.nonce === "string" ? payload.nonce : "";
  if (!nonce) return;
  const runCtx = contextForRun(runId);
  const server = String(payload.server ?? "unknown");
  const tool = String(payload.tool ?? "unknown");
  pendingConfirms.set(confirmKey(runId, nonce), {
    runId, workspaceId: runCtx.workspaceId, nonce, server, tool, requestedAt: Date.now(),
  });
  console.log(`[mcp] ${runId} is waiting for confirmation of ${server}/${tool} (hosted)`);
  relay.broadcastMcp(runCtx, {
    type: "confirmRequest",
    runId,
    nonce,
    server,
    tool,
    impactReason: String(payload.impact_reason ?? "it is classified high-impact"),
    args: String(payload.args ?? "{}"),
    timeoutS: typeof payload.timeout_s === "number" ? payload.timeout_s : 120,
    requestedAt: new Date().toISOString(),
  });
}

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
const contextResolver = new ContextResolver({
  identity: identityRepo,
  // THE HEAVIEST SIGNAL ON THE LIST, and the only one that is not about resources: somebody
  // asking to act in a workspace they are not a member of. The audit row is written inside the
  // resolver; this is the part that accumulates, so a single probe is visible as a probe and a
  // hundred of them is visible as an attack.
  // THE COUNTER WHOSE EXPECTED VALUE IS ZERO, and whose alert fires on any non-zero value with
  // no threshold and no window. See obs/slo.ts: a threshold here would be a decision that some
  // cross-tenant attempts are acceptable.
  //
  // On `onCrossTenantAttempt` rather than beside the signal below, which is the difference
  // between counting the probes and counting the thirty-second windows they arrived in. See the
  // resolver: a negative membership decision is cached, and this used to be gated on that cache.
  onCrossTenantAttempt: () => metrics.increment("cross_tenant_denials_total", { reason: "not_a_member" }),
  onCrossTenantDenial: ({ workspaceId, userId, requestId }) => {
    observe(systemContextFor(workspaceId, requestId), {
      kind: "tenancy.cross_denied",
      weight: SIGNALS["tenancy.cross_denied"].weight,
      detail: { userId },
      targetType: "workspace",
      targetId: workspaceId,
    });
  },
});
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
  // FAILS OPEN, like every other limiter call in this file — see rateLimit.ts. A workspace is a
  // tenancy rather than a row, so it is worth a bucket; a Redis blip is not worth being the
  // reason nobody can make one.
  limitWorkspaceCreate: async (userId) => {
    try {
      const decision = await rateLimiter.take("workspace.create", userId);
      if (!decision.ok) {
        metrics.increment("rate_limited_total", { action: "workspace.create" });
        return retryAfterSeconds(decision);
      }
    } catch (err) {
      console.error("[rate] limiter failed for workspace.create, admitting:", (err as Error)?.message ?? err);
    }
    return null;
  },
})) {
  if (route.method === "GET") router.get(route.path, route.handler);
  else router.post(route.path, route.handler);
}

// BILLING'S TWO HTTP SURFACES, and neither could have been a socket command.
//
// The checkout answers with a URL the browser has to NAVIGATE to, which is not a message shape.
// The webhook is unauthenticated by construction — a payment provider cannot present a bearer
// token and has no socket — so its SIGNATURE is its authentication, checked over the raw bytes
// before anything parses them. See http/billing.ts.
for (const route of billingRoutes({
  billing,
  identity: identityRepo,
  // Read per request, not captured: the same reason every other override in this codebase is a
  // function. A deployment that configures Stripe should not need a restart to start selling.
  config: () => stripeConfigFromEnv(),
  contextFor: async (req) => {
    const auth = await authenticate(req, tokenVerifier);
    const body = await req.json<{ workspaceId?: unknown }>();
    const requested = typeof body.workspaceId === "string" && body.workspaceId ? body.workspaceId : null;
    // Through the resolver, exactly like `/v1/ws-ticket`. Nothing below this line sees a
    // workspace id the client chose, which for a route that starts a PAYMENT matters rather more
    // than for one that opens a socket.
    return (await contextResolver.resolve(auth, requested, req.requestId, req.ip)).context;
  },
  emailFor: async (ctx) =>
    ctx.actorUserId ? ((await identityRepo.userById(ctx, ctx.actorUserId))?.email ?? null) : null,
  // Told on the providers channel, which is where a workspace already learns what it is
  // connected to and what it is paying with. A failed renewal is exactly the kind of thing that
  // must not wait for somebody to open a settings page.
  notify: (ctx, e) =>
    relay.broadcastProviders(ctx, {
      type: "notice",
      message:
        e.kind === "attention"
          ? `a payment for this workspace did not go through (${e.status}) — update the card before the retries run out`
          : `this workspace is now on the ${e.plan} plan`,
    }),
})) {
  router.post(route.path, route.handler);
}

// THE OAUTH CALLBACK, and it is the one route here a third party drives.
//
// Unauthenticated by construction, exactly as the payment webhook is: a provider redirects a
// BROWSER back to us, carrying no bearer token and no socket, and the single-use `state` we
// handed out ten minutes ago is the whole of the authentication. See http/oauth.ts, which is
// also where the reasoning lives for why every outcome ends in a redirect rather than in JSON.
for (const route of oauthRoutes({
  oauth,
  providerIds: [GOOGLE.id, SLACK.id],
  // A completed flow updates every socket in that workspace, not only the tab that was
  // redirected — somebody can start a flow on a phone and finish it there while the panel is
  // open on a laptop, and a panel that still says "not connected" is a panel people click twice.
  onCompleted: (result) => {
    const ctx = systemContextFor(result.workspaceId, newRequestId());
    void broadcastConnections(ctx);
    if (result.missingScopes.length) {
      relay.broadcastConnections(ctx, {
        type: "notice",
        connectorId: result.connection.connector_id,
        message:
          `${result.connection.connector_id} connected, but without ${result.missingScopes.join(", ")} — ` +
          `the tools that need those scopes will fail until it is reconnected with them granted`,
      });
    }
  },
  onFailed: (message) => console.warn(`[connections] a flow failed: ${message}`),
})) {
  router.get(route.path, route.handler);
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

// AND THE DELETER, constructed here because it needs everything: the rows, the objects, the
// checkpoints, the queue, and the revoker that ends grants at the providers themselves.
const workspaceDeleter = new WorkspaceDeleter({
  db,
  identity: identityRepo,
  objects,
  checkpoints,
  endGrants: async (ctx) => {
    const ended = await endAllGrants(ctx, {
      revoker: connectionRevoker,
      secrets,
      // The names this workspace's MCP credentials live under. Deleted rather than revoked —
      // an MCP token is a bearer value somebody pasted, and there is no endpoint to hand it back
      // to. See oauth/revoke.ts.
      mcpAuthKeys: async () => (await mcpStore.listServers(ctx)).map((s) => s.auth_env_key).filter((k): k is string => Boolean(k)),
    });
    // `already_gone` counts as revoked, because it is the same outcome — the grant does not
    // exist at the far end. `unsupported` and `unreachable` do NOT: the first means the provider
    // publishes no revocation endpoint and the grant is standing until a human removes it in
    // their account, and the second means we could not tell it. Both belong in the receipt as
    // failures, because a deletion that reports them as successes is the dishonest one.
    const done = ended.connections.filter((r) => r.remote === "revoked" || r.remote === "already_gone" || r.remote === "no_credential");
    return {
      revoked: done.length,
      failed: ended.connections
        .filter((r) => !done.includes(r))
        .map((r) => `${r.remote}: ${r.message ?? "the provider could not be told"}`),
      credentialsDeleted: ended.mcpCredentialsDeleted,
    };
  },
  // Best-effort, and only what has not started. A job already admitted is running against files
  // that still exist for as long as it takes to finish, which is the same rule every ceiling in
  // this codebase follows: bound what is started, never what is running.
  purgeQueue: async (ctx) => {
    let purged = 0;
    for (const jobClass of ["run.eval", "judge", "mcp.discover", "workspace.export"] as JobClass[]) {
      purged += await dispatcher.backend.purgeWorkspace(jobClass, ctx.workspaceId).catch(() => 0);
    }
    return purged;
  },
});

// A WORKSPACE ASKING FOR EVERYTHING IT HAS — see http/lifecycle.ts for why this is HTTP rather
// than a socket command, and why the status check needs no job table.
for (const route of lifecycleRoutes({
  objects,
  contextFor: async (req) => {
    const auth = await authenticate(req, tokenVerifier);
    const requested = req.url.searchParams.get("workspace");
    // Through the resolver, exactly like every other authenticated route: nothing below this
    // line sees a workspace id the client chose.
    return (await contextResolver.resolve(auth, requested, req.requestId, req.ip)).context;
  },
  enqueueExport: async (ctx, exportId) => {
    await dispatcher.enqueue(
      EXPORT_CLASS,
      ctx.workspaceId,
      { exportId },
      // Keyed by the export id, so a redelivered admission is the same unit of work rather than
      // a second archive of the same bytes.
      { idempotencyKey: buildIdempotencyKey(EXPORT_CLASS, ctx.workspaceId, exportId) },
    );
  },
  // AND THE OTHER HALF OF A DATA LIFECYCLE: taking it all away, everywhere it is.
  //
  // Rows, objects, checkpoints, queued work, and — the half nobody remembers — the grants at
  // somebody else's company. Session 7 built `endAllGrants` and called it the provider-side half
  // of the deletion this session owns; this is where the two meet.
  deleteWorkspace: (ctx) => workspaceDeleter.deleteWorkspace(ctx),
  audit: async (ctx, action, detail) => {
    await identityRepo.appendAudit(ctx, {
      action,
      targetType: "workspace",
      targetId: ctx.workspaceId,
      metadata: detail,
    });
  },
})) {
  if (route.prefix) router.prefixRoute(route.method, route.path, route.handler);
  else if (route.method === "GET") router.get(route.path, route.handler);
  else router.post(route.path, route.handler);
}

// THE SECRETS GROUP, and it is HTTP rather than socket commands for a reason worth stating.
//
// Everything else the product does goes down the WebSocket. This does not, because the elevation
// token has to ride on a request header — a browser cannot set one on a WebSocket, which is the
// same constraint that put the auth exchange on HTTP in the first place. Putting the gate on the
// socket would mean inventing a per-frame authorisation, which is a header with extra steps.
const secretPasscodes = new SecretPasscodes({ passcodes: new SecretPasscodeRepository(db) });
const secretElevations = new SecretElevations({ elevations: new SecretElevationRepository(db) });
const secretUsages = new SecretUsageRepository(db);
const secretsManager = new SecretsManager({ secrets, refs: secretRefs, usages: secretUsages });

// The one place in this process that ever holds a GitHub token as a value, and the one place that
// hands out a client without one. Everything else — push, pull, fetch, link — asks it for an api
// and never learns what is behind it. See githubIdentity.ts.
const githubRepo = new GithubRepository(db);
const githubIdentity = new GithubIdentity({
  repo: githubRepo,
  secrets,
  // Through the MANAGER rather than straight to the store, so the token appears in the Secrets tab
  // beside every other credential — classified, masked, with a rotation history. A value written
  // directly to the vault would be invisible in the one place somebody goes to audit what a
  // workspace holds.
  //
  // `managed` rather than `custom`: the verbs that apply to it are connect and disconnect, exactly
  // as they are for a connector's OAuth token. Offering Rotate on a row whose value Jaroku cannot
  // mint would be offering an action that ends in a paste box either way.
  store: (ctx, input) =>
    secretsManager.store(ctx, {
      name: input.name,
      value: input.value,
      kind: "managed",
      provider: input.provider,
      actorUserId: input.actorUserId,
    }),
  forget: (ctx, name) => secretsManager.revoke(ctx, name),
  // READ PER CALL, NOT CAPTURED. Registration writes the App's credentials into this process as
  // well as into runtime/.env, and a config captured at boot would leave the server believing it
  // has no App on the very request that just finished creating one.
  app: () => githubAppConfig(),
});
// The hole punched at the store's construction, filled now that there is something to fill it
// with. A run that reads a credential records WHERE, not just when.
recordRuntimeRead = async (workspaceId, names) => {
  await secretsManager.recordRuntimeReads(systemContextFor(workspaceId, newRequestId()), names);
};

/**
 * How recently somebody must have authenticated for a step-up route to accept them.
 *
 * Five minutes. Long enough that "sign in, then set your passcode" is one flow rather than a race,
 * short enough that a token minted this morning is not a fresh sign-in this afternoon.
 */
const STEP_UP_MAX_AGE_S = 5 * 60;

mountSecretsRoutes(router, {
  callerFor: async (req): Promise<SecretsCaller> => {
    const bearer = TokenVerifier.bearer(req.header("authorization")) ?? "";
    const auth = await authenticate(req, tokenVerifier);
    const requested = req.url.searchParams.get("workspace");
    // Through the resolver, exactly like every other authenticated route: nothing below this line
    // sees a workspace id the client chose. Elevation is an ADDITIONAL gate and never a
    // replacement for this one.
    const session = await contextResolver.resolve(auth, requested, req.requestId, req.ip);
    const nowS = Math.floor(Date.now() / 1000);
    return {
      ctx: session.context,
      userId: session.userId,
      // Derived from the token the request already carries, so signing out ends every elevation
      // it held without anything having to watch for a sign-out. See secrets/elevation.ts.
      sessionId: sessionIdFor(bearer),
      // NULL IS NOT FRESH. An issuer that will not say when somebody last authenticated cannot
      // satisfy a step-up, because treating silence as "recently" makes the gate a formality
      // against exactly the providers it cannot verify.
      reauthenticatedRecently:
        auth.authenticatedAt !== null && nowS - auth.authenticatedAt <= STEP_UP_MAX_AGE_S,
      ip: req.ip,
      userAgent: req.header("user-agent") ?? null,
    };
  },
  elevations: secretElevations,
  passcodes: secretPasscodes,
  gateFor: (ctx) => identityRepo.secretsGate(ctx),
  audit: async (caller, action, detail) => {
    await identityRepo.appendAudit(caller.ctx, {
      action,
      targetType: "workspace",
      targetId: caller.ctx.workspaceId,
      // USER-AGENT IN THE METADATA, because there is no column for it and `audit_log` is
      // append-only and shared. "Which browser was the credential-stuffing coming from" is asked
      // while an incident is open, and `ip` alone does not answer it.
      metadata: { ...detail, userAgent: caller.userAgent },
      ip: caller.ip,
    });
  },
  health: async (ctx) => {
    const counts = await secretRefs.health(ctx);
    return { ...counts };
  },
  limitElevation: async (caller) => {
    // TWO BUCKETS, and both FAIL OPEN — the limiter is a protection against volume, not the
    // boundary against a person. That boundary is the passcode ladder, which is unaffected by
    // whether Redis is answering. See rateLimit.ts for why a bare `await take()` here would turn
    // an unreachable Redis into an outage on this route.
    for (const [action, subject] of [
      ["secrets.elevation.user", caller.userId],
      ["secrets.elevation.ip", caller.ip ?? "unknown"],
    ] as const) {
      let decision;
      try {
        decision = await rateLimiter.take(action, subject);
      } catch (err) {
        console.error(`[rate] limiter failed for ${action}, admitting:`, (err as Error)?.message ?? err);
        continue;
      }
      if (!decision.ok) {
        metrics.increment("rate_limited_total", { action });
        return retryAfterSeconds(decision);
      }
    }
    return null;
  },
  list: (ctx) => secretsManager.list(ctx),
  // `actorUserId` is ATTRIBUTION, never authorisation — the capability check upstream is what
  // decided this may happen. See ADR-018.
  store: (caller, input) => secretsManager.store(caller.ctx, { ...input, actorUserId: caller.userId }),
  revoke: (caller, name) => secretsManager.revoke(caller.ctx, name),
  test: (caller, name) => secretsManager.test(caller.ctx, name),
  isReferenced: (ctx, name) => secretsManager.isReferenced(ctx, name),
  // THE STATIC HALF IS REFRESHED BEFORE THE ANSWER, so a revoke decision is made against the
  // agent's source as it is now rather than as it was when somebody last opened this. Scanning is
  // a substring walk over one version's files — cheap enough to do on demand, which is why there
  // is no background job here to schedule, monitor and forget.
  usage: async (caller, name) => {
    for (const agent of await agentRepo.list(caller.ctx)) {
      if (!agent.current_version) continue;
      try {
        const files = await projects.readCurrent(caller.ctx, agent.id, agent.current_version);
        await secretsManager.rescanAgent(caller.ctx, agent.id, files);
      } catch (err) {
        // One unreadable agent must not make the whole Usage view fail. What it costs is that
        // agent's static hits, and the runtime reads — the half that records what actually
        // happened — are unaffected.
        console.warn(`[secrets] could not scan ${agent.id}:`, (err as Error)?.message ?? err);
      }
    }
    return secretsManager.usage(caller.ctx, name);
  },
  // WHEN THIS CREDENTIAL WAS REPLACED, AND WHY. Recorded on every rotation since the vault landed
  // and read by nothing until now — see the route's own note. No value, and no scan: this is a
  // straight read of rows the rotation path already wrote.
  rotations: (caller, name) => secretRefs.rotations(caller.ctx, name),
  // ADR-035. The guard has already established that this request is elevated; this turns that into
  // the RECEIPT the vault demands, which is a value no request body can produce. A token that has
  // expired between the guard and here yields no receipt and therefore no credential.
  reveal: async (req, caller, name) => {
    const receipt = await secretElevations.receiptFor(caller.ctx, {
      userId: caller.userId,
      sessionId: caller.sessionId,
      token: req.header(ELEVATION_HEADER) ?? "",
    });
    if (!receipt) return null;
    return secretsManager.reveal(receipt, name);
  },
  limitReveal: async (caller) => {
    // Fails open, like every other limiter call in this file — see rateLimit.ts. The boundary here
    // is elevation and the capability check, not the bucket.
    try {
      const decision = await rateLimiter.take("secrets.reveal", caller.userId);
      if (!decision.ok) {
        metrics.increment("rate_limited_total", { action: "secrets.reveal" });
        return retryAfterSeconds(decision);
      }
    } catch (err) {
      console.error("[rate] limiter failed for secrets.reveal, admitting:", (err as Error)?.message ?? err);
    }
    return null;
  },
  // The two credential routes the GitHub feature needs, and the only two of its surfaces that are
  // HTTP. Everything else it does rides the socket, because everything else it does is about a
  // repository rather than about a token.
  github: {
    connect: (caller, token) => githubIdentity.connect(caller.ctx, token),
    disconnect: (caller) => githubIdentity.disconnect(caller.ctx),
  },
  notifyLockout: async (caller, until) => {
    // NO MAILER EXISTS IN THIS SERVER, and one invented for this single notification would be a
    // transport nothing else exercises. The durable record is the `secrets.locked_out` audit row,
    // already written by the caller. This is the seam a deployment with mail plugs into, and until
    // then it is a warning on the operator's own log.
    console.warn(
      `[secrets] ${caller.userId} in ${caller.ctx.workspaceId} is locked out of secrets until ${until ?? "unknown"}`,
    );
  },
});

const relay = new WsRelay({
  port: PORT,
  store,
  router,
  originPolicy,
  clientHtmlPath: join(SERVER_DIR, "debug-client.html"),
  // Session 5: fan every local broadcast out to any other gateway replica. A no-op call when
  // eventBridge is undefined — see its own construction above.
  onBroadcast: eventBridge ? (ctx, payload) => eventBridge.publish(ctx.workspaceId, payload) : undefined,
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
    // ARCHIVED AGENTS ARE INCLUDED AND FLAGGED. The sidebar's Archived tab has to be able to show
    // them and offer Restore, and every other consumer of this snapshot looks an agent up by id —
    // including whichever one is selected, which must keep rendering if it happens to be archived.
    // What excludes them is the LIST that offers work, in the browser, at one filter point.
    return (await agentRepo.list(ctx, { includeArchived: true })).map((a) => {
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
        archived_at: a.archived_at,
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
  // §4's grid, with every card's tags already derived — see `agentGridSnapshot` for why deriving
  // them here rather than in the browser is a correctness requirement and not an optimisation.
  listAgentGrid: (ctx) => agentGridSnapshot(ctx),
  // Scoped, so another workspace's agent id is indistinguishable from one that does not exist (§7.3).
  loadAgentDetail: (ctx, agentId) => agentDetail(ctx, agentId),
  loadAgentVersion: (ctx, agentId, version) => agentVersionFiles(ctx, agentId, version),
  // The list and the counts together, so the chips and the nav badge are one number — §2.1.
  listThreads: (ctx) => threadSnapshot(ctx),
  // §2.2's `unreviewed_failures` leaves when any one of its traces is opened, and this is the one
  // path into a trace from any of the four surfaces that offer one. The card resolves because the
  // work was done rather than because the card was pressed, which is Law 2 in one wire.
  onTraceOpened: (ctx, runId) =>
    noteInbox("that a trace was opened", noteTraceOpened(inboxDeps, ctx, runId)),
  // Scoped, so another workspace's thread id is indistinguishable from one that does not exist.
  // The items come back with the row, because opening a thread that renders somebody else's
  // conversation is the failure §4.5 exists to prevent — see ThreadEvent's `thread` member.
  loadThread: async (ctx, threadId) =>
    (await threadStore.get(ctx, threadId))
      ? { thread: await threadView(ctx, threadId), items: await threadStore.itemsFor(ctx, threadId) }
      : undefined,
  // §4.3's author column needs names, and nothing ever asked for them — see the relay's own note
  // at the initial snapshot. Answered only for a Team workspace: in a personal one the column does
  // not exist, so the list would be a payload on every connection that nothing renders.
  listMembers: async (ctx) => {
    const ws = await bootIdentity.workspaceById(ctx, ctx.workspaceId);
    if (ws?.kind !== "team") return undefined;
    const [members, invites] = await Promise.all([
      identityRepo.listMembers(ctx),
      identityRepo.listInvites(ctx),
    ]);
    return { members, invites };
  },
  // By name only, and per WORKSPACE. The client learns THAT a key is set, never what it is —
  // and learns it about its own workspace rather than about the machine.
  listProviders: (ctx) => providerSnapshot(ctx),
  // Same: env_keys are names, railwayConfigured is a boolean. No value crosses this.
  listDeployments: (ctx) => deploySnapshot(ctx),
  // THE ASKING SOCKET'S WORKSPACE, forwarded rather than discarded.
  //
  // The relay resolves a context per connection; before this it was thrown away here and
  // every handler reached for the server's own instead. With one workspace the two are the
  // same object, which is exactly why it would have gone unnoticed until it was not.
  onCommand: (cmd: ForwardedCommand, ctx: TenantContext) => void dispatchCommand(cmd, ctx),
});

/**
 * Every socket command, after the per-workspace rate limit has had its say.
 *
 * THE PER-WORKSPACE HALF OF THE RATE LIMIT IS HERE rather than at the edge, and that is the
 * reason it exists at all: only this process knows that `generate` costs a model call that
 * writes a whole project while `listDatasets` costs a SELECT. A WAF sees one socket and one
 * frame either way.
 *
 * Checked once, before dispatch, so there is a single place to read for "what is bounded" — and
 * a command with no rule falls through untouched, which is most of them and is deliberate: a
 * limit on reading is a limit on the UI working.
 */
async function dispatchCommand(cmd: ForwardedCommand, ctx: TenantContext): Promise<void> {
  if (!(await admitCommand(ctx, cmd))) return;
  {
    if (cmd.cmd === "run") void runAgent(ctx, cmd.input, cmd.provider, cmd.model, cmd.agentId, undefined, cmd.threadId);
    else if (cmd.cmd === "generate") generateAgent(ctx, cmd);
    else if (cmd.cmd === "planAgent") planAgent(ctx, cmd);
    else if (cmd.cmd === "discardPlan") planner.discard(ctx.workspaceId, cmd.planId);
    else if (cmd.cmd === "edit") void editAgent(ctx, cmd.agentId, cmd.instruction, cmd.threadId);
    else if (cmd.cmd === "applyEdit") void editor.apply(ctx, cmd.proposalId);
    else if (cmd.cmd === "undoEdit") void editor.undo(ctx, cmd.agentId);
    else if (cmd.cmd === "discardEdit") void editor.discard(ctx, cmd.proposalId);
    else if (cmd.cmd === "pauseRun") void pauseRun(ctx, cmd.runId);
    else if (cmd.cmd === "resumeRun") void resumeRun(ctx, cmd.runId);
    else if (cmd.cmd === "cancelRun") void cancelRun(ctx, cmd.runId);
    else if (cmd.cmd === "branchRun") void branchRun(ctx, cmd.fromRunId, cmd.atSeq, cmd.editNode, cmd.editedState);
    else if (cmd.cmd === "explain") explainAgent(ctx, cmd);
    else if (AGENT_COMMAND_NAMES.has(cmd.cmd)) void handleAgentCommand(ctx, cmd as AgentCommand);
    else if (MCP_COMMAND_NAMES.has(cmd.cmd)) void handleMcpCommand(ctx, cmd as McpCommand);
    else if (DEPLOY_COMMAND_NAMES.has(cmd.cmd)) void handleDeployCommand(ctx, cmd as DeployChannelCommand);
    else if (GITHUB_COMMAND_NAMES.has(cmd.cmd)) void handleGithubCommand(ctx, cmd as GithubCommand);
    else if (PROVIDER_COMMAND_NAMES.has(cmd.cmd)) void handleProviderCommand(ctx, cmd as ProviderCommand);
    else if (CONNECTION_COMMAND_NAMES.has(cmd.cmd)) void handleConnectionCommand(ctx, cmd as ConnectionCommand);
    else if (MEMBER_COMMAND_NAMES.has(cmd.cmd)) void handleMemberCommand(ctx, cmd as MemberCommand);
    else if (cmd.cmd === "listAudit") void sendAuditLog(ctx, cmd.limit);
    else if (cmd.cmd === "loadEnforcement") void broadcastEnforcement(ctx);
    else if (cmd.cmd === "appealEnforcement") void appealEnforcement(ctx, cmd.note);
    else if (THREAD_COMMAND_NAMES.has(cmd.cmd)) void handleThreadCommand(ctx, cmd as ThreadCommand);
    else if (cmd.cmd === "loadUsage") void broadcastUsage(ctx);
    else if (cmd.cmd === "setSpendCeiling") void setSpendCeiling(ctx, cmd.usd);
    else void handleEvalCommand(ctx, cmd);
  }
}

/**
 * Which bucket a command spends from, or null for one that costs a query and nothing else.
 *
 * A TABLE RATHER THAN A CHECK PER HANDLER, for the reason `capabilities.ts` is a table: the
 * useful question is "what is limited", asked of all of them at once, and fifteen scattered
 * checks answer it only for whoever reads all fifteen.
 */
const COMMAND_RATE_ACTIONS: Partial<Record<string, RateAction>> = {
  generate: "agent.generate",
  planAgent: "agent.plan",
  edit: "agent.edit",
  explain: "agent.explain",
  run: "run.start",
  branchRun: "run.start",
  resumeRun: "run.start",
  startEval: "eval.start",
  // DEPLOY WAS MISSING, and it is the one in its family that consumes. `enforcement.ts` says a
  // rung takes away "the ability to CONSUME: to start runs, evals, generations and deploys" —
  // three of those four were gated. A suspended workspace could still build an image and leave a
  // service running, which is the most durable thing on the list: a run ends by itself and a
  // deploy costs until somebody tears it down.
  //
  // Its siblings stay ungated on purpose. `planDeploy` reads the project directory and calls no
  // model, `loadDeployLogs` and `listDeployments` are reads, and `cancelDeploy` and
  // `forgetDeployment` REDUCE what is running — refusing those under a rung would trap a
  // workspace with a deploy it is not allowed to stop.
  deploy: "deploy.start",
  addMcpServer: "mcp.discover",
  rediscoverMcpServer: "mcp.discover",
  inviteMember: "member.invite",
  connectConnector: "connector.connect",
};

/**
 * Spend a token for this command, and tell whoever sent it when there is none.
 *
 * The refusal goes back on the channel the command's own family already uses for errors, so it
 * lands where the user is looking — a generation refusal in the build pane, an eval refusal on
 * the eval channel. There is no general-purpose "the server said no" channel, and inventing one
 * for this would put every refusal somewhere nobody has open.
 *
 * FAILS OPEN, deliberately and narrowly: if the limiter itself throws — Redis is down — the
 * command proceeds and the failure is logged. A limiter is a protection against volume, not a
 * boundary against a person; every actual authorisation happens elsewhere and is unaffected, and
 * a Redis blip that stopped everybody generating would be an outage caused by the safety rail.
 */
async function admitCommand(ctx: TenantContext, cmd: ForwardedCommand): Promise<boolean> {
  const action = COMMAND_RATE_ACTIONS[cmd.cmd];
  if (!action) return true;
  // THE LADDER FIRST, THEN THE BUCKET. A workspace that may not start work at all should be told
  // that rather than told it is going too fast — and a rung is the more informative refusal, so
  // it is the one worth spending the check on first. Only the commands with a rate action are
  // gated, which is the same set that consumes: reading is never refused by an enforcement, for
  // the reason enforcement.ts gives about not holding data hostage.
  const verdict = await abuseGate.mayStartWork(ctx);
  if (!verdict.ok) {
    const message = enforcementRefusal(verdict.state);
    console.warn(`[abuse] ${ctx.workspaceId} refused ${cmd.cmd} — ${verdict.state.level}`);
    refuseCommand(ctx, action, message);
    return false;
  }
  let decision;
  try {
    decision = await rateLimiter.take(action, ctx.workspaceId);
  } catch (err) {
    console.error(`[rate] limiter failed for ${action}, admitting:`, (err as Error)?.message ?? err);
    return true;
  }
  if (decision.ok) return true;
  console.warn(`[rate] workspace ${ctx.workspaceId} refused ${action} for ${retryAfterSeconds(decision)}s`);
  metrics.increment("rate_limited_total", { action });
  // Nearly weightless on purpose — see abuse/signals.ts. Tripping a limit is a client with a
  // loop in it and the limiter has already dealt with it; what this makes visible is a PATTERN.
  observe(ctx, { kind: "rate.limit_tripped", weight: SIGNALS["rate.limit_tripped"].weight, detail: { action } });
  refuseCommand(ctx, action, rateRefusal(decision));
  return false;
}

/**
 * Tell whoever sent a command that it was refused, on the channel their UI is already watching.
 *
 * One mapping shared by both gates, because a refusal that lands somewhere nobody has open is
 * indistinguishable from the product being broken — and there is deliberately no general-purpose
 * "the server said no" channel to invent one on.
 */
function refuseCommand(ctx: TenantContext, action: RateAction, message: string): void {
  if (action === "agent.generate" || action === "agent.plan") relay.broadcastGen(ctx, { type: "error", message });
  else if (action === "agent.edit") relay.broadcastEdit(ctx, { type: "error", message });
  else if (action === "agent.explain") relay.broadcastReply(ctx, { type: "error", agentId: "", message });
  else if (action === "eval.start") relay.broadcastEval(ctx, { type: "error", message });
  else if (action === "mcp.discover") relay.broadcastMcp(ctx, { type: "error", message });
  else if (action === "member.invite") relay.broadcastMembers(ctx, { type: "error", message });
  else if (action === "connector.connect") relay.broadcastConnections(ctx, { type: "error", message });
  // The deploy panel, which is where every other deploy error already goes. Without this the
  // refusal would fall to the `else` and land on the debug channel — a deploy button that does
  // nothing, and the explanation in a pane the person pressing it is not looking at.
  else if (action === "deploy.start") relay.broadcastDeploy(ctx, { type: "error", message });
  else relay.broadcastDebug(ctx, { type: "error", message });
}

// AND THE OTHER HALF: deliver what OTHER replicas publish to sockets THIS one holds.
// deliverFromPeer, deliberately not broadcastTo — see wsRelay.ts's own note on why using the
// publishing method here would ping-pong every message between replicas forever. The context
// is minted fresh per message rather than looked up, because nothing about a cross-replica
// event needs more than the workspace it belongs to — the actor and role that mattered were
// already checked on whichever replica actually handled the request.
if (eventBridge) {
  void eventBridge.subscribe((workspaceId, payload) => {
    relay.deliverFromPeer(systemContextFor(workspaceId, newRequestId()), payload);
  });
  console.log("[server] event bridge: subscribed for cross-replica fan-out");
}

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
  // The eval's own workspace, resolved at the moment of use. A judge verdict is a platform call
  // like a generation, and it bills to the platform's key unless the workspace opted its own in.
  apiKey: async () => {
    const evalId = evalRunner?.activeEvalIds()[0];
    return evalId ? providerKeys.platformKey(contextForEval(evalId)) : undefined;
  },
  onScored: (e) => relay.broadcastEval(contextForEval(e.evalId), { type: "scored", ...e }),
  // The judge's own spend, in the workspace's ledger. NOT a replacement for `addJudgeCost`,
  // which keeps accumulating on the eval so the comparison can show judge overhead apart from
  // any provider's agent cost — that separation is rule 3 in judge/score.ts and stays. This is
  // the same money arriving where a run's steps and a generation also land, so "what did this
  // workspace spend" has one answer instead of three tables to add up by hand.
  //
  // The key is deterministic here, unlike the other four platform calls: a judge call is
  // retried on a bounded, numbered attempt loop, so (job, attempt) names exactly one paid call
  // and names it the same way twice.
  onJudgeCall: (e) =>
    meterPlatformCall(contextForEval(e.evalId), "llm.judge", {
      model: e.model,
      inputTokens: e.input,
      outputTokens: e.output,
      cacheReadTokens: e.cacheRead,
      cacheWriteTokens: e.cacheWrite,
      idempotencyKey: usageKey("llm.judge", e.jobId, String(e.attempt)),
      // Reported by the scorer rather than re-resolved here: only it knows which key the verdict
      // actually went out on, and re-reading the preference at metering time would mis-attribute
      // a call made a moment before somebody changed their mind.
      payer: e.usedOwnKey ? "workspace" : "platform",
    }),
  onScoringFinished: (e) => {
    console.log(`[eval] ${e.evalId} scoring done — ${e.scored} scored, ${e.unscored} unscored`);
    relay.broadcastEval(contextForEval(e.evalId), { type: "scoringFinished", ...e });
    // §B.1, AND HERE RATHER THAN ON `onFinished`. The pass rate IS the judge's answer, so posting a
    // check the moment the runs finish would post a quality number computed from scores that have
    // not landed — which for a fast eval is most of them. This is the same distinction the Evals
    // tab already draws by showing "scoring…" instead of a quality column about to fill in.
    void postCheckResult(e.evalId);
  },
});

evalRunner = new EvalRunner({
  pool: evalPool,
  store,
  dispatcher,
  evalStore,
  // One eval runs at a time, so this is the eval in flight.
  context: () => contextForEval(evalRunner?.activeEvalIds()[0] ?? ""),
  // ...which only answers once the eval has a workspace recorded against it. The runner does
  // that itself, between the eval becoming live and its first job, because nothing outside
  // knows the id before then.
  bindWorkspace: (evalId, ctx) => evalWorkspaces.set(evalId, ctx),
  // The WORKSPACE's ceiling, checked on every pump beside the eval's own. A five-hundred-job
  // fan-out is five hundred things being started, and a gate that only ran at the button would
  // let the first job's authorisation cover all of them. Returns the sentence the user reads,
  // so the eval's stop reason names which ceiling stopped it rather than leaving somebody to
  // raise the wrong number and watch it stop again.
  workspaceOverBudget: async () => {
    const evalId = evalRunner?.activeEvalIds()[0];
    if (!evalId) return null;
    const ctx = contextForEval(evalId);
    const status = await budgetGate.status(ctx);
    return status.overCeiling ? ceilingRefusal(status) : null;
  },
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
    // The hold comes back here, settled against what the eval really spent. Whatever the
    // outcome — completed, cancelled, or stopped by a ceiling — the money it did not use is
    // the workspace's again the moment nothing is left to spend it.
    void settleEval(contextForEval(e.evalId), e.evalId);
    relay.broadcastEval(contextForEval(e.evalId), { type: "evalFinished", ...e });
    // The eval's runs are now in history like any other; refresh so drill-down can reach
    // them without a reconnect.
    void relay.broadcastHistory();
    // No more jobs are coming: the judge reports done once its own queue drains.
    judge.seal(e.evalId);
    // §3.3'S `evalProgress` COMES OFF `eval_runs.status`, so an eval finishing is a state
    // transition and nothing was pushing one. A thread whose eval had ended sat under RUNNING with
    // `eval 34/120` frozen until something unrelated happened in the workspace. Deliberately not
    // per job — that is the polling channel §7.1 refuses; see the eval-progress cost delta for how
    // the moving figure is fed instead.
    scheduleListRefresh(contextForEval(e.evalId));

    // AN EVAL WHOSE RESULTS NOBODY HAS OPENED, and — separately — one that stopped starting jobs
    // because it crossed a ceiling. Two items from one event on purpose: an eval can be both, and
    // collapsing them would mean choosing which half to tell somebody. The ceiling read is the
    // eval's own `budget_usd`, which is the number the refusal was measured against and therefore
    // the number the card must name.
    noteInbox(
      "a finished eval",
      (async () => {
        const ctx = contextForEval(e.evalId);
        const run = await evalStore.getEvalRun(ctx, e.evalId);
        if (!run) return;
        const dataset = await evalStore.getDataset(ctx, run.dataset_id);
        await noteEvalFinished(inboxDeps, ctx, {
          evalId: e.evalId,
          datasetName: dataset?.name ?? run.agent_id,
          status: e.status,
          ceilingUsd: run.budget_usd,
        });
      })(),
    );

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
  let cleared = 0;
  for (const [key, p] of [...pendingConfirms]) {
    if (p.runId !== runId) continue;
    cleared++;
    // Scoped to one ask when the caller knows which one. A graph node can fire several tool
    // calls in a turn and each high-impact one blocks independently (the client keeps them as
    // a queue), so one of them timing out must not close the modals for the others — those
    // are still being waited on, and answering them still means something.
    if (nonce !== undefined && p.nonce !== nonce) continue;
    pendingConfirms.delete(key);
    rmSync(approvalFile(p.runId, p.nonce), { force: true });
    relay.broadcastMcp(contextForRun(p.runId), { type: "confirmResolved", runId: p.runId, nonce: p.nonce, verdict: reason });
  }
  // §3.3 counts a pending confirmation as blocked work, so one going away is a genuine state
  // transition and the list has to be told. Only when something actually cleared: this runs on
  // every run's teardown and most runs never asked anything.
  if (cleared > 0) scheduleListRefresh(contextForRun(runId));
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

        // THE ID AND THE CREDENTIAL ARE DECIDED HERE, SYNCHRONOUSLY; THE HANDSHAKE IS NOT.
        //
        // Both halves have to be, and for different reasons. The id has to be allocated against
        // the workspace's existing servers, which is a read this request can do and a background
        // job would have to redo under a race. The token has to be written now because a job
        // payload must never carry one — a credential on a queue is a credential in Redis, which
        // is neither encrypted at rest nor scoped to a tenant. See mcpDiscovery.ts.
        const prepared = await mcpRegistry.prepare(ctx, {
          endpoint: cmd.endpoint,
          label: cmd.label,
          token: cmd.token,
        });
        if (!prepared.ok) {
          relay.broadcastMcp(ctx, { type: "error", message: prepared.message ?? "that server could not be added" });
          broadcastMcpServers();
          return;
        }
        await mcpDiscovery.enqueue(ctx, {
          kind: "add",
          serverId: prepared.id,
          endpoint: cmd.endpoint,
          label: cmd.label,
          hasToken: Boolean(cmd.token),
        });
        // The endpoint may carry a path or query a user would not want echoed; log the id we
        // assigned and let the job's own completion log what happened to it.
        console.log(`[mcp] add ${prepared.id} queued`);
        if (prepared.message) {
          relay.broadcastMcp(ctx, { type: "notice", message: prepared.message, serverId: prepared.id });
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
        // Queued, with an idempotency key of (workspace, server) and no attempt number — so
        // somebody pressing the button six times enqueues one discovery rather than six against
        // a server that is probably already struggling. See mcpDiscovery.ts.
        await mcpDiscovery.enqueue(ctx, { kind: "rediscover", serverId: cmd.serverId });
        console.log(`[mcp] rediscover ${cmd.serverId} queued`);
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
          //
          // TO THE ASKER, NOT THE WORKSPACE. This was a broadcast, so one person's double-click —
          // or a held Escape, which repeats — put "that confirmation is no longer waiting" in front
          // of every teammate, about a dialog they may never have seen. Same class as the thread
          // channel's refusals, different channel.
          relay.sendMcpTo(ctx, ctx.requestId, {
            type: "error",
            message: "that confirmation is no longer waiting — the run moved on without it",
          });
          return;
        }
        pendingConfirms.delete(key);
        // Both, unconditionally rather than branching on which kind of run this is: a local
        // run has no bus entry to resolve (resolveMcpConfirm is a no-op returning false), and a
        // hosted run has no approval file anybody is polling for. Writing to whichever
        // mechanism the run is NOT using costs one harmless call.
        writeApproval(cmd.runId, cmd.nonce, verdict);
        runEventBus.resolveMcpConfirm(cmd.runId, cmd.nonce, verdict);
        console.log(`[mcp] ${pending.server}/${pending.tool} — ${verdict}`);
        relay.broadcastMcp(ctx, { type: "confirmResolved", runId: cmd.runId, nonce: cmd.nonce, verdict });
        // The thread stops being blocked the moment this is answered, and §3.3 reads the confirm
        // queue live — so the fact changes here and the list has to hear about it.
        scheduleListRefresh(ctx);
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

// --- connections: what this workspace has authorised us to reach -------------
//
// Three commands, and none of them carries a credential in either direction — which is what
// separates this surface from the provider and MCP ones beside it, where a token travels
// browser-to-server exactly once. Here the credential is minted by the provider and collected at
// the callback, so the browser never holds one and this process never receives one from it.
//
// Every answer is a FULL SNAPSHOT of every connector this deployment offers, connected or not.
// A panel that listed only what exists could not offer the thing a user came to do, and a
// deployment with no OAuth app configured would show an empty page that reads as a missing
// feature rather than an unconfigured one — so an unavailable connector is rendered with the
// reason instead of hidden.

async function connectionSnapshot(ctx: TenantContext): Promise<ConnectionView[]> {
  const rows = new Map((await oauthRepo.list(ctx)).map((r) => [r.connector_id, r]));
  return oauth.connectors().map(({ provider, spec }) => {
    const row = rows.get(spec.connectorId);
    return {
      connectorId: spec.connectorId,
      label: spec.label,
      provider: provider.id,
      // "disconnected" rather than absent, so the panel renders one row per connector in a
      // stable order rather than a list that reshuffles as things are connected.
      status: row?.status ?? "disconnected",
      // What was GRANTED, from the row — never what the spec asked for. A user who ticked one
      // box of two must not be shown the full list as though they had agreed to it.
      scopes: row?.scopes ?? [],
      consent: spec.consent,
      account: row?.external_account_label ?? null,
      connectedAt: row?.created_at ?? null,
      lastError: row?.last_error ?? null,
      available: oauth.configured(spec.connectorId),
    };
  });
}

async function broadcastConnections(ctx: TenantContext): Promise<void> {
  relay.broadcastConnections(ctx, { type: "connections", connections: await connectionSnapshot(ctx) });
}

async function handleConnectionCommand(ctx: TenantContext, cmd: ConnectionCommand): Promise<void> {
  try {
    if (cmd.cmd === "listConnections") {
      await broadcastConnections(ctx);
      return;
    }

    // Validated against what this server actually offers, never taken verbatim — the same
    // posture `connectors.resolveSelected` and `McpStore.resolveTools` take. A connector id is a
    // client-supplied string that is about to be rendered and about to pick an OAuth app.
    const connectorId = typeof cmd.connectorId === "string" ? cmd.connectorId : "";
    if (!oauth.find(connectorId)) {
      relay.broadcastConnections(ctx, {
        type: "error",
        message: `"${connectorId.slice(0, 32)}" is not a connector you connect with an account`,
      });
      return;
    }

    if (cmd.cmd === "connectConnector") {
      const begun = await oauth.begin(ctx, connectorId, { returnTo: cmd.returnTo ?? "/" });
      // A URL for the client to NAVIGATE to. A socket cannot redirect anything, and the consent
      // screen is a page a person has to look at — see ConnectionEvent.
      relay.broadcastConnections(ctx, {
        type: "authorize",
        connectorId,
        url: begun.url,
        expiresAt: begun.expiresAt,
      });
      return;
    }

    // disconnectConnector. The full revocation — handing the grant back at the provider rather
    // than merely forgetting it here — arrives in its own commit; this drops the credentials and
    // marks the row, which is the half that is this session's to get right first.
    const row = await oauthRepo.forConnector(ctx, connectorId);
    if (!row) {
      relay.broadcastConnections(ctx, { type: "notice", message: "that connector is not connected", connectorId });
      await broadcastConnections(ctx);
      return;
    }
    // REVOKED AT THE PROVIDER, then forgotten here. The order matters and the reasoning is in
    // oauth/revoke.ts: a crash between the two must leave a dead grant we still know about
    // rather than a live one nothing points at.
    const ended = await connectionRevoker.disconnect(ctx, row);
    await identityRepo.appendAudit(ctx, {
      action: "connector.disconnected",
      targetType: "connector",
      targetId: connectorId,
      // The RECEIPT. Which of the outcomes it was, recorded where somebody answering a support
      // question can find it — "we could not reach Google" and "Google says it is gone" are
      // different answers and only one of them means the user should go and check.
      metadata: { provider: row.provider, account: row.external_account_label, remote: ended.remote },
    });
    relay.broadcastConnections(ctx, {
      type: "notice",
      message:
        ended.message ??
        `${connectorId} is disconnected — agents using it will report it at their next tool call`,
      connectorId,
    });
    await broadcastConnections(ctx);
  } catch (err) {
    // The service's messages are written in this codebase and safe to render; anything else is a
    // bug and says nothing, for the same reason the HTTP router refuses to echo a 500.
    const message = err instanceof OAuthError ? err.message : "that could not be done";
    if (!(err instanceof OAuthError)) console.error(`[connections] ${cmd.cmd} failed:`, err);
    relay.broadcastConnections(ctx, {
      type: "error",
      message,
      // Only the two commands that name one have one. A read that failed is not about a
      // connector, and putting an undefined field on the event would have the panel highlight a
      // row chosen at random.
      connectorId: cmd.cmd === "listConnections" ? undefined : cmd.connectorId,
    });
  }
}

// --- providers: which keys are set, and who pays with them ---------------------------------
// NO KEY IS WRITTEN OR PROBED ON THIS CHANNEL ANY MORE. `setProviderKey` and `testProviderKey`
// used to live here and were a way around the passcode gate: elevation rides on a request header,
// a browser cannot set one on a WebSocket, so a credential command on this socket is a credential
// command nothing can gate. `POST /v1/secrets` and `POST /v1/secrets/:name/test` are the one way
// in, and they go through the same guard everything else in the group does.
//
// What is left is `setOwnKeyForPlatform`, which carries no credential — it decides which of two
// already-stored keys pays for the platform's own calls.
//
// Nothing broadcast here carries a key either. A provider reports `configured: true/false`, which
// is the name of a variable being set and never the value behind it.

const PROVIDER_COMMAND_NAMES = new Set(["setOwnKeyForPlatform"]);
const CONNECTION_COMMAND_NAMES = new Set(["listConnections", "connectConnector", "disconnectConnector"]);

/**
 * Everything a client is told about this workspace's model credentials.
 *
 * ONE PRODUCER, for the on-connect snapshot, the answer to `listProviders`, and the broadcast that
 * follows a change. Three call sites used to build this message and only this one carried
 * `ownKeyForPlatform`, so the flag reached a client exactly once — after it had changed something
 * it had no control to change.
 */
async function providerSnapshot(ctx: TenantContext): Promise<ProviderSnapshot> {
  return {
    // The workspace's OWN configured names, not the server's environment. Locally these are the
    // same set — the local store is the process environment — and hosted they are emphatically
    // not: reading process.env there would tell every workspace it has a provider connected
    // because the server does.
    providers: providerStatus(await providerKeys.configuredNames(ctx)),
    ownKeyForPlatform: await providerKeys.ownKeyForPlatform(ctx),
    // THE SELECTABLE CATALOGUE, FROM THE PRICE SHEET. `runtime/pricing.json` declares itself the
    // single source of truth for models and is read by both this process and the Python
    // interceptor; the client used to hold a second, hidden copy of the CATALOGUE, which had
    // drifted four models behind it — so a model added to the priced table could not be chosen for
    // a run, added as an eval leg, or deployed with. There is nothing to keep in step now.
    //
    // ORDER IS THE FILE'S ORDER, deliberately: it is a curated list with the newest entries first,
    // and re-sorting it here would put a client's opinion in front of the one the price sheet
    // already expresses.
    models: allPrices().map((p) => ({
      id: p.id,
      provider: p.provider,
      label: providerLabel(p.provider),
      free: p.free,
    })),
  };
}

async function broadcastProviders(ctx: TenantContext): Promise<void> {
  relay.broadcastProviders(ctx, { type: "providers", ...(await providerSnapshot(ctx)) });
}

async function handleProviderCommand(ctx: TenantContext, cmd: ProviderCommand): Promise<void> {
  try {
    // The only command left on this channel, and it carries no credential: it decides which of two
    // already-stored keys pays for the platform's own calls.
    if (cmd.cmd === "setOwnKeyForPlatform") {
      const on = cmd.on === true;
      if (on && !(await providerKeys.configuredNames(ctx)).has(PROVIDER_ENV_KEY.anthropic)) {
        // Refused rather than accepted-and-inert. A workspace that turned this on with no key
        // would keep being billed platform credit while believing it was not, which is a
        // surprise on an invoice rather than an error at the moment of the mistake.
        relay.broadcastProviders(ctx, {
          type: "error",
          message: "connect an Anthropic key first — that is the key this would spend",
          provider: "anthropic",
        });
        return;
      }
      await providerKeys.setOwnKeyForPlatform(ctx, on);
      console.log(`[providers] own key for platform calls: ${on ? "on" : "off"} (${ctx.workspaceId})`);
      await broadcastProviders(ctx);
      return;
    }
  } catch (err) {
    const message = (err as Error)?.message ?? String(err);
    console.error(`[providers] ${cmd.cmd} failed: ${message}`);
    relay.broadcastProviders(ctx, { type: "error", message: `${cmd.cmd} failed: ${message}` });
  }
}

/**
 * What this workspace has spent, and against what.
 *
 * ONE COMPUTATION, SHARED WITH THE GATE. `budgetGate.status` is what refuses a run; every figure
 * below comes from it rather than from a second set of queries. A dashboard that computed its own
 * total would eventually disagree with the refusal a user is looking at, and a billing page that
 * disagrees with a refusal is worse than no billing page.
 *
 * COST-INCOMPLETE IS SURFACED, NOT HIDDEN. Every rollup here carries whether it could price
 * everything it counted, at every level — the period total, each agent, each run. A number
 * presented without that flag is a floor being read as a total, which is the one thing the whole
 * cost model has been arranged since the beginning to avoid.
 */
async function broadcastUsage(ctx: TenantContext): Promise<void> {
  try {
    const status = await budgetGate.status(ctx);
    const period = status.periodStart;
    const [byAgent, byRun, byKind, platform, agents, planRows] = await Promise.all([
      billing.spendByAgent(ctx, period),
      billing.spendByRun(ctx, period),
      billing.spendByKind(ctx, period),
      billing.platformSpendSince(ctx, period),
      agentRepo.list(ctx),
      // WHAT THIS DEPLOYMENT OFFERS, from the `plans` table rather than from `PLANS` — the table is
      // where deployment-specific configuration lives, and `purchasable` and `external_price_id` are
      // its columns. The limits beside each one come from `PLANS`, which is the code that enforces
      // them, so the panel cannot advertise a ceiling the gate would not apply.
      billing.listPlans(ctx),
    ]);
    // Slugs, because an agent uuid means nothing to a person reading a bill. Resolved here
    // rather than joined in SQL so the query stays about money.
    const slugById = new Map(agents.map((a) => [a.id, a.slug]));
    relay.broadcastBilling(ctx, {
      type: "usage",
      usage: {
        periodStart: status.periodStart,
        periodEnd: status.periodEnd,
        plan: { id: status.plan.id, label: status.plan.label },
        spentUsd: status.spentUsd,
        costKnown: status.costKnown,
        ceilingUsd: status.ceilingUsd,
        headroomUsd: status.headroomUsd,
        overCeiling: status.overCeiling,
        balanceUsd: status.balanceUsd,
        reservedUsd: status.reservedUsd,
        availableUsd: status.availableUsd,
        // What WE paid, against the ceiling that bounds it. A workspace on its own key sees
        // zero here and a full figure above, which is exactly the distinction BYOK is about.
        platformSpentUsd: platform.usd,
        platformCeilingUsd: status.plan.platformKeyCeilingUsd,
        ownKeyForPlatform: await providerKeys.ownKeyForPlatform(ctx),
        byAgent: byAgent.map((a) => ({
          agentId: a.agentId,
          // Null is not "unknown agent" — it is spend with no run behind it: a generation, a
          // plan, a judge verdict. Named rather than dropped, or the breakdown would not add up
          // to the total above it.
          label: a.agentId ? (slugById.get(a.agentId) ?? a.agentId) : "the platform, on your behalf",
          usd: a.usd, tokens: a.tokens, costKnown: a.costKnown, runs: a.runs,
        })),
        byRun: byRun.map((r) => ({
          runId: r.runId,
          label: r.agentId ? (slugById.get(r.agentId) ?? r.agentId) : null,
          usd: r.usd, tokens: r.tokens, costKnown: r.costKnown,
        })),
        byKind,
        // THE CATALOGUE, so the panel that names your plan can offer another one. Every field a
        // choice depends on travels: what it costs to run on (`monthlyCreditsUsd`), what it lets you
        // start (`budgetCeilingUsd`), how long a trace survives (`retentionDays`), how many people
        // may be in the workspace (`seats`), and whether it can deploy at all.
        plans: planRows.map((row) => {
          const limits = planFor(row.id);
          return {
            id: row.id,
            // The TABLE's name, not the code's: a deployment that renamed a tier in its own
            // configuration should see its own word in its own product.
            label: row.display_name,
            // `purchasable` alone is not enough — a plan marked purchasable with no price id
            // configured cannot be bought, and the checkout route refuses it in those words.
            purchasable: row.purchasable && row.external_price_id !== null,
            current: row.id === status.plan.id,
            monthlyCreditsUsd: limits.monthlyCreditsUsd,
            budgetCeilingUsd: limits.budgetCeilingUsd,
            platformKeyCeilingUsd: limits.platformKeyCeilingUsd,
            retentionDays: limits.retentionDays,
            seats: limits.seats,
            deploy: limits.features.deploy,
          };
        }),
        // WHETHER THIS DEPLOYMENT CAN SELL ANYTHING AT ALL, from the one signal the checkout route
        // already answers on. The local path has no Stripe keys and is not an error state, so the
        // Upgrade control is absent there rather than present and refusing.
        paymentsConfigured: paymentsConfigured(stripeConfigFromEnv()),
      },
    });
  } catch (err) {
    const message = (err as Error)?.message ?? String(err);
    console.error(`[billing] loadUsage failed: ${message}`);
    relay.broadcastBilling(ctx, { type: "error", message: `could not load usage: ${message}` });
  }
}

/**
 * Set the workspace's own spend ceiling, or clear it back to the plan's.
 *
 * THE THREE-STATE CONTRACT IS THE FEATURE, and it is the repository's own: `null` means "use the
 * plan's number", `0` means "this workspace may start nothing", and a positive number is a limit of
 * its own. All three are reachable from here, because a control that could not send `null` would be
 * a one-way door — a workspace that once set a ceiling could never go back to its plan's.
 *
 * WHAT IT DOES NOT SET is `limit_overrides`. Those are a negotiated exception to a plan — seats,
 * concurrency, retention, the platform-key ceiling — agreed with somebody and applied by an
 * operator, and a workspace that could raise its own retention or its own platform-key ceiling
 * would be editing what we pay for. That one stays SQL on purpose; this is the number that is the
 * customer's own to choose.
 *
 * Answered by re-broadcasting the whole usage snapshot, like every other mutation in this codebase:
 * the ceiling appears in three places on that panel (the meter's limit, its bar, and whether the
 * workspace is over), and a partial update is how those three come to disagree.
 */
async function setSpendCeiling(ctx: TenantContext, usd: number | null): Promise<void> {
  // A NUMBER OR NOTHING, checked here because the relay forwards this shape-unchecked. `NaN` is a
  // number as far as `typeof` is concerned and would be written straight into the column, where it
  // would compare false against every spend figure — a ceiling that silently stops bounding
  // anything, which is the worst available failure for this particular column.
  if (usd !== null && (typeof usd !== "number" || !Number.isFinite(usd) || usd < 0)) {
    relay.broadcastBilling(ctx, {
      type: "error",
      message: "a spend ceiling is a positive number of dollars, 0 to start nothing, or none to use the plan's",
    });
    return;
  }
  try {
    await billing.setCeiling(ctx, usd);
    console.log(`[billing] ${ctx.workspaceId} ceiling set to ${usd === null ? "the plan's" : `$${usd}`}`);
    await broadcastUsage(ctx);
  } catch (err) {
    const message = (err as Error)?.message ?? String(err);
    console.error(`[billing] setSpendCeiling failed: ${message}`);
    relay.broadcastBilling(ctx, { type: "error", message: `could not set the ceiling: ${message}` });
  }
}

// --- the Agents tab: the grid aggregate, one agent in full, and the lifecycle ---------------
//
// §7.2 IS THE WHOLE DESIGN CONSTRAINT HERE: the grid needs, per agent, a thread count, a 7-day run
// count, 7-day spend, a last-run time, its latest thread's title and last turn, health inputs,
// deploy state, version drift and a missing-credential count — and the number of statements that
// costs must not grow with the number of agents. Everything below reads a WORKSPACE at a time and
// joins in memory. `test:agent-grid` asserts the count is constant against one agent and against
// forty, which is the only version of that claim worth having.
//
// §7.4's SHAPE, UNCHANGED: the three reads are answered by the relay to the socket that asked, and
// every mutation broadcasts the whole grid. No client merges a partial update — §5.4's tag
// precedence is computed against a row as a whole, so a merged row is a row whose tags were decided
// at two different moments.

/** The window §4's sort, §5.2's footer and §5.4's health all read. Seven days, in milliseconds. */
const GRID_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;
/** The second window §6's Health tab asks for, beside the first. */
const GRID_WINDOW_30_MS = 30 * 24 * 60 * 60 * 1000;

const AGENT_COMMAND_NAMES = new Set([
  "archiveAgent", "restoreAgent", "renameAgent", "forkAgent", "restoreAgentVersion",
]);

/** A refusal on the agents channel, to the socket that earned it and nobody else. */
function refuseAgent(ctx: TenantContext, message: string, agentId?: string): void {
  relay.sendAgents(ctx, ctx.requestId, { type: "error", message, ...(agentId ? { agentId } : {}) });
}

/** A statement of fact on the agents channel, to the socket that asked for it. */
function noticeAgent(ctx: TenantContext, message: string, agentId?: string): void {
  relay.sendAgents(ctx, ctx.requestId, { type: "notice", message, ...(agentId ? { agentId } : {}) });
}

/**
 * Which agents a model is writing files for at this instant, by slug.
 *
 * READ OFF THE SINGLE-SLOT SUBSYSTEM this process already has, rather than from a column. An edit is
 * in-memory, single-slot and refuses a second while one runs — the same fact `threadFactsFor` reads
 * for the same reason — so "is this agent being written to" is a comparison against the slot, and a
 * durable flag would be one a restart left set forever.
 *
 * IT IS `editingAgentId` AND NOT `openProposals`, and that difference is the whole of this function.
 * A pending proposal is a diff that has ARRIVED and is waiting for somebody to apply or discard it —
 * work that has STOPPED — so reading it here put the amber `Generating` tag on an agent whose diff
 * was sitting still, and left an edit that was genuinely streaming wearing `Idle`. Both halves were
 * wrong and the first is the worse one: amber means runtime activity, and an unapplied diff is
 * somebody's turn rather than the machine's. A pending diff is the THREAD's business, which is
 * exactly where §3's rule puts it — it is not a fact about the agent.
 *
 * A GENERATION IS ABSENT ON PURPOSE. `generate` mints an agent's slug at the end, so for the whole
 * of a generation there is no row to mark and the grid has no card to put a tag on. By the time the
 * row exists the generation is over.
 */
function buildingAgents(ctx: TenantContext): Set<string> {
  const out = new Set<string>();
  const editing = editor.editingAgentId;
  if (editing && editContext?.workspaceId === ctx.workspaceId) out.add(editing);
  return out;
}

/**
 * The workspace's agents, as the grid renders them (§4, §5).
 *
 * NINE STATEMENTS, AND NOT ONE PER AGENT. Each of the reads below is bounded by the workspace and
 * grouped or keyed in the database; the joining is a handful of Map lookups. The naive shape — walk
 * the agent list and ask five questions per row — is 5N round trips on the path a socket is waiting
 * on, which is the N+1 §7.2 says will be instantly visible at forty agents.
 *
 * ARCHIVED AGENTS ARE IN THE LIST AND FLAGGED, exactly as `listAgents` carries them: §4 hides them
 * behind a filter, which is a decision the grid makes about what to render and not a reason for the
 * server to withhold the rows the Archived filter exists to show.
 *
 * SOFT-DELETED ONES ARE NOT. `agentRepo.list` excludes `deleted_at` unconditionally and this does
 * not override it: a swept row is a mirror of a directory that has gone, not something somebody put
 * away, and §4's Archived filter is about the second.
 */
async function agentGridSnapshot(ctx: TenantContext): Promise<AgentGridSnapshot> {
  const since7 = new Date(Date.now() - GRID_WINDOW_MS).toISOString();

  const [agents, runFacts, threadFacts, deployed, spend, versionSources, refs, tools, workspace] =
    await Promise.all([
      agentRepo.list(ctx, { includeArchived: true }),
      store.agentRunFacts(ctx, since7, OUTCOME_WINDOW),
      threadStore.agentThreadFacts(ctx),
      deployStore.currentByAgent(ctx),
      billing.spendByAgent(ctx, since7),
      agentRepo.currentVersionSources(ctx),
      // EVERY DECLARED NAME IN THE WORKSPACE, ONCE. §5.2's warning line is `required_env` against
      // `secret_refs`, and asking per agent would be the N+1 all over again for the line the
      // specification calls the most important one on the card.
      secretRefs.list(ctx),
      // Likewise for the impact classifications: one read of the workspace's tools, joined against
      // each agent's own `server/tool` refs. `mcpRegistry.resolve` is a lookup PER REF, which across
      // forty agents with a handful of grants each is exactly what this avoids.
      mcpRegistry.allTools(ctx),
      bootIdentity.workspaceById(ctx, ctx.workspaceId),
    ]);

  // `configured` IS THE TEST, NOT EXISTENCE — see `missingCredentials`. A row exists for every name
  // an agent has ever declared, so a membership test against the table would report every declared
  // credential as present and the warning line would never appear.
  const configured = new Set(refs.filter((r) => r.configured).map((r) => r.name));
  const impactByRef = new Map(tools.map((t) => [`${t.server_id}/${t.name}`, t.impact]));
  const spendBySlug = new Map(spend.map((s) => [s.agentId ?? "", s]));
  // `forked_from` is a uuid on the row and a SLUG on the wire, for the reason every other agent id on
  // it is: a slug is what a person recognises and what every other surface calls an agent id.
  const slugByUuid = new Map(agents.map((a) => [a.id, a.slug]));
  const building = buildingAgents(ctx);

  const cards: AgentCardView[] = agents.map((a) => {
    const runs = runFacts.get(a.slug);
    const threads = threadFacts.get(a.id);
    const deployment = deployed.get(a.slug) ?? null;
    const money = spendBySlug.get(a.slug);
    const versionSource = versionSources.get(a.id) ?? null;
    const outcomes = runs?.recent ?? [];

    return {
      agent_id: a.slug,
      uuid: a.id,
      name: a.display_name ?? a.slug,
      slug: a.slug,
      description: a.description,
      created_at: a.created_at,
      created_by: a.created_by ?? null,
      archived_at: a.archived_at,
      hand_written: a.hand_written,
      // THE SOURCE'S SLUG, NOT ITS UUID. The tag renders "Copied from api_gateway" — a name somebody
      // can recognise — and every other agent id on this wire shape is a slug for the same reason.
      // Null when the source has since been swept, which is the honest answer: the copy is still a
      // fork, and there is no longer a name to point at.
      forked_from: a.forked_from ? (slugByUuid.get(a.forked_from) ?? null) : null,
      current_version: a.current_version,
      version_source: versionSource,
      creation_cost: a.creation_cost,
      connectors: a.connectors,
      mcp_tools: a.mcp_tools,
      required_env: a.required_env,
      missing_env: missingCredentials(a.required_env, configured),
      // A ref whose server this workspace no longer has resolves to nothing and is not counted.
      // That is not an undercount: a grant nothing can honour is not a tool this agent can reach,
      // and the Capabilities tab shows the same ref with a null impact so the gap stays visible
      // where it can be acted on.
      high_impact_tools: a.mcp_tools.filter((ref) => impactByRef.get(ref) === "high").length,
      default_provider: a.default_provider,
      thread_count: threads?.threadCount ?? 0,
      latest_thread: threads?.latest
        ? {
            id: threads.latest.id,
            title: threads.latest.title,
            last_activity_at: threads.latest.lastActivityAt,
            last_turn: threads.latest.lastTurn,
          }
        : null,
      runtime: runtimeOf({
        liveRuns: runs?.liveRuns ?? 0,
        pausedRuns: runs?.pausedRuns ?? 0,
        building: building.has(a.slug),
        deploying: deployment !== null && isDeployInFlight(deployment.status),
      }),
      health: healthOf({ outcomes: outcomes.map((o) => o.outcome), versionSource }),
      activity: activityOf(runs?.runs7d ?? 0),
      last_run_at: runs?.lastRunAt ?? null,
      runs_7d: runs?.runs7d ?? 0,
      errors_7d: runs?.errors7d ?? 0,
      // The failing step is filled in below, for the few runs that need it.
      outcomes: outcomes.map((o) => ({
        run_id: o.runId,
        outcome: o.outcome,
        started_at: o.startedAt,
        failed_step_id: null,
      })),
      last_error: runs?.lastError ?? null,
      // NULL IS NOT ZERO, and the three states are the same three a thread's cost has. An agent
      // that has not run this week has spent nothing rather than $0.00, and §5.4's `Cost unknown`
      // tag is the middle case — a figure that is a floor because something ran unpriced.
      spend_7d: money ? money.usd : null,
      spend_known: money ? money.costKnown : true,
      deployment: deployment
        ? { id: deployment.id, status: deployment.status, url: deployment.url, version: deployment.version }
        : null,
      // DRIFT IS ONLY A FACT ABOUT SOMETHING THAT IS SERVING. `currentByAgent` answers with an
      // agent's most recent deployment whatever became of it, so a deploy that FAILED at the build
      // step, or one somebody has since forgotten, still carries the version it was going to build
      // from — and computing drift off that put `v2 → v9` on a card with nothing deployed at all,
      // claiming old code was live when no code was. The card guarded on `live` and the tag row did
      // not, which is exactly the kind of rule that has to be decided once, here, rather than
      // remembered by each surface that renders it.
      drift: deployment?.status === "live" ? driftOf(deployment.version, a.current_version) : null,
    };
  });

  // §5.5's "a failed bar opens on the failing step", resolved in ONE query for the whole grid rather
  // than one per red bar. The mapping from a step to its place in a trace already exists and is what
  // the click uses; this only supplies which step to open on. It is asked only for the runs that
  // actually failed — which in a healthy workspace is none of them, and the query is then skipped
  // entirely rather than run against an empty list.
  const failedRunIds = cards.flatMap((c) =>
    c.outcomes.filter((o) => o.outcome === "error").map((o) => o.run_id),
  );
  if (failedRunIds.length > 0) {
    const firstFailures = await store.firstFailedStepFor(ctx, failedRunIds);
    for (const card of cards) {
      for (const bar of card.outcomes) {
        if (bar.outcome === "error") bar.failed_step_id = firstFailures.get(bar.run_id) ?? null;
      }
    }
  }

  return { cards, team: workspace?.kind === "team" };
}

/**
 * One agent in full (§6), for the client that clicked its card.
 *
 * BUILT ON `agentGridSnapshot` RATHER THAN ON A SECOND ASSEMBLY, so the card in the detail header
 * and the card in the grid behind it can never disagree about a tag. That costs one grid read per
 * card opened — and the alternative is two functions that are required to agree and cannot be made
 * to, which is the mistake `threadView` documents having already avoided once.
 *
 * UNDEFINED FOR AN AGENT THIS WORKSPACE DOES NOT HAVE (§7.3). Every read below is scoped, so an id
 * belonging to another workspace produces exactly the same answer as one that never existed.
 */
async function agentDetail(ctx: TenantContext, slug: string): Promise<AgentDetailView | undefined> {
  const grid = await agentGridSnapshot(ctx);
  const card = grid.cards.find((c) => c.slug === slug);
  if (!card) return undefined;

  const since30 = new Date(Date.now() - GRID_WINDOW_30_MS).toISOString();
  const [versions, tools, refs, datasets, evalRuns, threads, runs, spend30, runs30] = await Promise.all([
    agentRepo.versions(ctx, card.uuid),
    mcpRegistry.allTools(ctx),
    secretRefs.list(ctx),
    evalStore.listDatasets(ctx, card.slug),
    evalStore.listEvalRuns(ctx, 50),
    threadStore.listForAgent(ctx, card.uuid),
    store.listRuns(ctx, 50),
    billing.spendByAgent(ctx, since30),
    store.runCountSince(ctx, card.slug, since30),
  ]);

  const byRef = new Map(tools.map((t) => [`${t.server_id}/${t.name}`, t]));
  const refByName = new Map(refs.map((r) => [r.name, r]));
  // Durations of the settled runs in the same window the sparkline covers, so a p95 beside a
  // sparkline is a percentile OF that sparkline rather than of a different set of runs.
  const settled = new Set(
    card.outcomes.filter((o) => o.outcome === "ok" || o.outcome === "error").map((o) => o.run_id),
  );
  const durations = runs
    .filter((r) => settled.has(r.id) && r.ended_at)
    .map((r) => new Date(r.ended_at!).getTime() - new Date(r.started_at).getTime());
  const { p50, p95 } = percentiles(durations);
  const spend30Usd = spend30.find((s) => s.agentId === card.slug)?.usd ?? null;

  // COST PER RUN, NOT TOTAL COST, and null rather than zero when there is no denominator. §6 asks
  // for "cost per run over 7 and 30 days", and an agent that has not run in the window has no cost
  // per run at all — a zero there would read as "this agent is free", which is the same false
  // confidence `creation_cost` is forbidden from claiming.
  const perRun = (usd: number | null, count: number): number | null =>
    usd === null || count <= 0 ? null : usd / count;

  const lastEval = evalRuns.find((e) => e.agent_id === card.slug) ?? null;
  /**
   * §6's "winning provider", which shipped as a hardcoded `null`.
   *
   * The field was on the wire shape and the tab rendered a chip for it, and nothing ever put a value
   * in — a stub wearing a feature's clothes. `aggregateEval` is the authority that the eval dashboard
   * is already drawn from, and `bestByQuality` is its ranking rule, so this is the same answer rather
   * than a second one.
   *
   * ONE EVAL, AND ONLY WHEN THERE IS ONE. The aggregate reads that eval's jobs and scores, which is
   * two statements for the single most recent comparison — not per agent, and not per card. An agent
   * that has never been evaluated pays nothing.
   */
  const winner = lastEval
    ? await aggregateEval(ctx, evalStore, lastEval.id)
        .then((agg) => (agg ? (bestByQuality(agg.providers)?.model ?? null) : null))
        // A ranking is a label. It must not be able to fail the read of an agent's record.
        .catch(() => null)
    : null;

  return {
    card,
    versions: versions.map((v) => ({
      version: v.version,
      source: v.source,
      instruction: v.instruction,
      summary: v.summary,
      file_stats: v.file_stats,
      total_bytes: v.total_bytes,
      undone_at: v.undone_at,
      created_at: v.created_at,
      created_by: null,
      current: v.version === card.current_version,
    })),
    // EVERY GRANTED REF, INCLUDING THE ONES THAT NO LONGER RESOLVE. A grant whose server has been
    // removed is a real thing to see on a Capabilities tab — it is why a tool the agent's code calls
    // will fail — and dropping it would make the tab quietly shorter than the manifest it describes.
    tools: card.mcp_tools.map((ref) => {
      const slash = ref.indexOf("/");
      const resolved = byRef.get(ref);
      return {
        ref,
        server: slash > 0 ? ref.slice(0, slash) : ref,
        tool: slash > 0 ? ref.slice(slash + 1) : "",
        impact: resolved?.impact ?? null,
        reason: resolved?.impact_reason ?? null,
      };
    }),
    // NAMES AND A BOOLEAN. There is no field here a value could travel in, which is the same
    // discipline the secrets panel and the deploy logs hold and the reason this is safe to send.
    credentials: card.required_env.map((name) => ({
      name,
      configured: refByName.get(name)?.configured ?? false,
      scope: refByName.get(name)?.scope ?? null,
    })),
    p50_ms: p50,
    p95_ms: p95,
    cost_per_run_7d: perRun(card.spend_7d, card.runs_7d),
    cost_per_run_30d: perRun(spend30Usd, runs30),
    evals: {
      datasets: datasets.map((d) => ({ id: d.id, name: d.name, example_count: d.example_count })),
      last: lastEval
        ? { id: lastEval.id, status: lastEval.status, started_at: lastEval.started_at, winner }
        : null,
    },
    threads: threads.map((t) => ({
      id: t.id,
      title: t.title,
      status: t.status,
      last_activity_at: t.last_activity_at,
      archived: t.archived_at !== null,
    })),
    runs: runs
      .filter((r) => r.agent_id === card.slug)
      .slice(0, 20)
      .map((r) => ({
        id: r.id,
        status: r.status,
        started_at: r.started_at,
        provider: r.provider,
        model: r.model,
      })),
  };
}

/**
 * One version's files (§6's browser, and the overflow menu's Export).
 *
 * OUT OF THE OBJECT STORE, NEVER OFF DISK, which §6 states as a requirement and the storage layer
 * already enforces: a replica that has never run this agent must show byte-identical output to the
 * one that generated it, and `runtime/agents/` is one namespace shared by every workspace on the
 * box. `readVersion` reads the manifest and fetches what it names, so a half-published version is an
 * error rather than a file that quietly vanishes from a project.
 */
async function agentVersionFiles(
  ctx: TenantContext,
  slug: string,
  version: number | undefined,
): Promise<{ version: number; files: AgentFileView[] } | undefined> {
  if (!isSafeAgentId(slug)) return undefined;
  const agent = (await agentRepo.list(ctx, { includeArchived: true })).find((a) => a.slug === slug);
  if (!agent) return undefined;
  const wanted = version ?? agent.current_version;
  const row = await agentRepo.version(ctx, agent.id, wanted);
  if (!row) return undefined;

  const [files, blame] = await Promise.all([
    projects.readVersion(ctx, agent.id, wanted),
    agentRepo.fileBlame(ctx, agent.id),
  ]);
  // POSIX SEPARATORS, and the match is against object paths rather than against anything a
  // filesystem produced. The Windows separator bug that silently dropped `tools/mcp_bridge.py` from
  // the block list is exactly this comparison done against a platform path.
  const connectorFiles = agentFilesDeps.connectorFilesFor(agent, slug);
  const readOnly = readOnlyPaths(connectorFiles);

  return {
    version: wanted,
    files: files.map((f) => ({
      path: f.path,
      content: f.content,
      bytes: row.manifest[f.path]?.bytes ?? Buffer.byteLength(f.content, "utf8"),
      read_only: readOnly.has(f.path),
      read_only_reason: readOnlyReason(f.path, connectorFiles),
      last_changed_in: blame.get(f.path) ?? null,
    })),
  };
}

/**
 * Duplicate an agent (§7.5): its connectors and its current manifest, and none of its MCP grants.
 *
 * NO FILE IS COPIED. Objects are content-addressed and immutable, so the fork's first version names
 * the same objects the original's current version does — a manifest and a pointer, exactly as §7.5
 * says. Neither agent can affect the other's bytes, because nothing ever rewrites an object.
 *
 * THE MANIFEST IS REGISTERED WITH `addVersion` rather than by writing a row by hand, so the fork
 * goes through the same reserve-then-promote path every other publish does — which is what makes it
 * impossible for the new agent's `current_version` to point at a version whose objects do not exist.
 *
 * `source: "import"` IS THE TRUTHFUL LABEL, and it is worth stating because `generation` would read
 * better. Nothing was generated: this version was published as-is out of another agent's manifest,
 * which is precisely what migration 014 defines `import` to mean — and it is also honest about the
 * validator, which never saw this project under this agent's name.
 */
async function forkAgent(ctx: TenantContext, slug: string): Promise<void> {
  const all = await agentRepo.list(ctx, { includeArchived: true });
  const source = all.find((a) => a.slug === slug);
  if (!source) {
    refuseAgent(ctx, `no agent called ${slug} in this workspace`, slug);
    return;
  }
  const version = await agentRepo.version(ctx, source.id, source.current_version);
  if (!version) {
    refuseAgent(ctx, `${slug} has published nothing yet — there is no version to fork`, slug);
    return;
  }

  // `takenSlugs`, NOT THE LIST ABOVE. `list` excludes soft-deleted rows by design, and a soft-deleted
  // row keeps its slug — so checking a candidate against the list said `foo_copy` was free while the
  // UNIQUE constraint disagreed, and the fork failed on INSERT with "that did not work" for a name
  // that was never available. What has to be avoided is what the constraint actually holds.
  const forkSlug = nextForkSlug(source.slug, await agentRepo.takenSlugs(ctx));
  if (!forkSlug) {
    refuseAgent(ctx, `${slug} has too many copies — rename one before making another`, slug);
    return;
  }

  const id = randomUUID();
  await agentRepo.create(ctx, {
    id,
    slug: forkSlug,
    display_name: `${source.display_name ?? source.slug} copy`,
    description: source.description,
    // COPIED, because a connector is a reviewed template this workspace has already audited and it
    // carries no third-party grant with it.
    connectors: source.connectors,
    // NOT COPIED, and §7.5 gives the reason: copying them would silently re-grant high-impact
    // third-party tools to a brand-new agent without anybody ticking a box, and the entire MCP
    // design rests on access being granted per tool, deliberately.
    mcp_tools: [],
    required_env: source.required_env,
    default_provider: source.default_provider,
    hand_written: false,
    // NULL, NOT THE ORIGINAL'S FIGURE. A fork cost a database row; claiming the original's
    // generation cost would put somebody else's spend on a new agent's overview, and v0.1.9's rule
    // is that a missing figure is not a zero — nor is it somebody else's.
    creation_cost: null,
    // THE PROVENANCE, AS A KEY RATHER THAN AS PROSE (migration 049). The version summary below says
    // the same thing for a person to read, and it is not what anything reads: a tag driven by parsing
    // that string would break silently the first time somebody reworded it.
    forkedFrom: source.id,
  });
  await agentRepo.addVersion(ctx, id, version.manifest, {
    source: "import",
    summary: `forked from ${source.slug} v${version.version}`,
  });

  console.log(`[agents] forked ${source.slug} v${version.version} to ${forkSlug}`);
  await relay.broadcastAgents();
  await relay.broadcastAgentGrid();
  noticeAgent(ctx, `Forked to ${forkSlug}. Its MCP grants start empty.`, forkSlug);
}

/**
 * Go back to an old version by publishing a NEW one that points at its manifest (§6).
 *
 * IT NEVER REWRITES HISTORY AND NEVER MOVES A POINTER BACKWARDS ONTO OBJECTS A CLEANUP MAY HAVE
 * COLLECTED. Both halves of that sentence are load-bearing. Moving `current_version` back would make
 * the version list stop describing what happened, and it would leave the pointer on objects whose
 * only protection is a version row a retention sweep is entitled to consider superseded. A forward
 * publish reserves a new number, names the same immutable objects, and promotes — the same order the
 * storage layer already fixed once, for the failure where a pointer led a publish.
 */
async function restoreAgentVersion(ctx: TenantContext, slug: string, version: unknown): Promise<void> {
  const wanted = typeof version === "number" && Number.isFinite(version) ? Math.floor(version) : null;
  if (wanted === null || wanted < 1) {
    refuseAgent(ctx, "that is not a version number", slug);
    return;
  }
  const agent = (await agentRepo.list(ctx, { includeArchived: true })).find((a) => a.slug === slug);
  if (!agent) {
    refuseAgent(ctx, `no agent called ${slug} in this workspace`, slug);
    return;
  }
  if (wanted === agent.current_version) {
    noticeAgent(ctx, `v${wanted} is already live`, slug);
    return;
  }
  // `includeUndone`, because a version taken off the line by an undo is exactly the one somebody
  // reaches for when they want it back — and the objects are still there, which is the whole reason
  // an undo is a pointer move rather than a delete.
  const row = (await agentRepo.versions(ctx, agent.id, true)).find((v) => v.version === wanted);
  if (!row) {
    refuseAgent(ctx, `${slug} has no v${wanted}`, slug);
    return;
  }

  const published = await agentRepo.addVersion(ctx, agent.id, row.manifest, {
    source: "import",
    summary: `restored v${wanted}`,
  });
  console.log(`[agents] ${slug} restored v${wanted} as v${published}`);
  await relay.broadcastAgents();
  relay.broadcastAgentFiles(ctx, slug);
  void relay.broadcastAgentGraph(ctx, slug);
  await relay.broadcastAgentGrid();
  noticeAgent(ctx, `v${wanted} is live again, published as v${published}`, slug);
}

async function handleAgentCommand(ctx: TenantContext, cmd: AgentCommand): Promise<void> {
  try {
    // SHAPE-CHECKED BEFORE ANYTHING ELSE SEES IT. The relay forwards any member of AGENT_COMMANDS
    // without checking its fields — deliberately, so the refusal can be written here and land on the
    // channel the grid is waiting on rather than in the status bar.
    if (typeof cmd.agentId !== "string" || !cmd.agentId) {
      refuseAgent(ctx, "that command needs an agent");
      return;
    }
    if (cmd.cmd === "archiveAgent") await setAgentArchived(ctx, cmd.agentId, true);
    else if (cmd.cmd === "restoreAgent") await setAgentArchived(ctx, cmd.agentId, false);
    else if (cmd.cmd === "renameAgent") await renameAgent(ctx, cmd.agentId, cmd.name);
    else if (cmd.cmd === "forkAgent") await forkAgent(ctx, cmd.agentId);
    else if (cmd.cmd === "restoreAgentVersion") await restoreAgentVersion(ctx, cmd.agentId, cmd.version);
  } catch (err) {
    // A FIXED SENTENCE, AND THE REAL ONE IN THE LOG — the same rule the thread commands follow. What
    // throws on this path is usually a database driver, and nothing a driver wrote was written for a
    // person to read.
    console.error(`[agents] ${cmd.cmd} failed:`, (err as Error)?.message ?? err);
    refuseAgent(ctx, "that did not work — the grid is unchanged", cmd.agentId);
  }
}

// --- threads: the snapshot and the four mutations ---------------------------
//
// §7.1's convention, exactly as the eval, MCP and members channels follow it: the two reads are
// answered by the relay from `threadSnapshot` below, and every mutation broadcasts the whole list
// afterwards. There is deliberately no partial-update path — a client replaces, so it can never
// hold a list assembled from two moments, and the counts the nav badge is drawn from can never be
// one snapshot behind the rows beside them.

/**
 * The share of a period's spend that makes one thread worth a second look (§4.3.6).
 *
 * A QUARTER, and the number is a judgement rather than a derivation. Low enough that a genuinely
 * expensive session is marked in a workspace with a handful of them; high enough that a workspace with
 * four threads does not have all four outlined, which would make the treatment mean nothing. It is a
 * constant here rather than a setting because §4.3.6 asks for "the lightest possible treatment", and a
 * threshold somebody can tune is a feature with a settings row and a migration behind it.
 */
const HIGH_COST_SHARE = 0.25;

const THREAD_COMMAND_NAMES = new Set([
  "createThread", "renameThread", "archiveThread", "restoreThread",
]);

/**
 * Which thread the one in-flight plan / generation / edit / explanation belongs to.
 *
 * MODULE STATE BESIDE `planContext`, `genContext`, `editContext` AND `replyContext`, and safe for
 * exactly the reason those are: each of the four subsystems is single-slot and refuses a second
 * while one is running. It is claimed after the guard that can refuse, for the same reason those
 * are — a refused request that repointed this would file the in-flight work's plan under the
 * refused caller's session.
 */
let planThread: string | null = null;
let genThread: string | null = null;
let editThread: string | null = null;
let replyThread: string | null = null;

/**
 * THREADS whose latest generation the validator refused.
 *
 * IN MEMORY, LIKE THE PROPOSAL AND THE PLAN IT SITS BESIDE. §3.3 counts a rejected generation as
 * work waiting on a person, and what it is waiting for is a retry in this process — the refused
 * files were never published anywhere. A restart clears this, and the thread reads as idle, which
 * is true: there is nothing left to retry, only something to ask for again.
 *
 * KEYED BY THREAD, NOT BY GENERATION, and that is what makes "cleared when the same thread generates
 * again" true rather than merely intended. Keyed by generation it could not be cleared at all: the
 * only id in hand at the start of a generation is the one just minted, and deleting a uuid nothing
 * has ever added is a no-op — so one refusal left a session amber through every later success, and
 * the §2.1 badge counted it forever. One entry per thread also bounds what was previously one entry
 * per failed attempt for the life of the process.
 */
const rejectedGenerations = new Set<string>();

/**
 * The thread a piece of work belongs to, resolving the three cases §3.1 allows.
 *
 * A NAMED THREAD, THE AGENT'S CURRENT ONE, OR A NEW ONE, in that order. The first is a client that
 * knows which session it is in. The second is the continuity migration 044's backfill established —
 * work on an agent joins the session already open on it, rather than littering the list with one row
 * per command. The third is §3.1's planning stage: somebody describing an agent that does not exist
 * yet is in a real session with real cost and nothing to attach it to.
 *
 * A `threadId` naming another workspace's thread resolves to `undefined` from the scoped read and
 * falls through to the same place as no id at all — the work is bound to this workspace's own
 * session rather than refused, because a caller learning "that id exists elsewhere" is the one
 * outcome worth avoiding.
 */
async function threadForWork(
  ctx: TenantContext,
  threadId: string | undefined,
  agentSlug?: string | null,
): Promise<string> {
  if (threadId && (await threadStore.get(ctx, threadId))) return threadId;
  if (agentSlug) {
    const agent = await agentRepo.bySlug(ctx, agentSlug);
    if (agent) return threadStore.ensureForAgent(ctx, agent.id, agent.display_name ?? agent.slug);
  }
  return (await threadStore.create(ctx)).id;
}

/**
 * Record something in a thread and tell the workspace.
 *
 * THE BROADCAST IS HERE RATHER THAN AT EVERY CALL SITE, because an item is exactly what §7.1 calls
 * a genuine state transition: a proposal appearing turns a row amber, a run starting turns it
 * ●, a message changes the preview. What must NOT be here is a per-cost-tick broadcast — that would
 * turn a full-snapshot channel into a polling one, which is the thing §7.1's protocol note refuses.
 *
 * Floating and caught, like `meterPlatformCall`: every call site is on a path somebody is watching,
 * and a generation must not fail because a list could not be refreshed.
 */
function noteThreadItem(
  ctx: TenantContext,
  threadId: string,
  item: { kind: ThreadItemKind; refId?: string | null; role?: "user" | null; body?: string | null },
): void {
  void threadStore
    .addItem(ctx, threadId, item)
    .then(() => scheduleListRefresh(ctx))
    .catch((err) => {
      console.error(`[threads] could not record a ${item.kind}:`, (err as Error)?.message ?? err);
    });
}

/**
 * What the user said, as the thread's own record.
 *
 * THE ONLY PROSE A THREAD STORES, and §4.3 is the reason: the preview line is "the last user
 * message, not Jaroku's reply", because the user's own intent is what makes a session recognisable.
 * Jaroku's half of the conversation is streamed on the gen / edit / reply channels and rebuilt from
 * them, so a second copy here would be a transcript nothing reads.
 */
function noteUserMessage(ctx: TenantContext, threadId: string, body: string): void {
  const text = body.trim();
  if (!text) return;
  void (async () => {
    await threadStore.addItem(ctx, threadId, { kind: "message", role: "user", body: text });
    // §5'S TITLE, FROM THE FIRST MESSAGE — THE ROW, NOT THE COUNT. This used to read the message
    // count back and title only when it was exactly one, which turned a race into no title at all:
    // two first messages whose inserts both landed before either read both saw two, so neither
    // titled, and the count only grows afterwards. A double-submit, two members of a Team workspace,
    // or a `planAgent` followed straight away by an `edit` all reach it, and the row then stayed
    // `Untitled thread` forever with §4.4's text filter unable to find it.
    //
    // Reading the FIRST message instead is idempotent: both racers see the same row and derive the
    // same title, so whichever writes last writes the same thing. Titling from every message would
    // be wrong for a different reason — §5 says the first — and `autoTitle` is a no-op on a thread
    // somebody has renamed, a guarantee that lives in its UPDATE's own WHERE rather than in a branch
    // here, so two clients racing cannot get past it either.
    const first = await threadStore.firstMessage(ctx, threadId);
    if (first) await threadStore.autoTitle(ctx, threadId, threadTitle(first));
    scheduleListRefresh(ctx);
  })().catch((err) => {
    console.error(`[threads] could not record a message:`, (err as Error)?.message ?? err);
  });
}

/**
 * What is outstanding in every thread, gathered from the places that know.
 *
 * SIX SOURCES, ONE PASS. Ownership comes from `thread_items`; liveness comes from whoever owns the
 * live thing — the editor's proposal map, the planner's slot, the confirm queue, `runs.status`,
 * `eval_runs.status`, the deploy store. `collectThreadFacts` is pure and takes all of it as data,
 * which is why the interesting half of §3.3 is testable without standing this process up.
 *
 * WHAT A RESTART DOES TO THIS, on purpose: a proposal and a plan live in memory, so after a restart
 * neither map has anything in it, no thread claims a pending diff, and the list says idle. That is
 * true rather than convenient — there is no diff left to apply — and it is why nothing here keeps a
 * durable "pending" flag that would go on asking somebody to apply what no longer exists.
 */
async function threadFactsFor(
  ctx: TenantContext,
  /**
   * The rows and items the caller has already read.
   *
   * `threadSnapshot` needs both for its own loop, and this needed both for the derivation — so
   * every snapshot listed the workspace's threads twice and read its entire `thread_items` table
   * twice, on every message, run start, proposal and thread command. Passed in rather than cached,
   * because the two must describe the same moment: a derivation over one read of the items and a
   * render over another is two moments in one list, which is what §7.1's full snapshots exist to
   * prevent.
   */
  loaded?: { rows: Thread[]; items: ThreadItem[] },
): Promise<Map<string, ThreadDerivation>> {
  const rows = loaded?.rows ?? (await threadStore.list(ctx));
  const items = loaded?.items ?? (await threadStore.allItems(ctx));
  const [runs, unfinishedEvals, deployedBySlug, agents] = await Promise.all([
    // ONLY THE RUNS SOME THREAD OWNS. The derivation looks up nothing else, and the ids are right
    // here in the items — so this is an indexed lookup rather than a scan of every run in the
    // workspace plus a GROUP BY over every errored run's steps.
    store.runOutcomes(
      ctx,
      items.filter((i) => i.kind === "run" && i.ref_id).map((i) => i.ref_id!),
    ),
    evalStore.unfinishedEvalRuns(ctx),
    deployStore.currentByAgent(ctx),
    agentRepo.list(ctx),
  ]);

  // The deploy store is keyed by SLUG and a thread holds the agent's uuid, so the two are joined
  // here rather than in the collector — which should not have to know that `agents` has two names.
  const uuidBySlug = new Map(agents.map((a) => [a.slug, a.id]));
  const deployedAgents = new Set<string>();
  for (const [slug, d] of deployedBySlug) {
    const uuid = uuidBySlug.get(slug);
    if (uuid && d.status === "live") deployedAgents.add(uuid);
  }

  // Progress per unfinished eval. One query per eval rather than one for all of them, because
  // "unfinished" is a handful by construction — a workspace with a hundred live evals has a
  // different problem than a slow list.
  const evals = new Map<string, EvalFact>();
  for (const ev of unfinishedEvals) {
    const jobs = await evalStore.jobsForEval(ctx, ev.id);
    evals.set(ev.id, {
      running: true,
      done: jobs.filter((j) => j.status !== "queued" && j.status !== "running").length,
      total: jobs.length,
      // The runs actually executing, so §4.3.3's live figure can attribute their step costs. A queued
      // job has no run yet and a finished one's cost is already in the ledger.
      liveRunIds: jobs.filter((j) => j.status === "running" && j.run_id).map((j) => j.run_id!),
    });
  }

  // Which runs are blocked on a person, counted per run — the queue is per run because a node can
  // fire several high-impact calls in one turn and each blocks independently.
  const confirms = new Map<string, number>();
  for (const p of pendingConfirms.values()) {
    if (p.workspaceId !== ctx.workspaceId) continue;
    confirms.set(p.runId, (confirms.get(p.runId) ?? 0) + 1);
  }

  const plans = new Set<string>();
  const pendingPlan = planner.peek(ctx.workspaceId);
  if (pendingPlan) plans.add(pendingPlan.planId);

  const proposals = new Map<string, { added: number; removed: number }>();
  for (const [id, p] of editor.openProposals(ctx)) proposals.set(id, { added: p.added, removed: p.removed });

  return collectThreadFacts({
    threads: rows,
    items,
    runs: runs as Map<string, RunFact>,
    evals,
    proposals,
    plans,
    rejectedGenerations,
    confirms,
    deployedAgents,
  });
}

/**
 * The workspace's threads, as the list renders them.
 *
 * DERIVED HERE, WRITTEN BACK WHEN IT MOVED. §3.3's status is a function of live facts, so the
 * stored column is a cache: this recomputes on every read and issues an UPDATE only for the rows
 * whose answer changed. That is what keeps "the deriver is the only writer" true without making a
 * read cost a write per row.
 */
async function threadSnapshot(ctx: TenantContext): Promise<ThreadSnapshot> {
  // ONE READ OF EACH, SHARED WITH THE DERIVATION. Both halves need the rows and the items, and
  // both used to fetch their own copy — so a snapshot cost two full listings of the workspace's
  // threads and two full reads of a table that only ever grows.
  const [rows, items] = await Promise.all([threadStore.list(ctx), threadStore.allItems(ctx)]);
  const [derived, spend, agents, deletedAgents] = await Promise.all([
    threadFactsFor(ctx, { rows, items }),
    // Cumulative, never "this period" — §4.3's cost column is a fact about the session. See
    // `spendByThread`.
    billing.spendByThread(ctx),
    agentRepo.list(ctx),
    // §3.2 is a JOIN, not a stored fact — see `noteAgentDeleted`. An agent's deletion is soft and
    // reverses itself when its directory comes back, so the row has to be able to stop being
    // `(deleted)` as easily as it started.
    agentRepo.deletedIds(ctx),
  ]);
  // THE SLUG, NOT THE UUID, GOES OUT ON THE WIRE. Every other thing the client holds calls the slug
  // "the agent id" — `listAgents` maps it that way, the sidebar selects by it, the run rows carry it —
  // so sending the uuid here would make this the one place where an agent id means something else,
  // and the row's agent chip could not select the agent it names. The uuid stays in the database,
  // where the foreign key is.
  const slugByUuid = new Map(agents.map((a) => [a.id, a.slug]));
  // And the name it goes by NOW, for the chip — see `agent_name` below. Only live agents are in
  // this list, so a miss is either a deleted agent or one this replica has not materialised, and
  // both fall back to the snapshot, which is the name the thread was linked to.
  const nameByUuid = new Map(agents.map((a) => [a.id, a.display_name ?? a.slug]));
  const views: ThreadView[] = [];
  const counts: ThreadCounts = { all: 0, needs_you: 0, running: 0, recent: 0, archived: 0 };
  /**
   * The rows whose cached status moved, grouped by what it moved TO.
   *
   * COLLECTED HERE AND WRITTEN ONCE BELOW, rather than one awaited UPDATE per row inside the loop.
   * There are five statuses, so this is at most five statements however long the list is — where
   * the sequential version made a workspace's first look at Threads after a busy afternoon a
   * round trip per changed thread, in series, on the path a socket is waiting on.
   */
  const moved = new Map<ThreadStatus, string[]>();

  for (const row of rows) {
    const entry = derived.get(row.id);
    const { status, fragment } = deriveThreadStatus(entry?.facts ?? { ...NO_FACTS, archivedAt: row.archived_at });
    const cost = spend.get(row.id);
    // Only when it moved. A read that wrote every row would turn opening the tab into one UPDATE
    // per thread, and `setStatus` refuses `archived` anyway — that one follows the timestamp.
    if (status !== row.status) moved.set(status, [...(moved.get(status) ?? []), row.id]);

    views.push({
      id: row.id,
      // Null for a deleted agent, which is what makes the chip render `name (deleted)` rather than a
      // link to nothing — and null for a slug the workspace no longer has, which is the same case.
      agent_id: row.agent_id ? (slugByUuid.get(row.agent_id) ?? null) : null,
      // THE LIVE NAME WHILE THE AGENT IS ALIVE, the snapshot only once it is not.
      //
      // §3.2 specifies the snapshot for a DELETED agent, and §4.3 says a live one shows "Agent
      // name" — but this rendered the snapshot unconditionally, and the snapshot is written once at
      // create/attach and never refreshed. `upsertFromDisk` rewrites `display_name` on every sync,
      // so renaming an agent left every thread row showing the old name while the sidebar two
      // panels over showed the new one.
      agent_name:
        (row.agent_id ? (nameByUuid.get(row.agent_id) ?? null) : null) ?? row.agent_name_snapshot,
      // The pair §4.3 renders three ways, and it is asked of the AGENTS table rather than of the
      // thread. Two cases mean deleted: the agent row is soft-deleted (reversible — the row stops
      // saying `(deleted)` the moment the agent comes back), or the link is gone entirely, which is
      // the hard delete's cascade and is what the snapshot name exists for.
      //
      // Deliberately NOT the slug lookup above: that also comes back empty for an agent this
      // replica has not materialised, and calling that "deleted" would dim a live agent's name.
      agent_deleted:
        (row.agent_id !== null && deletedAgents.has(row.agent_id)) ||
        (row.agent_id === null && row.agent_name_snapshot !== null),
      title: row.title,
      title_is_custom: row.title_is_custom,
      created_by: row.created_by,
      created_at: row.created_at,
      last_activity_at: row.last_activity_at,
      archived_at: row.archived_at,
      status,
      fragment,
      // UNKNOWN IS NOT ZERO, and a thread nothing has been spent in is a third case again. Null
      // means "nothing has cost anything yet" — a thread opened a minute ago — and `cost_known:
      // false` means the figure is a floor because something in it ran on an unpriced model. §4.3
      // renders those as nothing, `$0.04` and `$0.04+` respectively, which are three different
      // sentences.
      cost_usd: cost ? cost.usd : null,
      cost_known: cost ? cost.costKnown : true,
      preview: entry?.preview ?? null,
      // §4.3.3. Empty and null respectively for anything not running, so a client has nothing to
      // increment and nothing to extrapolate from — which is exactly what a thread whose cost has
      // stopped moving should show.
      live_run_ids: status === "running" ? (entry?.liveRunIds ?? []) : [],
      live_eval_ids: status === "running" ? (entry?.liveEvalIds ?? []) : [],
      eval_progress: status === "running" ? (entry?.facts.evalProgress ?? null) : null,
      // Both filled in below: the first needs every row's status, the second needs the period total.
      agent_active: 0,
      cost_share_high: false,
    });

    if (status === "archived") counts.archived++;
    // `needs_you` counts the SECTION, which §4.2 fills with both blocked statuses. One number,
    // rendered on the chip and on the nav badge — see ThreadCounts.
    else if (status === "needs_you" || status === "errored") counts.needs_you++;
    else if (status === "running") counts.running++;
    else counts.recent++;
  }

  // The cache catches up, in one statement per status that moved rather than one per row.
  await Promise.all([...moved].map(([status, ids]) => threadStore.setStatuses(ctx, ids, status)));

  // §4.3.4'S COLLISION COUNT, IN A SECOND PASS, because it is a fact about an AGENT and the first pass
  // is per thread: how many of an agent's sessions are live cannot be known until every one of them has
  // been derived. Two threads mid-flight against the same `api_gateway` files is a guaranteed occurrence
  // in a Team workspace, where any member may act on any thread — and this is the thread-level version of
  // the divergence Jaroku already detects for git branches. The panel's job is to surface it, not to
  // resolve it: nothing here blocks, merges or locks anything.
  const active = activePerAgent(views);
  for (const v of views) {
    v.agent_active = v.agent_id ? (active.get(v.agent_id) ?? 0) : 0;
  }

  // §4.3.6'S CONTEXT FOR A BARE FIGURE. `$0.04` says nothing about whether that is a lot here, and the
  // answer the row needs is one bit: worth a second look, or not.
  //
  // AGAINST THE ROLLING SPEND THE BILLING LAYER ALREADY AGGREGATES — the same period total the usage
  // panel is drawn from — so no new spend computation exists for this. One extra read, and a comparison.
  //
  // A THREAD'S TOTAL IS CUMULATIVE AND THE PERIOD'S IS NOT, which is why the comparison is bounded
  // below: a session that ran for three months against a workspace that started billing last week would
  // otherwise be "high share" simply for being older than the window. Threads that cost less than the
  // period total are the only ones the share can honestly be computed for; a thread that exceeds it is
  // marked anyway, because it is by definition the expensive one on the screen.
  const period = await budgetGate.status(ctx).then((s) => s.periodStart).catch(() => null);
  const periodTotal = period ? (await billing.spendSince(ctx, period)).usd : 0;
  if (periodTotal > 0) {
    for (const v of views) {
      if (v.cost_usd === null) continue;
      v.cost_share_high = v.cost_usd / periodTotal >= HIGH_COST_SHARE;
    }
  }

  // `all` is every active thread, not every row: the All chip and the Archived chip are two
  // filters over one list, and a total that included archived rows would make All the only chip
  // whose count did not match what clicking it shows.
  counts.all = counts.needs_you + counts.running + counts.recent;
  return { threads: views, counts };
}

async function broadcastThreads(ctx: TenantContext): Promise<void> {
  relay.broadcastThreads(ctx, { type: "threads", ...(await threadSnapshot(ctx)) });
}

/**
 * How long a workspace's pending thread broadcast waits for company.
 *
 * Short enough to be invisible — a click and its result still land in the same eye-blink — and long
 * enough to collapse the burst that one action really produces: an apply broadcasts, syncs the
 * agents, refreshes the files and rebuilds the graph, and a run ending touches the list from three
 * separate handlers within a millisecond of each other.
 */
const THREAD_BROADCAST_COALESCE_MS = 60;
const pendingThreadBroadcasts = new Map<string, ReturnType<typeof setTimeout>>();

/**
 * Refresh the two workspace lists soon, once, however many times this is called.
 *
 * §7.1 FORBIDS A POLLING CHANNEL, NOT COALESCING. The rule is that a full snapshot goes out on a
 * genuine state transition and never per cost tick; nothing in it asks that three transitions
 * arriving in the same millisecond produce three scans of the workspace. And the snapshot is
 * expensive by construction — it reads every thread, every item and every owned run — so a burst
 * issued one broadcast per event is the shape that makes the list appear to freeze under load.
 *
 * BOTH LISTS, ON ONE TIMER, and that is what this grew into when the Agents tab landed. Every one of
 * the eighteen places that calls this is a moment both lists changed: a run starting turns a thread
 * row ● and an agent card amber, a run ending grows a card's sparkline and settles a thread's status,
 * an applied edit moves a version on one surface and clears a pending diff on the other. Two
 * schedulers over one set of transitions would be two chances to add a call site to only one of them
 * — which is how a surface goes quietly stale — and the Agents grid's whole §5.5 promise is that it
 * updates without a refresh.
 *
 * The last call wins the context, which is correct because they are all the same workspace: the
 * key IS the workspace id, so two tenants never share a timer.
 *
 * Callers that must be immediate — a thread or agent command answering the socket that sent it —
 * still broadcast directly. This is for the event-driven ones, which is most of them.
 */
function scheduleListRefresh(ctx: TenantContext): void {
  const existing = pendingThreadBroadcasts.get(ctx.workspaceId);
  if (existing) clearTimeout(existing);
  const timer = setTimeout(() => {
    pendingThreadBroadcasts.delete(ctx.workspaceId);
    void broadcastThreads(ctx).catch((err) =>
      console.error(`[threads] could not refresh the list:`, (err as Error)?.message ?? err),
    );
    // Not awaited against the thread refresh and caught on its own: an Agents grid that could not be
    // rebuilt must not stop the Threads list from being, and neither is worth failing a run over.
    void relay.broadcastAgentGrid().catch((err) =>
      console.error(`[agents] could not refresh the grid:`, (err as Error)?.message ?? err),
    );
  }, THREAD_BROADCAST_COALESCE_MS);
  // Never the reason a process stays alive: a pending list refresh is not work worth delaying an
  // exit for, and the next boot's first snapshot is the same answer.
  timer.unref?.();
  pendingThreadBroadcasts.set(ctx.workspaceId, timer);
}

/**
 * A refusal on the threads channel, to the socket that earned it and nobody else.
 *
 * BROADCAST WAS THE WRONG PRIMITIVE HERE. A refusal is about one command from one client — one
 * member's mistyped rename painted a red strip across every teammate's Threads view, telling
 * somebody who had done nothing that "a thread needs a name — Escape cancels the edit" with no edit
 * open. `sendThreads` is the shape `createThread`'s answer already uses, and for the same reason.
 */
function refuseThread(ctx: TenantContext, message: string, threadId?: string): void {
  relay.sendThreads(ctx, ctx.requestId, { type: "error", message, ...(threadId ? { threadId } : {}) });
}

async function handleThreadCommand(ctx: TenantContext, cmd: ThreadCommand): Promise<void> {
  try {
    // SHAPE-CHECKED BEFORE THE DRIVER SEES IT. The relay forwards any member of THREAD_COMMANDS
    // without checking its fields — deliberately, so the refusal can be written here — and
    // `{"cmd":"archiveThread"}` with no id therefore reached `threadStore.archive(ctx, undefined)`
    // and let whatever the driver threw become a workspace-wide message.
    if (cmd.cmd !== "createThread" && typeof cmd.threadId !== "string") {
      refuseThread(ctx, "that command needs a thread");
      return;
    }

    if (cmd.cmd === "createThread") {
      const agentId = typeof cmd.agentId === "string" ? cmd.agentId : null;
      // The name is snapshotted at creation (§3.2), so it has to be resolved now rather than at
      // read time. A slug that names no agent in THIS workspace resolves to null and the thread is
      // created without one, which is the same outcome as not naming an agent at all.
      const agent = agentId ? await agentRepo.bySlug(ctx, agentId) : undefined;
      const thread = await threadStore.create(ctx, {
        agentId: agent?.id ?? null,
        agentName: agent ? (agent.display_name ?? agent.slug) : null,
        title: typeof cmd.title === "string" ? cmd.title : undefined,
      });
      console.log(`[threads] opened ${thread.id}${agent ? ` on ${agent.slug}` : ""}`);
      // ONE SNAPSHOT, READ TWICE. The broadcast is the list and the answer below is one row of the
      // same list — building each from its own `threadSnapshot` meant a create cost two full scans
      // of the workspace to produce two views that were required to agree.
      const snapshot = await threadSnapshot(ctx);
      relay.broadcastThreads(ctx, { type: "threads", ...snapshot });
      // And to the socket that asked, so it knows WHICH thread it just made. The broadcast is a
      // list; a client that had only that would have to guess its own new row by timestamp.
      // With its (empty) items, so the client can open it straight away rather than having to ask
      // again for a conversation it already knows is empty — see BUG-13's dead row.
      const made = snapshot.threads.find((t) => t.id === thread.id);
      if (made) {
        relay.sendThreads(ctx, ctx.requestId, {
          type: "thread",
          // The client OPENS this one rather than merely filing it, which is what turns a new row
          // from an inert entry in the list into the session the next thing typed lands in.
          reason: "created",
          thread: made,
          items: await threadStore.itemsFor(ctx, thread.id),
        });
      }
      return;
    }

    if (cmd.cmd === "renameThread") {
      // REFUSED RATHER THAN COERCED. `String(cmd.title)` turned a non-string into `"[object
      // Object]"` and stored it as somebody's chosen title — a coercion is the shape of accepting
      // input nobody sent. The length bound lives in the store, where both entry points meet it.
      if (typeof cmd.title !== "string") {
        refuseThread(ctx, "a thread needs a name — Escape cancels the edit", cmd.threadId);
        return;
      }
      const title = cmd.title.trim();
      if (!title) {
        refuseThread(ctx, "a thread needs a name — Escape cancels the edit", cmd.threadId);
        return;
      }
      await threadStore.rename(ctx, cmd.threadId, title);
      await broadcastThreads(ctx);
      return;
    }

    if (cmd.cmd === "archiveThread") {
      await threadStore.archive(ctx, cmd.threadId);
      await broadcastThreads(ctx);
      return;
    }

    if (cmd.cmd === "restoreThread") {
      await threadStore.restore(ctx, cmd.threadId);
      await broadcastThreads(ctx);
      return;
    }
  } catch (err) {
    // On the threads channel, because that is where the list is waiting for an answer. A refusal
    // in the status bar would leave the row showing the state it had before the click.
    //
    // A FIXED SENTENCE, AND THE REAL ONE IN THE LOG. What was interpolated here is whatever threw —
    // which on this path is usually a database driver, and the relay's own rule is that everything
    // reaching a client "was written in this codebase for a person to read, never a driver's". It
    // went to every socket in the workspace as well, so one member's malformed frame disclosed
    // internal error text to everybody with the tab open.
    console.error(`[threads] ${cmd.cmd} failed:`, (err as Error)?.message ?? err);
    refuseThread(ctx, "that did not work — the list is unchanged");
  }
}

/**
 * One thread as the list renders it.
 *
 * Goes through `threadSnapshot` rather than building a view of its own, because a second builder is
 * a second answer: the row a client is handed after a create and the row it gets in the next
 * broadcast have to agree about the derived status, and two functions cannot be made to.
 */
async function threadView(ctx: TenantContext, threadId: string): Promise<ThreadView> {
  const snapshot = await threadSnapshot(ctx);
  return snapshot.threads.find((t) => t.id === threadId)!;
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

/**
 * The rung this workspace is under, its explanation, and everything it has been under before.
 *
 * WHAT WAS MISSING WAS THE OTHER HALF OF THE LADDER. Work really is refused, and the workspace
 * really is told — by a message on whichever channel it happened to be working in. What it could
 * not do was read its own standing anywhere, or answer it: `appeal()` and `history()` had no
 * command, no route and no caller, so `appeal_note` could only be written with SQL. An appeal that
 * requires database access is not an appeal.
 *
 * THE RUNG'S OWN SENTENCE TRAVELS WITH IT. `enforcementRefusal` is what a refusal is built from,
 * and sending the same sentence here means the strip explaining the state and the refusal that
 * produced it cannot drift apart — the same rule the usage panel follows about `BudgetGate.status`.
 */
async function broadcastEnforcement(ctx: TenantContext): Promise<void> {
  try {
    const [state, history] = await Promise.all([
      enforcementRepo.current(ctx),
      enforcementRepo.history(ctx),
    ]);
    relay.broadcastEnforcement(ctx, {
      type: "enforcement",
      state: {
        ...state,
        // The sentence a refusal would carry, so the strip and the refusal are one computation.
        explain: state.level === "none" ? null : enforcementRefusal(state),
        // Whether this rung refuses work outright, rather than leaving a client to re-derive the
        // ladder's ordering from a level name.
        refusesWork: refusesWork(state.level),
      },
      history,
    });
  } catch (err) {
    const message = (err as Error)?.message ?? String(err);
    console.error(`[abuse] loadEnforcement failed: ${message}`);
    relay.broadcastEnforcement(ctx, { type: "error", message: "could not read this workspace's standing" });
  }
}

/**
 * Record what the workspace says about the rung it is under.
 *
 * It changes NOTHING about the enforcement, and the notice says so. A control that appeared to lift
 * a suspension and did not would be worse than no control — so the answer is the same snapshot with
 * `appealed_at` on the row, plus a sentence about what happens next.
 */
async function appealEnforcement(ctx: TenantContext, note: unknown): Promise<void> {
  const text = typeof note === "string" ? note.trim() : "";
  if (!text) {
    relay.broadcastEnforcement(ctx, { type: "error", message: "an appeal needs something to say" });
    return;
  }
  try {
    // False means there was nothing in force to appeal against — a rung lifted or lapsed between
    // the strip being rendered and the button being pressed, which is the ordinary race here.
    const recorded = await enforcementRepo.appeal(ctx, text);
    if (!recorded) {
      relay.broadcastEnforcement(ctx, {
        type: "notice",
        message: "there is nothing in force to appeal — this workspace is not under a rung",
      });
    } else {
      console.log(`[abuse] ${ctx.workspaceId} appealed its enforcement (${text.length} chars)`);
      relay.broadcastEnforcement(ctx, {
        type: "notice",
        message: "your appeal is recorded on the enforcement — a person reviews it, and nothing changes until they do",
      });
    }
    await broadcastEnforcement(ctx);
  } catch (err) {
    const message = (err as Error)?.message ?? String(err);
    console.error(`[abuse] appealEnforcement failed: ${message}`);
    relay.broadcastEnforcement(ctx, { type: "error", message: "could not record that appeal" });
  }
}

/**
 * The workspace's own record of what has been done to it (§the audit trail).
 *
 * WHY THIS EXISTS AT ALL. Every membership mutation writes an `audit_log` row inside the
 * transaction that makes the change; so does every GitHub safety override, every secret reveal and
 * rotation, every enforcement appeal, and workspace export and deletion. The reason given in the
 * code for writing them is that somebody will need to read them — `auditGithubOverride`'s own
 * comment says the record has to be readable "by somebody who does not know this feature exists".
 * The reader was written and had no caller: no command, no route, no UI. The rows were kept for a
 * question nobody could ask.
 *
 * ANSWERED TO THE ASKING SOCKET, and bounded. The default is the repository's hundred; a client may
 * ask for fewer or more, up to a cap, because this is the one read in the product whose useful range
 * is "the last few things" to "everything since the incident started".
 */
const AUDIT_LIMIT_MAX = 500;

async function sendAuditLog(ctx: TenantContext, limit?: number): Promise<void> {
  try {
    // Clamped rather than refused: an out-of-range number is a client being generous with a
    // parameter, not an attack, and answering 500 rows to a request for 50,000 is the useful
    // response. A non-number falls through to the repository's own default.
    const bounded =
      typeof limit === "number" && Number.isFinite(limit) && limit > 0
        ? Math.min(Math.floor(limit), AUDIT_LIMIT_MAX)
        : undefined;
    const entries = await identityRepo.listAudit(ctx, bounded);
    relay.sendAudit(ctx, ctx.requestId, { type: "audit", entries });
  } catch (err) {
    const message = (err as Error)?.message ?? String(err);
    console.error(`[audit] listAudit failed: ${message}`);
    relay.sendAudit(ctx, ctx.requestId, { type: "error", message: "could not read the audit log" });
  }
}

// --- github: commands -------------------------------------------------------
//
// Every mutation answers by re-broadcasting the whole snapshot on the "github" channel, the same
// shape a fresh `listGithub` would return — so a client never reconciles a partial update against
// local state. §1's four regions are views of ONE reconciliation, and a client that merged would
// eventually render a verdict computed from a link that had already moved.
//
// NOT ONE COMMAND HERE TOUCHES A TOKEN. Connecting is `POST /v1/github/connect`, in the secrets
// group, behind `guarded()` — see wsRelay.ts and http/secrets.ts for why that has to be HTTP.

// THE SAME TWELVE NAMES `wsRelay.GITHUB_COMMANDS` FORWARDS, PLUS THE ONE THIS LIST HAD DROPPED.
// The relay decides which commands reach the server and this decides which handler they reach, so
// a name in one and not the other is not a type error anywhere — it is a command that arrives,
// passes its capability check, and falls through the dispatch chain into `handleEvalCommand`,
// which has never heard of it. That is what happened to `generateGithubMessage`: ✨ generate sent,
// the button span, and no answer was ever coming.
const GITHUB_COMMAND_NAMES = new Set([
  "listGithub", "listGithubRepos", "checkGithubRepo", "linkGithub", "unlinkGithub",
  "refreshGithub", "pushGithub", "pullGithub", "switchGithubBranch", "createGithubBranch",
  "openGithubPr", "commitGithub", "generateGithubMessage", "diagnoseFile",
  "shadowRunGithub", "listShadowRuns", "semanticDiffGithub", "resolveReviewComment",
  "setAgentCiConfig", "listScanFindings",
]);

const prComments = new PrCommentsRepository(db);
// DECLARED HERE RATHER THAN BESIDE `checkRunner` BELOW, purely because the panel reads it: §B.8.2's
// markers are on the snapshot, so `githubService` needs it before `checkRunner` is constructed.
const checksRepo = new ChecksRepository(db);

const githubService = new GithubService({
  repo: githubRepo,
  identity: githubIdentity,
  agents: agentRepo,
  projects,
  // §B.5's mirrored review comments. The service syncs them on every view, which is one request per
  // panel open against a pull request that exists — and the only way the REVIEW region can be
  // current without a second webhook.
  comments: prComments,
  // §B.8.2's ⧫ markers, fed straight from B.1's check_runs rows — which is what makes a glance at
  // the canvas answer three questions at once: which commit is live, which scored best, and how far
  // main is from either.
  checks: checksRepo,
  // The same resolver `agentFilesDeps` uses, so the PROTECTED group in the panel and the read-only
  // set the edit loop enforces are one answer rather than two that agree today.
  connectorFilesFor: agentFilesDeps.connectorFilesFor,
  // BOTH RUNNERS, because ⟳ answers "is something happening" and not "which of the two". Declared
  // before either exists and read only at call time, which is the only order available: the
  // runners need nothing from the service and the service needs a live answer from them.
  inFlight: (agentUuid) => githubPusher.busy(agentUuid) || githubPuller.busy(agentUuid),
});

const githubPusher = new GithubPusher({
  repo: githubRepo,
  identity: githubIdentity,
  agents: agentRepo,
  projects,
  // §B.8.1's `Jaroku-Model` and `Jaroku-Cost`, resolved here because the pusher writes git objects
  // and this is where the billing repository lives. Per version, against the window between it and
  // the version before it — `billing.authoringSpend` says at length why a window is the only join
  // available and why a partial sum is null rather than a smaller number.
  //
  // WALKED OLDEST FIRST WITH A ROLLING BOUNDARY, so a push of six versions asks six bounded
  // questions rather than one unbounded one. The first version in the push is bounded BELOW by
  // whatever came before it in the agent's own history, not by the push — otherwise the earliest
  // commit in every push would be charged with everything that ever happened before it.
  provenanceFor: async (ctx, agentUuid, versions) => {
    const all = await agentRepo.versions(ctx, agentUuid);
    const previousOf = new Map<number, string | null>();
    // `versions()` is newest first; the row after a given one in that order is the one before it
    // in time, which is the lower bound each window wants.
    for (const [i, v] of all.entries()) previousOf.set(v.version, all[i + 1]?.created_at ?? null);

    const costs: (number | null)[] = [];
    let model: string | null = null;
    for (const v of versions) {
      const spend = await billing.authoringSpend(ctx, {
        after: previousOf.get(v.version) ?? null,
        until: v.created_at,
      });
      costs.push(spend.costUsd);
      // The first model named by any version in the push. A squash writes one line, and a push of
      // six separate commits gets the same line on each — the alternative is a per-version model
      // lookup that would usually answer the same thing at six times the cost.
      model ??= spend.model;
    }
    return { model, costs };
  },
  // §3.3's PROTECTED group, the same answer the service and the puller get, so a hand-staged
  // selection cannot reach a file the edit loop already refuses.
  connectorFilesFor: (agentUuid, slug) => agentFilesDeps.connectorFilesFor(undefined, slug),
  // §2.2's "Include Dockerfile & pyproject", rendered here because this is where the connector
  // catalogue and the serve template live — the same reason `provenanceFor` resolves here.
  //
  // THE SAME `buildArtifacts` THE DEPLOY PATH CALLS, from the agent's own row rather than from
  // `jaroku.json` on disk: the row is the source of truth since migration 008, and a push must not
  // depend on the agent happening to be materialised locally. `serve.py` is copied rather than
  // rendered — it is the one reviewed template of the four — and is read from the same directory
  // `writeDeployArtifacts` reads it from, so the pushed repo builds the image the deploy would.
  deployArtifactsFor: async (ctx, agentUuid, slug, files) => {
    const agent = await agentRepo.byId(ctx, agentUuid);
    if (!agent) return [];
    const { files: rendered } = buildArtifacts(
      {
        agentId: slug,
        connectors: agent.connectors,
        hasMcpTools: files.some((f) => f.path === MANIFEST_FILE),
        provider: agent.default_provider,
        ...(agent.description ? { description: agent.description } : {}),
      },
      loadConnectors(RUNTIME_DIR),
    );
    const out = Object.entries(rendered).map(([path, content]) => ({ path, content }));
    const serve = join(templatesDir(RUNTIME_DIR), "serve.py");
    // Absent means the three synthesised files still go, and the Dockerfile's own CMD is what
    // reports the missing entrypoint — which is a clearer failure than a repo with no artifacts.
    if (existsSync(serve)) out.push({ path: "serve.py", content: readFileSync(serve, "utf8") });
    return out;
  },
  // §B.6.1's literal pass: this workspace's credential VALUES.
  //
  // NAMES FROM THE VAULT, VALUES FROM THE ENVIRONMENT, which is the same pairing
  // `deploySecrets.resolveSecretValues` makes and for the same reason — the vault deliberately has
  // no plaintext-return path reachable from a request handler. `SecretsManager.reveal` needs an
  // elevation receipt, and a push is not an elevated operation: somebody pushing code has not
  // unlocked the Secrets tab and should not have to.
  //
  // SO THIS PASS IS NARROWER THAN IT LOOKS, and that is the honest trade rather than a gap: it
  // catches a credential this machine can actually see, which is every one the runtime can use. A
  // value only the vault holds is not one this process could leak into a file in the first place.
  knownSecretValues: async (ctx) => [
    ...resolveSecretValues((await secrets.listNames(ctx)).map((s) => s.name)).values(),
  ],
  // §B.4.4's bar for every intermediate state of a restack.
  //
  // THE REAL VALIDATOR, ON A REAL DIRECTORY, and that is the expensive part of the feature rather
  // than an incidental one: a reorder of four versions runs it four times, each with a sandboxed
  // import. It is what makes the guarantee true — a state that only parses is exactly the class
  // v0.1.0's changelog says AST checks cannot catch — and the alternative is a cheaper check that
  // would let a broken middle version through to be promoted later.
  //
  // A SCRATCH DIRECTORY PER STATE, removed in a finally. These states are candidates that mostly do
  // not become anything, so nothing is written to the object store and nothing reaches
  // `agent_versions` — which is the same discipline the puller keeps, one step earlier in its own
  // pipeline.
  validateFiles: async (ctx, agentUuid, files) => {
    const agent = await agentRepo.byId(ctx, agentUuid);
    if (!agent) return { ok: false, problems: ["no such agent in this workspace"] };
    const readOnly = readOnlyPaths(agentFilesDeps.connectorFilesFor(agent, agent.slug));
    const scratch = mkdtempSync(join(tmpdir(), `jaroku-restack-${agent.slug.slice(0, 12)}-`));
    try {
      for (const file of files) {
        const target = join(scratch, file.path);
        mkdirSync(dirname(target), { recursive: true });
        writeFileSync(target, file.content, "utf8");
      }
      const result = await validateProject(scratch, {
        runtimeDir: RUNTIME_DIR,
        connectorFiles: [...readOnly],
        // DON'T-REGRESS, read exactly as the edit loop and the puller read it: demanded only of an
        // agent that already had it, so a version generated before the templates started raising
        // stays reorderable.
        requireToolErrorHandling: files.some((f) => /handle_tool_errors\s*=\s*True/.test(f.content)),
      });
      return { ok: result.ok, problems: result.problems };
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
  },
});

/**
 * §B.2's ephemeral runs.
 *
 * THE STAGING ROOT IS THE ONE THE BOOT SWEEP ALREADY CLEARS — `runtime/agents/.staging/` — so a
 * process that died holding a materialised ref leaves nothing behind across a restart, on top of
 * the timed sweep that handles the ordinary case. Two mechanisms for the same directory is not
 * duplication here: one covers a crash and the other covers a long-lived process.
 */
const shadowRepo = new ShadowRunRepository(db);
const shadowRunner = new ShadowRunner({
  shadows: shadowRepo,
  projects,
  stagingRoot: join(RUNTIME_DIR, "agents", ".staging"),
});

/**
 * §B.2.2's sweep, on a timer.
 *
 * FIVE MINUTES AGAINST A FIFTEEN-MINUTE WINDOW, which is the same relationship the checkpoint sweep
 * keeps to its own: often enough that a directory outlives its window by a fraction of it, rare
 * enough that a quiet server is not walking a table every few seconds for nothing.
 *
 * SCOPED TO THE SERVER'S OWN WORKSPACE ON THE LOCAL PATH, exactly as `sweepRetention` is. A hosted
 * deployment sweeps per tenant through the same repository, which is why `sweepable` takes a
 * context rather than reading across workspaces the way the webhook's link lookup deliberately
 * does — a garbage collector has no reason to be the second method in this codebase that can.
 *
 * `unref`'d, because a timer is never a reason a process refuses to exit.
 */
const sweepShadowRuns = (): void => {
  const ctx = serverContext();
  void shadowRepo
    .sweepable(ctx)
    .then((rows) => shadowRunner.sweep(ctx, rows.filter((r) => shouldSweep(r))))
    .then((n) => {
      if (n > 0) console.log(`[shadow] swept ${n} staging director${n === 1 ? "y" : "ies"}`);
    })
    .catch((err) => console.error("[shadow] sweep failed:", (err as Error)?.message ?? err));
};
setInterval(sweepShadowRuns, 5 * 60_000).unref();

/**
 * §B.1's eval-as-CI.
 *
 * WIRED HERE AND NOWHERE ELSE, because this is the only place that has all four things it needs at
 * once: the checks repository, the eval runner, the GitHub client and the workspace resolution the
 * webhook produces. `CheckRunner` itself imports none of them — §B.10's claim that eval-as-CI is
 * not new execution machinery is only true if the file that would grow some cannot reach any.
 */
const checkRunner = new CheckRunner({
  checks: checksRepo,
  repo: githubRepo,
  // THE SAME `evalRunner.start` THE EVALS TAB CALLS, with the targets the boundary decided. A
  // second dispatch path would be a second place for the budget gate, the workspace binding and the
  // job fan-out to be got right — and the one that is exercised least would be the one a stranger's
  // pull request reaches.
  startEval: async (ctx, input) => {
    const started = await evalRunner.start({
      ctx,
      datasetId: input.datasetId,
      agentId: input.agentId,
      rubricId: await rubricIdFor(ctx, input.datasetId),
      targets: input.targets,
      // NO CEILING FROM HERE. The workspace's own balance and its plan already bound this — the
      // budget gate runs inside `start` — and inventing a per-check ceiling in this file would be a
      // number nobody configured, applied to somebody else's money, in a place they would never
      // find it.
      budgetUsd: null,
    });
    if ("error" in started) throw new Error(started.error);
    checkForEval.set(started.evalId, { checkRunId: input.checkRunId, workspaceId: ctx.workspaceId });
    return started.evalId;
  },
  cancelEval: async (_ctx, evalRunId) => {
    // §B.1.2: a cancelled check never starts new jobs, but a job already dispatched runs to
    // completion. That is the eval engine's own rule (v0.1.9) and `cancel` already implements it,
    // which is why this is a call rather than a policy.
    await evalRunner.cancel(evalRunId);
  },
});

/**
 * eval id -> the check it belongs to.
 *
 * IN MEMORY, AND THAT IS THE HONEST LIMIT RATHER THAN AN OVERSIGHT. `check_runs.eval_run_id` is the
 * durable record and is written the moment the eval starts; this map is a cache so the completion
 * callback does not query for it. A restart loses the map and not the row, so a check whose eval
 * finished across a restart is recoverable by reading the table — which is a repair somebody can
 * make, unlike a fact nothing wrote down.
 */
const checkForEval = new Map<string, { checkRunId: string; workspaceId: string }>();

/**
 * An eval that was a CI check has finished scoring: turn its aggregate into three numbers and post.
 *
 * THE NUMBERS COME FROM `aggregateEval`, which the Evals dashboard already reads, rather than from
 * a second rollup written for this. That is the point of §B.1's claim to be built from the eval
 * engine: the pass rate on a pull request and the quality column in the dashboard are the same
 * computation, so they cannot disagree about what this eval scored.
 *
 * ACROSS THE LEGS RATHER THAN PER LEG. A dataset configured for three providers produces three
 * `ProviderMetrics`, and a check is one number — so the pass rate is the mean over legs that
 * actually scored something, and cost is the mean per-run cost over legs that were priced.
 * Excluding the unscored and the unpriced rather than counting them as zero is `aggregateEval`'s
 * own rule, applied one level up: a judge that failed says nothing about a provider, and averaging
 * its silence in as a zero would punish the provider for it.
 *
 * SILENT WHEN THE EVAL WAS NOT A CHECK, which is almost all of them.
 */
async function postCheckResult(evalId: string): Promise<void> {
  const entry = checkForEval.get(evalId);
  if (!entry) return;
  checkForEval.delete(evalId);
  const ctx = contextForEval(evalId);
  try {
    const row = await checksRepo.byId(ctx, entry.checkRunId);
    if (!row) return;
    const link = (await githubRepo.links(ctx)).find((l) => l.id === row.link_id);
    const connection = await githubIdentity.apiFor(ctx);
    if (!link || !connection) return;

    const aggregate = await aggregateEval(ctx, evalStore, evalId);
    const legs = aggregate?.providers ?? [];
    const scored = legs.filter((p) => p.qualityScore !== null);
    const priced = legs.filter((p) => p.costPerRunUsd !== null && !p.costUnknown);
    const timed = legs.filter((p) => p.latencyP50Ms !== null);

    const mean = (ns: number[]): number | null =>
      ns.length === 0 ? null : ns.reduce((a, b) => a + b, 0) / ns.length;

    // The base ref's commit, read NOW rather than taken from the delivery: a long-running check
    // outlives the base moving, and a baseline computed against a stale sha compares this pull
    // request to a commit that is no longer what it is based on.
    const baseSha = await connection.api
      .refSha(link.repo_full_name, (await connection.api.repo(link.repo_full_name)).defaultBranch)
      .catch(() => null);

    await checkRunner.onEvalFinished(ctx, {
      api: connection.api,
      repoFullName: link.repo_full_name,
      checkRunId: row.id,
      metrics: {
        passRate: mean(scored.map((p) => p.qualityScore!)),
        costPerRunUsd: mean(priced.map((p) => p.costPerRunUsd!)),
        latencyP50Ms: mean(timed.map((p) => p.latencyP50Ms!)),
      },
      baseSha,
    });
  } catch (err) {
    console.error(`[checks] could not post the result for ${evalId}:`, (err as Error)?.message ?? err);
  }
}

const githubPuller = new GithubPuller({
  repo: githubRepo,
  identity: githubIdentity,
  agents: agentRepo,
  projects,
  runtimeDir: RUNTIME_DIR,
  connectorFilesFor: agentFilesDeps.connectorFilesFor,
});

/**
 * The whole panel, for whichever agent the client is looking at.
 *
 * `agentId` IS OPTIONAL AND `null` IS A REAL ANSWER. A client with no agent selected still needs
 * the workspace-wide half — whether GitHub is connected at all, and the link list the sidebar's
 * Synced filter counts — so the snapshot always carries those and carries `view` only when there
 * is an agent to have one.
 */
async function broadcastGithub(ctx: TenantContext, agentId?: string | null): Promise<void> {
  const installation = await githubIdentity.current(ctx);
  relay.broadcastGithub(ctx, {
    type: "state",
    agentId: agentId ?? null,
    connected: Boolean(installation),
    accountLogin: installation?.account_login ?? null,
    links: await githubRepo.links(ctx),
    view: agentId ? await githubService.view(ctx, agentId) : null,
  });
}

// THE GITHUB WEBHOOK, for the same reason and with the same shape as the payment one above.
//
// Unauthenticated by construction — GitHub presents no bearer token and holds no socket — so its
// HMAC over the raw bytes is the whole authentication. It is registered here rather than in the
// secrets group because that group's every handler comes from `guarded()`, which is exactly what
// this endpoint cannot be: `POST /v1/github/connect` writes a credential and must be elevated,
// while this one is a third party telling us a branch moved.
//
// WITHOUT `JAROKU_GITHUB_WEBHOOK_SECRET` SET, EVERY DELIVERY IS REFUSED. The route stays mounted
// so a misconfiguration reads as 401s in GitHub's own delivery log — somewhere somebody will look
// — rather than as 404s that look like a wrong URL.
/**
 * §2.1's "Connect GitHub", which is now a button and three redirects rather than a text field.
 *
 * THE STATES ARE SHARED ACROSS THE THREE ROUTES and live in this one object, because a
 * registration hands off to an install and the second half has to know which workspace started the
 * first. In memory and ten minutes, for the reason `RoundTripStates` gives: a state that outlives a
 * restart is a state nobody is still waiting on.
 */
const githubRoundTrips = new RoundTripStates();

for (const route of githubAppRoutes({
  identity: githubIdentity,
  // THE SAME RESOLVER THE SECRETS GROUP USES, so `/start` takes its workspace from the caller's own
  // token and never from a query parameter. The two callbacks after it are redirect targets and
  // have no token to take one from — the single-use state this route issues is what stands in.
  callerFor: async (req) => {
    const auth = await authenticate(req, tokenVerifier);
    const session = await contextResolver.resolve(
      auth, req.url.searchParams.get("workspace"), req.requestId, req.ip,
    );
    return { ctx: session.context };
  },
  // WHERE A BROWSER CAN REACH THIS SERVER, which is not always where the server thinks it is —
  // behind a proxy or on a hosted domain it is neither localhost nor the listening port. Baked into
  // the manifest at registration, so it is one variable to set before going to production and a
  // sensible default for a laptop.
  baseUrl: process.env["JAROKU_PUBLIC_URL"] || `http://localhost:${PORT}`,
  envPath: join(RUNTIME_DIR, ".env"),
  states: githubRoundTrips,
  // The panel goes from the empty state to a linked account with no click, because the install
  // finishes in a different tab from the one the user is watching.
  notify: (ctx) => void broadcastGithub(ctx, null),
})) {
  router.get(route.path, route.handler);
}

for (const route of githubWebhookRoutes({
  repo: githubRepo,
  // THE APP'S OWN SECRET FIRST. A GitHub App carries a webhook secret GitHub generated at
  // registration and hands back through the manifest conversion — so an App deployment is signed
  // and verified with no configuration at all, which is the other thing a personal access token
  // could never do. The standalone variable stays ahead of nothing and behind everything: it is
  // what a PAT-era deployment set by hand, and it still works.
  secret: () => githubAppConfig()?.webhookSecret || process.env[APP_ENV.webhookSecret] || undefined,
  // The panel updates itself with no click and no poll, which is the entire point of the hook:
  // a teammate's push reaches a tab nobody has touched. Through the same `broadcastGithub` a
  // command uses, so a webhook-driven refresh and a user-driven one are one code path.
  //
  // THE UUID IS RESOLVED TO A SLUG HERE. A link stores `agent_id` as the uuid, which is the right
  // key for a foreign key and the wrong one for `broadcastGithub` — that takes what the panel
  // calls an agent, and `githubService.view` looks it up with `bySlug`. Handing it a uuid finds no
  // agent, returns a null view, and broadcasts a snapshot that would UNLINK the agent in every
  // open tab: `applyState` deletes the entry when a message names an agent with no view.
  notify: (ctx, agentUuid) =>
    void agentRepo.byId(ctx, agentUuid).then((agent) => {
      if (agent) void broadcastGithub(ctx, agent.slug);
    }),
  // §B.1.2's trigger.
  //
  // MATCHED ON THE HEAD BRANCH, which is the branch the pull request is FROM — because that is the
  // branch a link points at. §3.1 has Jaroku own `jaroku/<agent-slug>`, and a pull request from it
  // into `main` is the reconciliation §3.7 hands off to. A lookup keyed on the BASE would match
  // every agent linked to `main` and check all of them against a pull request that touches one.
  //
  // THE CROSS-WORKSPACE READ IS THE LOOKUP AND NOTHING ELSE, exactly as `applyPush` keeps it: each
  // link comes back carrying the workspace it belongs to, and every statement after that is an
  // ordinary scoped one under that workspace's own context.
  onPullRequest: async (event) => {
    const owners = await githubRepo.linksForRepo(event.repoFullName, event.headBranch);
    let acted = 0;
    for (const { workspaceId, link } of owners) {
      // A SYSTEM CONTEXT, for the reason the push path gives: there is no user here, and putting a
      // name in `actor_user_id` that did not do this would be inventing one. The pull request
      // belongs to whoever GitHub says opened it, and that is a login rather than a Jaroku account.
      const ctx = systemContextFor(workspaceId, newRequestId());
      const agent = await agentRepo.byId(ctx, link.agent_id);
      const connection = await githubIdentity.apiFor(ctx);
      if (!agent || !connection) continue;

      const config = await checksRepo.config(ctx, agent.id);
      const dataset = config?.ci_dataset_id
        ? await evalStore.getDataset(ctx, config.ci_dataset_id)
        : undefined;

      const decision = await checkRunner.onPullRequest(ctx, {
        api: connection.api,
        agentUuid: agent.id,
        agentSlug: agent.slug,
        linkId: link.id,
        repoFullName: link.repo_full_name,
        event,
        // The legs this agent's own default provider implies. A dataset does not carry a target
        // list of its own — the Evals tab picks them per run — so the honest configured set is the
        // one an ordinary run of this agent would use, and §B.1.3's boundary filters it.
        configuredTargets: [{ provider: agent.default_provider, model: "" }],
        datasetName: dataset?.name ?? null,
      });
      if (decision.checkRunId) acted++;
      else console.log(`[checks] ${agent.slug}#${event.number}: ${decision.reason}`);
      void broadcastGithub(ctx, agent.slug);
    }
    return acted;
  },
})) {
  router.post(route.path, route.handler);
}

/**
 * Report a stage of a push or a pull as it happens.
 *
 * A CLOSURE PER OPERATION rather than a shared emitter, so a stage event can never be attributed
 * to the wrong agent — the id is captured once, at the call that started the work, instead of read
 * from a mutable field a second concurrent operation would have overwritten. That is the shape of
 * bug the deploy panel's `deployContext` was fixed for.
 */
function githubStage(ctx: TenantContext, agentId: string, op: "push" | "pull"): StageReport {
  return (stage, status) => relay.broadcastGithub(ctx, { type: "stage", agentId, op, stage, status });
}

/**
 * Write an override to `audit_log` as well as to `github_events`.
 *
 * TWO TABLES, TWO READERS, AND THAT IS NOT DUPLICATION. `github_events` is the feature's own
 * history — it is what the panel renders and what answers "is anybody actually editing exported
 * code", which is the question §8 says decides whether Phase 2 was worth building.
 * `audit_log` is the WORKSPACE's record, read by somebody who does not know this feature exists
 * and is asking "what did this person do here". §3.6 asks for the second by name, because a hosted
 * multi-tenant product needs "who overrode a safety refusal" to be answerable without knowing
 * which panel the override happened in.
 *
 * Written from the handler rather than from inside the pusher, so that the two runners stay
 * modules that talk to GitHub and a database and nothing else — and so there is one place to read
 * for "what does this feature put in the audit log".
 */
async function auditGithubOverride(
  ctx: TenantContext,
  action: string,
  agentId: string,
  detail: Record<string, unknown>,
): Promise<void> {
  await identityRepo.appendAudit(ctx, {
    action,
    targetType: "agent",
    targetId: agentId,
    metadata: detail,
  });
}

/**
 * §B.4.1's selection, from whatever the socket delivered.
 *
 * ENTRIES THAT ARE NOT WHAT THEY CLAIM ARE DROPPED, not refused. A stale index or a path that has
 * stopped changing is what a client one snapshot behind sends, and refusing the whole push over one
 * of them would lose the four files that are still valid. What protects the tree is
 * `githubStaging.stagedTree` — which ignores an index it cannot find and drops a protected path —
 * and the validator after it.
 */
function readSelections(raw: unknown[]): { path: string; hunks: number[] }[] {
  const out: { path: string; hunks: number[] }[] = [];
  for (const item of raw) {
    if (!item || typeof item !== "object") continue;
    const entry = item as { path?: unknown; hunks?: unknown };
    if (typeof entry.path !== "string" || !entry.path) continue;
    const hunks = Array.isArray(entry.hunks)
      ? entry.hunks.filter((n): n is number => Number.isInteger(n) && (n as number) >= 0)
      : [];
    out.push({ path: entry.path, hunks });
  }
  return out;
}

/** §B.4.4's restacked order, read the same way and for the same reason. */
function readSteps(raw: unknown[]): { versionIds: string[] }[] {
  const out: { versionIds: string[] }[] = [];
  for (const item of raw) {
    if (!item || typeof item !== "object") continue;
    const ids = (item as { versionIds?: unknown }).versionIds;
    if (!Array.isArray(ids)) continue;
    out.push({ versionIds: ids.filter((v): v is string => typeof v === "string" && v.length > 0) });
  }
  return out;
}

/**
 * §B.2.2's transient list, on its own message.
 *
 * DELIBERATELY NOT PART OF `broadcastGithub`'s snapshot. §B.2.2 requires shadow runs never to
 * appear in the agent's ordinary run history, and the way that stays true over time is that nothing
 * which assembles the ordinary history ever sees them — a field on the panel snapshot would be one
 * refactor away from being folded in beside `unpushed` and `pushed`.
 */
/**
 * Close out the `shadow_runs` row for a process that has ended, if the run was one.
 *
 * WHETHER IT FAILED IS READ OFF THE RUN ITSELF rather than from the exit code. The runner reports
 * a broken agent as a run with `status: "error"` and a message — v0.0.1's graceful failure — and
 * that is a better answer than "the process exited non-zero", which is true of a timeout, a kill
 * and a crash alike.
 *
 * SILENT WHEN THERE IS NO SHADOW ROW, which is almost every run. The teardown path runs for every
 * process in the system, and a lookup that finds nothing is the ordinary case rather than a
 * condition worth logging.
 */
async function finishShadowFor(runId: string): Promise<void> {
  const ctx = contextForRun(runId);
  try {
    const run = await store.getRun(ctx, runId);
    if (!run) return;
    // TWO ID SPACES MEET HERE AND THEY ARE NOT THE SAME ONE. `runs.agent_id` is the SLUG — the
    // frozen trace schema has held a text agent id since v0.0.1 and `runAgent` passes one — while
    // `shadow_runs.agent_id` is the uuid, because it carries a composite foreign key to
    // `agents (workspace_id, id)`. Handing the slug straight to `forAgent` finds nothing, silently,
    // which would leave every shadow row `running` forever and every staging directory unswept.
    const agent = await agentRepo.bySlug(ctx, run.agent_id);
    if (!agent) return;
    const row = (await shadowRepo.forAgent(ctx, agent.id, 50)).find((r) => r.run_id === runId);
    if (!row || row.ended_at !== null) return;
    await shadowRepo.finish(ctx, row.id, {
      status: run.status === "error" ? "error" : "completed",
      error: run.error ?? null,
    });
    await broadcastShadowRuns(ctx, agent.slug);
  } catch (err) {
    console.warn(`[shadow] could not close out ${runId}: ${(err as Error)?.message ?? String(err)}`);
  }
}

async function broadcastShadowRuns(ctx: TenantContext, agentId: string): Promise<void> {
  if (!isSafeAgentId(agentId)) return;
  const agent = await agentRepo.bySlug(ctx, agentId);
  if (!agent) return;
  const runs = await shadowRepo.forAgent(ctx, agent.id);
  relay.broadcastGithub(ctx, {
    type: "shadowRuns",
    agentId,
    runs: runs.map((r) => ({
      id: r.id,
      ref: r.ref,
      headSha: r.head_sha,
      // Null until a run was dispatched. `hasReadableTrace` is what decides whether the row opens
      // into a trace, and it stays true after the staging directory is swept — the trace is an
      // ordinary run on retention's own schedule.
      runId: hasReadableTrace(r) ? r.run_id : null,
      status: r.status,
      error: r.error,
      createdAt: r.created_at,
      endedAt: r.ended_at,
      staged: r.swept_at === null && r.staging_key !== null,
    })),
  });
}

async function handleGithubCommand(ctx: TenantContext, cmd: GithubCommand): Promise<void> {
  const fail = (message: string, agentId?: string): void => {
    relay.broadcastGithub(ctx, { type: "error", message, ...(agentId ? { agentId } : {}) });
  };
  try {
    switch (cmd.cmd) {
      case "listGithub":
        await broadcastGithub(ctx, cmd.agentId ?? null);
        return;

      case "listGithubRepos":
        relay.broadcastGithub(ctx, {
          type: "repos",
          repos: await githubService.repos(ctx, typeof cmd.query === "string" ? cmd.query : undefined),
        });
        return;

      case "checkGithubRepo": {
        // Answered even for a name that is not a legal repository name — see `checkName`. This
        // runs on every keystroke, and a red strip mid-typing is worse than a quiet "taken".
        const answer = await githubService.checkName(ctx, String(cmd.name ?? ""));
        relay.broadcastGithub(ctx, { type: "nameCheck", ...answer });
        return;
      }

      case "linkGithub": {
        const result = await githubService.link(ctx, {
          agentId: String(cmd.agentId ?? ""),
          repoFullName: typeof cmd.repoFullName === "string" ? cmd.repoFullName : undefined,
          createName: typeof cmd.createName === "string" ? cmd.createName : undefined,
          createPrivate: cmd.createPrivate !== false,
          branch: typeof cmd.branch === "string" ? cmd.branch : undefined,
          subdirectory: typeof cmd.subdirectory === "string" ? cmd.subdirectory : null,
          includeArtifacts: cmd.includeArtifacts !== false,
        });
        if (!result.ok) return fail(result.message ?? "could not link that repository", cmd.agentId);
        await broadcastGithub(ctx, cmd.agentId);
        return;
      }

      case "unlinkGithub": {
        const result = await githubService.unlink(ctx, String(cmd.agentId ?? ""));
        if (!result.ok) return fail(result.message ?? "could not unlink", cmd.agentId);
        relay.broadcastGithub(ctx, {
          type: "notice",
          agentId: cmd.agentId,
          // Said rather than assumed. §6's rule is that Jaroku never deletes a user's repo, and a
          // notice that did not say so leaves somebody wondering what just happened to it.
          message: "Unlinked. The repository and everything in it is untouched.",
        });
        await broadcastGithub(ctx, cmd.agentId);
        return;
      }

      case "refreshGithub": {
        const agentId = String(cmd.agentId ?? "");
        await githubService.refresh(ctx, agentId, cmd.explicit === true);
        await broadcastGithub(ctx, agentId);
        // Only for the deliberate one. A notice on every panel open would be a toast per
        // navigation, which is how people learn to stop reading them.
        if (cmd.explicit === true) {
          const view = await githubService.view(ctx, agentId);
          relay.broadcastGithub(ctx, {
            type: "notice",
            agentId,
            message: view ? `Fetched — ${view.verdict.toLowerCase()}.` : "Fetched.",
          });
        }
        return;
      }

      case "pushGithub": {
        const agentId = String(cmd.agentId ?? "");
        const result = await githubPusher.push(
          ctx,
          {
            agentId,
            squash: cmd.squash === true,
            force: cmd.force === true,
            confirmSlug: typeof cmd.confirmSlug === "string" ? cmd.confirmSlug : undefined,
            // SHAPE-CHECKED HERE RATHER THAN TRUSTED, because these two arrive from a browser and
            // both are lists of things that name other things. A malformed entry is dropped rather
            // than refused: a selection can be a snapshot behind, and the runner's own checks —
            // `checkSteps` for the shape of a restack, the validator for its result — are what
            // decide whether the outcome is allowed, not the parse.
            ...(Array.isArray(cmd.stage) ? { stage: readSelections(cmd.stage) } : {}),
            ...(Array.isArray(cmd.steps) ? { steps: readSteps(cmd.steps) } : {}),
            ...(typeof cmd.message === "string" && cmd.message.trim() ? { message: cmd.message } : {}),
            ignoreSecrets: cmd.ignoreSecrets === true,
          },
          githubStage(ctx, agentId, "push"),
        );
        // §B.6.1's override, in `audit_log` as well as in `secret_scan_findings`. The same two-
        // readers argument `auditGithubOverride` already makes for a force push: the findings table
        // is the feature's own record, and the audit log is the WORKSPACE's — read by somebody who
        // does not know this feature exists and is asking what a person did here.
        if (cmd.ignoreSecrets === true) {
          await auditGithubOverride(ctx, "github.ignore_secret_scan", agentId, {
            outcome: result.ok ? "ok" : "failed",
            findings: result.findings?.length ?? 0,
            paths: result.findings?.map((f) => f.path) ?? [],
          });
        }
        if (result.findings && !result.ok) {
          relay.broadcastGithub(ctx, {
            type: "scanRefused",
            agentId,
            message: result.message ?? "the scan refused this push",
            findings: result.findings,
          });
          await broadcastGithub(ctx, agentId);
          return;
        }
        // §B.4.4'S REFUSAL IS ITS OWN MESSAGE, never an error strip. The panel highlights the row
        // that failed and renders the validator's own words under it, and a one-line error could
        // carry neither — the same argument §3.6's refusal card makes for a refused pull.
        if (result.failedPosition !== undefined) {
          relay.broadcastGithub(ctx, {
            type: "restackRefused",
            agentId,
            position: result.failedPosition,
            message: result.message ?? "that order does not validate",
            problems: result.problems ?? [],
          });
          await broadcastGithub(ctx, agentId);
          return;
        }
        // BEFORE THE NOTICE AND BEFORE THE SNAPSHOT. An override that succeeded and then failed to
        // be recorded is the one ordering this must not have — the same "record first, then say it
        // happened" rule the trace ingest keeps between persisting a step and broadcasting it.
        if (cmd.force === true) {
          await auditGithubOverride(ctx, "github.force_push", agentId, {
            outcome: result.ok ? "ok" : "failed",
            branch: (await githubService.view(ctx, agentId))?.link.branch ?? null,
            commits: result.shas.length,
            failedStage: result.failedStage ?? null,
          });
        }
        if (!result.ok) fail(result.message ?? "the push did not complete", agentId);
        else if (result.shas.length) {
          relay.broadcastGithub(ctx, {
            type: "notice",
            agentId,
            message: `Pushed ${result.shas.length} commit${result.shas.length === 1 ? "" : "s"}.`,
          });
          // §B.6.2's build check, on the first push that gives the repository a default branch to
          // put it on. `link` declines on an empty repository — there is nowhere for a workflow to
          // run from — and said so expecting a push to follow up, which nothing did. Idempotent, so
          // every later push reads a tree and writes nothing; failures are surfaced as a notice
          // rather than turning a successful push into a failed one.
          const workflow = await githubService.ensureWorkflow(ctx, agentId).catch(() => null);
          if (workflow) relay.broadcastGithub(ctx, { type: "notice", agentId, message: workflow });
        }
        // BROADCAST EITHER WAY. A failed push still changed what the panel should say — the branch
        // moved under us, or the token died — and leaving the old snapshot up would show the user
        // the state that produced the failure as though it were the state after it.
        await broadcastGithub(ctx, agentId);
        return;
      }

      case "pullGithub": {
        const agentId = String(cmd.agentId ?? "");
        const result = await githubPuller.pull(
          ctx,
          {
            agentId,
            force: cmd.force === true,
            confirmSlug: typeof cmd.confirmSlug === "string" ? cmd.confirmSlug : undefined,
          },
          githubStage(ctx, agentId, "pull"),
        );
        if (cmd.force === true) {
          // A pull override publishes code the validator turned away. Recorded whatever the
          // outcome, for the reason above.
          await auditGithubOverride(ctx, "github.force_pull", agentId, {
            outcome: result.ok ? "ok" : "failed",
            version: result.version ?? null,
            refusedCheck: result.refusal?.check ?? null,
          });
        }
        if (result.refusal) {
          // ITS OWN EVENT, never an error strip. §3.6's card names the file, the check and the fact
          // that the agent is unchanged, and offers three actions — none of which a one-line error
          // could carry.
          relay.broadcastGithub(ctx, { type: "refused", agentId, ...result.refusal });
        } else if (!result.ok) {
          fail(result.message ?? "the pull did not complete", agentId);
        } else {
          relay.broadcastGithub(ctx, {
            type: "notice",
            agentId,
            message: `Pulled and published as v${result.version}.`,
          });
          // The files changed under everything else that renders them.
          relay.broadcastAgentFiles(ctx, agentId);
          void relay.broadcastAgents();
        }
        await broadcastGithub(ctx, agentId);
        return;
      }

      case "createGithubBranch":
      case "switchGithubBranch": {
        const agentId = String(cmd.agentId ?? "");
        const branch = String(cmd.branch ?? "").trim();
        if (!branch) return fail("name a branch", agentId);
        const agent = await agentRepo.bySlug(ctx, agentId);
        if (!agent) return fail("no such agent in this workspace", agentId);
        const link = await githubRepo.linkFor(ctx, agent.id);
        if (!link) return fail("link a repository first", agentId);

        // §3.2: switching a linked branch re-materialises the agent from a different tree, so it
        // is a heavier action than switching in an editor. With unpushed work the switcher offers
        // three answers and this refuses anything else — never a silent overwrite.
        const view = await githubService.view(ctx, agentId);
        // `keep` RATHER THAN `stash`, because nothing stashes and the old name said otherwise.
        // A Jaroku version belongs to the agent, not to a branch, so switching cannot strand it
        // and there is nothing to put on a stack or pop later — the versions stay exactly where
        // they are and become unpushed relative to the new branch. That is the honest behaviour
        // and it was already the behaviour; the word on the wire was borrowed from a git command
        // that means "put this somewhere else for now", which is the one thing it does not do.
        if (cmd.cmd === "switchGithubBranch" && (view?.ahead ?? 0) > 0 && cmd.onUnpushed !== "keep") {
          if (cmd.onUnpushed === "push") {
            const pushed = await githubPusher.push(ctx, { agentId }, githubStage(ctx, agentId, "push"));
            if (!pushed.ok) {
              await broadcastGithub(ctx, agentId);
              return fail(pushed.message ?? "could not push before switching", agentId);
            }
          } else {
            const ahead = view?.ahead ?? 0;
            await broadcastGithub(ctx, agentId);
            return fail(
              `${ahead} unpushed version${ahead === 1 ? "" : "s"} — push them, keep them here, or cancel.`,
              agentId,
            );
          }
        }

        if (cmd.cmd === "createGithubBranch") {
          const connection = await githubIdentity.apiFor(ctx);
          if (!connection) return fail("connect GitHub first", agentId);
          const from = link.last_pushed_sha ?? (await connection.api.refSha(link.repo_full_name, link.branch));
          if (!from) return fail("there is nothing on the current branch to branch from", agentId);
          await connection.api.createRef(link.repo_full_name, branch, from);
        }

        // THE WATERMARKS ARE CLEARED, not carried across. `last_pushed_sha` describes a commit on
        // the OLD branch, and leaving it in place would have the verdict compare the new branch's
        // head against a sha that is not in its history — which reads as diverged forever.
        await githubRepo.patchLink(ctx, link.id, {
          branch,
          lastKnownRemoteSha: null,
          ...(cmd.cmd === "switchGithubBranch" ? { lastPushedSha: null, lastPushedVersionId: null } : {}),
        });
        await githubRepo.record(ctx, {
          agentId: agent.id,
          linkId: link.id,
          kind: "branch_switch",
          detail: `${link.branch} -> ${branch}`,
        });
        await githubService.refresh(ctx, agentId);
        await broadcastGithub(ctx, agentId);
        return;
      }

      case "openGithubPr": {
        const agentId = String(cmd.agentId ?? "");
        const agent = await agentRepo.bySlug(ctx, agentId);
        if (!agent) return fail("no such agent in this workspace", agentId);
        const link = await githubRepo.linkFor(ctx, agent.id);
        if (!link) return fail("link a repository first", agentId);
        const connection = await githubIdentity.apiFor(ctx);
        if (!connection) return fail("connect GitHub first", agentId);
        const base = (await connection.api.repo(link.repo_full_name)).defaultBranch;
        if (base === link.branch) {
          // §3.1: Jaroku owns `jaroku/<slug>` and reconciliation is through a PR. A PR from a
          // branch into itself is not a thing GitHub can make, and the honest answer is to say why
          // rather than to forward its error.
          return fail("this agent is linked to the default branch, so there is nothing to open a PR against.", agentId);
        }
        // ASKED BEFORE IT IS OPENED. The panel hides this button when it already knows about a PR,
        // but `view.pr` is one of the four remote reads allowed to fail — a rate limit or a 500
        // turns it into null and puts the button back — and a colleague can open one between the
        // snapshot and the click. GitHub answers the second attempt with a 422 whose body is a
        // Validation Failed blob, and forwarding that put raw JSON in the error strip to say
        // something the panel could have said in five words.
        const existing = await connection.api.openPullRequest(link.repo_full_name, link.branch, base);
        if (existing) {
          relay.broadcastGithub(ctx, {
            type: "notice",
            agentId,
            message: `#${existing.number} is already open for ${link.branch}.`,
          });
          // So the card replaces the button rather than leaving somebody to press it again.
          await broadcastGithub(ctx, agentId);
          return;
        }
        const pr = await connection.api.createPullRequest(link.repo_full_name, {
          title: `Agent updates: ${agent.display_name ?? agent.slug}`,
          head: link.branch,
          base,
          body: "Pushed from Jaroku. Every commit on this branch was published as an agent version, and validated before it was.",
        });
        await githubRepo.record(ctx, {
          agentId: agent.id, linkId: link.id, kind: "pr_open", detail: `#${pr.number} -> ${base}`,
        });
        relay.broadcastGithub(ctx, { type: "notice", agentId, message: `Opened #${pr.number}.` });
        await broadcastGithub(ctx, agentId);
        return;
      }

      case "generateGithubMessage": {
        // §3.4's ✨ generate. THE DEFAULT MESSAGE NEEDS NO MODEL CALL AT ALL — it is pre-filled from
        // the version's stored instruction and summary, which `agent_versions` has held since
        // migration 014 — so this exists for the case where the staged files do not map cleanly
        // onto one version: a hand-staged subset, or a post-pull merge.
        //
        // ROUTED THROUGH THE SAME `streamExplain` THE PLAN STEP USES, rather than through a second
        // pathway of its own. That is not tidiness: it means one place decides which model, one
        // place handles the no-key fallback, and one place meters the call against the workspace's
        // balance under the right payer.
        const agentId = String(cmd.agentId ?? "");
        const view = await githubService.view(ctx, agentId);
        if (!view) return fail("link a repository first", agentId);
        if (view.unpushed.length === 0 && view.changes.length === 0) {
          return fail("there is nothing unpushed to describe", agentId);
        }
        const context = [
          `Agent: ${view.agentSlug}`,
          `Unpushed versions:`,
          ...view.unpushed.map((v) => `- v${v.version} ${v.summary} (+${v.additions}/-${v.deletions})`),
          `Files touched:`,
          ...view.changes.map((c) => `- ${c.status} ${c.path} (+${c.additions}/-${c.deletions})`),
        ].join("\n");
        const key = await providerKeys.platformKey(ctx);
        let text = "";
        await streamExplain(
          context,
          "Write a git commit message for these changes. First line is a subject under 72 characters in the imperative mood. Then a blank line, then two sentences of body explaining what changed and why. No markdown, no bullet points, no preamble.",
          {
            onDelta: (chunk) => { text += chunk; },
            onUsage: (u) =>
              meterPlatformCall(ctx, "llm.explain", {
                model: u.model,
                inputTokens: u.input,
                outputTokens: u.output,
                cacheReadTokens: u.cacheRead,
                cacheWriteTokens: u.cacheWrite,
                payer: key ? "workspace" : "platform",
              }),
            onDone: () => relay.broadcastGithub(ctx, { type: "message", agentId, message: text.trim() }),
            onError: (message) => fail(message, agentId),
          },
          key,
        );
        return;
      }

      case "resolveReviewComment": {
        // §B.5.3, and everything it deliberately is not. The edit has already been applied — by the
        // ordinary Apply, on the ordinary diff card, through the ordinary validator, against the
        // PROTECTED file list. This records what happened and tells the reviewer.
        const agentId = String(cmd.agentId ?? "");
        const agent = await agentRepo.bySlug(ctx, agentId);
        if (!agent) return fail("no such agent in this workspace", agentId);
        const comment = await prComments.byId(ctx, String(cmd.commentId ?? ""));
        if (!comment) return fail("that review comment is no longer here", agentId);

        // RECORDED FIRST, POSTED SECOND. The resolution is the fact this product owns; the reply is
        // a courtesy to somebody outside it. Losing the first because the second failed would make
        // an applied edit read as an open comment on the next panel open.
        await prComments.setResolution(
          ctx,
          comment.id,
          cmd.resolution === "dismissed" ? "dismissed" : "applied",
          typeof cmd.version === "number" ? cmd.version : null,
        );

        const body = typeof cmd.reply === "string" ? cmd.reply.trim() : "";
        if (body) {
          const link = await githubRepo.linkFor(ctx, agent.id);
          const connection = await githubIdentity.apiFor(ctx);
          if (link && connection) {
            try {
              // A THREADED REPLY to this specific comment, never a general pull request comment.
              // §B.5.3: a teammate who never opens Jaroku still sees the conversation resolve IN
              // PLACE, under the line they commented on.
              await connection.api.replyToReviewComment(
                link.repo_full_name,
                comment.pr_number,
                comment.github_comment_id,
                body,
              );
              await prComments.markReplied(ctx, comment.id);
            } catch (err) {
              // NOT A FAILURE OF THE RESOLUTION, which is already recorded. The panel renders the
              // difference — an applied edit whose reply did not land says so on the row — because
              // claiming the teammate was told would be the one silent failure §B.5.3 is about.
              relay.broadcastGithub(ctx, {
                type: "notice",
                agentId,
                message: `Recorded here, but the reply did not reach GitHub: ${(err as Error)?.message ?? String(err)}`,
              });
            }
          }
        }
        await broadcastGithub(ctx, agentId);
        return;
      }

      case "listScanFindings": {
        // §B.6's record, which was written and unreadable: every finding carries whether it was
        // OVERRIDDEN and by whom, and nothing could ask. The live refusal has always reached the
        // panel; this is the history behind it.
        const agentId = String(cmd.agentId ?? "");
        const agent = await agentRepo.bySlug(ctx, agentId);
        if (!agent) return fail("no such agent in this workspace", agentId);
        relay.broadcastGithub(ctx, {
          type: "scanFindings",
          agentId,
          findings: await githubRepo.findings(ctx, agent.id),
        });
        return;
      }

      case "setAgentCiConfig": {
        // §B.1.2's opt-in, and the row that four modules, two migrations, a webhook branch and four
        // passing suites were waiting for. `setConfig` had no caller anywhere, so `ci_dataset_id`
        // was always null and `checkRunner.open` returned "no dataset is linked for CI on this
        // agent" on every pull request, for every agent, always.
        const agentId = String(cmd.agentId ?? "");
        const agent = await agentRepo.bySlug(ctx, agentId);
        if (!agent) return fail("no such agent in this workspace", agentId);

        // THE DATASET IS CHECKED AGAINST THIS WORKSPACE'S OWN. A dataset id is a client-supplied
        // identifier, and this one decides what a pull request executes — so an id from another
        // tenant must not be storable, whatever the reads downstream would do with it.
        if (typeof cmd.datasetId === "string" && cmd.datasetId) {
          const dataset = await evalStore.getDataset(ctx, cmd.datasetId);
          if (!dataset) return fail("no such dataset in this workspace", agentId);
          // AND IT HAS TO BELONG TO THIS AGENT. A check runs the agent the pull request touches
          // against the named dataset; a dataset built for a different agent would score this one
          // against inputs nobody chose for it, and the pass rate would be meaningless rather than
          // wrong in a visible way.
          //
          // COMPARED AGAINST THE SLUG. `datasets.agent_id` holds a slug — it is written from the
          // client's `activeAgentId` and is what the job's working directory is derived from — while
          // `agent_ci_config.agent_id` holds the uuid. Both are deliberate and this is the seam.
          if (dataset.agent_id !== agent.slug) {
            return fail("that dataset belongs to a different agent", agentId);
          }
        }

        const policy = cmd.policy;
        if (
          policy !== undefined &&
          policy !== "dry_run_only" &&
          policy !== "collaborators_paid" &&
          policy !== "always_paid"
        ) {
          return fail(`"${String(policy).slice(0, 24)}" is not a provider policy`, agentId);
        }

        // FIELD BY FIELD FROM WHAT IS PRESENT, which is the repository's own contract: clearing the
        // dataset turns checks off and keeps the policy somebody chose, and choosing a policy does
        // not clear the dataset.
        await checksRepo.setConfig(ctx, agent.id, {
          ...(cmd.datasetId !== undefined ? { datasetId: cmd.datasetId } : {}),
          ...(policy !== undefined ? { policy } : {}),
        });
        console.log(
          `[checks] ${agentId} CI config: dataset ${cmd.datasetId === undefined ? "unchanged" : (cmd.datasetId ?? "none")}` +
            `, policy ${policy ?? "unchanged"}`,
        );
        await broadcastGithub(ctx, agentId);
        return;
      }

      case "semanticDiffGithub": {
        // §B.7. What changed about the AGENT between the current version and a ref, rather than
        // what changed about the text. Presentation, permanently — see the module's own boundary.
        const agentId = String(cmd.agentId ?? "");
        const agent = await agentRepo.bySlug(ctx, agentId);
        if (!agent) return fail("no such agent in this workspace", agentId);
        const link = await githubRepo.linkFor(ctx, agent.id);
        if (!link) return fail("link a repository first", agentId);
        const connection = await githubIdentity.apiFor(ctx);
        if (!connection) return fail("connect GitHub first", agentId);
        const ref = (typeof cmd.ref === "string" && cmd.ref.trim()) || link.branch;

        const head = await connection.api.refSha(link.repo_full_name, ref);
        if (!head) return fail(`there is no ref called ${ref} on ${link.repo_full_name}`, agentId);

        // THE REMOTE SIDE IS READ, NEVER RUN. §B.7's graph reading is static for exactly this
        // reason — the other side of the diff is a tree this machine has never executed and must
        // not, so `readShape` parses it and nothing imports it.
        const prefix = repoPrefix(link.subdirectory);
        const remote: { path: string; content: string }[] = [];
        for (const entry of (await connection.api.tree(link.repo_full_name, head)).filter(
          (e) => inSubdirectory(e.path, link.subdirectory),
        )) {
          const path = prefix ? entry.path.slice(prefix.length + 1) : entry.path;
          if (!path.endsWith(".py") && path !== MANIFEST_FILE) continue;
          remote.push({ path, content: await connection.api.blob(link.repo_full_name, entry.sha, entry.path) });
        }

        const local = await projects.readCurrent(ctx, agent.id, agent.current_version);
        const [before, after] = await Promise.all([
          readShape(remote, { runtimeDir: RUNTIME_DIR }),
          readShape(local, { runtimeDir: RUNTIME_DIR }),
        ]);

        // THE STORED CLASSIFICATION, LOOKED UP — never computed here. §B.7.2 mirrors the McpImpact
        // ratchet: a classification may only be raised by an untrusted signal, and "an external
        // commit changed the manifest" is precisely such a signal. Classifying a newly granted tool
        // from its name at this point would be that signal deciding its own impact.
        // EVERY TOOL THIS WORKSPACE HAS DISCOVERED, rather than only the ones this agent is
        // scoped to — because the whole question is about a grant that just WIDENED, and a tool the
        // agent did not have yesterday is by definition not in its current scope. A lookup narrowed
        // to the agent would return undefined for exactly the row §B.7.2 exists for, and undefined
        // reads as high, which is safe and unhelpful: the workspace may well have classified this
        // tool already, on another agent.
        const granted = new Map<string, McpImpact>();
        for (const tool of await mcpStore.listTools(ctx).catch(() => [])) {
          granted.set(`${tool.server_id}/${tool.name}`, tool.impact);
        }

        relay.broadcastGithub(ctx, {
          type: "semanticDiff",
          agentId,
          ref,
          rows: diffShapes(before, after, (r) => granted.get(r)),
          ...(before.error || after.error ? { partial: before.error ?? after.error ?? "" } : {}),
        });
        return;
      }

      case "listShadowRuns": {
        await broadcastShadowRuns(ctx, String(cmd.agentId ?? ""));
        return;
      }

      case "shadowRunGithub": {
        // §B.2. Stage a ref, run it once, and never touch the published version.
        const agentId = String(cmd.agentId ?? "");
        const ref = String(cmd.ref ?? "").trim();
        if (!ref) return fail("name a branch, tag or commit", agentId);
        const agent = await agentRepo.bySlug(ctx, agentId);
        if (!agent) return fail("no such agent in this workspace", agentId);
        const link = await githubRepo.linkFor(ctx, agent.id);
        if (!link) return fail("link a repository first", agentId);
        const connection = await githubIdentity.apiFor(ctx);
        if (!connection) return fail("connect GitHub first", agentId);

        const prepared = await shadowRunner.prepare(ctx, {
          api: connection.api,
          agentUuid: agent.id,
          agentSlug: agent.slug,
          link,
          ref,
        });
        if ("error" in prepared) {
          await broadcastShadowRuns(ctx, agentId);
          return fail(prepared.error, agentId);
        }

        // A CONTRACT FAILURE IS A FINISHED RUN, NOT A REFUSAL. §B.2.2: somebody asked what this
        // branch does, and "it does not satisfy the contract, so it does not run" is an answer.
        // The row ends as `error` with the reason on it, the panel renders it like any other
        // failed run, and nothing is refused — there was nothing to refuse.
        if (prepared.contractProblem) {
          await shadowRepo.finish(ctx, prepared.run.id, {
            status: "error",
            error: prepared.contractProblem,
          });
          await broadcastShadowRuns(ctx, agentId);
          relay.broadcastGithub(ctx, {
            type: "notice",
            agentId,
            message: `${ref} does not run: ${prepared.contractProblem}`,
          });
          return;
        }

        relay.broadcastGithub(ctx, {
          type: "notice",
          agentId,
          // Said before the run rather than after it, because the whole reason somebody hesitates
          // over this button is the fear that it changes something.
          message: `Running ${ref} at ${prepared.headSha.slice(0, 7)} — this does not affect ${agent.slug}'s published version.`,
        });
        await broadcastShadowRuns(ctx, agentId);
        await runAgent(
          ctx,
          typeof cmd.input === "string" ? cmd.input : undefined,
          typeof cmd.provider === "string" ? cmd.provider : undefined,
          typeof cmd.model === "string" ? cmd.model : undefined,
          agent.slug,
          { projectDir: prepared.projectDir, shadowRunId: prepared.run.id },
        );
        await broadcastShadowRuns(ctx, agentId);
        return;
      }

      case "diagnoseFile": {
        // §B.3. The cheap half of the validator, against text that has never been saved.
        //
        // NOTHING HERE GATES ANYTHING, and the shape of this handler is the proof: it reads, it
        // answers, and there is no path from it to a publish, a push or a version. §B.3.2's rule is
        // that the LSP surface changes when a user learns about a problem and never what stops a
        // bad file from being committed — a handler that could refuse something would already have
        // broken that.
        const agentId = String(cmd.agentId ?? "");
        const path = String(cmd.path ?? "");
        const source = typeof cmd.source === "string" ? cmd.source : "";
        const nonce = Number.isFinite(cmd.nonce) ? Number(cmd.nonce) : 0;
        if (!isSafeAgentId(agentId) || !path) return;
        const agent = await agentRepo.bySlug(ctx, agentId);
        if (!agent) return;

        // Rule 9 needs to know what counts as a tool, and the answer lives across the project
        // rather than in the buffer: the reviewed connector tools this agent is scoped to, plus
        // whatever MCP grant it holds. `@tool`s defined in the buffer itself are added by the
        // analysis, so a caller that knew neither would still catch most of it.
        const installed = new Set(agent.connectors ?? []);
        const knownTools = [
          ...loadConnectors(RUNTIME_DIR)
            .filter((c) => installed.has(c.id))
            .flatMap((c) => c.tools.map((t) => t.name)),
          ...(agent.mcp_tools ?? []),
        ];
        const diagnostics = await liveDiagnostics(path, source, {
          runtimeDir: RUNTIME_DIR,
          knownTools,
        });
        relay.broadcastGithub(ctx, {
          type: "diagnostics",
          agentId,
          path,
          nonce,
          // Stripped to the wire shape rather than sent whole: `Diagnostic` carries `path`, which
          // the message already names, and repeating it per row would put the same string on the
          // wire once per squiggle.
          diagnostics: diagnostics.map(({ path: _p, ...rest }) => rest),
        });
        return;
      }

      case "commitGithub": {
        // §3.4's commit box. A "commit" in Jaroku's model is a push of the staged subset — there is
        // no local git repository here, so there is nothing a commit could land in that a push does
        // not. Keeping the two buttons distinct in the UI while resolving both to a push is
        // deliberate: §A.8 splits them because one reaches GitHub and one does not, and the day a
        // local staging area exists this is the one place that changes.
        const agentId = String(cmd.agentId ?? "");
        if (cmd.push === false) {
          return fail("Jaroku has no local repository to commit into — use push.", agentId);
        }
        // THE MESSAGE IS FORWARDED, which it was not. The box pre-fills from the version's own
        // instruction, so a commit written from an untouched box read correctly and a commit
        // written from an edited one read correctly too — as the pre-fill. ✨ generate existed to
        // fill a field whose contents were then thrown away on the way to the runner.
        const result = await githubPusher.push(
          ctx,
          {
            agentId,
            squash: true,
            ...(typeof cmd.message === "string" && cmd.message.trim() ? { message: cmd.message } : {}),
            ignoreSecrets: cmd.ignoreSecrets === true,
          },
          githubStage(ctx, agentId, "push"),
        );
        // §B.6.1's override, in `audit_log` as well as in `secret_scan_findings`. The same two-
        // readers argument `auditGithubOverride` already makes for a force push: the findings table
        // is the feature's own record, and the audit log is the WORKSPACE's — read by somebody who
        // does not know this feature exists and is asking what a person did here.
        if (cmd.ignoreSecrets === true) {
          await auditGithubOverride(ctx, "github.ignore_secret_scan", agentId, {
            outcome: result.ok ? "ok" : "failed",
            findings: result.findings?.length ?? 0,
            paths: result.findings?.map((f) => f.path) ?? [],
          });
        }
        if (result.findings && !result.ok) {
          relay.broadcastGithub(ctx, {
            type: "scanRefused",
            agentId,
            message: result.message ?? "the scan refused this push",
            findings: result.findings,
          });
          await broadcastGithub(ctx, agentId);
          return;
        }
        if (!result.ok) fail(result.message ?? "the commit did not complete", agentId);
        await broadcastGithub(ctx, agentId);
        return;
      }
    }
  } catch (err) {
    const message = (err as Error)?.message ?? String(err);
    console.error(`[github] ${cmd.cmd} failed: ${message}`);
    relay.broadcastGithub(ctx, { type: "error", message: `${cmd.cmd} failed: ${message}` });
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
        // WHOSE DEPLOYMENT. The manager is one per process and keyed by id, so without this a
        // workspace holding another tenant's deployment id could stop their deploy partway —
        // against a real Railway account, with whatever it had already created left behind.
        // `forgetDeployment` below already asks this question; cancelling is the one that
        // interrupts something in flight, so it is the one that needed it more.
        if (!(await deployStore.get(ctx, target))) {
          relay.broadcastDeploy(ctx, { type: "error", message: "no such deployment" });
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
        // numbers can't support. Worse, `contextForEval` below resolves the runner's workspace
        // as its FIRST active eval, so a second live one writes into the first one's tenancy.
        //
        // A FAST PATH, NOT THE GUARD. This check is followed by an await before `start` is even
        // called, and wsRelay dispatches commands concurrently — so two of these overlap and both
        // read `active === false`. `EvalRunner.start` claims synchronously and refuses with the
        // same message; this only saves the round trip when the answer is already obvious.
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
        // MONEY ASKS FIRST, here as on the interactive path — and here it matters more, because
        // an eval is the one thing in this product that multiplies cost by examples x providers
        // and then adds a judge call per cell. The estimate is the same one the UI showed before
        // the button was pressed, computed by the same function over the same history.
        const evalEstimate = await estimateEval(ctx, store, evalStore, {
          datasetId: cmd.datasetId,
          agentId: cmd.agentId,
          targets: cmd.targets ?? [],
          judgeEnabled: JudgeScorer.available(),
          budget: await budgetGate.status(ctx),
        }).catch(() => null);
        const verdict = await budgetGate.mayStart(ctx, {
          // The HIGH end. An estimate that undershoots is the dangerous direction — it is the
          // one that talks somebody into a run they would have declined — and a hold sized from
          // the low end would leave the difference unprotected.
          estimateUsd: evalEstimate?.hasUnpricedTarget ? null : (evalEstimate?.totalHighUsd ?? null),
          purpose: "eval",
        });
        if (!verdict.ok) {
          relay.broadcastEval(ctx, { type: "error", message: verdict.message ?? "this eval was refused" });
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
        if ("error" in started) {
          // No eval, so no `evalFinished` is coming to settle the hold. Give it back now rather
          // than leaving it to the sweeper — the same shape as a run refused a pool slot.
          if (verdict.holdId) await balances.release(ctx, verdict.holdId);
          relay.broadcastEval(ctx, { type: "error", message: started.error });
          return;
        }
        // Whose hold to settle when this eval finishes. Keyed by the eval id, which only exists
        // once `start` has returned — which is why the hold was taken against no subject and is
        // attributed here.
        if (verdict.holdId) evalHolds.set(started.evalId, verdict.holdId);
        // The session the sweep was started from. §4.2 puts a running eval in the Running section
        // with its live cost ticking, and this row is what tells the derivation whose row that is —
        // "Nightly eval sweep · api_gateway · eval 34/120" is a thread, not a stray job list.
        //
        // The eval's own RUNS are deliberately not bound one by one. A hundred jobs would be a
        // hundred rows saying what this single row already says, and the derivation reads progress
        // off `eval_jobs`, which is where it is.
        noteThreadItem(ctx, await threadForWork(ctx, cmd.threadId, cmd.agentId), {
          kind: "eval",
          refId: started.evalId,
        });
        return;
      }
      case "cancelEval": {
        // WHOSE EVAL. The command carries an id and nothing else, and the runner's `live` map
        // is keyed by id across every workspace — so without this, a workspace holding another
        // tenant's eval id could kill their run mid-fan-out, and the queued jobs it cancels
        // would be written off against their rows. `getEvalRun` is scoped, so an eval that is
        // not this workspace's simply is not there.
        if (!(await evalStore.getEvalRun(ctx, cmd.evalId))) {
          relay.broadcastEval(ctx, { type: "error", message: "unknown eval" });
          return;
        }
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
            // The same status the gate itself decides with, so what this dialog says before
            // the button and what a refusal says after it cannot disagree.
            budget: await budgetGate.status(ctx),
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
        // §2.2's resolve condition for `eval_finished`, and this is the ONE path into a comparison
        // however somebody arrived at it — the Evals tab, a drill-down, or the card's own primary
        // action. That the Evals tab clears the Inbox card is Law 2 rather than a side effect: the
        // item leaves because the results were read, not because anything was pressed on it.
        //
        // AFTER THE ANSWER, so a failure to record the stamp cannot cost somebody the results they
        // asked for.
        noteInbox("that an eval's results were opened", noteEvalResultsOpened(inboxDeps, ctx, cmd.evalId));
        return;
      }
      case "listEvals": {
        // A GROWING WINDOW, like the run history's — see wsRelay's LoadHistoryCommand for why a
        // window rather than a cursor. The default is the repository's fifty; the cap is the same
        // one the history uses, because it is the same question about the same kind of list.
        const asked = typeof cmd.limit === "number" && Number.isFinite(cmd.limit) ? Math.floor(cmd.limit) : 50;
        const limit = Math.max(1, Math.min(asked, HISTORY_WINDOW_MAX));
        const all = await evalStore.listEvalRuns(ctx, limit);
        relay.broadcastEval(ctx, {
          type: "evals",
          evals: cmd.datasetId ? all.filter((e) => e.dataset_id === cmd.datasetId) : all,
          // Whether there is anything further back. Computed against the UNFILTERED window, because
          // the filter is applied here rather than in the query: a dataset with two evals in a
          // fifty-row window would otherwise report "complete" while older ones sit unread.
          complete: all.length < limit,
          window: limit,
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

// EVERYTHING BELOW LISTENS ON BOTH POOLS. An eval run's trace still has to reach the SAME
// TraceStore and the SAME control-line handling an interactive run's does — isEvalRun() is
// what already keeps its ordinary events off the live "trace"/"log" channels, and
// activeRunId/pausedRunId are already scoped to the interactive run alone (an eval runId
// never equals either), so registering the identical handler on evalPool costs nothing extra
// to reason about: every branch below already answers "is this MY run" correctly per event.
function onBothPools<K extends keyof RunPoolEvents>(
  event: K,
  handler: (...args: RunPoolEvents[K]) => void,
): void {
  // TypeScript cannot distribute EventEmitter.on's conditional parameter type through a
  // generic K here, even though `handler` is exactly what it wants for any concrete K a
  // caller below actually passes — the callers, not this plumbing, are what type safety here
  // protects.
  const on = (pool: RunPool) => (pool.on as (event: K, handler: (...args: RunPoolEvents[K]) => void) => void)(event, handler);
  on(interactivePool);
  on(evalPool);
}

onBothPools("event", ({ runId, event }) => {
  // THE ENVELOPE DECIDES WHOSE RUN THIS IS, AND THE BODY HAS TO AGREE.
  //
  // The pool attributes every line to the slot that produced it, which is what makes `runId`
  // trustworthy — but nothing downstream compared it against the ids INSIDE the event, and those
  // are what get written: `insertStep` binds `step.run_id` directly, and `upsertRun`'s
  // `ON CONFLICT(id) DO UPDATE SET status=…, cost=…, error=…` is scoped only by workspace. So a
  // sandbox holding its own valid run token could name another run in the same workspace and
  // rewrite its trace — flip a failed run to completed, restate its cost, inject steps into it —
  // against the record ADR-001 calls foundational and `billing/usage.ts` says a charge must be
  // defensible against.
  //
  // This is the same reconciliation the CONTROL path already does, and the comment that made it
  // asserted the event path "has always been safe" because of slot attribution. Slot attribution
  // makes the envelope safe and says nothing about the body. A legitimate event always matches:
  // a resume and a branch both run under the id the slot was started with.
  const claimed = runIdOf(event);
  if (claimed !== runId) {
    console.error(
      `[trace] dropped a ${event.kind} claiming run ${claimed} from the slot running ${runId}`,
    );
    return;
  }
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
        // What this run is executing on, cached for the steps that follow. A step does not
        // carry provider or model — the frozen schema puts them on the run — so without this
        // every metered step would be a second query on the one chain that must not become
        // chatty. See UsageMeter.
        if (event.kind === "run_start") {
          meter.noteRun(event.run.id, event.run.provider, event.run.model, runPayers.get(event.run.id) ?? "platform");
        }
      } else if (event.kind === "step") {
        await store.insertStep(runCtx, event.step);
        // INGESTION LAG, MEASURED FROM WHEN THE STEP ENDED RATHER THAN WHEN IT STARTED.
        //
        // The gauge is "time between a step being emitted in a sandbox and being persisted", and
        // a step is emitted when it finishes — so the emit instant is `started_at + latency_ms`,
        // not `started_at`. Measuring from the start would report a thirty-second model call as
        // thirty seconds of ingestion lag, and the SLO on this metric would then be an alert
        // about how slow the models are.
        //
        // Clamped at zero because the two clocks are different machines: a sandbox running a few
        // hundred milliseconds ahead of the gateway would otherwise contribute negative samples
        // to a histogram, which is a bucket boundary nobody can interpret.
        const emittedAt = Date.parse(event.step.started_at) + (event.step.latency_ms ?? 0);
        if (Number.isFinite(emittedAt)) {
          metrics.observe("trace_ingest_lag_seconds", Math.max(0, (Date.now() - emittedAt) / 1000));
        }
        // METERED AFTER THE STEP IS PERSISTED, AND ON THE SAME CHAIN.
        //
        // After, because a usage row for a step the database rejected would be a charge with
        // no evidence behind it — the trace is the record a bill has to be defensible against.
        // On the same chain, because ingestion is at-least-once and both writes are keyed by
        // the same step id: a redelivered batch re-runs both, and both are no-ops the second
        // time. Off the chain they could interleave with the next batch and stop agreeing.
        //
        // Its own try, because metering must never be able to lose a step. A billing failure
        // is money we did not charge for; a persist failure that took the trace with it is
        // the product.
        try {
          await meter.meterStep(runCtx, event.step);
        } catch (err) {
          console.error("[billing] failed to meter a step:", (err as Error).message);
        }
      }
    } catch (err) {
      console.error("[store] failed to persist event:", (err as Error).message);
    }
    if (!isEvalRun(runId)) relay.broadcastTrace(runCtx, event);
    // §3.3'S DERIVATION READS `runs.status`, SO A RUN ENDING IS A GENUINE STATE TRANSITION.
    //
    // `noteThreadItem` was the only broadcast point, and an item is written when work STARTS —
    // ownership does not change when it ends, because liveness is read from the owner. That design
    // is right; what was missing is that the owner changing liveness also has to say so. Without
    // this a run that failed left its thread rendering `● running` indefinitely: never `✕ errored`,
    // never in Needs You, never counted by the badge — the precise failure §2.1 exists to prevent.
    // It corrected itself only when something unrelated happened to the workspace.
    //
    // Coalesced (see `scheduleThreadBroadcast`), because the snapshot is expensive and a run ending
    // touches the list from three handlers within a millisecond of each other.
    if (event.kind === "run_end") scheduleListRefresh(runCtx);

    // A RUN THAT ENDED IN ERROR AND NOBODY HAS LOOKED AT, which is Inbox rather than Activity by
    // §1's first law: "run failed" is something that happened, and "run failed and nobody has opened
    // the trace" is something to do. One card per AGENT, so nine failures are one row with a nine on
    // it rather than nine rows nobody reads.
    //
    // EVAL RUNS ARE EXCLUDED, and it is the same exclusion the broadcast above makes. An eval's
    // failures are the eval's result — the comparison exists to show which target failed — and
    // putting a card on the board for each would bury the one item that matters, which is that the
    // eval finished and its results are unread.
    // A RUN THAT PASSED, AND THE TRIPLE §2.3 IS THE ONLY TRIGGER FOR: a run failed, an edit was
    // applied, and subsequent runs passed. All three legs are read from rows rather than from
    // anything this process is holding, because they can be days apart and across restarts — an
    // implementation watching for them in memory would propose only when all three landed inside
    // one process lifetime, which turns "the only trigger" into "the only trigger, on a good day".
    //
    // BOUNDED BY THE EDIT'S OWN AGE. A failure is only evidence that this edit fixed something if
    // it happened while the edit's predecessor was live, so the lookback ends at the version before
    // it — which is also what keeps the query's scan bounded.
    if (event.kind === "run_end" && event.run.status === "completed" && !isEvalRun(runId)) {
      const passedRunId = runId;
      const slug = event.run.agent_id;
      noteInbox(
        "a memory proposal",
        (async () => {
          const agent = await agentRepo.bySlug(runCtx, slug);
          if (!agent) return;
          const versions = await agentRepo.versions(runCtx, agent.id);
          const edit = versions.find((v) => v.source === "edit");
          if (!edit) return;
          // The version immediately before the edit. Its creation is when the code the failure ran
          // on became live, so a failure earlier than that was a failure of something else.
          const previous = versions.find((v) => v.version < edit.version);
          const failure = await store.failedRunBefore(
            runCtx,
            slug,
            edit.created_at,
            previous?.created_at ?? "1970-01-01T00:00:00.000Z",
          );
          await noteMemoryProposal(inboxDeps, runCtx, {
            agentUuid: agent.id,
            agentSlug: agent.slug,
            agentName: agent.display_name ?? agent.slug,
            passingRunId: passedRunId,
            edit: { version: edit.version, created_at: edit.created_at, instruction: edit.instruction },
            failure,
          });
        })(),
      );
    }

    if (event.kind === "run_end" && event.run.status === "error" && !isEvalRun(runId)) {
      // The run carries the SLUG (the frozen schema's `agent_id`); the item is keyed by the uuid,
      // because a slug is renameable and a card that survived a rename would key on a name.
      noteInbox(
        "a failed run",
        agentRepo.bySlug(runCtx, event.run.agent_id).then((agent) => {
          if (!agent) return null;
          return noteRunFailed(inboxDeps, runCtx, {
            runId,
            agentUuid: agent.id,
            agentName: agent.display_name ?? agent.slug,
          });
        }),
      );
    }
  });
});

onBothPools("parseError", ({ runId, line, error }) => {
  console.error(`[manager] non-event stdout line (${error}):`, line.slice(0, 200));
  if (!isEvalRun(runId)) relay.broadcastLog(contextForRun(runId), "parseError", `${error}: ${line.slice(0, 200)}`);
});

onBothPools("stderr", ({ runId, line }) => {
  console.error("[agent]", line);
  // An agent's stderr is its workspace's: it can carry a stack trace over the user's own data.
  if (!isEvalRun(runId)) relay.broadcastLog(contextForRun(runId), "stderr", line);
});

// Debug-depth control events (off the trace stream). A `boundary` correlates the durable
// checkpoint to the steps it covers (for later branching); a `paused` flips the run to the
// store-only 'paused' status so history shows it as resumable, without any run_end.
onBothPools("control", ({ runId: slotRunId, ctrl }) => {
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
      // A halted graph waiting on a person is §3.3's `needs_you`, and the derivation reads
      // `pendingConfirms` live — so the fact is already true and nothing was telling the list.
      // The row turns amber while the run is blocked, and back when `clearConfirms` fires.
      scheduleListRefresh(runCtx);
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

onBothPools("spawnError", ({ runId, error }) => {
  if (runId === activeRunId) {
    runActive = false;
    activeRunId = null;
  }
  void releaseInteractiveSlot(contextForRun(runId).workspaceId, runId);
  // A run that never started is a run that ended, as far as §3.3 is concerned — its thread stops
  // being `running` and nothing else would say so. See the `run_end` broadcast for the whole
  // argument; this is the case where there is no `run_end` at all.
  scheduleListRefresh(contextForRun(runId));
  console.error(`[manager] spawn error (run ${runId}):`, error.message);
});

onBothPools("exit", ({ runId, code, signal, timedOut, elapsedMs }) => {
  // WHAT THE SANDBOX COST TO HOLD. Metered here rather than from the trace, because the trace
  // cannot answer it: a run's first event arrives after the Python import has already run, and
  // a killed run never emits a last one at all. The pool launches the sandbox and hears it go,
  // so the pool is the only thing that knows how long the machine actually existed — and a
  // micro-VM is reserved for its whole lifetime, including the seconds before the agent spoke.
  //
  // Read before the context is dropped below: `contextForRun` falls back to the server's own
  // workspace once `runWorkspaces` forgets this run, which would put somebody else's sandbox
  // seconds on the server's ledger.
  const billedCtx = contextForRun(runId);
  // The run's own span closes here, where the machine actually stopped existing — the same
  // moment, and for the same reason, that its sandbox seconds are metered. `timedOut` and a
  // non-zero exit go on it, so a trace shows WHY a run ended and not only that it did.
  metrics.increment("runs_total", {
    status: timedOut ? "timeout" : code === 0 ? "ok" : "error",
    kind: isEvalRun(runId) ? "eval" : "interactive",
  });
  const span = runSpans.get(runId);
  if (span) {
    runSpans.delete(runId);
    span.set("jaroku.exit_code", code ?? -1);
    span.set("jaroku.timed_out", Boolean(timedOut));
    if (signal) span.set("jaroku.signal", signal);
    span.end();
  }
  void meter
    .meterSandboxSeconds(billedCtx, { runId, elapsedMs })
    .catch((err) => console.error("[billing] failed to meter sandbox time:", (err as Error)?.message ?? err));
  // AND THEN SETTLE, on the ingest chain rather than here.
  //
  // The steps this run emitted are metered as they are persisted, and the exit event can and
  // does arrive before the last of them has been written — the chain is what orders those, and
  // nothing else does. Settling straight from this handler would read the ledger while the end
  // of the run was still landing in it, and charge a number that is short by the last few
  // steps. Queued behind the chain, it reads a complete one.
  ingest(() => settleRun(billedCtx, runId));
  // AND WHAT THE RUN LOOKED LIKE, which the same two numbers already answer.
  //
  // A miner is a run that holds its sandbox for minutes and calls no model — and the platform
  // measures both halves of that already, one line above for the seconds and in the trace for
  // the calls. Queued behind the ingest chain for the same reason the settlement is: the exit
  // arrives before the last steps have landed, and a count of model calls taken early would read
  // zero for every run that ended promptly. See abuse/signals.ts for why the floor exists.
  ingest(async () => {
    try {
      const llmCalls = await store.countSteps(billedCtx, runId, "llm_call");
      for (const signal of signalsFromRun({ runId, sandboxSeconds: elapsedMs / 1000, llmCalls })) {
        observe(billedCtx, signal);
      }
    } catch (err) {
      console.error(`[abuse] could not classify run ${runId}:`, (err as Error)?.message ?? err);
    }
  });
  // The subprocess is gone, so any question it was waiting on is moot. Left standing, a run
  // that crashed while blocked would leave a modal asking about a process that no longer
  // exists, and answering it would write a file nobody will ever read.
  clearConfirms(runId, "run ended");
  // AND THE LIST LEARNS THE RUN IS OVER, including the crash that never emitted a `run_end`. The
  // ingest chain's own broadcast covers the ordinary ending; this covers a killed or crashed
  // process, which is exactly the case §3.3 turns red and the badge should count.
  scheduleListRefresh(billedCtx);
  traceBackpressure.release(runId);
  // A no-op for an eval run — it never acquired one. A paused run's process genuinely exits
  // (see debug depth §S3), so this releases the reservation across the pause too; resumeRun
  // re-acquires a fresh one on its way back in.
  void releaseInteractiveSlot(contextForRun(runId).workspaceId, runId);
  // Only the interactive run owns the interactive flags; an eval job finishing must not
  // clear them out from under a run the user is driving.
  if (runId === activeRunId) {
    runActive = false; // covers a crash before run_end ever arrived
    // A run that halted at a boundary keeps its 'paused' status (set from the control
    // event); a normal completion already updated the run via run_end. Either way this
    // subprocess is gone.
    activeRunId = null;
  }
  // §B.2. A shadow run's row learns how its process ended, from the same place every other run's
  // teardown happens. Looked up by run id rather than tracked in a second map: a shadow run is a
  // rare thing and a per-process map would be a second lifetime to get wrong, where a query that
  // finds nothing is exactly right for the ninety-nine runs in a hundred that are not shadows.
  void finishShadowFor(runId);

  // A paused run is coming back — resume re-registers it, and dropping it here would send
  // the resumed segment's events to the server's workspace instead of its own.
  if (runId !== pausedRunId) {
    runWorkspaces.delete(runId);
    runPayers.delete(runId);
    // Same condition, same reason: a resumed segment's steps still need to know what the run
    // is executing on, and the meter's fallback would otherwise re-read the run row once.
    // Harmless either way — this is a cache, not a record.
    meter.forgetRun(runId);
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
planner.on("started", (e) => planOut({ type: "plan_started", ...e }));
planner.on("delta", (e) => planOut({ type: "plan_delta", ...e }));
// ROUTED TO THE PLAN'S OWN WORKSPACE, not to the planner's current scope. A supersede fires while
// the scope belongs to whoever asked for the NEW plan — so the tenant whose card just died was told
// nothing, and the tenant who caused it received a plan id it had never seen. The event carries its
// owner for exactly this, and the thread on it is meaningless to anybody but that owner.
planner.on("discarded", ({ planId, workspaceId }) => {
  const ctx = workspaceId === contextForPlan().workspaceId
    ? contextForPlan()
    : systemContextFor(workspaceId, newRequestId());
  relay.broadcastGen(ctx, { type: "plan_discarded", planId }, ctx === planContext ? planThread : null);
  // §3.3 counts a plan awaiting a decision as blocked work, read live off the planner's slot — so a
  // discard un-blocks the thread and nothing was saying so. The row went on reading `plan awaiting`
  // until something else in the workspace forced a snapshot.
  scheduleListRefresh(ctx);
});

planner.on("plan", (e) => {
  const usage = e.usage as { cost_usd?: number; output_tokens?: number };
  console.log(
    `[plan] ${e.planId} (rev ${e.revision}) — ${e.plan.tools.length} tool(s), ` +
      `${e.warnings.length} warning(s), ${usage?.output_tokens ?? 0} output tokens, ` +
      `$${(usage?.cost_usd ?? 0).toFixed(5)}`,
  );
  for (const w of e.warnings) console.log(`  ! ${w}`);
  // The plan gate is a paid call the platform made for this workspace, and it is metered here
  // — once, at the moment it happened. The generation that follows meters itself; it must not
  // also meter `planUsage`, which is the same call reported a second time for display.
  meterPlatformCall(contextForPlan(), "llm.plan", {
    model: GENERATION_MODEL, ...tokensOf(e.usage), payer: planPayer, threadId: planThread,
  });
  planOut({ type: "plan", ...e });
  // The plan is now awaiting a decision, which is §3.3's `needs_you`. The item is what lets the
  // derivation find it: liveness comes from the planner's own slot, ownership from here.
  if (planThread) noteThreadItem(contextForPlan(), planThread, { kind: "plan", refId: e.planId });
});

planner.on("error", (e) => {
  console.error(`[plan] failed: ${e.message}`);
  planOut({ type: "plan_error", message: e.message });
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
  // TESTS AND SETS IN ONE STATEMENT. Reading `planner.inFlight` here and calling `planner.plan()`
  // three awaits later tested a flag `plan()` had not set yet, so two workspaces both passed and
  // the second repointed `planContext` at itself while the first one's plan was still streaming.
  if (!planner.tryClaim()) {
    relay.broadcastGen(ctx, { type: "plan_error", message: "a plan is already being written" });
    return;
  }
  planContext = ctx;
  // A REVISION STAYS IN THE SESSION THE PLAN IT REVISES WAS WRITTEN IN, which is why this looks up
  // the thread by the plan's own id before falling back. Three revisions of one brief are one build
  // session (§1.1) — filing each in a thread of its own would put three rows in a list whose whole
  // job is to be scannable, and the two of them nobody clicked would sit there with a plan awaiting
  // confirm forever.
  // Everything between the claim and `plan()` awaits, and anything that throws in there would
  // otherwise leave the slot held for the life of the process — a refusal every workspace would
  // then get forever. The claim is given back on the way out.
  try {
    planThread =
      (cmd.revisePlanId ? await threadStore.threadForRef(ctx, "plan", cmd.revisePlanId) : undefined) ??
      (await threadForWork(ctx, cmd.threadId));
    // The brief, or the feedback on a revision — which is what the user actually typed this turn and
    // therefore what §4.3's preview should show.
    noteUserMessage(ctx, planThread, cmd.prompt);
    console.log(
      `[plan] planning${cmd.revisePlanId ? " (revision)" : ""} — "${cmd.prompt.slice(0, 80)}"`,
    );
    const planKey = await providerKeys.platformKey(ctx);
    planPayer = planKey ? "workspace" : "platform";
    // Resolved here rather than in the planner, so the planner keeps its single dependency
    // on the connector catalogue. Refs naming a server or tool that has since gone away
    // resolve to nothing rather than to a guess — the same posture as resolveSelected.
    const mcpTools = await mcpRegistry.resolve(ctx, cmd.mcpTools ?? []);
    void planner.plan({
      runtimeDir: RUNTIME_DIR,
      workspaceId: ctx.workspaceId,
      // WHOSE KEY THINKS. Undefined for every workspace that has not opted in, which is all of
      // them by default and is the whole local path — and undefined means the platform's own key,
      // exactly as before. See billing/providerKeys.ts.
      apiKey: planKey,
      prompt: cmd.prompt,
      connectors: cmd.connectors,
      mcpTools,
      name: cmd.name,
      revisePlanId: cmd.revisePlanId,
    });
  } catch (err) {
    planner.releaseClaim();
    console.error(`[plan] could not start: ${(err as Error)?.message ?? err}`);
    relay.broadcastGen(ctx, { type: "plan_error", message: "could not start the plan" });
  }
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
  // CLAIMED IN THE SAME SYNCHRONOUS BLOCK AS THE GUARD, before the awaits below. The planned path
  // resolves the MCP catalogue between the two, and for that whole window `generating` was false —
  // so two planned generations both passed, both repointed `genContext`, and both registered a
  // listener set, which made one model call emit `done` twice and meter itself twice under two
  // different random idempotency keys. Every refusal below has to hand the slot back.
  generating = true;
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
      generating = false;
      genOut({
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
      generating = false;
      genOut({
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
      generating = false;
      genOut({
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

  // THE PLAN'S OWN SESSION WHEN THERE WAS A PLAN. `cmd.planId` was just spent, so the lookup is
  // against the row written when the plan arrived rather than against the planner — and it means a
  // generation lands in the thread the brief was written in rather than opening a second one beside
  // it. Without a plan, the ordinary resolution applies.
  const generationId = randomUUID();
  genThread =
    (cmd.planId ? await threadStore.threadForRef(ctx, "plan", cmd.planId) : undefined) ??
    (await threadForWork(ctx, cmd.threadId));
  // An unplanned generation is somebody typing a brief straight into the composer, and that brief is
  // the thread's first message. A planned one already recorded it when the plan was asked for, and
  // recording it twice would make the preview echo a brief the user has since revised.
  if (!cmd.planId) noteUserMessage(ctx, genThread, prompt);
  // A generation whose validator refuses it is §3.3's "rejected generation" — work waiting on a
  // person. Clearing the THREAD is what makes "rejected" describe the latest attempt rather than
  // every attempt this process has seen: this generation is the retry, so whatever the last one
  // was refused for is no longer what the session is blocked on.
  rejectedGenerations.delete(genThread);
  noteThreadItem(ctx, genThread, { kind: "generation", refId: generationId });
  console.log(`[gen] generating${plan ? " from an approved plan" : ""} — "${prompt.slice(0, 80)}"`);
  genOut({ type: "started", prompt });

  const onStart = (e: { path: string }) => genOut({ type: "file_start", ...e });
  const onDelta = (e: { path: string; text: string }) => genOut({ type: "file_delta", ...e });
  const onEnd = (e: { path: string }) => genOut({ type: "file_end", ...e });

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
    // `e.usage` ONLY. `planUsage` rides along so the UI can show what the agent cost in total,
    // but the plan was already metered when the plan gate ran — see planner.on("plan"). Adding
    // it again here would bill every planned generation for its plan twice, and the second
    // charge would look exactly like the first.
    meterPlatformCall(contextForGen(), "llm.generation", {
      model: GENERATION_MODEL, ...tokensOf(e.usage), payer: genPayer, threadId: genThread,
    });
    genOut({ type: "done", ...e });
    // THE SESSION LEARNS WHICH AGENT IT BUILT, and the name is snapshotted in the same statement
    // (§3.2) — after this, deleting that agent nulls the link and leaves the row saying
    // `name (deleted)` rather than losing what it was. `syncAgents` first, because the uuid this
    // needs is the row's and the row is written by that sync.
    const boundThread = genThread;
    const genCtxNow = contextForGen();
    void syncAgents()
      .then(async () => {
        if (boundThread) {
          const agent = await agentRepo.bySlug(genCtxNow, e.agentId);
          if (agent) {
            await threadStore.attachAgent(genCtxNow, boundThread, agent.id, agent.display_name ?? agent.slug);
          }
        }
        relay.broadcastAgents();
        scheduleListRefresh(genCtxNow);
      })
      .catch((err) => console.error(`[threads] could not attach the agent:`, (err as Error)?.message ?? err));
    cleanup();
  };

  const onError = (e: { message: string; problems?: string[] }) => {
    console.error(`[gen] failed: ${e.message}`);
    for (const p of e.problems ?? []) console.error(`  - ${p}`);
    genOut({ type: "error", ...e });
    // §3.3's "rejected generation": the thread is blocked on a person deciding what to do about it.
    // Marked rather than stored, for the reason `openProposals` is read live — the refused files
    // exist in this process and nowhere else. The THREAD is what is blocked, and the next
    // generation in it is what clears the mark.
    if (genThread) rejectedGenerations.add(genThread);
    scheduleListRefresh(contextForGen());
    cleanup();
  };

  generator.on("file_start", onStart);
  generator.on("file_delta", onDelta);
  generator.on("file_end", onEnd);
  generator.once("done", onDone);
  generator.once("error", onError);

  // Resolved fresh at build time, so the manifest carries the schemas and impact ratings as
  // they stand now rather than as they stood when the plan was written.
  //
  // Caught, because the listeners are already registered and the slot is already claimed: a key
  // lookup that throws here would otherwise leave both standing for the life of the process, and
  // `cleanup()` is the one place that undoes both.
  const genCtx = ctx;
  try {
    const genKey = await providerKeys.platformKey(genCtx);
    genPayer = genKey ? "workspace" : "platform";
    const mcpTools = await mcpRegistry.resolve(genCtx, mcpRefs);
    const mcpServers = await mcpRegistry.list(genCtx);
    void generator.generate({
      runtimeDir: RUNTIME_DIR, ctx: genCtx, prompt, connectors, mcpTools, mcpServers, name, plan, planUsage,
      // See planAgent: undefined unless this workspace asked that its own key pay for the
      // platform's calls, and undefined is the platform's key.
      apiKey: genKey,
    });
  } catch (err) {
    console.error(`[gen] could not start: ${(err as Error)?.message ?? err}`);
    genOut({ type: "error", message: "could not start the generation" });
    cleanup();
  }
}

// --- editing (fix loop) -----------------------------------------------------
// Streams into the "edit" channel. Like generation, nothing here touches the trace store
// or the frozen event schema. Listeners are permanent — every event carries its ids.
editor.on("file_start", (e) => editOut({ type: "file_start", ...e }));
editor.on("file_delta", (e) => editOut({ type: "file_delta", ...e }));
editor.on("file_end", (e) => editOut({ type: "file_end", ...e }));

editor.on("proposal", (e) => {
  console.log(
    `[edit] proposal for ${e.agentId} — ${e.files.length} file(s): ${e.summary}`,
  );
  // Metered on the PROPOSAL, not on apply. The model call is what costs money; applying a
  // proposal is a version pointer moving, and undoing one is the same pointer moving back.
  // Billing on apply would mean a rejected proposal was free, which it was not.
  meterPlatformCall(contextForEdit(), "llm.edit", {
    model: GENERATION_MODEL, ...tokensOf(e.usage), payer: editPayer, threadId: editThread,
  });
  editOut({ type: "proposal", ...e });
  // An unapplied diff is the most common thing a thread is blocked on, and this row is how the
  // derivation finds which thread. Whether it is still pending stays the editor's answer —
  // `openProposals` — so applying or discarding needs no row of its own here.
  if (editThread) noteThreadItem(contextForEdit(), editThread, { kind: "proposal", refId: e.proposalId });
});

editor.on("applied", (e) => {
  console.log(`[edit] applied v${e.version} to ${e.agentId}: ${e.summary}`);
  editOut({ type: "applied", ...e });
  // The proposal has left `openProposals`, so the thread is no longer blocked. Nothing is written —
  // the row that bound the proposal is still true — but the list has to be told, because the glyph
  // it is rendering has just stopped being amber.
  scheduleListRefresh(contextForEdit());
  void syncAgents().then(() => relay.broadcastAgents());
  relay.broadcastAgentFiles(contextForEdit(), e.agentId);
  // An edit changed the version, and the graph cache is keyed by it — so there is nothing to
  // invalidate, and re-pushing simply builds the new one.
  void relay.broadcastAgentGraph(contextForEdit(), e.agentId);
});

editor.on("undone", (e) => {
  console.log(`[edit] undid v${e.version} on ${e.agentId}`);
  editOut({ type: "undone", ...e });
  void syncAgents().then(() => relay.broadcastAgents());
  relay.broadcastAgentFiles(contextForEdit(), e.agentId);
  // Same as apply: the pointer moved, so the cache key did too.
  void relay.broadcastAgentGraph(contextForEdit(), e.agentId);
});

editor.on("discarded", (e) => {
  editOut({ type: "discarded", ...e });
  // Same as `applied`: the diff is gone from the editor, so the row is no longer blocked.
  scheduleListRefresh(contextForEdit());
});

editor.on("error", (e) => {
  console.error(`[edit] failed: ${e.message}`);
  for (const p of e.problems ?? []) console.error(`  - ${p}`);
  editOut({ type: "error", ...e });
});

async function editAgent(ctx: TenantContext, agentId: string, instruction: string, threadId?: string): Promise<void> {
  // Refused here rather than inside `propose`, so the refusal is answered to the asker and the
  // edit scope is left pointing at the workspace whose edit is actually running. The editor
  // refuses a second edit either way; what this adds is that a refused one cannot redirect the
  // in-flight edit's diff — which is another workspace's source — to whoever asked second.
  // TESTS AND SETS IN ONE STATEMENT. `propose` claims the slot at its own entry, but it is not
  // reached until the key lookup below resolves — so reading `editor.inFlight` here tested a flag
  // nothing had set yet, and a second workspace passed the same guard and repointed `editContext`
  // at itself while the first one's source files were still streaming out on that scope.
  if (!editor.tryClaim()) {
    relay.broadcastEdit(ctx, { type: "error", message: "an edit is already in progress", agentId });
    return;
  }
  editContext = ctx;
  console.log(`[edit] ${agentId} — "${instruction.slice(0, 80)}"`);
  // BOUND BEFORE THE FIRST EVENT GOES OUT, not alongside it. Every edit event now names the session
  // it belongs to, and `started` is the one that opens the turn — resolved in a floating `.then()`,
  // it went out carrying the PREVIOUS edit's thread, and the instruction would have opened a
  // conversation in a session it had nothing to do with.
  //
  // Claimed after the guard, like `editContext` immediately above it and for the same reason: a
  // refused edit that had already repointed this would file the running edit's proposal under
  // whoever asked second. The instruction is what the user said, so it is the thread's message.
  try {
    editThread = await threadForWork(ctx, threadId, agentId);
    noteUserMessage(ctx, editThread, instruction);
  } catch (err) {
    console.error(`[threads] could not bind the edit:`, (err as Error)?.message ?? err);
    editThread = null;
  }
  editOut({ type: "started", agentId, instruction });
  void providerKeys
    .platformKey(ctx)
    .then((apiKey) => {
      editPayer = apiKey ? "workspace" : "platform";
      return editor.propose(ctx, agentId, instruction, apiKey);
    })
    .catch((err) => {
      // The claim never became an edit, so it has to go back — otherwise one failed key lookup
      // refuses every edit in the deployment until the process restarts.
      editor.releaseClaim();
      console.error(`[edit] could not start: ${(err as Error)?.message ?? err}`);
      relay.broadcastEdit(ctx, { type: "error", message: "could not start the edit", agentId });
    });
}

// --- run trigger ------------------------------------------------------------
async function runAgent(
  ctx: TenantContext,
  input?: string,
  provider?: string,
  model?: string,
  agentId?: string,
  /**
   * §B.2: run a project that is NOT this agent's published version.
   *
   * ONE OPTIONAL ARGUMENT RATHER THAN A SECOND `runShadowAgent`, and that is the reuse §B.2 claims
   * rather than merely asserts. Everything a run needs — the budget gate, the hold, the payer, the
   * egress policy, the run token, the interactive reservation, the span, the metering — is decided
   * in the two hundred lines below, and a second entry point would be a second place for each of
   * those to be got right. A shadow run is an ordinary run whose project came from a git ref, so
   * what changes is one environment variable and one row that learns the run id.
   *
   * `projectDir` IS WHAT `JAROKU_AGENT_DIR` POINTS AT. `contract.py` already reads it — it is how
   * graph introspection builds a project the object store materialised — so nothing in the runner
   * has to learn what a shadow run is.
   */
  shadow?: { projectDir: string; shadowRunId: string },
  /**
   * The build session this run belongs to, when there is one.
   *
   * Last, and optional, because plenty of runs have no session: the boot autorun, a shadow run a
   * webhook started, an eval job. Those are bound by whoever started them if they are bound at all —
   * see `handleEvalCommand` for the eval side.
   */
  threadId?: string,
): Promise<void> {
  if (interactivePool.busy) {
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
  // Whose key this run turns out to spend. Decided below, when the environment is assembled, and
  // recorded on the meter before the first step arrives — it cannot be recovered afterwards,
  // because whether a run used its workspace's key depends on what was configured at the time.
  let runPayer: Payer = "platform";
  // What this run may reach, or undefined when no policy could be computed. Undefined is the
  // local default and is NOT "allow everything" on the hosted path — see SandboxSpec.egress.
  let runEgress: EgressPolicy | undefined;
  clearControl(runId); // no stale pause request from a prior life
  console.log(`[manager] starting ${agentId ?? "test_agent"}${input ? ` — "${input}"` : ""} (run ${runId})`);
  // Model is forwarded explicitly so a real-provider run can't silently fall back to
  // the agent's expensive default; unset means the agent picks its own default.
  // JAROKU_CONTROL_DIR is where tools/mcp_bridge.py exchanges confirmation approvals with
  // this process. Its ABSENCE is how a copied-out project knows nobody is watching — see the
  // gate's standalone branch. Set on every interactive run, so the gate always has a route.
  // TIER FOUR: THE SANDBOX'S OWN CONTEXT, handed to it in its environment.
  //
  // A run is a process on another machine that will call back over HTTP for control, for
  // confirmations, and to push its trace. Given a `TRACEPARENT` it makes those calls inside the
  // same trace as the click that started it, and "everything that happened for this run" stays
  // one query rather than four. A span rather than a bare id, so the run's own duration is
  // recorded here — the sandbox cannot end a span it did not create.
  const runSpan = tracer.start(`run ${agentId ?? "test_agent"}`, {
    attributes: { "jaroku.run_id": runId, "jaroku.workspace_id": ctx.workspaceId, "jaroku.agent": agentId ?? "test_agent" },
  });
  runSpans.set(runId, runSpan);
  const env: NodeJS.ProcessEnv = {
    JAROKU_RUN_ID: runId,
    // The W3C header name, spelled as an environment variable exactly as the OTel SDKs read it,
    // so a generated project that happens to use one picks it up without being told about us.
    TRACEPARENT: formatTraceparent(runSpan.context),
    JAROKU_CONTROL_DIR: CHECKPOINT_DIR,
    // WHICH WORKSPACE THIS RUN'S CHECKPOINTS BELONG TO.
    //
    // On the Postgres checkpointer every tenant's threads share one table and there is no RLS
    // in that schema — LangGraph never issues SET LOCAL, so a policy there would match nothing.
    // The isolation is the key: `ws:<workspace_id>:run:<run_id>`. The SQLite path ignores it,
    // because one file per run is already a namespace.
    JAROKU_WORKSPACE_ID: ctx.workspaceId,
  };
  // §B.2. The ref's tree, materialised, instead of the agent's published version. Set here — with
  // everything else about the environment — so a shadow run is metered, gated and traced by exactly
  // the code that does it for every other run.
  if (shadow) env.JAROKU_AGENT_DIR = shadow.projectDir;
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
    // AND THE WORKSPACE'S OWN PROVIDER KEY — for the provider this run actually names, and no
    // other. An agent on Anthropic does not receive OPENAI_API_KEY even when the workspace has
    // configured one: that is the same least-privilege rule the egress policy applies to the
    // socket, applied to the credential, and it matters more here because what receives it is
    // model-written Python. An unnamed provider is the dry-run one, which needs no key at all.
    const own = await providerKeys.runEnv(runId, provider);
    Object.assign(env, own);
    runPayer = Object.keys(own).length > 0 ? "workspace" : "platform";

    // AND THE CONNECTORS THIS AGENT WAS GENERATED WITH, each as a SHORT-LIVED access token.
    //
    // Resolved from the agent's own declared connector list, never from anything a client sent,
    // and refreshed first if the token is close enough to expiry that this run could outlive it.
    // The refresh token stays in the vault: what goes into the sandbox is the hour-long half, so
    // a value that leaks out of a log the agent wrote expires on its own.
    //
    // Written AFTER the required_env resolution above, deliberately. A workspace that has both
    // connected Gmail and pasted a `GMAIL_ACCESS_TOKEN` by hand should get the connection — the
    // hand-set one is the local development path, and hosted it is the one nobody is maintaining.
    const connectors = await connectorRunEnv(ctx, tokenRefresher, oauth, {
      connectors: agent?.connectors ?? [],
    });
    Object.assign(env, connectors.env);

    // EVERY VALUE THAT JUST ENTERED THIS RUN'S ENVIRONMENT IS NOW A KNOWN SECRET.
    //
    // This is the moment the process is holding plaintext credentials it did not load from
    // `runtime/.env` — a workspace's own provider key out of the vault, an hour-long access token
    // just minted for Gmail — and it is therefore the moment they have to be registered, before
    // anything can quote one back at us. What quotes one back: a provider's 401 body, a Python
    // traceback carrying an argument, the sandbox's own stderr. Registered by NAME, so a redacted
    // line still says which credential was in it. See obs/log.ts.
    for (const [name, value] of Object.entries(env)) {
      const upper = String(name).toUpperCase();
      if (isSecretName(name) || upper.endsWith("_TOKEN") || upper.endsWith("_KEY") || upper.endsWith("_SECRET")) {
        protectSecret(value, name);
      }
    }

    // Said out loud before the run rather than left for the first tool call to discover. "This
    // workspace's Gmail connection needs reconnecting" is a sentence somebody can act on; a 401
    // from Google surfacing as a red tool_call step twenty seconds into a graph is not.
    //
    // On the providers channel rather than the log, because it is a fact about what this
    // workspace is CONNECTED to — the same channel the refresher raises a reauth banner on, and
    // the same one the connections panel is already listening to.
    for (const credential of connectors.credentials) {
      if (credential.unavailable) relay.broadcastProviders(ctx, { type: "notice", message: credential.unavailable });
    }

    // AND WHAT THIS RUN MAY TALK TO, computed from the same declarations the credentials came
    // from: the one provider it names, the connectors it was generated with, the control plane,
    // and — for postgres — the workspace's own DATABASE_URL, re-resolved and pinned NOW rather
    // than trusted from whenever it was saved. Everything else denied.
    //
    // Built here and carried on the spec because the two sandbox implementations enforce it in
    // completely different places and neither should be deciding what the rules are. Locally
    // nothing enforces it at all — a child process shares this machine's network — which is why
    // LocalSubprocessSandbox refuses to start under NODE_ENV=production.
    runEgress = await buildRunEgress(ctx, runId, provider, agent?.connectors ?? [], agent?.mcp_tools ?? []);
  } catch (err) {
    console.warn(`[manager] could not resolve credentials for ${runId}: ${(err as Error).message}`);
  }

  // NO KEY OF ITS OWN — so this run would spend OURS. The only place in this system where the
  // platform's money is spent by somebody else's decision, and therefore the only one that needs
  // a switch nobody has to remember to use. See billing/platformKey.ts for the three gates and
  // why the platform-key ceiling is a different number from the budget ceiling.
  //
  // Checked only when it applies: a workspace running on its own key never reaches this at all,
  // which is why the refusals below say "connect a key" rather than "you are over budget". For
  // the population this can refuse, connecting a key is genuinely the fix.
  if (runPayer === "platform" && isRealProvider(provider)) {
    const lent = await platformKeyGate.mayUsePlatformKey(ctx, billingPeriod().start);
    if (!lent.allowed) {
      console.log(`[billing] refused run ${runId} on the platform key (${lent.reason}): ${lent.message}`);
      relay.broadcastDebug(ctx, { type: "error", message: lent.message });
      return;
    }
    // Handed over EXPLICITLY rather than left to inheritance. Locally the subprocess inherits
    // this process's environment and would have found it anyway; a hosted sandbox has an
    // explicit `env` and no inheritance at all, so the seam has to be filled here or the same
    // run works in development and cannot authenticate in production.
    const platformValue = process.env[PROVIDER_ENV_KEY[provider as ProviderId]];
    if (platformValue) env[PROVIDER_ENV_KEY[provider as ProviderId]] = platformValue;
  }

  // NO CREDENTIAL AT ALL IS SAID HERE, NOT DISCOVERED BY THE PROVIDER.
  //
  // Everything above is a place a key can legitimately fail to arrive: the workspace revoked it in
  // the Secrets tab, the run names a provider it never configured, or this deployment carries no
  // platform key to lend. Every one of them used to end the same way — the sandbox starts, Python
  // imports, an SDK builds a request with no Authorization header, and twenty seconds later a red
  // tool_call step shows somebody a 401 from a company they have no account with. §8 asks for the
  // other thing: a clear "the credential is gone", naming what and where to fix it.
  //
  // Refused in the same shape as the budget gate immediately below — an error on the debug channel
  // and no slot consumed — because it is the same kind of answer: this run cannot usefully start,
  // and the fix is one click away rather than in a stack trace.
  if (isRealProvider(provider) && !env[PROVIDER_ENV_KEY[provider as ProviderId]]) {
    const envKey = PROVIDER_ENV_KEY[provider as ProviderId];
    console.log(`[manager] refused run ${runId}: no ${envKey} for this workspace`);
    relay.broadcastDebug(ctx, {
      type: "error",
      message:
        `This workspace has no ${provider} credential — ${envKey} is not set, or was revoked. ` +
        `Add or rotate it in the Secrets tab, then run again.`,
    });
    return;
  }
  // MONEY ASKS FIRST — before a slot, before a subprocess, before anything that costs.
  //
  // Ordered after the credential resolution above and before the pool, deliberately: a run
  // refused for budget must not have consumed a slot, and a run about to be refused must not
  // have had a sandbox started for it. The estimate is the same projection the eval estimate
  // uses, so the number this holds against and the number the UI shows a user before an eval
  // are computed by the same code over the same history.
  //
  // An unpriced model estimates to null and holds nothing. Refusing a run on the strength of a
  // number we invented would be worse than letting it through and settling what it really
  // cost, which is what happens either way at exit.
  const estimate = await estimateRun(ctx, store, {
    agentId: agentId ?? "",
    model: model ?? "",
  }).catch(() => ({ highUsd: null as number | null }));
  const verdict = await budgetGate.mayStart(ctx, {
    estimateUsd: estimate.highUsd,
    purpose: "run",
    subjectId: runId,
  });
  if (!verdict.ok) {
    console.log(`[billing] refused run ${runId} for ${ctx.workspaceId}: ${verdict.message}`);
    relay.broadcastDebug(ctx, { type: "error", message: verdict.message ?? "this run was refused" });
    return;
  }
  // Whose hold to release when this run ends. Recorded before the start for the same reason
  // `runWorkspaces` is: the exit arrives on its own tick, and a hold nothing can find is a
  // hold that stands until its TTL lapses.
  if (verdict.holdId) runHolds.set(runId, verdict.holdId);

  // The reservation. interactivePool.busy already refused a second run process-wide, so this
  // should never actually be denied today — it is acquired anyway, unconditionally, because
  // it is the mechanism that has to exist and be exercised now for a future session to widen
  // the process-wide check above into a per-workspace one without also inventing this.
  runWorkspaces.set(runId, ctx); // before the start: its first events arrive on their own tick
  // Before the start, for the same reason: `run_start` is what the ingest chain caches provider
  // and model from, and by then the environment that decided the payer is gone.
  runPayers.set(runId, runPayer);
  const outcome = await interactiveSlots.reserveAndStart(ctx.workspaceId, runId, () =>
    interactivePool.tryStart({
      runId, runtimeDir: RUNTIME_DIR, input, agentId, env, workspaceId: ctx.workspaceId,
      egress: runEgress,
    }),
  );
  if (outcome !== "started") {
    runWorkspaces.delete(runId);
    // The run that never started still holds money. There is no exit event coming for it, so
    // the release has to happen here — the same rule Session 5 learned about the interactive
    // reservation, applied to the thing that is worse to leak.
    void settleRun(ctx, runId);
    console.warn(`[manager] interactive run ${runId} refused for workspace ${ctx.workspaceId}: ${outcome}`);
    relay.broadcastDebug(ctx, {
      type: "error",
      message:
        outcome === "no-reservation"
          ? "you already have an interactive run in progress"
          : "the server is at capacity for interactive runs — try again in a moment",
    });
    return;
  }
  runActive = true;
  activeRunId = runId;
  pausedRunId = null;
  // AFTER THE START, so a run that was refused a slot never gets attached to a shadow row that
  // would then look `running` forever. The row already exists and already says `staging`, which is
  // the honest state for a run that never got one.
  if (shadow) await shadowRepo.attachRun(ctx, shadow.shadowRunId, runId);
  // AFTER THE START, for the same reason and a second one: a run that never got a slot must not turn
  // a thread ● running, and a refused run should not be the thing that opens a session at all.
  //
  // A SHADOW RUN IS DELIBERATELY NOT BOUND. It is started by a webhook against a git ref, with
  // nobody watching and no session behind it — §B.2's own framing — so filing it under whichever
  // thread happens to be open on that agent would attribute a stranger's pull request to somebody's
  // afternoon of work, including its cost.
  //
  // The run's INPUT is not recorded as a message either. Test-mode input is what the agent is fed,
  // not what its author said, and §4.3's preview is explicit that the line is the user's own intent.
  if (!shadow) {
    const runThread = await threadForWork(ctx, threadId, agentId);
    noteThreadItem(ctx, runThread, { kind: "run", refId: runId });
  }
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
  if (interactivePool.busy && pausedRunId === runId) {
    for (let i = 0; i < 40 && interactivePool.busy; i++) {
      await new Promise((r) => setTimeout(r, 50));
    }
  }
  if (interactivePool.busy) {
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
  runWorkspaces.set(runId, ctx);
  const outcome = await interactiveSlots.reserveAndStart(ctx.workspaceId, runId, () =>
    interactivePool.tryStart({ runId, runtimeDir: RUNTIME_DIR, agentId: run.agent_id, env, workspaceId: ctx.workspaceId }),
  );
  if (outcome !== "started") {
    runWorkspaces.delete(runId);
    relay.broadcastDebug(ctx, {
      type: "error",
      runId,
      message:
        outcome === "no-reservation"
          ? "you already have an interactive run in progress"
          : "the server is at capacity for interactive runs — try again in a moment",
    });
    return;
  }
  runActive = true;
  activeRunId = runId;
  pausedRunId = null;
  // Announced only once the process is genuinely going — a "resumed" for a run that never
  // restarted leaves the UI showing a live run against a dead id.
  relay.broadcastDebug(ctx, { type: "resumed", runId, seqOffset });
}

// Kill a run outright — unlike pauseRun, there is nothing left to resume from. Works on an
// eval job's run id too (harmless: interactivePool.stop() on a run it doesn't hold is a
// documented no-op), though cancelEval is the normal way to stop a whole eval; this is for
// addressing one run directly, same as pauseRun/resumeRun already do.
async function cancelRun(ctx: TenantContext, runId: string): Promise<void> {
  // Scoped the same way pauseRun is: a run that is not this workspace's simply is not there.
  const run = await store.getRun(ctx, runId);
  if (!run) {
    console.log(`[debug] cancelRun refused — ${runId} is not this workspace's run`);
    return;
  }
  console.log(`[debug] cancel requested for run ${runId}`);
  clearControl(runId); // no stale pause/resume request outlives a cancel
  await store.markRunCancelled(ctx, runId);
  relay.broadcastDebug(ctx, { type: "cancelled", runId });
  // The exit handler (onBothPools("exit", ...)) does the rest once the process actually
  // dies: clears runActive/activeRunId if this was the interactive run, and releases its
  // reservation — the same teardown a normal completion goes through, just triggered here
  // instead of by the runner finishing on its own.
  interactivePool.stop(runId);
  evalPool.stop(runId);
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
  if (interactivePool.busy) {
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

  // The branch belongs to the same workspace as its parent, which is the one that could see
  // the parent in order to branch from it.
  runWorkspaces.set(branchId, ctx);
  const outcome = await interactiveSlots.reserveAndStart(ctx.workspaceId, branchId, () =>
    interactivePool.tryStart({ runId: branchId, runtimeDir: RUNTIME_DIR, agentId: parent.agent_id, env, workspaceId: ctx.workspaceId }),
  );
  if (outcome !== "started") {
    runWorkspaces.delete(branchId);
    relay.broadcastDebug(ctx, {
      type: "error",
      runId: fromRunId,
      message:
        outcome === "no-reservation"
          ? "you already have an interactive run in progress"
          : "the server is at capacity for interactive runs — try again in a moment",
    });
    return;
  }
  runActive = true;
  activeRunId = branchId;
  pausedRunId = null;
  console.log(`[debug] branching ${fromRunId} @seq ${seqHigh} -> ${branchId} (agent ${parent.agent_id})`);
  void relay.broadcastHistory(); // surface the new branch run in history immediately
  relay.broadcastDebug(ctx, { type: "branched", parentRunId: fromRunId, branchId, fromSeq: seqHigh });
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
  // After the guard, like `replyContext`. A question is something the user said, so it becomes the
  // thread's message and therefore §4.3's preview — asking "why is it 401ing on refresh?" is exactly
  // the line that makes a session recognisable a week later.
  replyThread = await threadForWork(ctx, cmd.threadId, cmd.agentId);
  noteUserMessage(ctx, replyThread, cmd.question);
  replyOut({ type: "started", agentId: cmd.agentId, question: cmd.question });
  let context = await buildExplainContext(ctx, cmd);
  // §7's attachments, resolved at SEND TIME rather than at attach time — a chip made five minutes
  // ago should ground the answer in the repository as it is now. Appended rather than prepended so
  // the agent's own context stays first: what the assistant is being asked about is still this
  // agent, and the GitHub material is evidence about it.
  if (Array.isArray(cmd.github) && cmd.github.length > 0) {
    const attached = await githubService.resolveAttachments(ctx, cmd.agentId, cmd.github);
    if (attached) context = `${context}

Attached from GitHub:
${attached}`;
  }
  const explainKey = await providerKeys.platformKey(ctx);
  void streamExplain(context, cmd.question, {
    onDelta: (text) => replyOut({ type: "delta", agentId: cmd.agentId, text }),
    // Only fires when a model was actually asked. The no-key path streams the raw context and
    // completes without a call, and a workspace must not be billed for the fallback.
    onUsage: (u) =>
      meterPlatformCall(ctx, "llm.explain", {
        model: u.model,
        inputTokens: u.input,
        outputTokens: u.output,
        cacheReadTokens: u.cacheRead,
        cacheWriteTokens: u.cacheWrite,
        payer: explainKey ? "workspace" : "platform",
        threadId: replyThread,
      }),
    onDone: () => { explaining = false; replyOut({ type: "done", agentId: cmd.agentId }); },
    onError: (message) => { explaining = false; replyOut({ type: "error", agentId: cmd.agentId, message }); },
  }, explainKey);
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
  interactivePool.stopAll();
  evalPool.stopAll();
  // Drain the ingest chain before closing. Events already read off a subprocess's stdout are
  // events the user watched happen, and closing the database out from under the last few
  // would lose the end of a trace that visibly ran. Bounded, so a wedged write cannot make
  // Ctrl-C do nothing.
  const drained = Promise.race([
    ingestChain,
    new Promise<void>((r) => setTimeout(r, 2000).unref?.()),
  ]);
  void drained.then(() => store.close()).then(() => eventBridge?.close()).finally(() => process.exit(0));
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
