// SESSION 2'S ACCEPTANCE TEST, LITERALLY.
//
// The spec's sentence, and this file exists to be the thing that actually runs it:
//
//   "two real accounts, two workspaces, both using the app simultaneously against one server,
//    neither able to observe the other by any command, socket, or timing."
//
// `auth/attacks.test.ts` already covers the adversarial half well — forged tokens, replayed
// tickets, revoked memberships, an id from the other workspace named on purpose. This is the
// other half, and it is the half the spec actually made the gate: TWO PEOPLE JUST USING THE
// APP. Nobody attacking anything. Both signed in, both with a socket open on one process, both
// doing ordinary work at the same time and interleaved with each other.
//
// It is worth its own file because the failures it catches are not the ones an attack finds.
// An attack asks "can I reach across the boundary if I try". Concurrency asks "does the server
// keep two ordinary sessions apart while it is busy", and the answers differ whenever the
// server holds per-operation state in a module-level variable — which it did, for the build,
// edit, explain and deploy channels, and which no adversarial test would ever have provoked
// because the attacker's move there is to do something perfectly legitimate in their own
// workspace at the wrong moment.
//
// THE THREE CHANNELS THE SPEC NAMES, each asserted below:
//   command — every answer to every command Ada sends is Ada's, under concurrent load.
//   socket  — nothing that arrives unbidden on Ada's socket is Bob's.
//   timing  — the answer to "does this id exist" costs the same whether or not it does.
//
//   npm run test:acceptance

import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import WebSocket from "ws";

import { openTestSqlite } from "./db/testDb.ts";
import { IdentityRepository } from "./db/repositories/identity.ts";
import { DbTicketStore } from "./db/repositories/tickets.ts";
import { newRequestId, systemContext, type TenantContext } from "./db/tenant.ts";
import { TraceStore } from "./store.ts";
import { Router } from "./http/router.ts";
import { WsRelay, type ForwardedCommand } from "./wsRelay.ts";
import { JwksClient } from "./auth/jwks.ts";
import { TokenVerifier } from "./auth/verifier.ts";
import { LocalIssuer } from "./auth/localIssuer.ts";
import { sessionRoutes } from "./auth/session.ts";
import { ContextResolver } from "./auth/resolve.ts";
import { resolveSocketAuth } from "./auth/socketAuth.ts";
import { resolveOriginPolicy } from "./auth/origin.ts";
import { DEFAULT_AUDIENCE, LOCAL_ISSUER, type AuthConfig } from "./auth/config.ts";
import type { Run, Step } from "./types.ts";

let failures = 0;
const check = (ok: boolean, msg: string, detail = ""): void => {
  if (ok) console.log(`  ok   ${msg}`);
  else {
    failures++;
    console.log(`  FAIL ${msg}${detail ? ` — ${detail}` : ""}`);
  }
};
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

const keyDir = mkdtempSync(join(tmpdir(), "jaroku-acceptance-"));
const db = await openTestSqlite();
const identity = new IdentityRepository(db);
const tickets = new DbTicketStore(db);
const resolver = new ContextResolver({ identity, log: () => {} });
const store = new TraceStore(db);
await store.init();
const sys = systemContext(newRequestId());

const issuer = new LocalIssuer(join(keyDir, "devauth.json"), DEFAULT_AUDIENCE, () => {});
const jwksHttp: Server = createServer((_req, res) => {
  res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(issuer.jwks()));
});
await new Promise<void>((r) => jwksHttp.listen(0, "127.0.0.1", r));
const jwksUrl = `http://127.0.0.1:${(jwksHttp.address() as AddressInfo).port}/jwks.json`;
const config: AuthConfig = { mode: "local", issuer: LOCAL_ISSUER, audience: DEFAULT_AUDIENCE, jwksUrl };
const verifier = new TokenVerifier(config, new JwksClient({ url: jwksUrl }));

const router = new Router({ log: () => {}, cors: resolveOriginPolicy({}, () => {}) });
for (const route of sessionRoutes({ config, verifier, identity, localIssuer: issuer, tickets, resolver, log: () => {} })) {
  if (route.method === "GET") router.get(route.path, route.handler);
  else router.post(route.path, route.handler);
}

/** Every command the app was asked to do, with the workspace it arrived in. */
const commands: { cmd: string; workspaceId: string; at: number }[] = [];
/** What each workspace's agent list is. Distinct per workspace, so a mix-up is visible. */
const AGENTS = new Map<string, string>();

const PORT = 4700 + Math.floor(Math.random() * 90);
const relay = new WsRelay({
  port: PORT,
  store,
  router,
  clientHtmlPath: "/dev/null",
  originPolicy: resolveOriginPolicy({}, () => {}),
  contextFor: resolveSocketAuth({ tickets, devContext: () => { throw new Error("no dev auth here"); }, env: {}, log: () => {} }),
  listAgents: async (ctx) => [{ agent_id: AGENTS.get(ctx.workspaceId) ?? "none" }],
  listAgentFiles: async (ctx, agentId) =>
    AGENTS.get(ctx.workspaceId) === agentId ? [{ path: `${agentId}.py` }] : [],
  getAgentGraph: async (ctx, agentId) =>
    AGENTS.get(ctx.workspaceId) === agentId ? { agent_id: agentId } : { agent_id: agentId, error: "not here" },
  listMcpServers: async (ctx) => [{ id: `mcp_${AGENTS.get(ctx.workspaceId)}` }],
  listProviders: () => ({ providers: [], ownKeyForPlatform: false, models: [] }),
  listDeployments: async (ctx) => ({ deployments: [{ id: `dep_${AGENTS.get(ctx.workspaceId)}` }], railwayConfigured: false }),
  // The app half, and it does real work in the context it was handed: a `run` writes a run row
  // into the ASKING workspace and pushes fresh history to everybody. That last part is what
  // makes this a concurrency test rather than a request/response one — Ada's run causes a
  // broadcast while Bob has a socket open, which is precisely the moment a shared snapshot
  // would go to the wrong person.
  onCommand: (cmd: ForwardedCommand, ctx: TenantContext) => {
    commands.push({ cmd: cmd.cmd, workspaceId: ctx.workspaceId, at: Date.now() });
    if (cmd.cmd !== "run") return;
    void (async () => {
      const runId = `run-${AGENTS.get(ctx.workspaceId)}-${randomUUID().slice(0, 8)}`;
      await store.upsertRun(ctx, {
        id: runId, agent_id: AGENTS.get(ctx.workspaceId) ?? "none", provider: "fake", model: "fake-dry-run",
        status: "completed", started_at: new Date().toISOString(), ended_at: new Date().toISOString(),
        cost: 0, tokens: 0, error: null,
      } as Run);
      await store.insertStep(ctx, {
        id: randomUUID(), run_id: runId, seq: 0, type: "llm_call",
        name: `secret_of_${AGENTS.get(ctx.workspaceId)}`,
        input: { owner: AGENTS.get(ctx.workspaceId) }, output: { owner: AGENTS.get(ctx.workspaceId) },
        state_before: null, state_after: null, tokens: null, cost: null, latency_ms: 1,
        error: null, parent_step_id: null, started_at: new Date().toISOString(),
      } as Step);
      relay.broadcastTrace(ctx, {
        kind: "run_start", schema_version: 1,
        run: {
          id: runId, agent_id: AGENTS.get(ctx.workspaceId) ?? "none", provider: "fake", model: "fake-dry-run",
          status: "running", started_at: new Date().toISOString(), ended_at: null, cost: 0, tokens: 0, error: null,
        },
      });
      await relay.broadcastHistory();
    })();
  },
});
await sleep(200);

const base = `http://127.0.0.1:${PORT}`;
const wsBase = `ws://127.0.0.1:${PORT}`;

async function post(path: string, token?: string, body?: unknown) {
  const res = await fetch(`${base}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify(body ?? {}),
  });
  const text = await res.text();
  let json: any = null;
  try { json = JSON.parse(text); } catch { /* status is the assertion */ }
  return { status: res.status, json };
}

interface Person {
  name: string;
  email: string;
  token: string;
  workspaceId: string;
  ws: WebSocket;
  inbox: any[];
  send: (o: unknown) => void;
}

/** Sign in, take a ticket, open a socket. The client's exact three-request exchange. */
async function signIn(name: string, agentId: string): Promise<Person> {
  const email = `acc-${name}-${Math.random().toString(36).slice(2, 7)}@example.com`.toLowerCase();
  const token = issuer.mint({ email }).token;
  const session = await post("/v1/auth/session", token);
  if (session.status !== 200) throw new Error(`${name} could not sign in: ${session.status}`);
  const workspaceId: string = session.json.defaultWorkspaceId;
  AGENTS.set(workspaceId, agentId);

  const ticket = await post("/v1/ws-ticket", token, { workspaceId });
  if (ticket.status !== 200) throw new Error(`${name} got no ticket: ${ticket.status}`);
  const ws = new WebSocket(`${wsBase}/?ticket=${encodeURIComponent(ticket.json.ticket)}`);
  const inbox: any[] = [];
  ws.on("message", (d) => {
    try { inbox.push(JSON.parse(d.toString())); } catch { /* ignore */ }
  });
  await new Promise<void>((resolve, reject) => {
    ws.once("open", () => resolve());
    ws.once("error", reject);
    setTimeout(() => reject(new Error(`${name}'s socket never opened`)), 4000);
  });
  return { name, email, token, workspaceId, ws, inbox, send: (o) => ws.send(JSON.stringify(o)) };
}

console.log("\ntwo real accounts, two workspaces, one server");

const ada = await signIn("ada", "ada_agent");
const bob = await signIn("bob", "bob_agent");
check(ada.workspaceId !== bob.workspaceId, "each account was provisioned into its own workspace");
check(ada.ws.readyState === WebSocket.OPEN && bob.ws.readyState === WebSocket.OPEN, "both sockets are open at once");
await sleep(500);

console.log("\nboth use the app simultaneously");
{
  // The ordinary things a person does, both people doing them at the same time, interleaved
  // rather than one after the other. `Promise.all` over an interleaved script is the point:
  // sequential requests would never put two workspaces inside one server's state at once,
  // which is the only condition under which the bugs this file exists for appear.
  commands.length = 0;
  const script = (p: Person) => async (): Promise<void> => {
    p.send({ cmd: "listAgents" });
    p.send({ cmd: "run", input: "hello", agentId: AGENTS.get(p.workspaceId) });
    await sleep(40);
    p.send({ cmd: "loadAgentFiles", agentId: AGENTS.get(p.workspaceId) });
    p.send({ cmd: "listMcpServers" });
    await sleep(40);
    p.send({ cmd: "listDeployments" });
    p.send({ cmd: "run", input: "again", agentId: AGENTS.get(p.workspaceId) });
    await sleep(40);
    p.send({ cmd: "listAgents" });
  };
  await Promise.all([script(ada)(), script(bob)(), script(ada)(), script(bob)()]);
  await sleep(1500);

  const adasCommands = commands.filter((c) => c.workspaceId === ada.workspaceId);
  const bobsCommands = commands.filter((c) => c.workspaceId === bob.workspaceId);
  check(
    adasCommands.length > 0 && bobsCommands.length > 0 && adasCommands.length === bobsCommands.length,
    `both people's commands reached the app (${adasCommands.length} / ${bobsCommands.length})`,
  );
  check(
    commands.every((c) => c.workspaceId === ada.workspaceId || c.workspaceId === bob.workspaceId),
    "every command arrived in one of the two real workspaces and no other",
  );

  // The work genuinely overlapped, or "they did not interfere" is a claim about a queue.
  const adaWindow = [Math.min(...adasCommands.map((c) => c.at)), Math.max(...adasCommands.map((c) => c.at))];
  const bobWindow = [Math.min(...bobsCommands.map((c) => c.at)), Math.max(...bobsCommands.map((c) => c.at))];
  check(
    adaWindow[0]! <= bobWindow[1]! && bobWindow[0]! <= adaWindow[1]!,
    "...and the two sessions genuinely OVERLAPPED in time, rather than taking turns",
  );
}

console.log("\nby command: every answer each of them got is their own");
{
  const audit = (p: Person, other: Person): void => {
    const otherAgent = AGENTS.get(other.workspaceId)!;
    const mine = AGENTS.get(p.workspaceId)!;

    const leaked = p.inbox.filter((m) => JSON.stringify(m).includes(otherAgent));
    check(leaked.length === 0, `${p.name} received NOTHING mentioning ${other.name}'s agent (${leaked.length})`,
      JSON.stringify(leaked).slice(0, 200));

    const leakedWs = p.inbox.filter((m) => JSON.stringify(m).includes(other.workspaceId));
    check(leakedWs.length === 0, `...nor ${other.name}'s workspace id anywhere (${leakedWs.length})`);

    const agents = p.inbox.filter((m) => m.channel === "agents").pop();
    check(agents?.agents?.[0]?.agent_id === mine, `${p.name}'s agent list is ${p.name}'s`);

    const history = p.inbox.filter((m) => m.channel === "history").pop();
    check(
      history?.runs?.length > 0 && history.runs.every((r: any) => r.agent_id === mine),
      `${p.name}'s history holds only ${p.name}'s runs (${history?.runs?.length ?? 0})`,
    );

    const files = p.inbox.filter((m) => m.channel === "agentFiles").pop();
    check(files?.files?.[0]?.path === `${mine}.py`, `${p.name}'s agent source is ${p.name}'s`);

    const mcp = p.inbox.filter((m) => m.channel === "mcp" && m.type === "servers").pop();
    check(mcp?.servers?.[0]?.id === `mcp_${mine}`, `${p.name}'s MCP registry is ${p.name}'s`);

    const dep = p.inbox.filter((m) => m.channel === "deploy" && m.type === "deployments").pop();
    check(dep?.deployments?.[0]?.id === `dep_${mine}`, `${p.name}'s deployments are ${p.name}'s`);
  };
  audit(ada, bob);
  audit(bob, ada);
}

console.log("\nby socket: nothing arrives unbidden from the other session");
{
  // Everything above was an ANSWER to something they asked for. This is the other traffic: the
  // live trace events and history pushes that Ada's run caused while Bob's socket sat open.
  // A broadcast built once and sent to every connected client would land here and nowhere else.
  const adaTrace = ada.inbox.filter((m) => m.channel === "trace");
  const bobTrace = bob.inbox.filter((m) => m.channel === "trace");
  check(adaTrace.length > 0 && bobTrace.length > 0, `both saw their own live trace (${adaTrace.length} / ${bobTrace.length})`);
  check(
    adaTrace.every((m: any) => m.event?.run?.agent_id === "ada_agent"),
    "every live trace event on Ada's socket is Ada's run",
    JSON.stringify(adaTrace.map((m: any) => m.event?.run?.agent_id)),
  );
  check(
    bobTrace.every((m: any) => m.event?.run?.agent_id === "bob_agent"),
    "every live trace event on Bob's socket is Bob's run",
    JSON.stringify(bobTrace.map((m: any) => m.event?.run?.agent_id)),
  );

  // The counts should match what each of them caused, not what the server did in total.
  check(
    adaTrace.length === bobTrace.length,
    `neither received the other's volume of events (${adaTrace.length} / ${bobTrace.length})`,
  );
}

console.log("\nby timing: an id that exists elsewhere costs what a nonexistent one costs");
{
  // The residual channel once the payloads are identical. If naming a real-but-someone-else's
  // run took a database round trip that a fabricated id did not, the LATENCY answers the
  // question the response refused to — "is this a real run id" — and an attacker enumerates
  // ids rather than reading them.
  const bobsRealRun = (bob.inbox.filter((m) => m.channel === "history").pop() as any)?.runs?.[0]?.id;
  check(typeof bobsRealRun === "string", "Bob has a real run to be probed for", String(bobsRealRun));

  async function timeLoadRun(p: Person, runId: string, rounds: number): Promise<{ ms: number[]; payloads: string[] }> {
    const ms: number[] = [];
    const payloads: string[] = [];
    for (let i = 0; i < rounds; i++) {
      const before = p.inbox.length;
      const t0 = performance.now();
      p.send({ cmd: "loadRun", runId });
      for (let w = 0; w < 400; w++) {
        const hit = p.inbox.slice(before).find((m: any) => m.channel === "runSteps" && m.runId === runId);
        if (hit) {
          ms.push(performance.now() - t0);
          payloads.push(JSON.stringify({ steps: hit.steps }));
          break;
        }
        await sleep(5);
      }
    }
    return { ms, payloads };
  }

  const ROUNDS = 25;
  const real = await timeLoadRun(ada, bobsRealRun as string, ROUNDS);
  const fake = await timeLoadRun(ada, `run-nobody-${randomUUID()}`, ROUNDS);
  check(real.ms.length === ROUNDS && fake.ms.length === ROUNDS, `both probes completed (${real.ms.length} / ${fake.ms.length})`);

  // The response itself first. Timing only matters once the payloads are indistinguishable —
  // if they were not, there would be nothing left for timing to reveal.
  check(
    new Set([...real.payloads, ...fake.payloads]).size === 1,
    "the ANSWER is byte-identical whether the id is real-elsewhere or invented",
    [...new Set([...real.payloads, ...fake.payloads])].join(" vs ").slice(0, 200),
  );

  const median = (xs: number[]): number => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)]!;
  const mReal = median(real.ms);
  const mFake = median(fake.ms);
  // A ratio, with a deliberately loose bound. This is not a claim to defeat a lab-grade timing
  // attack over a network — it is the assertion that there is no ORDER-OF-MAGNITUDE oracle,
  // which is what a scoped-versus-unscoped query would produce and what would be exploitable
  // over the internet. A tighter bound here would fail on a loaded machine and teach everyone
  // to ignore it.
  const ratio = Math.max(mReal, mFake) / Math.max(0.01, Math.min(mReal, mFake));
  check(
    ratio < 3,
    `and it costs the same to ask (${mReal.toFixed(2)}ms real-elsewhere vs ${mFake.toFixed(2)}ms invented, ratio ${ratio.toFixed(2)})`,
  );
}

console.log("\nand the sessions stay independent as they end");
{
  // Ada signs out. Bob is mid-session on the same process and must not notice.
  const bobBefore = bob.inbox.length;
  ada.ws.close();
  await sleep(400);
  check(bob.ws.readyState === WebSocket.OPEN, "Bob's socket survives Ada's disconnect");

  commands.length = 0;
  bob.send({ cmd: "listAgents" });
  await sleep(400);
  const stillWorks = bob.inbox.slice(bobBefore).filter((m: any) => m.channel === "agents").pop();
  check(stillWorks?.agents?.[0]?.agent_id === "bob_agent", "...and still answers Bob, in Bob's workspace");

  const sessionEvents = bob.inbox.slice(bobBefore).filter((m: any) => m.channel === "session");
  check(sessionEvents.length === 0, `...and Bob was told nothing about it (${sessionEvents.length} session events)`);
}

bob.ws.close();
await relay.close();
await new Promise<void>((r) => jwksHttp.close(() => r()));
await store.close();
rmSync(keyDir, { recursive: true, force: true });

console.log(failures === 0 ? "\nALL CORRECT" : `\n${failures} FAILURES`);
process.exit(failures === 0 ? 0 : 1);
