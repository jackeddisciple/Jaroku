// The relay, with two sockets in two workspaces.
//
// The relay answers reads locally and broadcasts to every connected client, which is correct
// for a single-user localhost app and a data breach in a hosted one. Session 1 gave each
// socket a context; this is what proves the context is actually USED — by every read, by
// every broadcast, and by every command forwarded to the app.
//
// It builds a relay directly rather than booting the server, because the thing under test is
// what happens when two connections disagree about which workspace they are in, and the
// server has exactly one until Session 2.
//
//   npm run test:relay

import { randomUUID } from "node:crypto";
import WebSocket from "ws";

import { openTestSqlite } from "./db/testDb.ts";
import { newRequestId, systemContextFor, type TenantContext } from "./db/tenant.ts";
import { TraceStore } from "./store.ts";
import { MAX_WS_MESSAGE_BYTES, WsRelay, describeClient, CLOSE_RECONNECT, CLOSE_UNAUTHORISED, type ForwardedCommand, type SessionVerdict } from "./wsRelay.ts";
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

const db = await openTestSqlite();
const store = new TraceStore(db);
await store.init();

// Two workspaces, each with one run.
const A = randomUUID();
const B = randomUUID();
for (const [id, slug] of [[A, "relay-a"], [B, "relay-b"]] as const) {
  await db.run(
    `INSERT INTO workspaces (id, slug, name, kind, plan, created_at) VALUES (?, ?, ?, 'team', 'free', ?)`,
    [id, slug, slug, new Date().toISOString()],
  );
}
const ctxA = systemContextFor(A, newRequestId());
const ctxB = systemContextFor(B, newRequestId());

async function seed(ctx: TenantContext, tag: string): Promise<string> {
  const runId = randomUUID();
  const run: Run = {
    id: runId, agent_id: `agent_${tag}`, provider: "fake", model: "fake-dry-run",
    status: "completed", started_at: new Date().toISOString(), ended_at: new Date().toISOString(),
    cost: 0, tokens: 0, error: null,
  };
  await store.upsertRun(ctx, run);
  const step: Step = {
    id: randomUUID(), run_id: runId, seq: 0, type: "llm_call", name: tag,
    input: { tag }, output: { tag }, state_before: null, state_after: null,
    tokens: null, cost: null, latency_ms: 0, error: null, parent_step_id: null,
    started_at: new Date().toISOString(),
  };
  await store.insertStep(ctx, step);
  return runId;
}
const runA = await seed(ctxA, "a");
const runB = await seed(ctxB, "b");

// The relay hands out A to the first socket and B to the second, which is the shape Session 2
// produces from a ticket. Everything below asks whether the rest of the system honours it.
let connections = 0;
const commandLog: { cmd: string; workspaceId: string }[] = [];
/** What the next revalidation should conclude, per workspace. Set by the tests below. */
const verdicts = new Map<string, SessionVerdict>();
const PORT = 4507;

/** Which workspace owns which agent. The agents table answers this for real. */
const OWNED: Record<string, string[]> = { [A]: ["agent_a"], [B]: ["agent_b"] };

const relay = new WsRelay({
  port: PORT,
  store,
  clientHtmlPath: "/dev/null",
  // A is an owner, B a plain member. Session 1 only needed two workspaces; Session 2 needs
  // two ROLES as well, so the same two sockets can answer both questions this file asks.
  contextFor: () => (connections++ === 0 ? { ...ctxA, role: "owner" as const } : { ...ctxB, role: "member" as const }),
  listAgents: async (ctx) => [{ agent_id: ctx.workspaceId === A ? "agent_a" : "agent_b" }],
  // Modelled on the real wiring rather than answering unconditionally: an agent's source is
  // read from a global directory BY ID, so the implementation has to check that the caller's
  // workspace owns that id. A stub that ignores agentId cannot tell a correct implementation
  // from one that hands any caller any agent's code — which is what this used to do.
  listAgentFiles: async (ctx, agentId) => {
    // THE THIRD OUTCOME, which this stub could not previously produce and which is the one that
    // shipped broken: a version row whose objects were never written throws on read. `[]` models
    // "not yours"; this models "the store could not answer", and they must not look the same on
    // the wire — see the assertions in the reads section.
    if (agentId === "agent_unreadable") throw new Error("no such object: ws/x/agents/y/v2/agent.py");
    return OWNED[ctx.workspaceId]?.includes(agentId) ? [{ path: `${agentId}.py` }] : [];
  },
  getAgentGraph: async (ctx, agentId) =>
    OWNED[ctx.workspaceId]?.includes(agentId)
      ? { agent_id: agentId }
      : { agent_id: agentId, error: "no such agent in this workspace" },
  listMcpServers: async (ctx) => [{ id: ctx.workspaceId === A ? "server_a" : "server_b" }],
  listProviders: () => ({ providers: [], ownKeyForPlatform: false, models: [] }),
  listDeployments: async (ctx) => ({
    deployments: [{ id: ctx.workspaceId === A ? "deploy_a" : "deploy_b" }],
    railwayConfigured: false,
  }),
  onCommand: (cmd: ForwardedCommand, ctx: TenantContext) => {
    commandLog.push({ cmd: cmd.cmd, workspaceId: ctx.workspaceId });
  },
  // Driven by hand below rather than by a timer: what is under test is the DECISION, and a
  // suite that waits sixty seconds to see it is a suite nobody runs.
  revalidate: async (session) => verdicts.get(session.context.workspaceId) ?? { ok: true, role: session.context.role },
  revalidateMs: 60_000,
});

interface Client {
  ws: WebSocket;
  inbox: Record<string, unknown>[];
  send: (o: unknown) => void;
  want: (pred: (m: any) => boolean, label: string) => Promise<any>;
  /** The close code, once it arrives. A client can miss the last frame; it cannot miss this. */
  closed: () => number | null;
}

async function connect(): Promise<Client> {
  const ws = new WebSocket(`ws://127.0.0.1:${PORT}`);
  const inbox: Record<string, unknown>[] = [];
  ws.on("message", (d) => {
    try {
      inbox.push(JSON.parse(d.toString()));
    } catch {
      /* ignore */
    }
  });
  let closeCode: number | null = null;
  ws.on("close", (code) => { closeCode = code; });
  await new Promise((r) => ws.once("open", r));
  return {
    ws,
    inbox,
    closed: () => closeCode,
    send: (o) => ws.send(JSON.stringify(o)),
    want: async (pred, label) => {
      for (let i = 0; i < 100; i++) {
        const hit = inbox.find(pred);
        if (hit) return hit;
        await sleep(50);
      }
      throw new Error(`timeout: ${label}`);
    },
  };
}

const a = await connect();
await sleep(150); // so the first connection is deterministically A
const b = await connect();
await sleep(500);

console.log("\nthe initial snapshot is per socket");
{
  const ha: any = await a.want((m) => m.channel === "history", "A history");
  const hb: any = await b.want((m) => m.channel === "history", "B history");
  check(ha.runs.length === 1 && ha.runs[0].id === runA, `A's history is A's run only (${ha.runs.length})`);
  check(hb.runs.length === 1 && hb.runs[0].id === runB, `B's history is B's run only (${hb.runs.length})`);

  const aa: any = await a.want((m) => m.channel === "agents", "A agents");
  const ab: any = await b.want((m) => m.channel === "agents", "B agents");
  check(aa.agents[0]?.agent_id === "agent_a" && ab.agents[0]?.agent_id === "agent_b", "each socket's agent list is its own");

  const ma: any = await a.want((m) => m.channel === "mcp", "A mcp");
  const mb: any = await b.want((m) => m.channel === "mcp", "B mcp");
  check(ma.servers[0]?.id === "server_a" && mb.servers[0]?.id === "server_b", "each socket's MCP list is its own");

  const da: any = await a.want((m) => m.channel === "deploy", "A deploy");
  const dbm: any = await b.want((m) => m.channel === "deploy", "B deploy");
  check(da.deployments[0]?.id === "deploy_a" && dbm.deployments[0]?.id === "deploy_b", "each socket's deploy list is its own");
}

console.log("\nlocally-answered reads are per socket");
{
  // B asks for A's run by id. It must get nothing, not A's trace.
  b.send({ cmd: "loadRun", runId: runA });
  const stolen: any = await b.want((m) => m.channel === "runSteps" && m.runId === runA, "B loadRun of A's run");
  check(stolen.steps.length === 0, `B cannot load A's run by id (${stolen.steps.length} steps)`);

  a.send({ cmd: "loadRun", runId: runA });
  const own: any = await a.want((m) => m.channel === "runSteps" && m.runId === runA, "A loadRun of its own");
  check(own.steps.length === 1, "A can load its own");

  b.send({ cmd: "loadAgentFiles", agentId: "agent_b" });
  const files: any = await b.want((m) => m.channel === "agentFiles" && m.agentId === "agent_b", "B files");
  check(files.files[0]?.path === "agent_b.py", "loadAgentFiles answers for the socket's own agent");

  // The leak this is really about: an agent's source lives in a global directory keyed by id,
  // so B naming A's agent is a request for another tenant's generated code.
  b.send({ cmd: "loadAgentFiles", agentId: "agent_a" });
  const stolenFiles: any = await b.want((m) => m.channel === "agentFiles" && m.agentId === "agent_a", "B files for A's agent");
  check(stolenFiles.files.length === 0,
    `B cannot read A's agent source by naming it (${stolenFiles.files.length} files)`,
    JSON.stringify(stolenFiles.files).slice(0, 120));

  // A READ THAT THREW IS ANSWERED, and this is the assertion the whole `onError` parameter exists
  // for. It used to be a `console.error` on a server the person who asked cannot see, so the
  // client sat on its initial state indefinitely — no spinner, no error, and an empty file list
  // that every consumer of this channel reads as "this agent has nothing", which is a confident
  // wrong answer rather than a missing one. Asserted with a TIMEOUT rather than by inspecting the
  // inbox: "no frame ever arrives" is precisely the old behaviour, and only waiting can tell it
  // from a frame that arrives late.
  b.send({ cmd: "loadAgentFiles", agentId: "agent_unreadable" });
  const failed: any = await b.want(
    (m) => m.channel === "agentFiles" && m.agentId === "agent_unreadable",
    "B files for an agent whose objects are missing",
  );
  check(
    typeof failed.error === "string" && failed.error.includes("no such object"),
    "a read that throws answers the asking socket with the failure, carrying its own message",
    JSON.stringify(failed).slice(0, 160),
  );
  check(
    failed.files === undefined,
    "...and sends no file list with it, so an empty tree cannot be mistaken for an answer",
  );

  b.send({ cmd: "loadAgentGraph", agentId: "agent_b" });
  const graph: any = await b.want((m) => m.channel === "graph" && m.agentId === "agent_b", "B graph");
  check(graph.graph?.agent_id === "agent_b" && !graph.graph?.error,
    "loadAgentGraph answers for the socket's own agent");

  b.send({ cmd: "loadAgentGraph", agentId: "agent_a" });
  const stolenGraph: any = await b.want((m) => m.channel === "graph" && m.agentId === "agent_a", "B graph for A's agent");
  check(Boolean(stolenGraph.graph?.error),
    "B cannot introspect A's agent topology by naming it",
    JSON.stringify(stolenGraph.graph).slice(0, 120));
}

console.log("\nforwarded commands carry the asking socket's workspace");
{
  commandLog.length = 0;
  a.send({ cmd: "run", input: "x", agentId: "example_agent" });
  b.send({ cmd: "run", input: "x", agentId: "example_agent" });
  await sleep(600);
  const forA = commandLog.find((c) => c.workspaceId === A);
  const forB = commandLog.find((c) => c.workspaceId === B);
  check(commandLog.length === 2, `both commands reached the app (${commandLog.length})`);
  check(!!forA && !!forB, "each arrived with its OWN socket's workspace, not one shared context",
    JSON.stringify(commandLog));
}

console.log("\nbroadcasts are built per recipient");
{
  // The failure this catches: one query, one payload, sent to everybody. History and agents
  // were fixed for it; the MCP and deploy snapshots were not.
  const beforeA = a.inbox.length;
  const beforeB = b.inbox.length;
  await relay.broadcastHistory();
  await relay.broadcastAgents();
  await sleep(400);
  const ha = a.inbox.slice(beforeA).filter((m: any) => m.channel === "history").pop() as any;
  const hb = b.inbox.slice(beforeB).filter((m: any) => m.channel === "history").pop() as any;
  check(ha?.runs?.[0]?.id === runA && hb?.runs?.[0]?.id === runB, "a history broadcast is scoped per client");

  const aa = a.inbox.slice(beforeA).filter((m: any) => m.channel === "agents").pop() as any;
  const ab = b.inbox.slice(beforeB).filter((m: any) => m.channel === "agents").pop() as any;
  check(aa?.agents?.[0]?.agent_id === "agent_a" && ab?.agents?.[0]?.agent_id === "agent_b",
    "an agents broadcast is scoped per client");

  const beforeA2 = a.inbox.length;
  const beforeB2 = b.inbox.length;
  await relay.broadcastMcpServers();
  await relay.broadcastDeployments();
  await sleep(400);
  const ma = a.inbox.slice(beforeA2).filter((m: any) => m.channel === "mcp" && m.type === "servers").pop() as any;
  const mb = b.inbox.slice(beforeB2).filter((m: any) => m.channel === "mcp" && m.type === "servers").pop() as any;
  check(ma?.servers?.[0]?.id === "server_a" && mb?.servers?.[0]?.id === "server_b",
    "an MCP registry broadcast is scoped per client",
    `A got ${ma?.servers?.[0]?.id}, B got ${mb?.servers?.[0]?.id}`);

  const da = a.inbox.slice(beforeA2).filter((m: any) => m.channel === "deploy" && m.type === "deployments").pop() as any;
  const dbm = b.inbox.slice(beforeB2).filter((m: any) => m.channel === "deploy" && m.type === "deployments").pop() as any;
  check(da?.deployments?.[0]?.id === "deploy_a" && dbm?.deployments?.[0]?.id === "deploy_b",
    "a deployments broadcast is scoped per client",
    `A got ${da?.deployments?.[0]?.id}, B got ${dbm?.deployments?.[0]?.id}`);

  // A trace event is NOT per client — it belongs to one run in one workspace, and sending it
  // to everybody is the same class of leak.
  const beforeA3 = a.inbox.length;
  const beforeB3 = b.inbox.length;
  relay.broadcastTrace(ctxA, {
    kind: "run_start",
    schema_version: 1,
    run: {
      id: runA, agent_id: "agent_a", provider: "fake", model: "fake-dry-run", status: "running",
      started_at: new Date().toISOString(), ended_at: null, cost: 0, tokens: 0, error: null,
    },
  });
  await sleep(300);
  const ta = a.inbox.slice(beforeA3).filter((m: any) => m.channel === "trace");
  const tb = b.inbox.slice(beforeB3).filter((m: any) => m.channel === "trace");
  check(ta.length === 1, `A receives the trace event for its own run (${ta.length})`);
  check(tb.length === 0, `B receives none of another workspace's trace (${tb.length})`);
}

console.log("\nthe socket's ROLE decides what it may do");
{
  // The scope question is "whose rows"; this is the other one — "may this role do this at
  // all". B is a member, so it builds and runs agents and touches nothing that commits the
  // workspace to money, a third party, or a public URL.
  commandLog.length = 0;
  // `setOwnKeyForPlatform` rather than `setProviderKey`, which no longer exists: a command that
  // carries a credential cannot live on this socket, because elevation rides on a request header a
  // WebSocket cannot set. What is left on the providers channel decides which of two already-stored
  // keys pays for the platform's calls, and it is still `provider:manage`.
  b.send({ cmd: "setOwnKeyForPlatform", on: true });
  const refused: any = await b.want(
    (m) => m.channel === "providers" && m.type === "error",
    "B refused a provider command",
  );
  check(/member/.test(refused.message), "a member spending the workspace's key is refused");
  check(/provider:manage/.test(refused.message), "...naming the capability it needed");
  await sleep(300);
  check(
    commandLog.length === 0,
    `...and the command NEVER REACHED THE APP (${commandLog.length}) — a refusal that forwards first has already acted`,
  );

  b.send({ cmd: "addMcpServer", endpoint: "https://mcp.example/x" });
  const mcpRefusal: any = await b.want((m) => m.channel === "mcp" && m.type === "error", "B refused an MCP server");
  check(/mcp:manage/.test(mcpRefusal.message), "a member connecting an MCP server is refused ON THE MCP CHANNEL");

  b.send({ cmd: "deploy", agentId: "agent_b", provider: "anthropic", model: "m", envKeys: [] });
  const deployRefusal: any = await b.want((m) => m.channel === "deploy" && m.type === "error", "B refused a deploy");
  check(/deploy:manage/.test(deployRefusal.message), "...and a deploy, on the deploy channel");

  // A refusal has to arrive where the panel that asked is listening. Anywhere else and the
  // panel waits forever while an unrelated one shows somebody else's error.
  check(
    refused.channel === "providers" && mcpRefusal.channel === "mcp" && deployRefusal.channel === "deploy",
    "each refusal lands on the channel its command belongs to",
  );

  // ...and the same member is not obstructed from doing the product's actual job.
  commandLog.length = 0;
  b.send({ cmd: "run", input: "x", agentId: "agent_b" });
  b.send({ cmd: "edit", agentId: "agent_b", instruction: "add a tool" });
  await sleep(500);
  check(commandLog.length === 2, `a member still runs and edits agents (${commandLog.length}/2)`);

  // An owner does what a member may not.
  commandLog.length = 0;
  a.send({ cmd: "setOwnKeyForPlatform", on: true });
  await sleep(400);
  check(commandLog.some((c) => c.cmd === "setOwnKeyForPlatform"), "an owner's provider command reaches the app");

  // A command nothing has classified is refused rather than allowed. The default matters more
  // than any single entry: it is what a command added in a later session gets for free.
  b.send({ cmd: "somethingNobodyClassified" });
  const unknown: any = await b.want((m) => m.channel === "log" && m.type === "error", "unclassified refusal");
  check(/not a command this server authorises/.test(unknown.message), "an unclassified command is REFUSED, not allowed");
}

console.log("\nprovider state is per workspace too");
{
  // The last broadcast that went to every client regardless of workspace. "anthropic is
  // configured" is a fact one workspace has no business learning because another workspace's
  // admin pressed Save.
  const beforeA = a.inbox.length;
  const beforeB = b.inbox.length;
  relay.broadcastProviders(ctxA, { type: "notice", message: "for A only" });
  await sleep(300);
  const pa = a.inbox.slice(beforeA).filter((m: any) => m.channel === "providers" && m.type === "notice");
  const pb = b.inbox.slice(beforeB).filter((m: any) => m.channel === "providers" && m.type === "notice");
  check(pa.length === 1, `A receives its own provider notice (${pa.length})`);
  check(pb.length === 0, `B receives none of A's (${pb.length})`);
}

console.log("\nhow much one client may send");
{
  // The HTTP router next to this refuses a body over 64 KiB; `ws` defaults to a hundred
  // megabytes. So the socket was the way around the cap — and unlike a request body, an
  // oversized frame is buffered in the server's heap before anything gets to look at it.
  commandLog.length = 0;
  const big = await connect();
  await sleep(200);
  const oversized = JSON.stringify({ cmd: "run", agentId: "example_agent", input: "x".repeat(MAX_WS_MESSAGE_BYTES) });
  check(Buffer.byteLength(oversized) > MAX_WS_MESSAGE_BYTES, `the frame really is over the limit (${Buffer.byteLength(oversized)} bytes)`);
  big.ws.on("error", () => { /* the close is the answer; the error beside it is noise */ });
  big.ws.send(oversized);
  await sleep(500);
  check(big.ws.readyState !== WebSocket.OPEN, "an oversized frame closes the socket");
  check(big.closed() === 1009, `...with 1009, the code for a message too big (${big.closed()})`);
  check(commandLog.length === 0, `...and the command inside it never ran (${commandLog.length})`);

  // The other half: the limit has to leave room for the commands that legitimately carry prose.
  const roomy = await connect();
  await sleep(200);
  commandLog.length = 0;
  roomy.send({ cmd: "run", agentId: "example_agent", input: "y".repeat(200 * 1024) });
  await sleep(600);
  check(commandLog.length === 1, `a 200 KiB command still goes through (${commandLog.length})`);
  roomy.ws.close();
}

console.log("\na socket does not outlive the membership that authorised it");
{
  // The gap this closes: every HTTP request re-presents its token, but a socket is checked
  // once at the upgrade and then runs for as long as a tab is open — eight hours later still
  // acting on a membership revoked in the first ten minutes.

  // A role change does NOT close the connection. It is still legitimately theirs; what
  // changed is what it may do, and the capability check reads the context on every command.
  verdicts.set(B, { ok: true, role: "admin" });
  const beforeRole = b.inbox.length;
  await relay.revalidateAll();
  await sleep(200);
  const roleEvent = b.inbox.slice(beforeRole).find((m: any) => m.channel === "session" && m.type === "role_changed") as any;
  check(roleEvent?.role === "admin", "a promotion arrives on the session channel");
  check(b.ws.readyState === WebSocket.OPEN, "...without closing the socket — a role change is not an interruption");

  // ...and it is the ENFORCEMENT, not a notification: the same socket may now do what it
  // could not a moment ago.
  commandLog.length = 0;
  b.send({ cmd: "addMcpServer", endpoint: "https://mcp.example/y" });
  await sleep(400);
  check(
    commandLog.some((c) => c.cmd === "addMcpServer"),
    "...and the promoted socket may now do what it was refused before, on the SAME connection",
  );

  // A failed re-check must not close anything. A database blip signing every user out turns a
  // hiccup into an outage — the same rule the JWKS cache follows.
  verdicts.set(B, { get ok(): never { throw new Error("database is down"); } } as never);
  await relay.revalidateAll();
  await sleep(200);
  check(b.ws.readyState === WebSocket.OPEN, "a revalidation that THROWS leaves the socket open");
  verdicts.delete(B);

  // Revocation does close it, with the code that says "sign in again".
  verdicts.set(B, { ok: false, reason: "revoked" });
  const beforeRevoke = b.inbox.length;
  await relay.revalidateAll();
  await sleep(400);
  const revoked = b.inbox.slice(beforeRevoke).find((m: any) => m.channel === "session" && m.type === "revoked") as any;
  check(!!revoked, "a revoked membership is announced on the session channel");
  check(b.ws.readyState !== WebSocket.OPEN, "...and the socket is closed, not merely warned");
  check(b.closed() === CLOSE_UNAUTHORISED, `...with the sign-in-again close code (${b.closed()})`);

  // A deleted workspace is a different instruction: reconnect elsewhere, do not sign in again.
  verdicts.set(A, { ok: false, reason: "workspace_gone" });
  const beforeGone = a.inbox.length;
  await relay.revalidateAll();
  await sleep(400);
  const gone = a.inbox.slice(beforeGone).find((m: any) => m.channel === "session" && m.type === "workspace_changed") as any;
  check(!!gone, "a workspace that no longer exists is announced as workspace_changed, not revoked");
  check(a.closed() === CLOSE_RECONNECT, `...with the reconnect close code (${a.closed()})`);
}

// §14.1's "browser/device", and the two orderings that make it right rather than plausible.
//
// THIS IS A PURE FUNCTION AND IT STILL EARNS A SUITE, because both of its lists are ordered by a
// rule that is invisible in the code and load-bearing in the answer. Every Chromium browser claims
// to be Chrome and Chrome claims to be Safari; an iPhone claims "like Mac OS X" and an Android
// claims "Linux". A scan that asked the general question first is not subtly wrong — it reports
// Safari for every browser and macOS for every phone, confidently, on a row whose entire job is
// helping somebody recognise their own session in a list of four. The iOS case shipped wrong here
// and this is what found it.
console.log("\nwhat connected, in two words");
{
  const seen = (ua: string | undefined): string | null => describeClient(ua);
  check(
    seen("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36") === "Chrome on macOS",
    "Chrome is Chrome, not the Safari it claims to be",
  );
  check(
    seen("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0 Safari/537.36 Edg/131.0") === "Edge on Windows",
    "...and Edge is Edge, not the Chrome it also claims to be",
  );
  check(
    seen("Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 Version/17.0 Mobile/15E148 Safari/604.1") === "Safari on iOS",
    "an iPhone is iOS, despite saying `like Mac OS X`",
  );
  check(
    seen("Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0 Mobile Safari/537.36") === "Chrome on Android",
    "...and an Android is Android, despite saying `Linux`",
  );
  check(
    seen("Mozilla/5.0 (X11; Linux x86_64; rv:133.0) Gecko/20100101 Firefox/133.0") === "Firefox on Linux",
    "a real Linux desktop is still Linux",
  );

  // AN UNRECOGNISED AGENT IS NULL, NOT A WORD. The panel renders nothing for a null and would
  // render "Unknown" for a string — and "Unknown browser" beside somebody's name reads as a warning
  // about their session rather than as an absent header.
  check(seen(undefined) === null, "a missing header is null rather than a word");
  check(seen("") === null, "...and so is an empty one");
  check(seen("curl/8.4.0") === null, "...and so is something nobody has a name for");

  // AND NOTHING OF THE RAW HEADER SURVIVES. §14.1 asks for browser and device; a version string or
  // a device model is a fingerprint of a colleague's machine on an internal panel.
  const described = seen("Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 Chrome/131.0.6778.85 Mobile Safari/537.36") ?? "";
  check(!/\d/.test(described), `no version number reaches the panel ("${described}")`);
  check(!/Pixel/.test(described), "...and no device model");
}

a.ws.close();
b.ws.close();
await relay.close();
await store.close();

console.log(failures === 0 ? "\nALL CORRECT" : `\n${failures} FAILURES`);
process.exit(failures === 0 ? 0 : 1);
