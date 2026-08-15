// EVERY WebSocket channel, audited for workspace scoping. Once, exhaustively, by construction.
//
// This suite exists because the stale-broadcast bug has now been found twice by hand — once in
// Session 1 (the history and agent snapshots went to every client), once in Session 2 (the
// provider channel did, and so did the build/edit/reply channels via a shared context variable).
// Finding them one at a time as somebody happens to notice is not the same as KNOWING there are
// none left, and the second kind of confidence is the only kind worth having about a
// cross-tenant leak.
//
// So this does not test a list of channels somebody remembered. It ENUMERATES them:
//
//   1. From `wsRelay.ts` itself — every method that sends on a channel, and every literal
//      `channel:` it can emit. A channel added in a later session appears here automatically
//      and must be classified, or this suite fails.
//   2. From `COMMAND_CHANNEL` — every channel a command's answer, including a refusal, can
//      land on.
//
// ...and then puts two live sockets in two workspaces behind it and fires every one.
//
// THE RULE BEING ENFORCED: a message that carries anything a workspace owns goes only to
// sockets in that workspace. There are exactly two correct mechanisms, and a third that is a
// bug:
//
//   scoped     — `broadcastTo(ctx, …)`, filtered by workspaceId.            ✓
//   per-client — `perClient(…)`, which rebuilds the payload per recipient.  ✓
//   fan-out    — one payload, every socket.                                 ✗ THIS IS THE BUG
//
//   npm run test:channels

import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import WebSocket from "ws";

import { openTestSqlite } from "./db/testDb.ts";
import { newRequestId, systemContextFor, type TenantContext } from "./db/tenant.ts";
import { TraceStore } from "./store.ts";
import { WsRelay } from "./wsRelay.ts";
import { COMMAND_CHANNEL } from "./wsRelay.ts";
import type { Run } from "./types.ts";

let failures = 0;
const check = (ok: boolean, msg: string, detail = ""): void => {
  if (ok) console.log(`  ok   ${msg}`);
  else {
    failures++;
    console.log(`  FAIL ${msg}${detail ? ` — ${detail}` : ""}`);
  }
};
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

const HERE = dirname(fileURLToPath(import.meta.url));
const relaySource = readFileSync(join(HERE, "wsRelay.ts"), "utf8");
const indexSource = readFileSync(join(HERE, "index.ts"), "utf8");

// ---------------------------------------------------------------------------------------------
// 1. The channels that exist, read out of the source rather than remembered.
// ---------------------------------------------------------------------------------------------

console.log("\nthe channel inventory is complete");

/** Every `channel: "x"` and `channel, "x"` the relay can put on the wire. */
const emitted = new Set<string>(
  [...relaySource.matchAll(/channel:\s*"([a-zA-Z]+)"/g)].map((m) => m[1]!),
);
/** Every channel a command's answer or refusal can land on. */
const answered = new Set<string>(Object.values(COMMAND_CHANNEL));

const ALL_CHANNELS = [...new Set([...emitted, ...answered])].sort();

/**
 * The classification. Every channel is in exactly one bucket, and the buckets are the point:
 * "scoped" is a claim about a leak, and it must be argued per channel rather than assumed.
 */
const TENANT_CHANNELS = new Set([
  "history",    // run rows
  "runSteps",   // step payloads — email bodies, database output, Slack messages
  "trace",      // the same, live
  "agents",     // the workspace's agent list
  "agentFiles", // generated source
  "graph",      // generated topology
  "gen",        // a generation streaming its source, and the plan gate
  "edit",       // a proposal's diff
  "debug",      // pause/resume/branch, per run
  "reply",      // an explanation, which quotes the system prompt and tool source
  "eval",       // datasets, scores, results
  "mcp",        // the registry, and confirmRequest, which shows the model's arguments
  "deploy",     // deployment rows and scrubbed build logs
  "members",    // people, with their email addresses
  "providers",  // which keys are set — see broadcastProviders for why this is scoped anyway
  // Which third-party accounts this workspace has authorised us to reach, and whose. It carries
  // no token, but it carries an ACCOUNT LABEL — a person's email address, a company's Slack team
  // name — plus the scopes they granted, which together describe what one tenant has integrated
  // with and on whose behalf. The `authorize` event is worse: it is a live consent URL bound to
  // one workspace's flow, and a second tenant receiving one could complete it.
  "connections",
  "billing",    // what this workspace has spent — one tenant reading another's invoice
  "log",        // stderr lines and refusals, both of which quote the workspace's own work
]);

/**
 * The one channel that is NOT workspace data, and must not be scoped like it.
 *
 * `session` is about the CONNECTION — expiring, revoked, role_changed. It is addressed to one
 * socket by identity, never broadcast, and scoping it by workspace would be meaningless: the
 * message exists precisely because that socket's membership may no longer be what it was.
 */
const CONNECTION_CHANNELS = new Set(["session"]);

const unclassified = ALL_CHANNELS.filter(
  (c) => !TENANT_CHANNELS.has(c) && !CONNECTION_CHANNELS.has(c),
);
check(
  unclassified.length === 0,
  `every channel the relay can emit is classified (${ALL_CHANNELS.length} found)`,
  unclassified.length ? `UNCLASSIFIED: ${unclassified.join(", ")} — decide whether each is tenant data` : "",
);

// A channel named in the classification that no longer exists is dead weight that makes the
// next reader trust a stale list.
const phantom = [...TENANT_CHANNELS, ...CONNECTION_CHANNELS].filter((c) => !ALL_CHANNELS.includes(c));
check(phantom.length === 0, "and no classified channel has since disappeared", phantom.join(", "));

// ---------------------------------------------------------------------------------------------
// 2. Every sender routes through a scoping mechanism. Structural, so a new one cannot skip it.
// ---------------------------------------------------------------------------------------------

console.log("\nevery sender is scoped by construction");
{
  // Each public `broadcast*` / `send*` method on the relay, with its body.
  const senders = [...relaySource.matchAll(
    /^  (?:async )?((?:broadcast|send)[A-Z]\w*)\s*\(([^)]*)\)[^{]*\{([\s\S]*?)\n  \}/gm,
  )].map((m) => ({ name: m[1]!, params: m[2]!, body: m[3]! }));

  check(senders.length >= 15, `found the relay's senders (${senders.length})`, senders.map((s) => s.name).join(", "));

  const unscoped: string[] = [];
  for (const s of senders) {
    // `sendTo` is the primitive every one of them ends in; what matters is how the RECIPIENT
    // was chosen. Either a TenantContext decided it, or the payload was rebuilt per client
    // behind a workspace comparison.
    const takesContext = /ctx:\s*TenantContext/.test(s.params);
    const viaBroadcastTo = /this\.broadcastTo\(/.test(s.body);
    const viaPerClient = /this\.perClient\(/.test(s.body);
    // `sendMembers` walks the socket table by hand, because it addresses ONE socket by the
    // request that asked — an invite link is a credential and must not go to every admin with
    // a tab open. A hand-written loop is fine; what it must not skip is the comparison.
    const comparesWorkspace = /workspaceId\s*!==\s*ctx\.workspaceId/.test(s.body);
    const ok = viaBroadcastTo || ((viaPerClient || /for \(const \[?ws/.test(s.body)) && (takesContext ? comparesWorkspace : true));
    if (!ok) unscoped.push(`${s.name}(${s.params.trim().slice(0, 40)})`);
  }
  check(
    unscoped.length === 0,
    "no sender fans one payload out to every socket",
    unscoped.length ? `UNSCOPED: ${unscoped.join(", ")}` : "",
  );

  // `broadcastTo` is the chokepoint the claim above rests on. If its filter ever goes, every
  // assertion in this file is vacuously true and nothing else would say so.
  const broadcastTo = /private broadcastTo\([\s\S]*?\n  \}/.exec(relaySource)?.[0] ?? "";
  check(
    /this\.contexts\.get\(ws\)\?\.workspaceId\s*!==\s*ctx\.workspaceId/.test(broadcastTo),
    "broadcastTo itself still compares the recipient's workspace, not merely its liveness",
  );
}

// ---------------------------------------------------------------------------------------------
// 3. The emitter contexts in index.ts — one per single-flight subsystem, never one shared.
// ---------------------------------------------------------------------------------------------

console.log("\nan in-flight operation's channel scope belongs to it alone");
{
  // The relay scopes correctly and always did; the leak was one layer up, where the app chose
  // WHICH context to hand it. A single `buildContext` covered planning, generation, editing and
  // explaining — four subsystems with four independent locks, so two could be in flight at once
  // and one variable could not hold both answers.
  // Code, not prose: the comment above the replacement names the old variable on purpose, and
  // a check that cannot tell the two apart would fail on its own explanation.
  check(
    !/^\s*(let|const)\s+buildContext\b/m.test(indexSource) && !/\bbuildContext\s*=/.test(indexSource),
    "the shared `buildContext` is gone — it covered four concurrent subsystems with one variable",
  );

  for (const scope of ["planContext", "genContext", "editContext", "replyContext", "deployContext"]) {
    check(
      new RegExp(`let ${scope}: TenantContext \\| null`).test(indexSource),
      `${scope} is its own scope`,
    );
  }

  // The second half of the bug, and the subtler one: the scope was assigned BEFORE the guard
  // that could refuse the request, so a refused command from another workspace repointed it
  // while the real operation was still streaming. Every claim must now come after its guard.
  const claims = [
    { scope: "genContext", guard: "if (generating)", fn: "async function generateAgent" },
    { scope: "planContext", guard: "if (planner.inFlight)", fn: "async function planAgent" },
    { scope: "editContext", guard: "if (editor.inFlight)", fn: "function editAgent" },
    { scope: "replyContext", guard: "if (explaining)", fn: "function explainAgent" },
  ];
  for (const { scope, guard, fn } of claims) {
    const start = indexSource.indexOf(fn);
    const body = indexSource.slice(start, start + 2500);
    const guardAt = body.indexOf(guard);
    const claimAt = body.indexOf(`${scope} = ctx`);
    check(
      guardAt !== -1 && claimAt !== -1 && guardAt < claimAt,
      `${fn.split(" ").pop()} claims ${scope} only AFTER "${guard}"`,
      guardAt === -1 ? "guard not found" : claimAt === -1 ? "claim not found" : "claim precedes the guard",
    );
  }

  // `deploy` is a switch case rather than a function, so its guard is located the same way.
  const deployCase = indexSource.slice(indexSource.indexOf(`case "deploy": {`));
  check(
    deployCase.indexOf("deployManager.busy") < deployCase.indexOf("deployContext = ctx"),
    'the deploy case claims deployContext only AFTER "deployManager.busy"',
  );
}

// ---------------------------------------------------------------------------------------------
// 4. Live: two sockets, two workspaces, every tenant channel fired.
// ---------------------------------------------------------------------------------------------

const db = await openTestSqlite();
const store = new TraceStore(db);
await store.init();

const A = randomUUID();
const B = randomUUID();
for (const [id, slug] of [[A, "chan-a"], [B, "chan-b"]] as const) {
  await db.run(
    `INSERT INTO workspaces (id, slug, name, kind, plan, created_at) VALUES (?, ?, ?, 'team', 'free', ?)`,
    [id, slug, slug, new Date().toISOString()],
  );
}
const ctxA = systemContextFor(A, newRequestId());
const ctxB = systemContextFor(B, newRequestId());

const runA = randomUUID();
const run: Run = {
  id: runA, agent_id: "agent_a", provider: "fake", model: "fake-dry-run", status: "completed",
  started_at: new Date().toISOString(), ended_at: new Date().toISOString(),
  cost: 0, tokens: 0, error: null,
};
await store.upsertRun(ctxA, run);

let connections = 0;
const PORT = 4519;
const relay = new WsRelay({
  port: PORT,
  store,
  clientHtmlPath: "/dev/null",
  contextFor: () => (connections++ === 0 ? ctxA : ctxB),
  listAgents: async (ctx) => [{ agent_id: ctx.workspaceId === A ? "agent_a" : "agent_b" }],
  listAgentFiles: async (ctx, agentId) =>
    ctx.workspaceId === A && agentId === "agent_a" ? [{ path: "agent.py" }] : [],
  getAgentGraph: async (ctx, agentId) => ({ agent_id: agentId, owner: ctx.workspaceId }),
  listMcpServers: async () => [],
  listProviders: () => ({ providers: [], ownKeyForPlatform: false }),
  listDeployments: async () => ({ deployments: [], railwayConfigured: false }),
});

interface Client {
  ws: WebSocket;
  inbox: Record<string, unknown>[];
}
async function connect(): Promise<Client> {
  const ws = new WebSocket(`ws://127.0.0.1:${PORT}`);
  const inbox: Record<string, unknown>[] = [];
  ws.on("message", (d) => {
    try { inbox.push(JSON.parse(d.toString())); } catch { /* ignore */ }
  });
  await new Promise((r) => ws.once("open", r));
  return { ws, inbox };
}

const a = await connect();
await sleep(150);
const b = await connect();
await sleep(500);

console.log("\nfired live, in A, and B receives none of it");
{
  // One firing per tenant channel that has a broadcast entry point, all addressed to A. B is a
  // fully-connected socket in another workspace, and its inbox is the assertion.
  const MARK = "canary-for-A-only";
  const beforeB = b.inbox.length;
  const beforeA = a.inbox.length;

  relay.broadcastTrace(ctxA, {
    kind: "run_start", schema_version: 1,
    run: { ...run, status: "running", ended_at: null },
  });
  relay.broadcastLog(ctxA, "stderr", MARK);
  relay.broadcastGen(ctxA, { type: "file_delta", path: "agent.py", text: MARK });
  relay.broadcastEdit(ctxA, { type: "file_delta", path: "agent.py", text: MARK });
  relay.broadcastDebug(ctxA, { type: "error", message: MARK });
  relay.broadcastReply(ctxA, { type: "delta", agentId: "agent_a", text: MARK });
  relay.broadcastEval(ctxA, { type: "error", message: MARK });
  relay.broadcastMcp(ctxA, { type: "error", message: MARK });
  relay.broadcastDeploy(ctxA, { type: "error", message: MARK });
  relay.broadcastMembers(ctxA, { type: "notice", message: MARK });
  relay.broadcastProviders(ctxA, { type: "notice", message: MARK });
  relay.broadcastConnections(ctxA, { type: "notice", message: MARK });
  relay.broadcastBilling(ctxA, { type: "error", message: MARK });
  relay.sendMembers(ctxA, ctxA.requestId, { type: "notice", message: MARK });
  relay.broadcastAgentFiles(ctxA, "agent_a");
  await relay.broadcastAgentGraph(ctxA, "agent_a");
  await relay.broadcastHistory();
  await relay.broadcastAgents();
  await relay.broadcastMcpServers();
  await relay.broadcastDeployments();
  await sleep(600);

  const gotA = a.inbox.slice(beforeA);
  const gotB = b.inbox.slice(beforeB);

  // Every tenant channel actually fired, or the assertion below proves nothing.
  const firedChannels = new Set(gotA.map((m: any) => m.channel));
  const notFired = [...TENANT_CHANNELS].filter((c) => !firedChannels.has(c) && c !== "runSteps");
  check(
    notFired.length === 0,
    `every tenant channel was actually exercised (${firedChannels.size})`,
    notFired.length ? `never fired: ${notFired.join(", ")} — this suite is not covering them` : "",
  );

  const leakedMark = gotB.filter((m) => JSON.stringify(m).includes(MARK));
  check(
    leakedMark.length === 0,
    `B received nothing marked for A (${leakedMark.length})`,
    JSON.stringify(leakedMark).slice(0, 300),
  );

  // The agent id is data too. `perClient` alone would have sent B an empty file list for
  // `agent_a` — no contents, but the NAME of another tenant's agent, pushed unasked.
  const leakedName = gotB.filter((m: any) => JSON.stringify(m.agentId ?? "") === '"agent_a"');
  check(
    leakedName.length === 0,
    `B was not even told A's agent id exists (${leakedName.length})`,
    JSON.stringify(leakedName).slice(0, 300),
  );

  const leakedRun = gotB.filter((m) => JSON.stringify(m).includes(runA));
  check(leakedRun.length === 0, `B saw none of A's run ids (${leakedRun.length})`);

  // ...and A did receive it, so the isolation above is not just a dead socket.
  const marked = gotA.filter((m) => JSON.stringify(m).includes(MARK));
  check(marked.length >= 11, `A received its own traffic (${marked.length} marked messages)`);
}

a.ws.close();
b.ws.close();
await relay.close();
await store.close();

console.log(failures === 0 ? "\nALL CORRECT" : `\n${failures} FAILURES`);
process.exit(failures === 0 ? 0 : 1);
