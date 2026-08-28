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
import { WorkActions } from "./actions.ts";
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
  slug: string;
  deploymentId: string;
  work: WorkStore;
  dispatcher: WorkDispatcher;
  serveTokens: Map<string, string>;
  endpointScopes: string[];
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
  const slug = `dispatch_${suffix}`;
  const agent = await agents.upsertFromDisk(ctx, { slug, display_name: "dispatch agent" });
  // THE DEPLOYMENT NAMES THE AGENT BY SLUG, which is what `DeployManager` writes: that column is
  // `text` from migration 002 and predates agent uuids. A fixture that used the uuid here would
  // AGREE WITH a dispatcher that compared uuids, and both would be wrong together — in production
  // every dispatch would refuse with "this agent is not live", which reads as a deployment problem
  // rather than a lookup one. That is exactly how this was missed the first time.
  const deployment = await deploys.create(ctx, {
    agentId: slug, provider: "anthropic", model: "claude-haiku-4-5", envKeys: [],
  });
  const serviceId = `svc_${suffix}`;
  await deploys.patch(ctx, deployment.id, {
    status: "live", url,
    railway_project_id: "proj", railway_service_id: serviceId, railway_environment_id: "env",
  });

  const serveTokens = new Map<string, string>();
  if (opts.serveToken !== null) serveTokens.set(serviceId, opts.serveToken ?? "stub-token");

  // WHAT SCOPE THE ENDPOINT WAS ASKED FOR, recorded so the assertion below can be about it. A
  // deployment's row is read under a scope, and the only honest source of that scope is the
  // request doing the dispatching — see `DeployDispatchDeps.endpoint`.
  const endpointScopes: string[] = [];
  const dispatch = new DeployDispatcher({
    runs: deployRuns,
    endpoint: async (deploymentId, workspaceId) => {
      endpointScopes.push(workspaceId);
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
    agentSlug: async (_c, uuid) => (uuid === agent.id ? slug : null),
    serveToken: async (_c, id) => serveTokens.get(id) ?? null,
    controlPlaneUrl: () => controlPlaneUrl,
  });

  return { ctx, agentId: agent.id, slug, deploymentId: deployment.id, work, dispatcher, serveTokens, endpointScopes };
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
      // THE SLUG RESOLVES AND THE DEPLOYMENT DOES NOT, which is the case worth testing: an agent
      // this workspace has, with nothing live behind it. A resolver answering null would refuse
      // for the wrong reason and the assertion below would pass anyway.
      agentSlug: async () => `nodeploy_${suffix}`,
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

    // THE TWO SPELLINGS OF "WHICH AGENT", ASSERTED APART. This is the check that would have caught
    // the confusion rather than leaving it to be found by opening the tab: a work item names its
    // agent by UUID because its column is a real foreign key, and the deployment it ran on names
    // the same agent by SLUG because that column is `text` from migration 002. They are different
    // strings for one agent, and code that compared them found nothing and refused every dispatch
    // with a sentence about deployments.
    check("the item names its agent by uuid", out.item.agent_id === f.agentId && f.agentId !== f.slug);
    const ran = await new DeployStore(db).get(f.ctx, out.item.deployment_id);
    check("...while the deployment it ran on names the same agent by slug", ran?.agent_id === f.slug);

    // THE JOIN IS THE POINT OF THE COLUMN. A trace event carries a run id and nothing else, so the
    // lifecycle's only way back to the item is this read — and it is what makes the Cockpit's cost,
    // duration and trace link the same numbers the rest of the product shows.
    const byRun = await f.work.byRun(f.ctx, out.item.run_id!);
    check("the item is findable by its run id", byRun?.id === out.item.id);

    // AND THE RUN IS REGISTERED ON THE BUS, which is what makes a deployed run an ordinary traced
    // run rather than a row nobody can watch. Registered BEFORE the request left, so a container
    // fast enough to push its run_start while the 202 was still in flight is not a dropped event.
    check("the run is registered on the control plane's bus", deployRuns.has(out.item.run_id!));

    // AND THE ENDPOINT WAS READ IN THE DISPATCHING WORKSPACE. This is the second assertion that
    // would have caught a bug found by opening the tab rather than by running the suite: the
    // deployment row is read under a SCOPE, and resolving that scope from the server's own
    // context — which is right for the deploy manager, whose work happens in one workspace —
    // returns nothing for a socket dispatching in another. The job was accepted, the row was
    // written, and it then failed with "this agent has no live deployment to run on": a sentence
    // about a deployment that was live, said by a read looking in the wrong place.
    check("the endpoint was resolved in the workspace that dispatched",
      f.endpointScopes.length > 0 && f.endpointScopes.every((w) => w === f.ctx.workspaceId),
      f.endpointScopes.join(", "));

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
    // THE RETURNED ITEM IS THE ONE BROADCAST, so it has to read what the row reads. It used to be
    // the snapshot taken at insert, which meant the delta announcing a failure said `queued` — and
    // every open Cockpit in the workspace kept the job on screen as in flight, under a Cancel
    // button, until somebody reloaded. Asserting the stored row alone never saw this.
    check("...and the item the caller broadcasts says so too",
      !out.ok && out.stage === "failed" && out.item.status === "failed", !out.ok && out.stage === "failed" ? out.item.status : "");
    check("...with the kind and the ending on it",
      !out.ok && out.stage === "failed" && out.item.failure_kind === "unauthorised" && out.item.ended_at !== null);
  }

  // THE CONTAINER IS NOT THERE. Port 1 on loopback answers nothing.
  {
    const f = await fixture(db, "http://127.0.0.1:1");
    const out = await f.dispatcher.dispatch(f.ctx, { agentId: f.agentId, input: "hello" });
    check("a deployment that cannot be reached fails as unreachable",
      !out.ok && out.stage === "failed" && out.failureKind === "unreachable");
    check("...and the item the caller broadcasts has ended, not queued",
      !out.ok && out.stage === "failed" && out.item.status === "failed" && out.item.ended_at !== null,
      !out.ok && out.stage === "failed" ? out.item.status : "");
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
      agentSlug: async () => f.slug,
      serveToken: async () => "stub-token",
      controlPlaneUrl: () => controlPlaneUrl,
      concurrency: () => 2,
    });
    const refused = await capped.dispatch(f.ctx, { agentId: f.agentId, input: "one too many" });
    check("the third is refused", !refused.ok && refused.stage === "refused" && refused.refusal === "at_capacity");
    check("...naming the figure and the variable, so it can be acted on",
      !refused.ok && /2 jobs in flight/.test(refused.detail) && /JAROKU_WORK_CONCURRENCY/.test(refused.detail),
      !refused.ok ? refused.detail : "");
    check("...and the limit as its own number, not the count over again",
      !refused.ok && /the limit is 2/.test(refused.detail), !refused.ok ? refused.detail : "");
    {
      // THE TWO NUMBERS PARTED COMPANY, which is the case the assertion above cannot see because a
      // cap of two with two in flight prints "2" either way. A cap lowered under a busy workspace
      // is the ordinary way here — as is a job parked in `waiting` on somebody who never answers.
      const lowered = new WorkDispatcher({
        work: f.work,
        deployments: new DeployStore(db),
        dispatch: new DeployDispatcher({ runs: deployRuns, endpoint: async () => ({ url: stub!.url, serveToken: "stub-token" }) }),
        agentSlug: async () => f.slug,
        serveToken: async () => "stub-token",
        controlPlaneUrl: () => controlPlaneUrl,
        concurrency: () => 1,
      });
      const over = await lowered.dispatch(f.ctx, { agentId: f.agentId, input: "over a lowered cap" });
      check("a cap lowered under a busy workspace reports the count and the cap apart",
        !over.ok && /2 jobs in flight/.test(over.detail) && /the limit is 1/.test(over.detail),
        !over.ok ? over.detail : "");
    }
    check("...and writing no row", (await f.work.list(f.ctx, { scope: "all" })).items.length === 2);

    {
      // TEN AT ONCE, WHICH IS THE ONLY WAY TO SEE THIS. Every case above dispatches in turn, so
      // each one's insert has landed before the next one counts — and a cap read before the write
      // then looks correct. Sent together they all read the same figure, all find room, and all
      // write: a cap of four admitted ten against the live server before the count moved inside
      // the insert's own transaction. §6 sets the cap so Jaroku does not manufacture the 429s it
      // then retries, and a cap that only holds when nobody is in a hurry does not do that.
      const f2 = await fixture(db, stub.url);
      const burst = new WorkDispatcher({
        work: f2.work,
        deployments: new DeployStore(db),
        dispatch: new DeployDispatcher({ runs: deployRuns, endpoint: async () => ({ url: stub!.url, serveToken: "stub-token" }) }),
        agentSlug: async () => f2.slug,
        serveToken: async () => "stub-token",
        controlPlaneUrl: () => controlPlaneUrl,
        concurrency: () => 4,
      });
      const settled = await Promise.all(
        Array.from({ length: 10 }, (_, i) => burst.dispatch(f2.ctx, { agentId: f2.agentId, input: `together ${i}` })),
      );
      const accepted = settled.filter((r) => r.ok).length;
      const atCapacity = settled.filter((r) => !r.ok && r.stage === "refused" && r.refusal === "at_capacity").length;
      const written = (await f2.work.list(f2.ctx, { scope: "all" })).items.length;
      check(`ten simultaneous dispatches do not beat a cap of four (${accepted} accepted)`, accepted <= 4, String(accepted));
      check(`...and the rest are refused by name (${atCapacity})`, accepted + atCapacity === 10, `${accepted}+${atCapacity}`);
      check(`...leaving no more rows than the cap allows (${written})`, written <= 4, String(written));
    }

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

// --- 7. every failure kind, against a container that answers it ----------------------------------
//
// §4's table has six kinds and each one puts a different sentence and a different control on the
// card. `stopped_reporting` is the one that is not reachable from here — it is what Part 1's
// reconciliation writes for a container that went quiet AFTER accepting, which is
// `test:deploy-reconcile`'s and `test:work-lifecycle`'s ground rather than the dispatcher's.

console.log("\nevery kind a dispatch can fail with");
{
  const db = await openTestSqlite();
  const cases: { status: number; body: string; kind: string; why: string }[] = [
    // A 4xx IS JAROKU'S BUG AND IS WORDED THAT WAY. §4's table says so in as many words, which is
    // why this is `rejected` rather than `agent_error`: telling somebody their agent crashed when
    // Jaroku sent it something malformed points them at the wrong product.
    { status: 400, body: "input must be a string", kind: "rejected", why: "a 400 is Jaroku sending something the agent refused" },
    { status: 413, body: "body too large", kind: "rejected", why: "...and so is a 413" },
    { status: 401, body: "", kind: "unauthorised", why: "a 401 is the stored token being wrong" },
    { status: 403, body: "", kind: "unauthorised", why: "...and a 403 is the same fact and the same button" },
    // AND A 5xx IS THEIRS. The trace has the failing step, and pointing at Jaroku here would send
    // somebody to read this repository's source about a crash inside code a model wrote for them.
    { status: 500, body: "Traceback (most recent call last)", kind: "agent_error", why: "a 500 is the agent's own crash" },
    { status: 503, body: "starting up", kind: "agent_error", why: "...and so is a 503" },
  ];
  for (const c of cases) {
    const server = await answering(c.status, c.body);
    try {
      const f = await fixture(db, server.url, { serveToken: "stub-token" });
      const out = await f.dispatcher.dispatch(f.ctx, {
        agentId: f.agentId, input: "hello",
        // The budget is spent instantly so a retryable status does not hold the suite open; the
        // non-retryable ones never reach it.
      });
      check(c.why, !out.ok && out.stage === "failed" && out.failureKind === c.kind,
        out.ok ? "accepted" : `${out.stage}: ${out.detail}`);
      if (c.body) {
        check(`...carrying what the container actually said (${c.status})`, !out.ok && out.detail.includes(c.body.slice(0, 20)));
      }
    } finally {
      await server.close();
    }
  }
  await db.close();
}

// --- 8. the retry policy -------------------------------------------------------------------------
//
// §6's Bounds in one sentence: "bounded, discriminating retry on 429 and connection transients
// only, honouring Retry-After — a 401 or 400 fails identically every time and retrying multiplies
// nothing but the bill". Every assertion here is about one of those four words.

console.log("\nwhat is worth trying again");
{
  const db = await openTestSqlite();

  /** A server that answers `first` for the first `n` requests and then `then`. Counts requests. */
  const flaky = async (n: number, first: number, then: number, headers: Record<string, string> = {}) => {
    let seen = 0;
    const server: Server = createServer((_req, res) => {
      seen++;
      const status = seen <= n ? first : then;
      if (status === 202) {
        res.writeHead(202, { "content-type": "application/json" });
        res.end(JSON.stringify({ accepted_at: new Date().toISOString() }));
        return;
      }
      res.writeHead(status, { "content-type": "text/plain", ...(seen <= n ? headers : {}) });
      res.end("busy");
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    return {
      url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
      requests: () => seen,
      close: () => new Promise<void>((r) => server.close(() => r())),
    };
  };

  /** A dispatcher whose clock and sleep are fake together, so the budget is real and costs nothing. */
  const withFakeClock = (f: Awaited<ReturnType<typeof fixture>>, url: string) => {
    let clock = Date.now();
    const waits: number[] = [];
    const deploys = new DeployStore(db);
    return {
      waits,
      dispatcher: new WorkDispatcher({
        work: f.work,
        deployments: deploys,
        dispatch: new DeployDispatcher({
          runs: deployRuns,
          endpoint: async () => ({ url, serveToken: "stub-token" }),
          timeoutMs: 3_000,
        }),
        agentSlug: async () => f.slug,
        serveToken: async () => "stub-token",
        controlPlaneUrl: () => controlPlaneUrl,
        now: () => clock,
        sleep: async (ms) => { waits.push(ms); clock += ms; },
      }),
    };
  };

  // A 429 THAT CLEARS. One retry, and the job runs — which is the whole reason retrying at all is
  // worth the complexity: a container at its own concurrency limit is a container that will have
  // room in a moment.
  {
    const server = await flaky(1, 429, 202);
    try {
      const f = await fixture(db, server.url);
      const { dispatcher, waits } = withFakeClock(f, server.url);
      const out = await dispatcher.dispatch(f.ctx, { agentId: f.agentId, input: "hello" });
      check("a 429 that clears is retried and accepted", out.ok === true, out.ok ? "" : out.detail);
      check("...after exactly one more request", server.requests() === 2, String(server.requests()));
      check("...having waited the backoff", waits.length === 1 && waits[0] === 1_000, waits.join(","));
    } finally {
      await server.close();
    }
  }

  // AND A 429 THAT DOES NOT. Bounded: three attempts including the first, and then the container's
  // own last word rather than a fourth request.
  {
    const server = await flaky(99, 429, 429);
    try {
      const f = await fixture(db, server.url);
      const { dispatcher, waits } = withFakeClock(f, server.url);
      const out = await dispatcher.dispatch(f.ctx, { agentId: f.agentId, input: "hello" });
      check("a container that stays busy fails as busy", !out.ok && out.stage === "failed" && out.failureKind === "busy");
      check("...after three attempts and no more", server.requests() === 3, String(server.requests()));
      check("...backing off between them", waits.join(",") === "1000,2000", waits.join(","));
    } finally {
      await server.close();
    }
  }

  // `Retry-After` IN SECONDS WINS OVER THE BACKOFF. The container is the thing that knows how long
  // its own slots are held; ignoring it is how one overloaded container becomes a retry storm.
  {
    const server = await flaky(1, 429, 202, { "retry-after": "5" });
    try {
      const f = await fixture(db, server.url);
      const { dispatcher, waits } = withFakeClock(f, server.url);
      const out = await dispatcher.dispatch(f.ctx, { agentId: f.agentId, input: "hello" });
      check("Retry-After is honoured over the backoff", out.ok === true && waits[0] === 5_000, waits.join(","));
    } finally {
      await server.close();
    }
  }

  // AND A `Retry-After` LONGER THAN THE BUDGET ENDS IT RATHER THAN BEING TRUNCATED. Coming back
  // early is exactly what the header exists to stop, and waiting the remainder before giving up
  // spends the budget to learn nothing.
  {
    const server = await flaky(99, 429, 429, { "retry-after": "600" });
    try {
      const f = await fixture(db, server.url);
      const { dispatcher, waits } = withFakeClock(f, server.url);
      const out = await dispatcher.dispatch(f.ctx, { agentId: f.agentId, input: "hello" });
      check("a Retry-After past the budget stops rather than being truncated",
        !out.ok && out.stage === "failed" && out.failureKind === "busy" && waits.length === 0 && server.requests() === 1,
        `${waits.length} waits, ${server.requests()} requests`);
    } finally {
      await server.close();
    }
  }

  // THE FOUR THAT ARE NEVER RETRIED, and this is the assertion §6 is actually about: "a 401 or 400
  // fails identically every time and retrying multiplies nothing but the bill". The request count
  // is the whole check — a second 401 costs nothing but a second 500 is a graph crashing twice on
  // somebody's provider key.
  for (const status of [400, 401, 403, 500]) {
    const server = await flaky(99, status, status);
    try {
      const f = await fixture(db, server.url);
      const { dispatcher } = withFakeClock(f, server.url);
      const out = await dispatcher.dispatch(f.ctx, { agentId: f.agentId, input: "hello" });
      check(`a ${status} is asked exactly once`, !out.ok && server.requests() === 1, String(server.requests()));
    } finally {
      await server.close();
    }
  }

  // A RETRY USES A FRESH RUN ID, and this is the subtlest thing in the file. Part 1's client closes
  // the run on every answer that is not a 202, and closing REVOKES the token — against a denylist
  // keyed by RUN ID. Reusing the id would get its 202, mark the item running, and then have every
  // push the container made refused for the life of the run: a job that reads as executing and
  // produces no trace, no cost and no ending. It would only ever happen under load, which is the
  // only condition a 429 arrives in.
  {
    const server = await flaky(1, 429, 202);
    try {
      const f = await fixture(db, server.url);
      const before = (await f.work.list(f.ctx, { scope: "all" })).items.length;
      const { dispatcher } = withFakeClock(f, server.url);
      const out = await dispatcher.dispatch(f.ctx, { agentId: f.agentId, input: "hello" });
      check("the retried job is running", out.ok === true);
      if (out.ok) {
        check("...on a run id the first attempt did not revoke", !revocations.isRevoked(out.item.run_id!));
        check("...which is still registered on the bus", deployRuns.has(out.item.run_id!));
        // ONE ROW, NOT TWO. A retry is the same job asked again, not a second job — the operator
        // pressed dispatch once.
        check("...and it is still one job", (await f.work.list(f.ctx, { scope: "all" })).items.length === before + 1);
      }
    } finally {
      await server.close();
    }
  }

  await db.close();
}

// --- 9. cancel and retry -------------------------------------------------------------------------
//
// BOTH SIT ON PART 1'S CONTROL ACTIONS and neither is a new mechanism, so what is asserted here is
// only the part that is the Cockpit's: which items each verb may act on, and what "again" means.

console.log("\nstopping one, and asking again");
{
  const db = await openTestSqlite();
  const accepting = await answering(202, JSON.stringify({ accepted_at: new Date().toISOString() }));
  try {
    const f = await fixture(db, accepting.url);
    const actions = new WorkActions({
      work: f.work,
      dispatcher: f.dispatcher,
      dispatch: new DeployDispatcher({
        runs: deployRuns,
        endpoint: async () => ({ url: accepting.url, serveToken: "stub-token" }),
      }),
    });

    // A CANCEL IS A REQUEST, NOT AN OUTCOME — the whole design of it. The run stops at its next
    // node boundary and emits its own run_end, and THAT is what closes the item. Writing
    // `cancelled` the moment the button is pressed would be a control claiming something it cannot
    // deliver: the graph is still executing and still spending.
    const running = await f.dispatcher.dispatch(f.ctx, { agentId: f.agentId, input: "stop this one" });
    check("a job is running before it is cancelled", running.ok === true);
    if (running.ok) {
      const asked = await actions.cancel(f.ctx, running.item.id);
      check("cancelling a running job is accepted", asked.ok === true && asked.kind === "requested");
      check("...and reported as a request rather than as a stop",
        asked.ok && /asked to stop/.test(asked.detail), asked.ok ? asked.detail : "");
      check("...leaving the job running until the container says otherwise",
        (await f.work.get(f.ctx, running.item.id))?.status === "running");

      // A RETRY OF SOMETHING STILL RUNNING is refused: two containers on the same work, both
      // spending, with no way afterwards to tell which answer was which.
      const tooSoon = await actions.retry(f.ctx, running.item.id);
      check("a job that is still running cannot be retried", !tooSoon.ok && /still running/.test(tooSoon.detail));
    }

    // A QUEUED JOB IS CLOSED HERE, without asking anybody — there is nothing at the other end to
    // receive a request, so this is the one path that writes `cancelled` directly and it is honest.
    {
      const queued = await f.work.create(f.ctx, {
        agentId: f.agentId, deploymentId: f.deploymentId, runId: randomUUID(), input: "never left",
      });
      const closed = await actions.cancel(f.ctx, queued.id);
      check("a queued job is closed rather than asked about", closed.ok === true && closed.kind === "closed");
      check("...as cancelled", (await f.work.get(f.ctx, queued.id))?.status === "cancelled");
      check("...and cancelling it twice is refused rather than silent",
        !(await actions.cancel(f.ctx, queued.id)).ok);
    }

    // A RETRY IS A NEW ROW. §12 needs `work_items.id` to stay stable and citable, because Part 3's
    // answers cite it and the citation is clickable — so a retry that rewrote the row would move a
    // job somebody had already been told about, and the failure it is a retry OF would stop
    // existing.
    {
      const original = await f.work.create(f.ctx, {
        agentId: f.agentId, deploymentId: f.deploymentId, runId: randomUUID(), input: "refund order 4471",
      });
      await f.work.finish(f.ctx, original.id, {
        status: "failed", error: "the deployment refused Jaroku's credential", failureKind: "unauthorised",
      });
      const again = await actions.retry(f.ctx, original.id);
      check("a failed job can be asked again", again.ok === true, again.ok ? "" : again.detail);
      if (again.ok) {
        check("...as a NEW job", again.item.id !== original.id);
        check("...carrying the same input, copied from the row rather than re-supplied",
          again.item.input === "refund order 4471");
        check("...attributed to whoever pressed retry", again.item.created_by === f.ctx.actorUserId);
        const before = await f.work.get(f.ctx, original.id);
        check("...and the original is untouched, failure kind and all",
          before?.status === "failed" && before?.failure_kind === "unauthorised");
      }
    }

    check("cancelling a job that does not exist is refused by name",
      !(await actions.cancel(f.ctx, randomUUID())).ok);
  } finally {
    await accepting.close();
    await db.close();
  }
}

for (const close of closers) await close();
console.log(fail === 0 ? "\nALL CORRECT" : `\n${fail} FAILURES`);
process.exitCode = fail === 0 ? 0 : 1;
