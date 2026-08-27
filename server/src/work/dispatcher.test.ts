// Giving a live agent a job, and the ways that does not happen.
//
// THE SPLIT THAT MATTERS IN THIS SUITE is not happy path against failure — it is REFUSED against
// FAILED, and it is the one thing about the dispatcher a reader has to hold. A refusal happens
// before a row exists: nobody was asked to do anything, nothing was spent, and there is nothing to
// record. A failure happens after one does, and the row stays as the operator's evidence that
// something MAY have been spent — because between the POST leaving and the answer arriving, the
// container may have started the job. Every assertion below says which of the two it expects, and
// several of them check that the OTHER one did not happen.
//
// DRIVEN AGAINST REAL HTTP, never against a stubbed `DeployDispatcher`. Part 1's client is where
// the care about somebody else's container lives — the timeout, the truncation, the run being
// closed again on every answer that is not a 202 — and a fake in front of it would test the fake.
// The one thing standing in for Railway is `startMockServe`, which is the fixture that whole half
// of the bridge was built against.
//
//   npm run test:work-dispatch

import { randomUUID } from "node:crypto";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";

import { startMockServe, type MockServeHandle } from "../../fixtures/deploy/mockServe.ts";
import { DeployDispatcher } from "../deployDispatch.ts";
import { DeployStore } from "../deployStore.ts";
import { DeployRuns } from "../deployRuns.ts";
import { RunEventBus } from "../sandbox/eventBus.ts";
import { RunTokenRevocationList } from "../sandbox/runTokens.ts";
import { AgentRepository } from "../db/repositories/agents.ts";
import { IdentityRepository } from "../db/repositories/identity.ts";
import { openTestSqlite, testContext } from "../db/testDb.ts";
import { newRequestId, systemContext, type TenantContext } from "../db/tenant.ts";
import type { Db } from "../db/db.ts";
import { randomBytes } from "node:crypto";
import { MAX_WORK_INPUT_BYTES, WorkStore } from "./workStore.ts";
import { checkEndpointAddress, DEFAULT_WORK_CONCURRENCY, WorkDispatcher, workConcurrencyFromEnv } from "./dispatcher.ts";

let fail = 0;
const check = (name: string, ok: boolean, detail = ""): void => {
  if (ok) console.log(`  ok   ${name}`);
  else { fail++; console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ""}`); }
};

const closers: (() => Promise<void>)[] = [];

/** A control plane the container can push into — the same routes index.ts registers. */
const bus = new RunEventBus();
const revocations = new RunTokenRevocationList();
const signingKey = randomBytes(32);
const deployRuns = new DeployRuns({ signingKey, revocations, bus });
const controlPlane = createServer((_req, res) => res.writeHead(204).end());
await new Promise<void>((r) => controlPlane.listen(0, "127.0.0.1", r));
const controlPlaneUrl = `http://127.0.0.1:${(controlPlane.address() as AddressInfo).port}`;
closers.push(() => new Promise<void>((r) => controlPlane.close(() => r())));

/** An agent, a person, and a live deployment pointed at `url`. */
async function fixture(db: Db, url: string | null, opts: { serveToken?: string | null } = {}): Promise<{
  ctx: TenantContext;
  agentId: string;
  deploymentId: string;
  work: WorkStore;
  dispatcher: WorkDispatcher;
  serveTokens: Map<string, string>;
}> {
  const identity = new IdentityRepository(db);
  const agents = new AgentRepository(db);
  const deploys = new DeployStore(db);
  const work = new WorkStore(db);
  const suffix = randomUUID().slice(0, 8);

  const person = await identity.provisionUser(systemContext(newRequestId()), {
    externalId: `dispatch-${suffix}`,
    email: `dispatch-${suffix}@example.com`,
  });
  const ctx: TenantContext = { ...testContext(), actorUserId: person.user.id };
  const agent = await agents.upsertFromDisk(ctx, { slug: `dispatch_${suffix}`, display_name: "dispatch agent" });
  const deployment = await deploys.create(ctx, {
    agentId: agent.id, provider: "anthropic", model: "claude-haiku-4-5", envKeys: [],
  });
  const serviceId = `svc_${suffix}`;
  await deploys.patch(ctx, deployment.id, {
    status: "live", url,
    railway_project_id: "proj", railway_service_id: serviceId, railway_environment_id: "env",
  });

  const serveTokens = new Map<string, string>();
  if (opts.serveToken !== null) serveTokens.set(serviceId, opts.serveToken ?? "stub-token");

  const dispatch = new DeployDispatcher({
    runs: deployRuns,
    endpoint: async (deploymentId) => {
      const row = await deploys.get(ctx, deploymentId);
      if (!row?.url) return null;
      return { url: row.url, serveToken: serveTokens.get(row.railway_service_id ?? "") ?? null };
    },
    timeoutMs: 4_000,
  });

  const dispatcher = new WorkDispatcher({
    work,
    deployments: deploys,
    dispatch,
    serveToken: async (_c, id) => serveTokens.get(id) ?? null,
    controlPlaneUrl: () => controlPlaneUrl,
  });

  return { ctx, agentId: agent.id, deploymentId: deployment.id, work, dispatcher, serveTokens };
}

/** A server that answers one status to every request. For the branches a stub agent never takes. */
async function answering(status: number, body = ""): Promise<{ url: string; close: () => Promise<void> }> {
  const server: Server = createServer((_req, res) => {
    res.writeHead(status, { "content-type": "text/plain" });
    res.end(body);
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return { url, close: () => new Promise<void>((r) => server.close(() => r())) };
}

// --- 1. the cap and its default ------------------------------------------------------------------

console.log("\nthe concurrency cap");
{
  check("it defaults to four, matching the container's own", workConcurrencyFromEnv({}) === DEFAULT_WORK_CONCURRENCY);
  check("an explicit value is honoured", workConcurrencyFromEnv({ JAROKU_WORK_CONCURRENCY: "9" }) === 9);
  // Every one of these would otherwise be a cap of zero or a negative one, which is a workspace
  // that can never dispatch — a refusal nobody can act on, from a typo in an environment file.
  for (const bad of ["0", "-1", "four", "", "2.5"]) {
    check(`${JSON.stringify(bad)} falls back to the default`, workConcurrencyFromEnv({ JAROKU_WORK_CONCURRENCY: bad }) === DEFAULT_WORK_CONCURRENCY);
  }
}

// --- 2. the address check ------------------------------------------------------------------------

console.log("\nwhere a job may be sent");
{
  const refuses = async (url: string): Promise<boolean> => {
    try {
      await checkEndpointAddress(url, async () => ({ v4: [], v6: [] }));
      return false;
    } catch {
      return true;
    }
  };
  check("loopback is allowed, because `npm run mock:serve` is the local path", !(await refuses("http://127.0.0.1:8932")));
  check("...and so is ::1", !(await refuses("http://[::1]:8932")));
  // The one that makes this check worth having rather than arguing about.
  check("the cloud metadata endpoint is refused", await refuses("http://169.254.169.254/latest/meta-data/"));
  check("an RFC1918 neighbour is refused", await refuses("http://10.0.0.5:8080"));
  check("...and so is a 172.16 one", await refuses("http://172.16.4.4"));
  // A HOSTNAME THAT RESOLVES SOMEWHERE PRIVATE, which is the shape a literal check misses entirely.
  let resolvedPrivate = false;
  try {
    await checkEndpointAddress("https://agent.example.com", async () => ({ v4: ["10.1.2.3"], v6: [] }));
  } catch {
    resolvedPrivate = true;
  }
  check("a public-looking hostname that resolves privately is refused", resolvedPrivate);
  check("...while one that resolves publicly is not", await (async () => {
    await checkEndpointAddress("https://agent.example.com", async () => ({ v4: ["93.184.216.34"], v6: [] }));
    return true;
  })());
}

// --- 3. refused before a row exists --------------------------------------------------------------

console.log("\nrefused, with nothing written");
{
  const db = await openTestSqlite();

  // NO LIVE DEPLOYMENT. §6.1 asks for this to refuse before the row is written and to name the
  // Deploy panel, and the second assertion is the load-bearing one: a row here would put a job on
  // the board that was never sent anywhere, for an agent that cannot run it.
  {
    const identity = new IdentityRepository(db);
    const agents = new AgentRepository(db);
    const work = new WorkStore(db);
    const suffix = randomUUID().slice(0, 8);
    const person = await identity.provisionUser(systemContext(newRequestId()), {
      externalId: `nodeploy-${suffix}`, email: `nodeploy-${suffix}@example.com`,
    });
    const ctx: TenantContext = { ...testContext(), actorUserId: person.user.id };
    const agent = await agents.upsertFromDisk(ctx, { slug: `nodeploy_${suffix}` });
    const dispatcher = new WorkDispatcher({
      work,
      deployments: new DeployStore(db),
      dispatch: new DeployDispatcher({ runs: deployRuns, endpoint: async () => null }),
      serveToken: async () => null,
      controlPlaneUrl: () => controlPlaneUrl,
    });
    const out = await dispatcher.dispatch(ctx, { agentId: agent.id, input: "refund order 4471" });
    check("an agent with no live deployment is refused", out.ok === false && out.stage === "refused");
    check("...as no_deployment", !out.ok && out.stage === "refused" && out.refusal === "no_deployment");
    check("...naming the Deploy panel, because that is the fix",
      !out.ok && /Deploy panel/i.test(out.detail), !out.ok ? out.detail : "");
    check("...and NOTHING was written", (await work.list(ctx, { scope: "all" })).items.length === 0);
  }

  // OVER THE INPUT CAP. Refused at the composer, not at the container — and again, no row.
  {
    const f = await fixture(db, "http://127.0.0.1:1");
    const out = await f.dispatcher.dispatch(f.ctx, {
      agentId: f.agentId, input: "x".repeat(MAX_WORK_INPUT_BYTES + 1),
    });
    check("an oversized input is refused", !out.ok && out.stage === "refused" && out.refusal === "input_too_large");
    check("...before the container was ever called", (await f.work.list(f.ctx, { scope: "all" })).items.length === 0);
  }

  // AN ADDRESS THIS SERVER MAY NOT CALL.
  {
    const f = await fixture(db, "http://169.254.169.254");
    const out = await f.dispatcher.dispatch(f.ctx, { agentId: f.agentId, input: "hello" });
    check("a deployment pointed at the metadata endpoint is refused", !out.ok && out.stage === "refused" && out.refusal === "egress");
    check("...with no row and no token sent anywhere", (await f.work.list(f.ctx, { scope: "all" })).items.length === 0);
  }

  await db.close();
}

// --- 4. accepted ---------------------------------------------------------------------------------

console.log("\n202, and the row that follows it");
{
  const db = await openTestSqlite();
  let stub: MockServeHandle | null = null;
  try {
    stub = await startMockServe({ token: "stub-token", behaviour: "complete", agentId: "a_deployed_agent" });
    const f = await fixture(db, stub.url);

    const out = await f.dispatcher.dispatch(f.ctx, { agentId: f.agentId, input: "refund order 4471" });
    check("a live agent accepts the job", out.ok === true, out.ok ? "" : `${out.stage}: ${out.detail}`);
    if (!out.ok) throw new Error(out.detail);

    check("the item is running", out.item.status === "running", out.item.status);
    check("...with a started_at the container's own acceptance stamped", out.item.started_at !== null);
    check("...attributed to the person who dispatched it", out.item.created_by === f.ctx.actorUserId);
    check("...against the deployment that actually ran it", out.item.deployment_id === f.deploymentId);
    check("...and joined to a run before anything left the process", typeof out.item.run_id === "string");
    check("no failure kind on a job that has not failed", out.item.failure_kind === null && out.item.ended_at === null);

    // THE JOIN IS THE POINT OF THE COLUMN. A trace event carries a run id and nothing else, so the
    // lifecycle's only way back to the item is this read — and it is what makes the Cockpit's cost,
    // duration and trace link the same numbers the rest of the product shows.
    const byRun = await f.work.byRun(f.ctx, out.item.run_id!);
    check("the item is findable by its run id", byRun?.id === out.item.id);

    // AND THE RUN IS REGISTERED ON THE BUS, which is what makes a deployed run an ordinary traced
    // run rather than a row nobody can watch. Registered BEFORE the request left, so a container
    // fast enough to push its run_start while the 202 was still in flight is not a dropped event.
    check("the run is registered on the control plane's bus", deployRuns.has(out.item.run_id!));

    await stub.settled(out.item.run_id!);
  } finally {
    await stub?.close();
    await db.close();
  }
}

// --- 5. failed, with the row kept ----------------------------------------------------------------

console.log("\nfailed, with the row kept as evidence");
{
  const db = await openTestSqlite();

  // NO STORED CREDENTIAL. Every agent deployed before Part 1 is in this state, and it is the one
  // failure with a button attached — so the assertion that matters is the KIND, because that is
  // what decides whether the card offers Reconnect.
  {
    const f = await fixture(db, "http://127.0.0.1:1", { serveToken: null });
    const out = await f.dispatcher.dispatch(f.ctx, { agentId: f.agentId, input: "hello" });
    check("a deployment Jaroku has no token for fails", !out.ok && out.stage === "failed");
    check("...as unauthorised, which is what puts Reconnect on the card",
      !out.ok && out.stage === "failed" && out.failureKind === "unauthorised");
    check("...saying so in words a person can act on", !out.ok && /reconnect/i.test(out.detail), !out.ok ? out.detail : "");
    // THE ROW SURVIVES. It is the operator's evidence that they asked for something and it did not
    // happen — and unlike a refusal, this one got as far as writing one.
    const rows = await f.work.list(f.ctx, { scope: "all" });
    check("...and the row is kept", rows.items.length === 1 && rows.items[0]!.status === "failed");
    check("...carrying the kind, so the card can offer the fix", rows.items[0]!.failure_kind === "unauthorised");
    check("...and an ended_at, so nothing counts it as in flight", rows.items[0]!.ended_at !== null);
    check("...leaving nothing against the concurrency cap", (await f.work.inFlight(f.ctx)) === 0);
  }

  // THE CONTAINER IS NOT THERE. Port 1 on loopback answers nothing.
  {
    const f = await fixture(db, "http://127.0.0.1:1");
    const out = await f.dispatcher.dispatch(f.ctx, { agentId: f.agentId, input: "hello" });
    check("a deployment that cannot be reached fails as unreachable",
      !out.ok && out.stage === "failed" && out.failureKind === "unreachable");
  }

  await db.close();
}

// --- 6. at capacity ------------------------------------------------------------------------------

console.log("\nthe cap, on a workspace that is already busy");
{
  const db = await openTestSqlite();
  let stub: MockServeHandle | null = null;
  try {
    // A container that never finishes, so the items stay in flight while the cap is tested.
    stub = await startMockServe({ token: "stub-token", behaviour: "died", agentId: "a_deployed_agent" });
    const f = await fixture(db, stub.url);

    for (let i = 0; i < 2; i++) {
      const out = await f.dispatcher.dispatch(f.ctx, { agentId: f.agentId, input: `job ${i}` });
      check(`job ${i + 1} of two is accepted under a cap of two`, out.ok === true, out.ok ? "" : out.detail);
    }
    // The cap is read per dispatch rather than captured, so a deployment that raises it takes
    // effect without a restart — the same posture `DeployManagerDeps.token` takes.
    const capped = new WorkDispatcher({
      work: f.work,
      deployments: new DeployStore(db),
      dispatch: new DeployDispatcher({ runs: deployRuns, endpoint: async () => ({ url: stub!.url, serveToken: "stub-token" }) }),
      serveToken: async () => "stub-token",
      controlPlaneUrl: () => controlPlaneUrl,
      concurrency: () => 2,
    });
    const refused = await capped.dispatch(f.ctx, { agentId: f.agentId, input: "one too many" });
    check("the third is refused", !refused.ok && refused.stage === "refused" && refused.refusal === "at_capacity");
    check("...naming the figure and the variable, so it can be acted on",
      !refused.ok && /2 jobs in flight/.test(refused.detail) && /JAROKU_WORK_CONCURRENCY/.test(refused.detail),
      !refused.ok ? refused.detail : "");
    check("...and writing no row", (await f.work.list(f.ctx, { scope: "all" })).items.length === 2);

    // A REFUSAL AT THE CAP IS NOT A 429 FROM THE CONTAINER, which is the whole reason the cap
    // exists: Jaroku must not manufacture the refusals it then retries. Nothing was sent.
    for (const item of (await f.work.list(f.ctx, { scope: "all" })).items) {
      await f.work.finish(f.ctx, item.id, { status: "cancelled" });
    }
    const afterRoom = await capped.dispatch(f.ctx, { agentId: f.agentId, input: "room again" });
    check("...and once there is room the same request is accepted", afterRoom.ok === true);
  } finally {
    await stub?.close();
    await db.close();
  }
}

// --- 7. what a non-202 means ---------------------------------------------------------------------
//
// One case here rather than all six: the rest of the mapping, and the retry policy that decides
// which of them is worth trying again, are `test:work-retry`'s.

console.log("\na container that refuses");
{
  const db = await openTestSqlite();
  const refuser = await answering(400, "input must be a string");
  try {
    const f = await fixture(db, refuser.url);
    const out = await f.dispatcher.dispatch(f.ctx, { agentId: f.agentId, input: "hello" });
    // A 4xx IS JAROKU'S BUG AND IS WORDED THAT WAY. §4's table says so in as many words, which is
    // why this is `rejected` rather than `agent_error`: telling somebody their agent crashed when
    // Jaroku sent it something malformed points them at the wrong product.
    check("a 400 fails the job as rejected", !out.ok && out.stage === "failed" && out.failureKind === "rejected");
    check("...carrying what the container actually said", !out.ok && /input must be a string/.test(out.detail));
  } finally {
    await refuser.close();
    await db.close();
  }
}

for (const close of closers) await close();
console.log(fail === 0 ? "\nALL CORRECT" : `\n${fail} FAILURES`);
process.exitCode = fail === 0 ? 0 : 1;
