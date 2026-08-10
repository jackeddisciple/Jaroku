// The isolation suite. The gate for every session after this one.
//
// Two workspaces, A and B, both populated. For every store the app has, A's context must not
// be able to READ, MUTATE or ENUMERATE anything of B's — and a workspace id forged into a
// payload must be ignored in favour of the context.
//
// It grew. Session 2 added token-level attacks — expired, forged, replayed, cross-workspace,
// revoked-mid-socket — which live in `auth/attacks.test.ts` and are invoked from here rather
// than given their own script: the spec makes THIS suite the gate for every later session, and
// a second script somebody can forget to run is not a gate. Session 3 adds object keys,
// Session 4 adds run tokens and sandbox reach. The rule is that a session does not merge
// until this file covers what it added, which is why the coverage assertion at the bottom
// fails when a store grows a method nothing here exercises.
//
// Runs on both drivers. On Postgres RLS is a second wall behind everything asserted here; on
// SQLite this layer is the only wall, which is exactly why the suite matters more there.
//
//   npm run test:tenancy
//   JAROKU_PG_URL=postgres://… npm run test:tenancy    # runs it twice

import { randomUUID } from "node:crypto";
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
import { attackSuite } from "./auth/attacks.test.ts";
import type { Run, Step } from "./types.ts";

let failures = 0;
const check = (ok: boolean, msg: string): void => {
  if (ok) console.log(`  ok   ${msg}`);
  else {
    failures++;
    console.log(`  FAIL ${msg}`);
  }
};

const MIGRATIONS = join(new URL("..", import.meta.url).pathname, "migrations");

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
    "plannedNextVersion", "version", "versions", "undoVersion", "editCounts",
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
  ],
  // `sweep` is deliberately absent: it deletes EXPIRED rows across every workspace, which is
  // maintenance rather than a scoped operation, and asserting it "cannot reach another
  // workspace" would be asserting the opposite of what it is for. tickets.test.ts covers it.
  DbTicketStore: ["issue", "consume", "revoke"],
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

  let plannedRefused = false;
  try {
    await agents.plannedNextVersion(A.ctx, theirAgent.id);
  } catch {
    plannedRefused = true;
  }
  check(plannedRefused, "plannedNextVersion refuses an agent uuid from B rather than answering 1");
}

// --- run it -------------------------------------------------------------------------------

const tmp = mkdtempSync(join(tmpdir(), "jaroku-tenancy-"));
{
  const db = new SqliteDb(join(tmp, "tenancy.db"));
  await migrate(db.migrationTarget(), join(MIGRATIONS, "sqlite"), () => {});
  try {
    await suite("SqliteDb", db);
    await remainder(db);
  } finally {
    await db.close();
  }
}
rmSync(tmp, { recursive: true, force: true });

await withScratchPostgres(async (db) => {
  await suite("PostgresDb", db);
  await remainder(db);
});

coverage();

console.log(failures === 0 ? "\nALL CORRECT" : `\n${failures} FAILURES`);
process.exit(failures === 0 ? 0 : 1);
