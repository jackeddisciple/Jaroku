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
import { WsRelay, type ForwardedCommand } from "./wsRelay.ts";
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
const PORT = 4507;

const relay = new WsRelay({
  port: PORT,
  store,
  clientHtmlPath: "/dev/null",
  contextFor: () => (connections++ === 0 ? ctxA : ctxB),
  listAgents: async (ctx) => [{ agent_id: ctx.workspaceId === A ? "agent_a" : "agent_b" }],
  listAgentFiles: (ctx) => [{ path: ctx.workspaceId === A ? "a.py" : "b.py" }],
  getAgentGraph: async (ctx) => ({ agent_id: ctx.workspaceId === A ? "a" : "b" }),
  listMcpServers: async (ctx) => [{ id: ctx.workspaceId === A ? "server_a" : "server_b" }],
  listProviders: () => [],
  listDeployments: async (ctx) => ({
    deployments: [{ id: ctx.workspaceId === A ? "deploy_a" : "deploy_b" }],
    railwayConfigured: false,
  }),
  onCommand: (cmd: ForwardedCommand, ctx: TenantContext) => {
    commandLog.push({ cmd: cmd.cmd, workspaceId: ctx.workspaceId });
  },
});

interface Client {
  ws: WebSocket;
  inbox: Record<string, unknown>[];
  send: (o: unknown) => void;
  want: (pred: (m: any) => boolean, label: string) => Promise<any>;
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
  await new Promise((r) => ws.once("open", r));
  return {
    ws,
    inbox,
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

  b.send({ cmd: "loadAgentFiles", agentId: "x" });
  const files: any = await b.want((m) => m.channel === "agentFiles", "B files");
  check(files.files[0]?.path === "b.py", "loadAgentFiles answers in the asking socket's workspace");

  b.send({ cmd: "loadAgentGraph", agentId: "x" });
  const graph: any = await b.want((m) => m.channel === "graph", "B graph");
  check(graph.graph?.agent_id === "b", "loadAgentGraph answers in the asking socket's workspace");
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

a.ws.close();
b.ws.close();
await relay.close();
await store.close();

console.log(failures === 0 ? "\nALL CORRECT" : `\n${failures} FAILURES`);
process.exit(failures === 0 ? 0 : 1);
