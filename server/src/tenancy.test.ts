// The isolation suite. The gate for every session after this one.
//
// Two workspaces, A and B, both populated. For every store the app has, A's context must not
// be able to READ, MUTATE or ENUMERATE anything of B's — and a workspace id forged into a
// payload must be ignored in favour of the context.
//
// It grew. Session 2 added token-level attacks — expired, forged, replayed, cross-workspace,
// revoked-mid-socket — which live in `auth/attacks.test.ts` and are invoked from here rather
// than given their own script: the spec makes THIS suite the gate for every later session, and
// a second script somebody can forget to run is not a gate. Session 3 added STORAGE: object
// keys, presigned URLs, version pointers, credential names and checkpoint threads, all of which
// live outside the tables the earlier assertions cover and none of which RLS reaches. Session 4
// adds a version's cached graph result (below) and, on a surface with no Db-backed rows at all —
// run tokens and the control-plane HTTP routes a hosted sandbox calls — a companion file,
// sandbox/tenancyIsolation.test.ts, asserting the identical property against that transport
// instead. The rule is that a session does not merge until this file (or its companion) covers
// what it added, which is why the coverage assertion at the bottom fails when a store grows a
// method nothing here exercises.
//
// Runs on both drivers. On Postgres RLS is a second wall behind everything asserted here; on
// SQLite this layer is the only wall, which is exactly why the suite matters more there.
//
//   npm run test:tenancy
//   JAROKU_PG_URL=postgres://… npm run test:tenancy    # runs it twice

import { randomBytes, randomUUID } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import type { Db } from "./db/db.ts";
import { migrate } from "./db/migrate.ts";
import { SqliteDb } from "./db/sqlite.ts";
import { withScratchPostgres } from "./db/testDb.ts";
import { newRequestId, systemContext, systemContextFor, type TenantContext } from "./db/tenant.ts";
import { IdentityRepository } from "./db/repositories/identity.ts";
import { AgentRepository } from "./db/repositories/agents.ts";
import { TraceStore } from "./store.ts";
import { EvalStore } from "./evalStore.ts";
import { McpStore } from "./mcpStore.ts";
import { DeployStore } from "./deployStore.ts";
import { DbTicketStore } from "./db/repositories/tickets.ts";
import { SecretRefRepository } from "./db/repositories/secretRefs.ts";
import { OAuthRepository } from "./db/repositories/oauth.ts";
import { KmsSecretStore } from "./secrets/kmsSecretStore.ts";
import { LocalMasterKeyProvider } from "./secrets/masterKey.ts";
import { hashState, newPkce, newState } from "./oauth/pkce.ts";
import { authEnvKeyFor } from "./envWriter.ts";
import { BillingRepository } from "./db/repositories/billing.ts";
import { attackSuite } from "./auth/attacks.test.ts";
import { FsObjectStore } from "./storage/fsObjectStore.ts";
import { ProjectStore } from "./storage/projectStore.ts";
import { agentVersionKey, workspacePrefix } from "./storage/keys.ts";
import { OBJECT_ROUTE_PREFIX, objectRoutes } from "./http/objects.ts";
import type { HttpRequest } from "./http/router.ts";
import { checkpointThreadId, workspaceThreadPrefix } from "./checkpoints/threads.ts";
import type { Run, Step } from "./types.ts";

let failures = 0;
const check = (ok: boolean, msg: string): void => {
  if (ok) console.log(`  ok   ${msg}`);
  else {
    failures++;
    console.log(`  FAIL ${msg}`);
  }
};

const MIGRATIONS = join(fileURLToPath(new URL("..", import.meta.url)), "migrations");

/** Everything one workspace owns, so the same fixture can be built twice. */
interface Fixture {
  ctx: TenantContext;
  runId: string;
  datasetId: string;
  exampleId: string;
  evalId: string;
  jobId: string;
  serverId: string;
  deploymentId: string;
  agentSlug: string;
}

async function populate(db: Db, label: string): Promise<Fixture> {
  const identity = new IdentityRepository(db);
  const sys = systemContext(newRequestId());
  const ws = await identity.createWorkspaceUnowned(sys, { name: `tenancy ${label} ${randomUUID().slice(0, 6)}` });
  const ctx = systemContextFor(ws.id, newRequestId());

  const trace = new TraceStore(db);
  const evals = new EvalStore(db);
  const mcp = new McpStore(db);
  const deploys = new DeployStore(db);
  const agents = new AgentRepository(db);

  const runId = randomUUID();
  const run: Run = {
    id: runId, agent_id: `agent_${label}`, provider: "fake", model: "fake-scripted",
    status: "completed", started_at: new Date().toISOString(), ended_at: new Date().toISOString(),
    cost: 0.01, tokens: 10, error: null,
  };
  await trace.upsertRun(ctx, run);
  const step: Step = {
    id: randomUUID(), run_id: runId, seq: 0, type: "llm_call", name: "model",
    input: { q: label }, output: { a: label }, state_before: null, state_after: null,
    tokens: 10, cost: 0.01, latency_ms: 1, error: null, parent_step_id: null,
    started_at: new Date().toISOString(),
  };
  await trace.insertStep(ctx, step);

  const dataset = await evals.createDataset(ctx, `agent_${label}`, `${label} cases`);
  const example = await evals.addExample(ctx, dataset.id, `hello from ${label}`);
  const rubric = await evals.defaultRubricFor(ctx, [
    { id: "correct", label: "Correct", description: "Is it right?", weight: 1 },
  ]);
  const evalRun = await evals.createEvalRun(ctx, {
    dataset_id: dataset.id, agent_id: `agent_${label}`, rubric_id: rubric.id,
    targets: [{ provider: "fake", model: "fake-scripted" }], budget_usd: 1,
  });
  const [job] = await evals.createJobs(ctx, evalRun.id, [
    { example_id: example.id, provider: "fake", model: "fake-scripted" },
  ]);
  await evals.finishJob(ctx, job!.id, "succeeded", { cost_usd: 0.01, tokens: 10 });
  await evals.putScore(ctx, { job_id: job!.id, score: 0.9 });

  // The same server id in both workspaces, on purpose: a slug like "mock" is what two tenants
  // connecting the same service actually produce.
  await mcp.upsertServer(ctx, {
    id: "mock", label: `mock ${label}`, endpoint: `https://mcp.example/${label}`,
    transport: "http", auth_env_key: null, server_name: null, server_version: null,
    protocol_version: null, status: "connected", last_error: null, discovered_at: null,
  });
  await mcp.replaceTools(ctx, "mock", [
    {
      name: "send_message", description: `for ${label}`, input_schema: { type: "object" },
      annotations: null, impact: "high", impact_reason: "its name begins \"send\"",
    },
  ]);

  const deployment = await deploys.create(ctx, {
    agentId: `agent_${label}`, provider: "anthropic", model: "claude-haiku-4-5", envKeys: [],
  });
  await deploys.appendLog(ctx, deployment.id, "building", "build", `line for ${label}`);

  // The same slug in both, which migration 008 is what makes possible.
  await agents.upsertFromDisk(ctx, { slug: "support_bot", display_name: `support (${label})` });

  return {
    ctx, runId, datasetId: dataset.id, exampleId: example.id, evalId: evalRun.id,
    jobId: job!.id, serverId: "mock", deploymentId: deployment.id, agentSlug: "support_bot",
  };
}

async function suite(label: string, db: Db): Promise<void> {
  console.log(`\n${label}`);
  const A = await populate(db, "a");
  const B = await populate(db, "b");

  const trace = new TraceStore(db);
  const evals = new EvalStore(db);
  const mcp = new McpStore(db);
  const deploys = new DeployStore(db);
  const agents = new AgentRepository(db);

  // --- enumerate ---------------------------------------------------------------

  console.log("  · enumeration");
  check((await trace.listRuns(A.ctx)).every((r) => r.id !== B.runId), "history lists none of B's runs");
  check((await evals.listDatasets(A.ctx)).every((d) => d.id !== B.datasetId), "datasets list none of B's");
  check((await evals.listEvalRuns(A.ctx)).every((e) => e.id !== B.evalId), "eval history lists none of B's");
  check((await mcp.listServers(A.ctx)).every((s) => s.label !== "mock b"), "MCP servers list none of B's");
  check((await mcp.listTools(A.ctx)).every((t) => t.description !== "for b"), "MCP tools list none of B's");
  check((await deploys.list(A.ctx)).every((d) => d.id !== B.deploymentId), "deployments list none of B's");
  check(
    (await agents.list(A.ctx)).every((a) => a.display_name !== "support (b)"),
    "agents list none of B's, even sharing a slug",
  );

  // Both really do have their own, or the assertions above pass on an empty database.
  check((await trace.listRuns(A.ctx)).some((r) => r.id === A.runId), "...while A sees its own run");
  check((await agents.list(A.ctx)).some((a) => a.display_name === "support (a)"), "...and its own agent");

  // --- read by id --------------------------------------------------------------

  console.log("  · reading by id");
  check((await trace.getRun(A.ctx, B.runId)) === undefined, "a run id from B resolves to nothing");
  check((await trace.stepsForRun(A.ctx, B.runId)).length === 0, "...and its steps to nothing");
  check((await evals.getDataset(A.ctx, B.datasetId)) === undefined, "a dataset id from B resolves to nothing");
  check((await evals.listExamples(A.ctx, B.datasetId)).length === 0, "...and its examples to nothing");
  check((await evals.getExample(A.ctx, B.exampleId)) === undefined, "an example id from B resolves to nothing");
  check((await evals.getEvalRun(A.ctx, B.evalId)) === undefined, "an eval id from B resolves to nothing");
  check((await evals.jobsForEval(A.ctx, B.evalId)).length === 0, "...and its jobs to nothing");
  check((await evals.getJob(A.ctx, B.jobId)) === undefined, "a job id from B resolves to nothing");
  check((await evals.jobForRun(A.ctx, B.runId)) === undefined, "...and so does a lookup by its run");
  check((await evals.scoresForEval(A.ctx, B.evalId)).length === 0, "scores from B resolve to nothing");
  check((await deploys.get(A.ctx, B.deploymentId)) === null, "a deployment id from B resolves to nothing");
  check((await deploys.logs(A.ctx, B.deploymentId)).length === 0, "...and its build log to nothing");

  // The one place a shared id is not a mistake: both workspaces have a server called "mock".
  const mine = await mcp.getServer(A.ctx, "mock");
  check(mine?.label === "mock a", `the same server slug resolves to MY server (${mine?.label})`);
  const myTool = await mcp.getTool(A.ctx, "mock", "send_message");
  check(myTool?.description === "for a", `...and my tool of that name (${myTool?.description})`);
  const myAgent = await agents.bySlug(A.ctx, "support_bot");
  check(myAgent?.display_name === "support (a)", `the same agent slug resolves to MY agent`);

  // --- mutate ------------------------------------------------------------------

  console.log("  · mutation");

  await trace.upsertRun(A.ctx, {
    id: B.runId, agent_id: "hijack", provider: "fake", model: "m", status: "error",
    started_at: new Date().toISOString(), ended_at: null, cost: 99, tokens: 0, error: "hijacked",
  });
  check((await trace.getRun(B.ctx, B.runId))?.error === null, "a run_end for B's run changes nothing");

  await trace.setRunStatus(A.ctx, B.runId, "paused");
  check((await trace.getRun(B.ctx, B.runId))?.status === "completed", "nor does a status flip");

  await trace.setCheckpointUpto(A.ctx, B.runId, 0, "hijack");
  check((await trace.boundaryForStep(B.ctx, B.runId, 0)) === null, "nor a checkpoint stamp");

  await evals.renameDataset(A.ctx, B.datasetId, "renamed by A");
  check((await evals.getDataset(B.ctx, B.datasetId))?.name === "b cases", "renaming B's dataset does nothing");

  await evals.deleteDataset(A.ctx, B.datasetId);
  check((await evals.getDataset(B.ctx, B.datasetId)) !== undefined, "nor does deleting it");

  await evals.deleteExample(A.ctx, B.exampleId);
  check((await evals.getExample(B.ctx, B.exampleId)) !== undefined, "nor deleting B's example");

  await evals.setEvalStatus(A.ctx, B.evalId, "cancelled", "by A");
  check((await evals.getEvalRun(B.ctx, B.evalId))?.status === "queued", "nor cancelling B's eval");

  const cancelled = await evals.cancelQueuedJobs(A.ctx, B.evalId, "by A");
  check(cancelled === 0, "nor cancelling its queued jobs");

  await evals.addJudgeCost(A.ctx, B.evalId, 100);
  check((await evals.trueSpend(B.ctx, B.evalId)) < 1, "nor charging judge cost to B's eval");

  await evals.finishJob(A.ctx, B.jobId, "failed", { error: "by A" });
  check((await evals.getJob(B.ctx, B.jobId))?.status === "succeeded", "nor failing B's job");

  await mcp.setServerStatus(A.ctx, "mock", "unreachable", "by A");
  check((await mcp.getServer(B.ctx, "mock"))?.status === "connected", "nor breaking B's server of the same name");

  await mcp.setToolImpactOverride(A.ctx, "mock", "send_message", "low");
  check(
    (await mcp.getTool(B.ctx, "mock", "send_message"))?.impact_override === null,
    "nor lowering the impact of B's tool of the same name",
  );

  await mcp.deleteServer(A.ctx, "mock");
  check((await mcp.getServer(B.ctx, "mock")) !== null, "nor deleting it");

  await deploys.patch(A.ctx, B.deploymentId, { status: "removed" });
  check((await deploys.get(B.ctx, B.deploymentId))?.status === "queued", "nor removing B's deployment");

  const superseded = await deploys.supersede(A.ctx, B.deploymentId, "svc");
  check(superseded === 0, "nor superseding it");

  await agents.upsertFromDisk(A.ctx, { slug: "support_bot", display_name: "hijacked" });
  check(
    (await agents.bySlug(B.ctx, "support_bot"))?.display_name === "support (b)",
    "nor rewriting B's agent of the same slug",
  );

  // --- a forged workspace in a payload -----------------------------------------

  console.log("  · forgery");

  // The client controls what it sends, never which workspace it acts in. A store takes the
  // scope from the context and from nowhere else, so a workspace_id in a payload — here, a
  // run whose row is being written — cannot redirect the write.
  const forgedRunId = randomUUID();
  await trace.upsertRun(A.ctx, {
    id: forgedRunId,
    // A caller trying to plant a row in B's workspace by decorating the object.
    ...({ workspace_id: B.ctx.workspaceId } as object),
    agent_id: "forged", provider: "fake", model: "m", status: "completed",
    started_at: new Date().toISOString(), ended_at: null, cost: 0, tokens: 0, error: null,
  } as Run);
  check((await trace.getRun(B.ctx, forgedRunId)) === undefined, "a forged workspace_id does not place a row in B");
  check((await trace.getRun(A.ctx, forgedRunId)) !== undefined, "...it lands in the caller's own workspace");

  // --- the sentinel ------------------------------------------------------------

  await attackSuite(db, check, label);

  console.log("  · no unreachable rows");

  const TENANT_TABLES = ["runs", "steps", "datasets", "eval_jobs", "mcp_servers", "deployments"];

  if (db.dialect === "sqlite") {
    // SQLite cannot drop a column default, so NOT NULL arrives with one — the empty string,
    // which is not a uuid and equals no workspace. A row that got it would be invisible to
    // every context, so its absence is the assertion. See migration 004.
    for (const table of TENANT_TABLES) {
      const orphan = await db.get<{ n: unknown }>(
        `SELECT COUNT(*) AS n FROM ${table} WHERE workspace_id = ?`,
        [""],
      );
      check(Number(orphan?.n ?? 0) === 0, `${table} has no rows with the empty-workspace sentinel`);
    }
  } else {
    // Postgres has no sentinel to look for, because it does not need one: the column is uuid
    // NOT NULL with the default DROPPED, so a write that forgets its scope fails outright
    // rather than landing somewhere unreachable. That is the stronger property, and it is a
    // property of the schema, so it is what gets asserted.
    for (const table of TENANT_TABLES) {
      // pg_catalog rather than information_schema: `to_regclass` resolves the name through
      // the search_path, which is what makes this work in the scratch schema the suite runs
      // in without having to know what that schema is called.
      const col = await db.get<{ notnull: boolean; default_expr: string | null }>(
        `SELECT a.attnotnull AS notnull, pg_get_expr(d.adbin, d.adrelid) AS default_expr
           FROM pg_attribute a
           JOIN pg_class c ON c.oid = a.attrelid
           LEFT JOIN pg_attrdef d ON d.adrelid = c.oid AND d.adnum = a.attnum
          WHERE c.oid = to_regclass(?) AND a.attname = 'workspace_id'`,
        [table],
      );
      check(
        col?.notnull === true && col?.default_expr === null,
        `${table}.workspace_id is NOT NULL with no default ` +
          `(notnull=${col?.notnull}, default=${col?.default_expr})`,
      );
    }
  }
}

// --- coverage -----------------------------------------------------------------------------
//
// The assertion that makes this file the gate the spec says it is: a store that grows a
// method nothing here touches would otherwise merge with no isolation test at all, and
// nobody would notice until the method that was never checked is the one that leaks.

function coverage(): void {
  console.log("\ncoverage");
  const source = readSuiteSource();
  const missing: string[] = [];
  for (const [mod, methods] of Object.entries(SCOPED_API)) {
    for (const m of methods) {
      if (!new RegExp(`\\.${m}\\(`).test(source)) missing.push(`${mod}.${m}`);
    }
  }
  if (missing.length) {
    failures++;
    console.log(`  FAIL these scoped methods are not exercised here: ${missing.join(", ")}`);
  } else {
    const total = Object.values(SCOPED_API).reduce((n, m) => n + m.length, 0);
    console.log(`  ok   every scoped read and mutation is exercised (${total})`);
  }
}

/**
 * The scoped surface this suite has to cover.
 *
 * Maintained by hand, and that is the point: adding a method here is the moment somebody
 * decides how it should behave across a tenant boundary. The CONTRIBUTING note says a new
 * table without a tenancy test is rejected, and this list is where that becomes mechanical.
 */
const SCOPED_API: Record<string, string[]> = {
  TraceStore: [
    "upsertRun", "insertStep", "listRuns", "getRun", "setRunStatus", "maxSeqForRun",
    "setCheckpointUpto", "boundaryForStep", "copyRunPrefix", "stepsForRun",
  ],
  EvalStore: [
    "createDataset", "renameDataset", "listDatasets", "getDataset", "deleteDataset",
    "addExample", "updateExample", "deleteExample", "hasExampleWithInput", "defaultDatasetFor",
    "listExamples", "getExample", "putRubric", "getRubric", "rubricForDataset",
    "defaultRubricFor", "createEvalRun", "setEvalStatus", "addJudgeCost", "getEvalRun",
    "listEvalRuns", "createJobs", "markJobRunning", "finishJob", "requeueJob", "retryJob",
    "cancelQueuedJobs", "jobsForEval", "getJob", "jobForRun", "trueSpend", "putScore",
    "scoresForEval",
  ],
  McpStore: [
    "listServers", "getServer", "upsertServer", "setServerStatus", "setServerAuthEnvKey",
    "deleteServer", "listTools", "getTool", "resolveTools", "replaceTools",
    "setToolImpactOverride",
  ],
  DeployStore: [
    "create", "patch", "appendLog", "get", "list", "listForAgent", "currentForAgent",
    "currentByAgent", "reusableTarget", "supersede", "logs", "inFlight",
  ],
  // Session 3. `agent_versions` has no workspace_id of its own — it hangs off `agents`, whose
  // uuid is already workspace-scoped — so every one of these is scoped by a JOIN rather than by
  // a WHERE on this table, and a missing join would be invisible in a single-tenant test.
  AgentRepository: [
    "list", "bySlug", "byId", "create", "upsertFromDisk", "syncFromDisk", "addVersion",
    "plannedNextVersion", "reserveVersion", "promoteVersion", "version", "versions",
    "undoVersion", "editCounts",
    // Session 4.
    "getGraphCache", "setGraphCache",
    // Session 6 — what a storage bill is computed from.
    "storedBytes",
  ],
  // Session 2. These decide who can see a workspace AT ALL, so a cross-tenant bug in any of
  // them is worse than one in the stores above — it does not leak a row, it hands over the
  // whole workspace.
  //
  // The lookup primitives are deliberately absent: `membership`, `workspaceById`,
  // `workspacesForUser` and `userByExternalId` take an AnyContext and answer questions ACROSS
  // workspaces by design — they are what the resolver uses to decide a scope, so scoping them
  // to one would be circular. They are covered by test:resolve, which asserts the decisions
  // they feed.
  IdentityRepository: [
    "listMembers", "addMember", "removeMember", "setMemberRole",
    "createInvite", "listInvites", "revokeInvite", "acceptInvite", "listAudit",
    // Session 6 — the one writer of `workspaces.plan`, and therefore of every limit read from it.
    "setWorkspacePlan",
  ],
  // `sweep` is deliberately absent: it deletes EXPIRED rows across every workspace, which is
  // maintenance rather than a scoped operation, and asserting it "cannot reach another
  // workspace" would be asserting the opposite of what it is for. tickets.test.ts covers it.
  DbTicketStore: ["issue", "consume", "revoke"],
  // Session 3. The names a workspace has configured — no values, but a list of what somebody
  // integrates with is still theirs. `touch` takes a workspace id rather than a context,
  // because its caller resolved one from a run; it is exercised for the same scoping anyway.
  SecretRefRepository: ["list", "get", "declare", "markConfigured", "markCleared", "forget", "touch"],
  // Session 6. `listPlans` and `setPlanPrice` are deliberately absent: `plans` is the
  // platform's own catalogue, has no workspace_id and carries no policy — every workspace is
  // meant to read the same rows, so asserting one cannot see another's would be asserting the
  // opposite of what the table is for. Everything else here decides or records money.
  BillingRepository: [
    "balance", "addCredit", "setCeiling", "setLimitOverrides", "record", "spendSince",
    "eventsForRun", "recentEvents", "runSpend", "hold", "liveHolds", "expiredHolds", "liveSubscription",
    "subscriptions", "upsertSubscription", "platformSpendSince", "setOwnKeyForPlatform",
  ],
  // Session 7. A connection is a grant against somebody's REAL ACCOUNT, so a cross-tenant read
  // here is not a leaked row — it is one workspace learning whose mailbox another's agents read,
  // and a cross-tenant WRITE is one workspace ending an integration it does not own.
  //
  // `consumeState` and `sweepStates` are deliberately absent, and it is the same exemption
  // `DbTicketStore.consume` and `sweep` have for the same reason: consuming a state is the
  // operation that PRODUCES a workspace scope — the callback arrives from a third party carrying
  // nothing else — so scoping it would be circular, and the sweep deletes expired rows across
  // every workspace because that is maintenance rather than a scoped operation. Both are covered
  // by `test:oauth-state`, which asserts single use, expiry, and that a forged value resolves to
  // nothing at all.
  OAuthRepository: [
    "list", "forConnector", "usable", "upsert", "recordRefresh", "markReauthRequired",
    "markRevoked", "markRevokedWithNote", "beginFlow", "openFlowCount",
  ],
};

/**
 * The suite's source — BOTH files.
 *
 * The attack half lives in `auth/attacks.test.ts` and is invoked from here, so a method
 * exercised there is exercised by this suite. Reading only this file would report the whole
 * Session 2 surface as uncovered and push somebody to duplicate assertions to satisfy a
 * counter, which is the opposite of what the coverage rule is for.
 */
function readSuiteSource(): string {
  const here = fileURLToPath(import.meta.url);
  return [here, join(dirname(here), "auth", "attacks.test.ts")]
    .map((f) => readFileSync(f, "utf8"))
    .join("\n");
}

/**
 * Session 3: everything that is not a row.
 *
 * The assertions above are about queries, and RLS is the wall behind them. None of that reaches
 * an object key, a presigned URL, or a checkpoint thread — those are separated by the KEY and by
 * the code that builds one, so each needs its own attempt to cross the boundary.
 */
async function storageIsolation(db: Db): Promise<void> {
  console.log("  · storage: keys, URLs, versions and threads");

  const identity = new IdentityRepository(db);
  const agents = new AgentRepository(db);
  const mkWorkspace = async (label: string): Promise<TenantContext> => {
    const ws = await identity.createWorkspaceUnowned(systemContext(newRequestId()), {
      name: `storage ${label} ${randomUUID().slice(0, 6)}`,
    });
    return systemContextFor(ws.id, newRequestId());
  };
  const A = await mkWorkspace("a");
  const B = await mkWorkspace("b");

  const root = mkdtempSync(join(tmpdir(), "jaroku-tenancy-objects-"));
  const signingKey = randomBytes(32);
  const objects = new FsObjectStore({ root, signingKey });
  const projects = new ProjectStore(objects, agents);

  try {
    // Both workspaces hold an agent with the SAME slug and the same file paths, which is the
    // case Session 1's per-workspace uniqueness made possible and nothing had yet exercised
    // against real bytes.
    const mine = await agents.upsertFromDisk(A, { slug: "support_bot" });
    const theirs = await agents.upsertFromDisk(B, { slug: "support_bot" });
    await projects.publish(A, mine.id, [{ path: "agent.py", content: "# A's code\n" }], { source: "generation" });
    await projects.publish(B, theirs.id, [{ path: "agent.py", content: "# B's code\n" }], { source: "generation" });

    // --- object keys ----------------------------------------------------------------
    check(
      (await projects.readVersion(A, theirs.id, 2)).length === 0,
      "A cannot read B's agent version by uuid",
    );
    check(
      (await objects.list(workspacePrefix(A.workspaceId))).every((o) => !o.key.includes(theirs.id)),
      "and none of B's objects sit under A's prefix",
    );
    check(
      (await objects.get(agentVersionKey(A.workspaceId, mine.id, 2, "agent.py"))).toString() === "# A's code\n",
      "...while each workspace's own key resolves to its own bytes",
    );
    let forgedKey = false;
    try {
      // The forged-payload case, at the storage layer: a key naming another workspace, built by
      // hand rather than by the builders. It has to be refused for being outside the keyspace
      // the caller can name, not merely return nothing.
      await objects.get(`ws/${A.workspaceId}/../${B.workspaceId}/agents/${theirs.id}/v2/agent.py`);
    } catch {
      forgedKey = true;
    }
    check(forgedKey, "a key that traverses out of A's prefix is refused, not resolved");

    // --- version pointers -----------------------------------------------------------
    const beforeUndo = (await agents.bySlug(B, "support_bot"))!.current_version;
    check((await agents.undoVersion(A, theirs.id)) === null, "A cannot move B's version pointer");
    check(
      (await agents.bySlug(B, "support_bot"))!.current_version === beforeUndo,
      "...and it is where B left it",
    );
    const dest = join(root, "materialised");
    let materialiseRefused = true;
    try {
      materialiseRefused = (await projects.materialise(A, theirs.id, 2, dest)).length === 0;
    } catch {
      materialiseRefused = true;
    }
    check(materialiseRefused, "A cannot materialise B's version onto a disk it controls");

    // --- presigned URLs -------------------------------------------------------------
    //
    // The leaked-URL case the spec asks for by name. The URL is VALID — minted by this server,
    // correctly signed, unexpired — and is presented by a request authenticated for the other
    // workspace. A signature proves where a URL came from; it does not prove who is holding it.
    const leaked = await projects.presignFile(A, mine.id, 2, "agent.py");
    const routes = objectRoutes({
      objects,
      signingKey,
      workspaceFor: async (req) => req.header("x-test-workspace") ?? null,
    });
    const get = routes.find((r) => r.method === "GET")!.handler;
    const asRequest = (url: string, workspace: string | null): HttpRequest => {
      const parsed = new URL(url, "http://jaroku.invalid");
      return {
        requestId: newRequestId(),
        method: "GET",
        path: parsed.pathname,
        url: parsed,
        raw: {} as never,
        ip: null,
        header: (name) => (name.toLowerCase() === "x-test-workspace" ? workspace ?? undefined : undefined),
        json: async () => ({}) as never,
        buffer: async () => Buffer.alloc(0),
      };
    };

    const byOwner = await get(asRequest(leaked.url, A.workspaceId));
    check(
      Buffer.isBuffer(byOwner.body) && byOwner.body.toString() === "# A's code\n",
      "a presigned URL works for a request scoped to the workspace it names",
    );

    let refusedForB = false;
    try {
      await get(asRequest(leaked.url, B.workspaceId));
    } catch (err) {
      refusedForB = (err as { status?: number }).status === 403;
    }
    check(refusedForB, "...and is refused for a B-scoped request, even though the signature is valid");

    // A URL with no credential at all still works — that is what a presigned URL IS, and the
    // sandbox in Session 4 depends on it. Asserted so the rule above is not mistaken for
    // "credentials are required", which would be a different and incompatible design.
    const anonymous = await get(asRequest(leaked.url, null));
    check(
      Buffer.isBuffer(anonymous.body),
      "...while a request carrying no credential redeems it, which is what presigning is for",
    );

    let refusedTamper = false;
    try {
      const other = agentVersionKey(B.workspaceId, theirs.id, 2, "agent.py");
      await get(asRequest(`${OBJECT_ROUTE_PREFIX}${encodeURIComponent(other)}${new URL(leaked.url, "http://x.invalid").search}`, null));
    } catch (err) {
      refusedTamper = (err as { status?: number }).status === 403;
    }
    check(refusedTamper, "and repointing a valid URL at B's key does not verify");

    // --- checkpoint threads ----------------------------------------------------------
    //
    // No RLS reaches the langgraph schema, so the thread name is the whole of the separation.
    const runId = randomUUID();
    check(
      checkpointThreadId(A.workspaceId, runId, "postgres") !==
        checkpointThreadId(B.workspaceId, runId, "postgres"),
      "one run id in two workspaces is two different checkpoint threads",
    );
    check(
      !checkpointThreadId(B.workspaceId, runId, "postgres").startsWith(workspaceThreadPrefix(A.workspaceId)),
      "...and B's thread is outside the prefix A's sweep walks",
    );

    // --- credential names --------------------------------------------------------------
    const refs = new SecretRefRepository(db);
    await refs.markConfigured(B, { name: "THEIR_TOKEN", provider: "mcp" });
    check((await refs.get(A, "THEIR_TOKEN")) === undefined, "A cannot see that B has a credential configured");
    check((await refs.list(A)).every((r) => r.name !== "THEIR_TOKEN"), "...by name or by listing");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

// --- the methods coverage demands, exercised where the assertions above did not -----------

async function remainder(db: Db): Promise<void> {
  const A = await populate(db, "r1");
  const B = await populate(db, "r2");
  const trace = new TraceStore(db);
  const evals = new EvalStore(db);
  const mcp = new McpStore(db);
  const deploys = new DeployStore(db);
  const agents = new AgentRepository(db);

  console.log("  · the rest of the surface");

  check((await trace.maxSeqForRun(A.ctx, B.runId)) === -1, "maxSeqForRun sees none of B's steps");
  let branchRefused = false;
  try {
    await trace.copyRunPrefix(A.ctx, B.runId, randomUUID(), 0, 0);
  } catch {
    branchRefused = true;
  }
  check(branchRefused, "copyRunPrefix refuses to fork B's run");

  await evals.updateExample(A.ctx, B.exampleId, { input: "by A" });
  check(
    (await evals.getExample(B.ctx, B.exampleId))?.input.startsWith("hello") === true,
    "updateExample cannot reach B's",
  );
  check(
    !(await evals.hasExampleWithInput(A.ctx, B.datasetId, "hello from r2")),
    "hasExampleWithInput sees none of B's",
  );
  const ds = await evals.defaultDatasetFor(A.ctx, "agent_r2");
  check(ds.id !== B.datasetId, "defaultDatasetFor never returns B's dataset");
  check((await evals.getRubric(A.ctx, "does-not-exist")) === undefined, "getRubric is scoped");
  check((await evals.rubricForDataset(A.ctx, B.datasetId)) === undefined, "rubricForDataset is scoped");
  await evals.putRubric(A.ctx, { dataset_id: null, name: "mine", criteria: [] });
  await evals.markJobRunning(A.ctx, B.jobId, randomUUID(), 1);
  check((await evals.getJob(B.ctx, B.jobId))?.attempt === 0, "markJobRunning cannot reach B's job");
  await evals.requeueJob(A.ctx, B.jobId);
  await evals.retryJob(A.ctx, B.jobId, 5, new Date());
  check((await evals.getJob(B.ctx, B.jobId))?.status === "succeeded", "nor requeue or retry it");

  await mcp.setServerAuthEnvKey(A.ctx, "mock", "JAROKU_MCP_HIJACK_TOKEN");
  check((await mcp.getServer(B.ctx, "mock"))?.auth_env_key === null, "setServerAuthEnvKey cannot reach B's server");
  check((await mcp.resolveTools(A.ctx, ["mock/send_message"]))[0]?.description === "for r1", "resolveTools is scoped");

  check((await deploys.listForAgent(A.ctx, "agent_r2")).length === 0, "listForAgent sees none of B's");
  check((await deploys.currentForAgent(A.ctx, "agent_r2")) === null, "currentForAgent sees none of B's");
  check(!(await deploys.currentByAgent(A.ctx)).has("agent_r2"), "currentByAgent sees none of B's");
  check((await deploys.reusableTarget(A.ctx, "agent_r2")) === null, "reusableTarget never returns B's service");
  check((await deploys.inFlight(A.ctx)).every((d) => d.id !== B.deploymentId), "inFlight sees none of B's");

  check((await agents.byId(A.ctx, (await agents.bySlug(B.ctx, "support_bot"))!.id)) === undefined,
    "an agent uuid from B resolves to nothing");
  const mineAgent = (await agents.bySlug(A.ctx, "support_bot"))!;
  await agents.addVersion(A.ctx, mineAgent.id, { "agent.py": { sha256: "x", bytes: 1 } });
  check((await agents.bySlug(A.ctx, "support_bot"))!.current_version === 2, "addVersion bumps my own agent");
  await agents.syncFromDisk(A.ctx, [{ slug: "support_bot" }]);
  check((await agents.bySlug(B.ctx, "support_bot")) !== undefined, "syncFromDisk never soft-deletes B's agents");

  // Session 3: an agent's VERSIONS. Every one of these is scoped through the agent rather than
  // by a column of its own, which is exactly the shape that fails quietly if the join is
  // dropped — the query still runs, and it returns another workspace's history.
  const theirAgent = (await agents.bySlug(B.ctx, "support_bot"))!;
  await agents.addVersion(B.ctx, theirAgent.id, { "agent.py": { sha256: "b", bytes: 2 } }, { source: "edit" });
  check((await agents.version(A.ctx, theirAgent.id, 2)) === undefined, "version cannot read B's version row");
  check((await agents.versions(A.ctx, theirAgent.id)).length === 0, "versions lists none of B's");
  check((await agents.versions(A.ctx, theirAgent.id, true)).length === 0, "...including the undone ones");
  check((await agents.undoVersion(A.ctx, theirAgent.id)) === null, "undoVersion refuses B's agent");
  check(
    (await agents.bySlug(B.ctx, "support_bot"))!.current_version === 2,
    "...leaving B's pointer where it was",
  );
  // `create` mints the row for a generation, with the uuid the object keys were already built
  // from. Two workspaces may hold the same slug, and the rows must be distinct agents.
  const sameSlug = randomUUID();
  await agents.create(A.ctx, { id: sameSlug, slug: "shared_name" });
  await agents.create(B.ctx, { id: randomUUID(), slug: "shared_name" });
  check((await agents.bySlug(B.ctx, "shared_name"))!.id !== sameSlug, "create gives each workspace its own agent for one slug");
  check((await agents.byId(B.ctx, sameSlug)) === undefined, "...and B cannot resolve A's uuid");

  check(!(await agents.editCounts(A.ctx)).has(theirAgent.id), "editCounts counts none of B's edits");


  // Session 4: a version's cached graph introspection result (agent_versions.graph_cache). No
  // workspace_id of its own, same as the version row it lives on — scoped by the same join.
  await agents.setGraphCache(B.ctx, theirAgent.id, 2, { agent_id: "support_bot", nodes: [], edges: [] });
  check((await agents.getGraphCache(A.ctx, theirAgent.id, 2)) === undefined, "getGraphCache cannot read B's cached graph");
  await agents.setGraphCache(A.ctx, theirAgent.id, 2, { agent_id: "forged", nodes: [], edges: [] });
  check(
    ((await agents.getGraphCache(B.ctx, theirAgent.id, 2)) as { agent_id?: string } | undefined)?.agent_id === "support_bot",
    "setGraphCache cannot overwrite B's cached graph",
  );

  // Session 3: the credential NAMES a workspace has. No values live here, but what a tenant
  // integrates with is not something another tenant is entitled to enumerate.
  const refs = new SecretRefRepository(db);
  await refs.markConfigured(B.ctx, { name: "B_ONLY_TOKEN", provider: "mcp" });
  await refs.declare(B.ctx, { name: "B_DECLARED_TOKEN" });
  check((await refs.get(A.ctx, "B_ONLY_TOKEN")) === undefined, "a secret ref of B's is invisible to A");
  check((await refs.list(A.ctx)).every((r) => !r.name.startsWith("B_")), "and absent from A's listing");
  await refs.markCleared(A.ctx, "B_ONLY_TOKEN");
  check((await refs.get(B.ctx, "B_ONLY_TOKEN"))?.configured === true, "A cannot clear B's ref");
  await refs.touch(A.ctx.workspaceId, ["B_ONLY_TOKEN"]);
  check((await refs.get(B.ctx, "B_ONLY_TOKEN"))?.last_used_at === null, "nor record a use of it");
  await refs.forget(A.ctx, "B_DECLARED_TOKEN");
  check((await refs.get(B.ctx, "B_DECLARED_TOKEN")) !== undefined, "nor forget one B declared");

  // reserve/promote are the two halves of a publish. Neither may reach an agent of B's — the
  // first would write a version row against it, the second would move its live pointer.
  let reserveRefused = false;
  try {
    await agents.reserveVersion(A.ctx, theirAgent.id, { "x.py": { sha256: "x", bytes: 1 } });
  } catch {
    reserveRefused = true;
  }
  check(reserveRefused, "reserveVersion refuses an agent uuid from B");
  let promoteRefused = false;
  try {
    await agents.promoteVersion(A.ctx, theirAgent.id, 1);
  } catch {
    promoteRefused = true;
  }
  check(promoteRefused, "promoteVersion cannot move B's pointer");
  check((await agents.bySlug(B.ctx, "support_bot"))!.current_version === 2, "...which is where B left it");

  let plannedRefused = false;
  try {
    await agents.plannedNextVersion(A.ctx, theirAgent.id);
  } catch {
    plannedRefused = true;
  }
  check(plannedRefused, "plannedNextVersion refuses an agent uuid from B rather than answering 1");

  // Session 6: money. A cross-tenant read here is not a leak of somebody's data, it is a
  // decision made against somebody else's balance — a run refused because another workspace is
  // broke, or admitted because another workspace is not. And a usage row written into the wrong
  // workspace is an invoice line the wrong person pays.
  // The figure a storage bill is computed from. A leak here is not a leak of rows, it is one
  // workspace paying for another's files. Asserted last, because adding a version to B's agent
  // moves the pointer the version-history assertions above are about.
  await agents.addVersion(B.ctx, theirAgent.id, { "big.py": { sha256: "b", bytes: 4_096 } });
  const theirsBytes = await agents.storedBytes(B.ctx);
  check(theirsBytes >= 4_096, "storedBytes sees B's own versions");
  check(await agents.storedBytes(A.ctx) < theirsBytes, "and A's own figure does not include them");

  const billing = new BillingRepository(db);
  await billing.addCredit(B.ctx, 50);
  await billing.setCeiling(B.ctx, 25);
  await billing.setLimitOverrides(B.ctx, { evalConcurrency: 9 });
  check((await billing.balance(A.ctx)).balance_usd === 0, "balance never shows B's credit");
  check((await billing.balance(A.ctx)).ceiling_usd === null, "nor B's ceiling");
  check(
    Object.keys((await billing.balance(A.ctx)).limit_overrides).length === 0,
    "nor B's negotiated limits",
  );
  await billing.addCredit(A.ctx, 1);
  check((await billing.balance(B.ctx)).balance_usd === 50, "addCredit cannot top up B's balance");
  await billing.setCeiling(A.ctx, 999);
  check((await billing.balance(B.ctx)).ceiling_usd === 25, "setCeiling cannot lift B's ceiling");

  await billing.record(B.ctx, {
    kind: "llm.provider",
    idempotencyKey: `tenancy-b-${randomUUID()}`,
    runId: B.runId,
    provider: "fake",
    model: "fake-scripted",
    costUsd: 0.25,
  });
  check((await billing.spendSince(A.ctx, "1970-01-01T00:00:00.000Z")).usd === 0, "spendSince counts none of B's usage");
  check((await billing.runSpend(A.ctx, B.runId)).usd === 0, "runSpend cannot settle against B's run");
  check(
    (await billing.platformSpendSince(A.ctx, "1970-01-01T00:00:00.000Z")).usd === 0,
    "platformSpendSince counts none of B's — a platform-key ceiling must not throttle A for B's spending",
  );
  await billing.setOwnKeyForPlatform(A.ctx, true);
  check(
    (await billing.balance(B.ctx)).own_key_for_platform === false,
    "setOwnKeyForPlatform cannot decide whose key B's platform calls spend",
  );
  check((await billing.eventsForRun(A.ctx, B.runId)).length === 0, "eventsForRun cannot read B's run's usage");
  check((await billing.recentEvents(A.ctx)).length === 0, "recentEvents lists none of B's");

  // The hold rows a reservation leaves behind. Inserted through the same scoped handle the
  // reservation will use, so what is asserted here is the scoping the real path has.
  const theirHold = randomUUID();
  await db.forWorkspace(B.ctx.workspaceId).run(
    `INSERT INTO billing_holds (id, workspace_id, amount_usd, purpose, subject_id, created_at, expires_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [theirHold, B.ctx.workspaceId, 5, "run", B.runId, new Date().toISOString(), new Date(0).toISOString()],
  );
  check((await billing.hold(A.ctx, theirHold)) === undefined, "a hold of B's is invisible to A");
  check((await billing.liveHolds(A.ctx)).length === 0, "and absent from A's live holds");
  check((await billing.expiredHolds(A.ctx)).length === 0, "and from what A's sweeper would reclaim");

  await billing.upsertSubscription(B.ctx, {
    planId: "pro",
    status: "active",
    externalSubscriptionId: `sub_${randomUUID()}`,
    externalCustomerId: "cus_b",
  });
  check((await billing.liveSubscription(A.ctx)) === undefined, "liveSubscription never returns B's");
  // The one plan write in the system. A workspace that could move another's plan could grant
  // itself a paid tier, or take one away.
  const identityRepo = new IdentityRepository(db);
  await identityRepo.setWorkspacePlan(A.ctx, "scale");
  check(
    (await identityRepo.workspaceById(B.ctx, B.ctx.workspaceId))?.plan !== "scale",
    "setWorkspacePlan cannot move B's plan",
  );
  check((await billing.subscriptions(A.ctx)).length === 0, "nor does the full history");
}

/**
 * Session 7: connections, and the credentials behind them.
 *
 * WHAT MAKES THIS DIFFERENT FROM EVERY SECTION ABOVE. The rows here are not this workspace's own
 * data — they are grants against SOMEBODY ELSE'S ACCOUNT, made by a person who clicked a consent
 * screen with their own credentials. A cross-tenant read is one workspace learning whose mailbox
 * another workspace's agents are reading. A cross-tenant write is one workspace ending an
 * integration it does not own, or worse, pointing another's agents at its own mailbox.
 *
 * And the MCP half is the one that was ACTUALLY BROKEN until this session rather than
 * hypothetically: a server id is a slug, so two workspaces on one endpoint derived one variable
 * name in one process environment, and the second to save a token replaced the first's. It is
 * asserted here as well as in `test:mcp-tenancy`, because this suite is the gate.
 */
async function connectorIsolation(db: Db): Promise<void> {
  console.log("  · connectors: connections, credentials and MCP");

  const identity = new IdentityRepository(db);
  const mkWorkspace = async (label: string): Promise<TenantContext> => {
    const ws = await identity.createWorkspaceUnowned(systemContext(newRequestId()), {
      name: `conn ${label} ${randomUUID().slice(0, 6)}`,
    });
    return systemContextFor(ws.id, newRequestId());
  };
  const A = await mkWorkspace("a");
  const B = await mkWorkspace("b");

  const oauth = new OAuthRepository(db);
  const connRefs = new SecretRefRepository(db);
  const vault = new KmsSecretStore({
    db,
    master: new LocalMasterKeyProvider("a-master-key-with-enough-entropy-behind-it-0123456789"),
    refs: connRefs,
    runWorkspace: async () => null,
  });
  const mcp = new McpStore(db);

  // Both workspaces connect the SAME connector, with different accounts and different tokens.
  // Every name below is identical between them, which is the case that has to work.
  const accounts = [
    [A, "ada@a.example", "tok-A"],
    [B, "bo@b.example", "tok-B"],
  ] as const;
  for (const [ctx, account, token] of accounts) {
    await vault.set(ctx, "GMAIL_ACCESS_TOKEN", token);
    await oauth.upsert(ctx, {
      provider: "google",
      connectorId: "gmail",
      scopes: ["openid"],
      accessSecretName: "GMAIL_ACCESS_TOKEN",
      externalAccountLabel: account,
      accessExpiresAt: new Date(Date.now() + 3600_000).toISOString(),
    });
  }

  check(
    (await oauth.forConnector(A, "gmail"))?.external_account_label === "ada@a.example",
    "each workspace's connection names its OWN account",
  );
  check(
    (await oauth.forConnector(B, "gmail"))?.external_account_label === "bo@b.example",
    "...and B's names B's, under the same connector id",
  );
  check((await oauth.list(A)).length === 1, "A's listing holds one connection");
  check(
    (await oauth.list(A)).every((c) => c.external_account_label !== "bo@b.example"),
    "...and it is not B's",
  );
  check(
    (await vault.getForPlatformCall(A, ["GMAIL_ACCESS_TOKEN"]))["GMAIL_ACCESS_TOKEN"] === "tok-A",
    "the vault gives A its own token under the shared name",
  );
  check(
    (await vault.getForPlatformCall(B, ["GMAIL_ACCESS_TOKEN"]))["GMAIL_ACCESS_TOKEN"] === "tok-B",
    "...and B its own, which one process environment could not have managed",
  );

  // The mutations, each aimed at the other workspace's row by its real id.
  const bRow = await oauth.forConnector(B, "gmail");
  const bId = bRow?.id ?? "";
  await oauth.markReauthRequired(A, bId, "by A");
  check((await oauth.forConnector(B, "gmail"))?.status === "active", "A cannot break B's connection");
  await oauth.markRevoked(A, bId);
  check((await oauth.usable(B, "gmail")) !== null, "...nor end it");
  await oauth.markRevokedWithNote(A, bId, "by A");
  check((await oauth.forConnector(B, "gmail"))?.last_error === null, "...nor write a note onto it");
  await oauth.recordRefresh(A, bId, new Date(Date.now() + 60_000).toISOString());
  check(
    (await oauth.forConnector(B, "gmail"))?.last_refreshed_at === null,
    "...nor claim to have refreshed it",
  );

  // A flow opened by one workspace is counted only by that one — and the state row it writes is
  // what a callback resolves a scope FROM, so a leak here is a callback completing in the wrong
  // workspace entirely.
  await oauth.beginFlow(A, hashState(newState()), {
    provider: "google",
    connectorId: "gmail",
    codeVerifier: newPkce().verifier,
    redirectUri: "https://jaroku.example.com/v1/oauth/google/callback",
    scopes: [],
  });
  check((await oauth.openFlowCount(A)) === 1, "A has one flow open");
  check((await oauth.openFlowCount(B)) === 0, "...and B has none");

  // MCP: the same endpoint, the same derived variable name, two workspaces. The bug this session
  // fixed, asserted in the suite that gates the session.
  const key = authEnvKeyFor("linear");
  const mcpTokens = [
    [A, "lin-A"],
    [B, "lin-B"],
  ] as const;
  for (const [ctx, token] of mcpTokens) {
    await vault.set(ctx, key, token);
    await mcp.upsertServer(ctx, {
      id: "linear",
      label: "Linear",
      endpoint: "https://mcp.linear.app/sse",
      transport: "http",
      auth_env_key: key,
      server_name: null,
      server_version: null,
      protocol_version: null,
      status: "connected",
      last_error: null,
      discovered_at: null,
    });
  }
  check(
    (await vault.getForPlatformCall(A, [key]))[key] === "lin-A",
    "two workspaces on one MCP endpoint hold two different credentials",
  );
  check((await vault.getForPlatformCall(B, [key]))[key] === "lin-B", "...under the same derived name");

  await mcp.setServerAuthEnvKey(A, "linear", null);
  check(
    (await mcp.getServer(B, "linear"))?.auth_env_key === key,
    "A clearing its own server's key does not clear B's",
  );
  await mcp.deleteServer(A, "linear");
  check((await mcp.getServer(B, "linear")) !== null, "...and removing its server leaves B's standing");
  check(
    (await vault.getForPlatformCall(B, [key]))[key] === "lin-B",
    "...with B's credential intact",
  );

  // And the names themselves. A list of what somebody integrates with is theirs.
  await vault.set(B, "SLACK_BOT_TOKEN", "xoxb-b");
  check(
    !(await vault.listNames(A)).some((r) => r.name === "SLACK_BOT_TOKEN"),
    "A never sees a credential name only B has configured",
  );
  check(
    (await vault.listNames(B)).some((r) => r.name === "SLACK_BOT_TOKEN"),
    "...while B does",
  );
}

// --- run it -------------------------------------------------------------------------------

const tmp = mkdtempSync(join(tmpdir(), "jaroku-tenancy-"));
{
  const db = new SqliteDb(join(tmp, "tenancy.db"));
  await migrate(db.migrationTarget(), join(MIGRATIONS, "sqlite"), () => {});
  try {
    await suite("SqliteDb", db);
    await remainder(db);
    await storageIsolation(db);
    await connectorIsolation(db);
  } finally {
    await db.close();
  }
}
rmSync(tmp, { recursive: true, force: true });

await withScratchPostgres(async (db) => {
  await suite("PostgresDb", db);
  await remainder(db);
  await storageIsolation(db);
  await connectorIsolation(db);
});

coverage();

console.log(failures === 0 ? "\nALL CORRECT" : `\n${failures} FAILURES`);
process.exit(failures === 0 ? 0 : 1);
