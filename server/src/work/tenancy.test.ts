// Two workspaces, both dispatching, and every verb of A's refused inside B.
//
// THE ASSERTION THAT MATTERS IS THE NEGATIVE ONE — §7, "in the direction the Inbox tested": a pass
// for A cannot list, dispatch, cancel, retry or confirm anything in B. All five, because they fail
// differently: `list` leaks rows, `dispatch` writes one, and `cancel`, `retry` and `confirm` are
// the three that ACT — an operator in one tenant stopping a job in another, re-spending its money,
// or answering a question in front of somebody else's agent.
//
// AND IN BOTH DIRECTIONS, which is the half an isolation suite usually forgets. An assertion that A
// cannot see B's rows passes trivially against a store that returns nothing at all, and returning
// nothing is the other way a scoped read fails. So both workspaces are seeded with real jobs and
// each is checked to see ITS OWN — not merely to miss the other's.
//
// THE THREE ACTING VERBS ARE CHECKED AGAINST A CONTAINER THAT WOULD SAY YES. Each stub is live and
// answering, so a refusal here is the scope refusing rather than the network — a suite whose cancel
// failed because nothing was listening would pass while proving nothing.
//
// IT IS EXPORTED AND ALSO RUNNABLE ON ITS OWN, which is the shape `activity/tenancy.test.ts` takes:
// `npm run test:tenancy` invokes it on both drivers with RLS behind it, and `npm run
// test:work-tenancy` runs it against SQLite alone for somebody working on this feature.
//
//   npm run test:work-tenancy

import { randomBytes, randomUUID } from "node:crypto";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { pathToFileURL } from "node:url";

import type { Db } from "../db/db.ts";
import { AgentRepository } from "../db/repositories/agents.ts";
import { IdentityRepository } from "../db/repositories/identity.ts";
import { newRequestId, systemContext, systemContextFor, type TenantContext } from "../db/tenant.ts";
import { openTestSqlite } from "../db/testDb.ts";
import { DeployDispatcher } from "../deployDispatch.ts";
import { DeployRuns } from "../deployRuns.ts";
import { DeployStore } from "../deployStore.ts";
import { RunEventBus } from "../sandbox/eventBus.ts";
import { RunTokenRevocationList } from "../sandbox/runTokens.ts";
import { TraceStore } from "../store.ts";
import { WorkActions } from "./actions.ts";
import { WorkDispatcher } from "./dispatcher.ts";
import { WorkLifecycle } from "./lifecycle.ts";
import { WorkStore, type WorkItem } from "./workStore.ts";

interface WorkFixture {
  ctx: TenantContext;
  agentId: string;
  deploymentId: string;
  /** One job, dispatched and running in a container that is listening. */
  item: WorkItem;
  runId: string;
  /** One job that has already failed, so retry has something to act on. */
  finished: WorkItem;
}

/**
 * A workspace with its own agent, its own live deployment and two jobs.
 *
 * DELIBERATELY UNLIKE THE OTHER ONE — different agent slugs, different inputs, a different stub
 * container — for the reason the Activity isolation suite gives: two tenants holding identical data
 * cannot tell a correctly scoped read from one that reads everything and happens to halve.
 */
async function populate(
  db: Db,
  label: string,
  url: string,
  deps: { work: WorkStore; dispatcher: WorkDispatcher },
): Promise<WorkFixture> {
  const identity = new IdentityRepository(db);
  const agents = new AgentRepository(db);
  const deploys = new DeployStore(db);
  const sys = systemContext(newRequestId());

  const ws = await identity.createWorkspaceUnowned(sys, { name: `work ${label} ${randomUUID().slice(0, 6)}` });
  const person = await identity.provisionUser(sys, {
    externalId: `work-tenancy-${label}-${randomUUID().slice(0, 8)}`,
    email: `work-tenancy-${label}-${randomUUID().slice(0, 8)}@example.com`,
  });
  const ctx: TenantContext = { ...systemContextFor(ws.id, newRequestId()), actorUserId: person.user.id };

  // THE SAME SLUG IN BOTH, which migration 008 is what makes possible and which is the case a
  // scoped read has to get right rather than the case it obviously does.
  const agent = await agents.upsertFromDisk(ctx, { slug: "shared_bot", display_name: `shared (${label})` });
  const deployment = await deploys.create(ctx, {
    agentId: agent.id, provider: "anthropic", model: "claude-haiku-4-5", envKeys: [],
  });
  await deploys.patch(ctx, deployment.id, {
    status: "live", url,
    railway_project_id: "proj", railway_service_id: `svc-${label}`, railway_environment_id: "env",
  });

  const dispatched = await deps.dispatcher.dispatch(ctx, { agentId: agent.id, input: `job for ${label}` });
  if (!dispatched.ok) throw new Error(`fixture ${label} could not dispatch: ${dispatched.detail}`);

  const failedRunId = randomUUID();
  const failed = await deps.work.create(ctx, {
    agentId: agent.id, deploymentId: deployment.id, runId: failedRunId, input: `failed job for ${label}`,
  });
  await deps.work.finish(ctx, failed.id, { status: "failed", error: "boom", failureKind: "agent_error" });

  return {
    ctx,
    agentId: agent.id,
    deploymentId: deployment.id,
    item: dispatched.item,
    runId: dispatched.item.run_id!,
    finished: (await deps.work.get(ctx, failed.id))!,
  };
}

/** A container that answers 202 to everything, so a refusal is the scope rather than the network. */
async function alwaysAccepts(): Promise<{ url: string; close: () => Promise<void> }> {
  const server: Server = createServer((_req, res) => {
    res.writeHead(202, { "content-type": "application/json" });
    res.end(JSON.stringify({ accepted_at: new Date().toISOString() }));
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  return {
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    close: () => new Promise<void>((r) => server.close(() => r())),
  };
}

/**
 * The five verbs, refused across the boundary and honoured inside it.
 *
 * Exported so `tenancy.test.ts` runs it on both drivers — on Postgres with RLS behind every
 * assertion, which is the only place the second wall is exercised at all.
 */
export async function workTenancySuite(
  db: Db,
  check: (ok: boolean, msg: string) => void,
): Promise<void> {
  console.log("  · the Cockpit: five verbs, across a boundary");

  const containerA = await alwaysAccepts();
  const containerB = await alwaysAccepts();
  try {
    const bus = new RunEventBus();
    const revocations = new RunTokenRevocationList();
    const deployRuns = new DeployRuns({ signingKey: randomBytes(32), revocations, bus });
    const work = new WorkStore(db);
    const deploys = new DeployStore(db);
    const trace = new TraceStore(db);

    const endpointFor = (url: string) => new DeployDispatcher({
      runs: deployRuns,
      endpoint: async () => ({ url, serveToken: "t" }),
      timeoutMs: 4_000,
    });
    const dispatcherFor = (url: string) => new WorkDispatcher({
      work,
      deployments: deploys,
      dispatch: endpointFor(url),
      serveToken: async () => "t",
      controlPlaneUrl: () => "http://127.0.0.1:9",
    });

    const A = await populate(db, "a", containerA.url, { work, dispatcher: dispatcherFor(containerA.url) });
    const B = await populate(db, "b", containerB.url, { work, dispatcher: dispatcherFor(containerB.url) });

    const actionsA = new WorkActions({
      work,
      dispatcher: dispatcherFor(containerA.url),
      dispatch: endpointFor(containerA.url),
    });
    const lifecycle = new WorkLifecycle({ work, steps: (c, id) => trace.stepsForRun(c, id) });

    // --- 1. list ---------------------------------------------------------------------------
    const listed = await work.list(A.ctx, { scope: "all" });
    check(listed.items.every((i) => i.id !== B.item.id), "the work list carries none of B's jobs");
    check(listed.items.some((i) => i.id === A.item.id), "...while A sees its own");
    check(
      (await work.list(A.ctx, { scope: "all", agentId: B.agentId })).items.length === 0,
      "...and filtering by B's agent returns nothing rather than B's jobs",
    );
    check((await work.get(A.ctx, B.item.id)) === undefined, "B's job id resolves to nothing in A");
    check((await work.byRun(A.ctx, B.runId)) === undefined, "...and so does B's run id");

    // --- 2. dispatch -----------------------------------------------------------------------
    //
    // A NAMED AGENT FROM ANOTHER WORKSPACE, which is the shape a forged command takes: the client
    // controls the agent id it sends and controls nothing else. The refusal has to come from the
    // deployment lookup being scoped, not from the agent being unknown to the product.
    const intoB = await dispatcherFor(containerA.url).dispatch(A.ctx, {
      agentId: B.agentId, input: "dispatched into somebody else's workspace",
    });
    check(!intoB.ok && intoB.stage === "refused", "dispatching to B's agent from A is refused");
    check(
      (await work.list(B.ctx, { scope: "all" })).items.length === 2,
      "...and writes no row into B",
    );

    // --- 3. cancel -------------------------------------------------------------------------
    //
    // AGAINST A CONTAINER THAT WOULD SAY YES. The stub answers 202 to everything, so this refusal
    // is the scope and not the network.
    const cancelled = await actionsA.cancel(A.ctx, B.item.id);
    check(!cancelled.ok, "cancelling B's running job from A is refused");
    check(
      (await work.get(B.ctx, B.item.id))?.status === "running",
      "...and B's job is still running, which is what its operator would see",
    );
    check((await actionsA.cancel(A.ctx, A.item.id)).ok, "while A can cancel its own");

    // --- 4. retry --------------------------------------------------------------------------
    const retried = await actionsA.retry(A.ctx, B.finished.id);
    check(!retried.ok, "retrying B's failed job from A is refused");
    check(
      (await work.list(B.ctx, { scope: "all" })).items.length === 2,
      "...and no second job appears in B",
    );
    const own = await actionsA.retry(A.ctx, A.finished.id);
    check(own.ok, `while A can retry its own${own.ok ? "" : ` (${own.detail})`}`);
    check(
      own.ok && own.item.id !== A.finished.id,
      "...as a NEW row, because §12 needs the original id to stay citable",
    );
    check(
      own.ok && (await work.get(A.ctx, A.finished.id))?.status === "failed",
      "...leaving the failure it came from exactly as it was",
    );

    // --- 5. confirm ------------------------------------------------------------------------
    //
    // THE GATE IS ANSWERED BY RUN ID, which is what makes this reachable at all: a confirmation
    // arrives naming a run, and the lifecycle's only way back to an item is a scoped read.
    check(
      (await lifecycle.onConfirmRequested(A.ctx, B.runId)) === undefined,
      "a confirmation on B's run does not park B's job from A",
    );
    check(
      (await work.get(B.ctx, B.item.id))?.status === "running",
      "...and B's job never moved",
    );
    check(
      (await lifecycle.onConfirmResolved(A.ctx, B.runId)) === undefined,
      "nor can A answer one on B's behalf",
    );
    check(
      (await lifecycle.onConfirmRequested(B.ctx, B.runId)) !== undefined,
      "while B's own context can park B's job",
    );

    // --- 6. the counts, which are aggregates and therefore the classic leak ------------------
    //
    // COMPARED AGAINST A'S OWN LIST rather than against a number written here, because the number
    // written here would be wrong for a reason that has nothing to do with tenancy: a cancel is a
    // REQUEST, so A's original job is still running, and the retry above added a second. Asserting
    // "0" would have failed as a tenancy leak and been a misreading of Part 1's control action.
    const mineRunning = (await work.list(A.ctx, { scope: "all", status: "running" })).items.length;
    check(
      (await work.countsByStatus(A.ctx)).running === mineRunning,
      `A's status counts are A's own (${mineRunning})`,
    );
    check((await work.inFlight(B.ctx)) === 1, "...and B's in-flight count is B's");
    check(
      (await work.liveByAgent(A.ctx)).every((r) => r.agent_id !== B.agentId),
      "and the per-agent breakdown names none of B's agents",
    );
  } finally {
    await containerA.close();
    await containerB.close();
  }
}

// --- run it on SQLite when invoked directly ------------------------------------------------------
//
// `tenancy.test.ts` runs the same function on both drivers. This entry point exists so somebody
// working on the Cockpit can run the five verbs without standing Postgres up, and so CI has a step
// naming this feature rather than only the suite that covers every feature.

// THROUGH `pathToFileURL`, NOT BY COMPARING THE BASENAME. The obvious guard — does argv[1] end in
// "tenancy.test.ts" — is true when `src/tenancy.test.ts` is the entry point and this file is merely
// imported by it, so the block below ran in the middle of the other suite, printed its own
// ALL CORRECT and set the process exit code. Two files in this repository share that basename by
// design; only the resolved URL tells them apart, and only `pathToFileURL` gets Windows drive
// letters and percent-encoding right.
if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  let failures = 0;
  const check = (ok: boolean, msg: string): void => {
    if (ok) console.log(`  ok   ${msg}`);
    else { failures++; console.log(`  FAIL ${msg}`); }
  };
  const db = await openTestSqlite();
  await workTenancySuite(db, check);
  await db.close();
  console.log(failures === 0 ? "\nALL CORRECT" : `\n${failures} FAILURES`);
  process.exitCode = failures === 0 ? 0 : 1;
}
