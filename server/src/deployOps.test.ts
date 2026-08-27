// Health, runtime logs, kill and reconnect — the four server-side commands §10 and §8 ask for.
//
//   npm run test:deploy-ops
//
// Every one of them has a failure that looks like success, and those are what the assertions are
// about:
//
//   HEALTH that asks RAILWAY rather than the agent reports a crash-looping container as fine.
//   LOGS paged by offset walk backwards through a moving window — the bug the changelog already
//     records for build logs and §10 says not to reintroduce.
//   KILL that reports what it ASKED FOR rather than what happened tells somebody they stopped
//     paying for something they are still paying for.
//   RECONNECT that does not say it restarts the service is how a control plane loses trust in
//     one click.

import { randomUUID } from "node:crypto";
import { readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { DeployOps, HEALTH_CACHE_MS } from "./deployOps.ts";
import { DeployStore } from "./deployStore.ts";
import { RailwayApi, RailwayError } from "./railwayApi.ts";
import { TraceStore } from "./store.ts";
import { openTestSqlite, testContext } from "./db/testDb.ts";

let fail = 0;
const check = (name: string, ok: boolean, detail = "") => {
  if (ok) console.log(`  ok   ${name}`);
  else { fail++; console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ""}`); }
};

const SRC = dirname(fileURLToPath(import.meta.url));
const DB = join(tmpdir(), `jaroku-deploy-ops-${randomUUID()}.db`);
const db = await openTestSqlite(DB);
const trace = new TraceStore(db);
await trace.init();
const store = new DeployStore(trace.database());
await store.init();
const ctx = testContext();

const RAILWAY_TOKEN = "rw_token_known_test_value_0123456789";

async function seed(over: Record<string, unknown> = {}) {
  const dep = await store.create(ctx, {
    agentId: "a_deployed_agent", provider: "anthropic", model: "claude-haiku-4-5", envKeys: [],
  });
  await store.patch(ctx, dep.id, {
    status: "live",
    url: "https://agent.example",
    railway_project_id: "proj-1",
    railway_environment_id: "env-1",
    railway_service_id: `svc-${randomUUID()}`,
    railway_deployment_id: "rwdep-1",
    ...over,
  });
  return (await store.get(ctx, dep.id))!;
}

/** A Railway API that records what it was asked and answers from a script. */
function fakeApi(script: {
  logs?: { timestamp: string; message: string; severity?: string | null }[];
  failDelete?: string;
  failVariables?: string;
}) {
  const calls: { op: string; args: unknown }[] = [];
  const api = {
    deploymentLogs: async (deploymentId: string, limit: number) => {
      calls.push({ op: "deploymentLogs", args: { deploymentId, limit } });
      return (script.logs ?? []).map((l) => ({ ...l, severity: l.severity ?? null }));
    },
    deleteService: async (serviceId: string) => {
      calls.push({ op: "deleteService", args: { serviceId } });
      if (script.failDelete) throw new RailwayError("api", script.failDelete, "deleteService");
    },
    upsertVariables: async (target: unknown, values: Record<string, string>) => {
      calls.push({ op: "upsertVariables", args: { target, names: Object.keys(values), values } });
      if (script.failVariables) throw new RailwayError("api", script.failVariables, "upsertVariables");
    },
  } as unknown as RailwayApi;
  return { api, calls };
}

// --- 1. health -------------------------------------------------------------------------------

{
  const dep = await seed();
  let probes = 0;
  let answer: Response = new Response(JSON.stringify({ ok: true, agent: "a_deployed_agent" }), { status: 200 });
  let clock = Date.UTC(2026, 7, 27, 12, 0, 0);
  const ops = new DeployOps({
    store,
    token: () => RAILWAY_TOKEN,
    storeServeToken: async () => null,
    canKill: () => true,
    now: () => clock,
    fetchImpl: (async () => { probes++; return answer.clone(); }) as unknown as typeof fetch,
  });

  const first = await ops.health(ctx, dep.id);
  // ASKS THE AGENT, NOT RAILWAY. Railway reports a service as deployed while the process inside
  // it crash-loops; /health is the only thing that knows the agent came up.
  check("a healthy agent reports healthy", first.state === "healthy" && first.agentId === "a_deployed_agent",
    JSON.stringify(first));
  check("...as of right now, and it says so", first.staleMs === 0);

  clock += 5_000;
  const second = await ops.health(ctx, dep.id);
  check("a second look inside the cache window does not probe again", probes === 1, `${probes} probes`);
  // THE STALENESS IS RETURNED RATHER THAN ASSUMED, so a screen can say "as of 5s ago" instead of
  // implying it just checked. A cache that hid its own age would make every card look live.
  check("...and says how old the answer it gave is", second.staleMs === 5_000, String(second.staleMs));

  clock += HEALTH_CACHE_MS;
  await ops.health(ctx, dep.id);
  check("...and probes again once the answer is stale", probes === 2, `${probes} probes`);

  // TEN CALLERS, ONE PROBE. Ten sockets opening at once against a cold cache would otherwise make
  // ten requests to somebody's container in the same millisecond — a cache of RESULTS cannot stop
  // that, because by the time the first finishes the other nine are already in flight.
  clock += HEALTH_CACHE_MS;
  const before = probes;
  await Promise.all(Array.from({ length: 10 }, () => ops.health(ctx, dep.id)));
  check("ten callers against a cold cache make one request, not ten", probes === before + 1,
    `${probes - before} probes`);

  // AND WHAT IT MUST NOT CALL HEALTHY.
  clock += HEALTH_CACHE_MS;
  answer = new Response("upstream is down", { status: 502 });
  check("a container answering 502 is unhealthy", (await ops.health(ctx, dep.id)).state === "unhealthy");
  clock += HEALTH_CACHE_MS;
  answer = new Response("<html>a parked domain</html>", { status: 200 });
  const parked = await ops.health(ctx, dep.id);
  check("...and so is a 200 that is not a health response at all",
    parked.state === "unhealthy" && (parked.detail ?? "").includes("not a health response"),
    JSON.stringify(parked));
  clock += HEALTH_CACHE_MS;
  answer = new Response(JSON.stringify({ ok: false }), { status: 200 });
  check("...and a health response that says it is not ok",
    (await ops.health(ctx, dep.id)).state === "unhealthy");

  const noUrl = await seed({ url: null });
  check("a deployment with no URL is not called unreachable, which would blame the network",
    (await ops.health(ctx, noUrl.id)).state === "no_url");
}

// --- 2. runtime logs, followed as a sliding window ---------------------------------------------

{
  const dep = await seed();
  const { api, calls } = fakeApi({
    logs: [
      { timestamp: "2026-08-27T12:00:01.000Z", message: "[serve] example_agent on :8080" },
      { timestamp: "2026-08-27T12:00:02.000Z", message: "[serve] 127.0.0.1 POST /run 202" },
      { timestamp: "2026-08-27T12:00:03.000Z", message: `[serve] token=${RAILWAY_TOKEN} leaked by an agent` },
    ],
  });
  const ops = new DeployOps({
    store, token: () => RAILWAY_TOKEN, storeServeToken: async () => null, canKill: () => true,
    apiFor: () => api,
  });

  const first = await ops.runtimeLogs(ctx, dep.id);
  check("runtime logs come back oldest first, so they read as a log", first.lines.length === 3 &&
    first.lines[0]!.timestamp < first.lines[2]!.timestamp, JSON.stringify(first.lines.map((l) => l.timestamp)));
  // THROUGH THE SAME SCRUBBER THE BUILD LOG USES. A runtime log is somebody else's text echoed
  // back at us, from a process that has every credential the deploy handed it.
  check("...scrubbed, because a runtime log is somebody else's text",
    !JSON.stringify(first.lines).includes(RAILWAY_TOKEN) && first.lines[2]!.message.includes("••••••••"),
    first.lines[2]!.message);
  check("...with a cursor that is the newest line actually shown",
    first.cursor === "2026-08-27T12:00:03.000Z", String(first.cursor));

  // THE BUG §10 NAMES. Following the window means asking for the window again and dropping what
  // is not newer — never advancing an offset, which walks backwards through a stream that is
  // still being written.
  const second = await ops.runtimeLogs(ctx, dep.id, { since: first.cursor });
  check("following the log returns nothing when nothing new arrived", second.lines.length === 0);
  check("...and does not move the cursor to now, which would skip what had not flushed yet",
    second.cursor === first.cursor, String(second.cursor));
  check("...and asked Railway for the WINDOW again rather than for a page",
    calls.filter((c) => c.op === "deploymentLogs").length === 2 &&
      JSON.stringify(calls[0]!.args) === JSON.stringify(calls[1]!.args),
    JSON.stringify(calls.map((c) => c.args)));

  // And the same lines re-served by Railway are not shown twice.
  const third = await ops.runtimeLogs(ctx, dep.id, { since: "2026-08-27T12:00:01.500Z" });
  check("a line already shown is not shown again", third.lines.length === 2,
    JSON.stringify(third.lines.map((l) => l.timestamp)));

  // AND THE SOURCE RULE, so the next person cannot reintroduce it. An offset or a page number in
  // this file would be the changelog's bug arriving a second time.
  const source = readFileSync(resolve(SRC, "deployOps.ts"), "utf8");
  const code = source.split("\n").filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join("\n");
  check("nothing in the ops layer pages runtime logs by offset",
    !/\boffset\b|\bpage(Number|Index)\b|\bskip:/.test(code));
}

// --- 3. kill, which reports what happened -------------------------------------------------------

{
  const dep = await seed();
  const denied = new DeployOps({
    store, token: () => RAILWAY_TOKEN, storeServeToken: async () => null, canKill: () => false,
    apiFor: () => fakeApi({}).api,
  });
  const refusal = await denied.kill(ctx, dep.id);
  check("stopping an agent is capability-gated", !refusal.ok && !refusal.serviceRemoved, JSON.stringify(refusal));
  check("...and refusing does not touch the deployment",
    (await store.get(ctx, dep.id))?.status === "live");
}

{
  const dep = await seed();
  const { api, calls } = fakeApi({});
  const ops = new DeployOps({
    store, token: () => RAILWAY_TOKEN, storeServeToken: async () => null, canKill: () => true,
    apiFor: () => api,
  });
  const outcome = await ops.kill(ctx, dep.id);
  check("a permitted kill deletes the Railway service", outcome.ok && outcome.serviceRemoved,
    JSON.stringify(outcome));
  check("...naming the service it was asked about",
    calls.some((c) => c.op === "deleteService" && JSON.stringify(c.args).includes(dep.railway_service_id!)));
  const after = await store.get(ctx, dep.id);
  check("...and the row stops claiming to be serving",
    after?.status === "removed" && after.url === null, `${after?.status} ${after?.url}`);
}

{
  // THE ONE THAT LOOKS LIKE SUCCESS. Railway refused; the row still has to be settled, because
  // leaving it "live" claims an agent is serving — but saying "stopped" would tell somebody they
  // stopped paying for something they are still paying for.
  const dep = await seed();
  const { api } = fakeApi({ failDelete: "service not found" });
  const ops = new DeployOps({
    store, token: () => RAILWAY_TOKEN, storeServeToken: async () => null, canKill: () => true,
    apiFor: () => api,
  });
  const outcome = await ops.kill(ctx, dep.id);
  check("a kill Railway refused is not reported as a kill", !outcome.ok && !outcome.serviceRemoved,
    JSON.stringify(outcome));
  check("...and says the agent may still be running and still costing money",
    outcome.detail.includes("still be running") && outcome.detail.includes("costing money"),
    outcome.detail);
  check("...while the row is still settled, because 'live' would be the bigger lie",
    (await store.get(ctx, dep.id))?.status === "removed");
}

// --- 4. reconnect, which restarts the service and says so -----------------------------------------

{
  const dep = await seed();
  const stored: { serviceId: string; token: string }[] = [];
  const { api, calls } = fakeApi({});
  const ops = new DeployOps({
    store, token: () => RAILWAY_TOKEN, canKill: () => true, apiFor: () => api,
    storeServeToken: async ({ serviceId, token }) => { stored.push({ serviceId, token }); return null; },
  });

  const outcome = await ops.reconnect(ctx, dep.id);
  check("reconnect mints a fresh token and reports it once", outcome.ok && (outcome.token ?? "").length >= 24,
    JSON.stringify({ ...outcome, token: outcome.token ? "<redacted>" : null }));
  check("...sets it on Railway under the name the container reads",
    calls.some((c) => c.op === "upsertVariables" &&
      (c.args as { names: string[] }).names.join() === "JAROKU_SERVE_TOKEN"),
    JSON.stringify(calls.map((c) => c.op)));
  check("...and stores it against the SERVICE, so a later dispatch can find it",
    stored.length === 1 && stored[0]!.serviceId === dep.railway_service_id && stored[0]!.token === outcome.token);
  // THE FACT THAT MUST TRAVEL WITH THE COMMAND. Setting a variable restarts the container:
  // everything in flight in it dies and its checkpoints go, so a run paused this morning cannot
  // be resumed afterwards. Part 2 can only warn about that if this says it.
  check("...and says that pressing it restarts the service", outcome.restartsService === true);

  const fresh = await ops.reconnect(ctx, dep.id);
  check("reconnecting twice mints a different token, never the same one again",
    fresh.token !== outcome.token && stored.length === 2);
}

{
  // A RECONNECT THAT SET THE TOKEN AND COULD NOT KEEP IT is the worst state available — the
  // container now expects a credential Jaroku does not have — so it is reported as a failure and
  // the token is still handed back, because it is now the only copy.
  const dep = await seed();
  const { api } = fakeApi({});
  const ops = new DeployOps({
    store, token: () => RAILWAY_TOKEN, canKill: () => true, apiFor: () => api,
    storeServeToken: async () => "the vault is locked",
  });
  const outcome = await ops.reconnect(ctx, dep.id);
  check("a reconnect that could not store the token is not reported as ok", !outcome.ok);
  check("...but still restarts the service and still returns the token, because it is the only copy",
    outcome.restartsService && (outcome.token ?? "").length > 0);
  check("...and names what went wrong", outcome.detail.includes("the vault is locked"), outcome.detail);
}

{
  const dep = await seed();
  const { api } = fakeApi({ failVariables: "unauthorized" });
  const ops = new DeployOps({
    store, token: () => RAILWAY_TOKEN, canKill: () => true, apiFor: () => api,
    storeServeToken: async () => null,
  });
  const outcome = await ops.reconnect(ctx, dep.id);
  check("a reconnect Railway refused restarts nothing and returns no token",
    !outcome.ok && !outcome.restartsService && outcome.token === null, JSON.stringify(outcome));
}

await db.close();
try { rmSync(DB, { force: true }); } catch { /* the OS will get it */ }
console.log(fail === 0 ? "\nALL CORRECT" : `\n${fail} FAILURES`);
process.exitCode = fail === 0 ? 0 : 1;
