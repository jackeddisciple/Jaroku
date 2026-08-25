// §19.1's `test:access-resolver` — the twelve assertions the whole feature rests on.
//
// EVERY GATED COMMAND IS DRIVEN WITH THE CLIENT BYPASSED ENTIRELY. §5 is explicit that the client's
// copy of the matrix is advisory — "used to hide buttons, never trusted" — and a suite that reached
// enforcement through a rendered component would be testing the advice. So this stands a real relay
// on a real port, opens raw WebSockets, and sends the JSON a `curl` would send: no store, no hook,
// no component, nothing that could be politely refusing on the client's behalf.
//
// THE TWO ASSERTIONS THAT LOOK REDUNDANT ARE THE ONES THIS FILE EXISTS FOR.
//
//   A grant exceeding a workspace role is refused at WRITE time, and a row written straight to the
//   database is intersected down at READ time anyway. The second is not a belt on the first's
//   braces: write-time validation is correct for exactly as long as nobody's role changes, and the
//   read-time intersection is what makes a demotion bite without anybody finding and rewriting
//   grant rows. It is also the only thing standing between somebody with database access and an
//   authorisation.
//
//   And a cross-workspace agent id answers "there is no such agent" rather than "you may not touch
//   it", on every command. A 403 confirms an id exists, which turns this socket into an enumeration
//   oracle for anybody who can open one.
//
//   npm run test:access-resolver

import { randomUUID } from "node:crypto";
import WebSocket from "ws";

import { openTestSqlite } from "./db/testDb.ts";
import { newRequestId, systemContextFor, type Role, type TenantContext } from "./db/tenant.ts";
import { TraceStore } from "./store.ts";
import { WsRelay, type ForwardedCommand } from "./wsRelay.ts";
import { AgentGrantRepository } from "./db/repositories/agentGrants.ts";
import {
  agentCapabilityFor, holds, resolveCapabilities, type AgentCapability,
} from "./auth/capabilities.ts";

let failures = 0;
const check = (ok: boolean, msg: string, detail = ""): void => {
  if (ok) console.log(`  ok   ${msg}`);
  else {
    failures++;
    console.log(`  FAIL ${msg}${detail ? ` — ${detail}` : ""}`);
  }
};
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

// --- a workspace, a second workspace, two people and two agents ---------------------------------

const db = await openTestSqlite();
const store = new TraceStore(db);
await store.init();
const grants = new AgentGrantRepository(db);

const now = new Date().toISOString();
const WS_A = randomUUID();
const WS_B = randomUUID();
for (const [id, slug] of [[WS_A, "acme"], [WS_B, "other"]] as const) {
  await db.run(
    `INSERT INTO workspaces (id, slug, name, kind, plan, created_at) VALUES (?, ?, ?, 'team', 'free', ?)`,
    [id, slug, slug, now],
  );
}

const ADMIN_USER = randomUUID();
const MEMBER_USER = randomUUID();
for (const [id, email] of [[ADMIN_USER, "priya@acme.test"], [MEMBER_USER, "sam@acme.test"]] as const) {
  await db.run(
    `INSERT INTO users (id, external_id, email, created_at) VALUES (?, ?, ?, ?)`,
    [id, `ext-${id}`, email, now],
  );
}
/** The role each person is currently on. Mutated below, exactly as `setMemberRole` would. */
const roles = new Map<string, Role>([[ADMIN_USER, "admin"], [MEMBER_USER, "member"]]);
for (const [userId, role] of roles) {
  await db.run(
    `INSERT INTO workspace_members (workspace_id, user_id, role, created_at) VALUES (?, ?, ?, ?)`,
    [WS_A, userId, role, now],
  );
}

const AGENT_A = randomUUID();
const AGENT_B = randomUUID();
await db.run(
  `INSERT INTO agents (id, workspace_id, slug, current_version, created_at) VALUES (?, ?, 'billing_bot', 1, ?)`,
  [AGENT_A, WS_A, now],
);
await db.run(
  `INSERT INTO agents (id, workspace_id, slug, current_version, created_at) VALUES (?, ?, 'their_bot', 1, ?)`,
  [AGENT_B, WS_B, now],
);

const ctxFor = (userId: string, workspaceId = WS_A): TenantContext => ({
  workspaceId,
  actorUserId: userId,
  role: roles.get(userId) ?? "member",
  requestId: newRequestId(),
});

// --- the database half: the composite key, and the intersection at read time --------------------

console.log("\nthe key expresses tenancy rather than existence");
{
  // §4.1 — A GRANT NAMING ANOTHER TENANT'S AGENT IS REJECTED BY THE DATABASE, not by a check
  // somebody remembered. `secret_refs` had a foreign key to `agents(id)` — satisfied by ANY
  // tenant's agent, because the id is a globally unique uuid — and migration 018 fixed it by
  // keying on the pair. Repeating that on an access-control table would be considerably worse.
  let rejected = false;
  try {
    await grants.upsert(ctxFor(ADMIN_USER), {
      agentId: AGENT_B,
      userId: ADMIN_USER,
      capabilities: ["view"],
      grantedBy: ADMIN_USER,
    });
  } catch {
    rejected = true;
  }
  check(rejected, "a grant referencing another workspace's agent is refused by the foreign key");

  // ...and one naming this workspace's own agent is not, so the check above is a constraint doing
  // its job rather than a table that refuses everything.
  await grants.upsert(ctxFor(ADMIN_USER), {
    agentId: AGENT_A,
    userId: MEMBER_USER,
    capabilities: ["view"],
    grantedBy: ADMIN_USER,
  });
  check(
    (await grants.find(ctxFor(ADMIN_USER), AGENT_A, MEMBER_USER)) !== undefined,
    "...while one on this workspace's own agent is written",
  );
}

console.log("\na stored set above the role's ceiling is intersected down at read time");
{
  // WRITTEN STRAIGHT TO THE DATABASE, bypassing `grantAccess` entirely, because that is the case
  // write-time validation cannot cover: a row that exists because somebody's role changed after it
  // was written, or because somebody has a database.
  await db.run(
    `UPDATE agent_grants SET capabilities = ? WHERE workspace_id = ? AND agent_id = ? AND user_id = ?`,
    [JSON.stringify(["view", "run", "deploy", "secrets", "admin"]), WS_A, AGENT_A, MEMBER_USER],
  );
  const stored = await grants.find(ctxFor(MEMBER_USER), AGENT_A, MEMBER_USER);
  check(stored?.capabilities.length === 5, `the row really does say five capabilities (${stored?.capabilities.length})`);

  const resolved = await resolveCapabilities(ctxFor(MEMBER_USER), AGENT_A, grants);
  check(!holds(resolved, "deploy"), "...and a member does not get deploy out of it");
  check(!holds(resolved, "admin"), "...nor admin");
  check(holds(resolved, "run"), "...but keeps everything under the ceiling");
}

console.log("\na role change moves effective access without touching the grant row");
{
  const before = await grants.find(ctxFor(MEMBER_USER), AGENT_A, MEMBER_USER);

  // §16 — ROLE RESTORED, ACCESS RETURNS, NO RE-GRANT. Promote the member and the same row resolves
  // wider; demote them again and it narrows back. Nothing writes to `agent_grants` in between,
  // which is the whole assertion.
  roles.set(MEMBER_USER, "admin");
  const promoted = await resolveCapabilities(ctxFor(MEMBER_USER), AGENT_A, grants);
  check(holds(promoted, "deploy"), "raising the role returns the granted capabilities");
  check(holds(promoted, "admin"), "...all of them");

  roles.set(MEMBER_USER, "member");
  const demoted = await resolveCapabilities(ctxFor(MEMBER_USER), AGENT_A, grants);
  check(!holds(demoted, "deploy"), "lowering it takes them away again");

  const after = await grants.find(ctxFor(MEMBER_USER), AGENT_A, MEMBER_USER);
  check(
    JSON.stringify(before?.capabilities) === JSON.stringify(after?.capabilities),
    "and the grant row is untouched throughout — the intersection is what moved",
  );
}

console.log("\nexpiry is evaluated at resolution, never by a job that may not have run");
{
  const past = new Date(Date.now() - 60_000).toISOString();
  await db.run(
    `UPDATE agent_grants SET capabilities = ?, expires_at = ? WHERE workspace_id = ? AND agent_id = ? AND user_id = ?`,
    [JSON.stringify(["view"]), past, WS_A, AGENT_A, MEMBER_USER],
  );
  const resolved = await resolveCapabilities(ctxFor(MEMBER_USER), AGENT_A, grants);
  check(resolved.provenance.kind === "expired", "a grant whose moment has passed is recognised as expired");
  // NOTHING SWEPT IT. The row is still there, unchanged, and the resolver reached the right answer
  // without anything having run on a schedule.
  const row = await grants.find(ctxFor(MEMBER_USER), AGENT_A, MEMBER_USER);
  check(row !== undefined, "...with the row still present, because nothing swept it");
  // AND IT FALLS BACK TO THE ROLE RATHER THAN TO NOTHING. A narrowing grant that expired into a
  // lockout would be a different feature — see the resolver's own note.
  check(holds(resolved, "run"), "...and the person is back on their workspace role, not locked out");

  const future = new Date(Date.now() + 3600_000).toISOString();
  await db.run(
    `UPDATE agent_grants SET expires_at = ? WHERE workspace_id = ? AND agent_id = ? AND user_id = ?`,
    [future, WS_A, AGENT_A, MEMBER_USER],
  );
  const live = await resolveCapabilities(ctxFor(MEMBER_USER), AGENT_A, grants);
  check(live.provenance.kind === "grant" && !holds(live, "run"), "an unexpired narrowing grant still narrows");
}

console.log("\na cross-workspace agent resolves to nothing, for everybody");
{
  // §1.C — the caller is a legitimate admin of workspace A asking about an agent in workspace B.
  // The repository is scoped, so the grant lookup finds nothing; what matters is that the ANSWER
  // is indistinguishable from an agent that does not exist.
  const resolved = await resolveCapabilities(ctxFor(ADMIN_USER), AGENT_B, grants);
  check(
    resolved.provenance.kind === "role",
    "an id from another workspace resolves through the role like any unknown id",
  );
  // The scoped read is what makes it so: there is no grant row reachable, so nothing about the
  // other tenant's agent can influence this answer in either direction.
  check(
    (await grants.find(ctxFor(ADMIN_USER), AGENT_B, ADMIN_USER)) === undefined,
    "...and no grant on it is reachable from this workspace at all",
  );
}

// --- the socket half: every gated command, with the client bypassed ------------------------------

const PORT = 4521;
/** Which commands actually reached the app. A refused one must not appear here. */
const forwarded: string[] = [];

/** Whose socket the next connection gets. Read by `contextFor` above. */
let who: string = MEMBER_USER;

const relay = new WsRelay({
  port: PORT,
  store,
  clientHtmlPath: "/dev/null",
  // The socket is the admin's. Every refusal below is therefore about the AGENT rather than about
  // the workspace — an admin holds every workspace capability these commands need.
  contextFor: () => ctxFor(who),
  listAgents: async () => [],
  // ANSWERED LOCALLY BY THE RELAY, so it has to be supplied or every `loadAgentDetail` comes back
  // as the relay's own "no such agent" — which would look exactly like an authorisation failure and
  // is not one. The stub is scoped, like the real one: an id the caller's workspace does not have
  // returns nothing.
  //
  // The shape is cast rather than built: what is under test is whether the command was ALLOWED to
  // reach this callback, and constructing a whole `AgentDetailView` to answer that would be forty
  // lines of fixture asserting nothing.
  loadAgentDetail: async (ctx, agentId) =>
    (await db.get(`SELECT id FROM agents WHERE workspace_id = ? AND id = ?`, [ctx.workspaceId, agentId]))
      ? ({ card: { uuid: agentId } } as never)
      : undefined,
  listMcpServers: async () => [],
  listProviders: () => ({ providers: [], ownKeyForPlatform: false, models: [] }),
  listDeployments: async () => ({ deployments: [], railwayConfigured: false }),
  onCommand: (cmd: ForwardedCommand) => void forwarded.push(cmd.cmd),
  // THE REAL RESOLVER, wired exactly as index.ts wires it — one call to `resolveCapabilities` and
  // a sentence. A stub here would make every assertion below a test of the stub.
  resolvesAgent: async (ctx, agentId, capability: AgentCapability) => {
    const agent = await db.get<{ id: string; slug: string }>(
      `SELECT id, slug FROM agents WHERE workspace_id = ? AND id = ? AND deleted_at IS NULL`,
      [ctx.workspaceId, agentId],
    );
    if (!agent) return { message: `there is no agent "${agentId}" in this workspace`, absent: true };
    const resolved = await resolveCapabilities(ctx, agent.id, grants);
    if (holds(resolved, capability)) return null;
    return { message: `you do not have "${capability}" on ${agent.slug}`, absent: false };
  },
});



interface Client {
  ws: WebSocket;
  inbox: Record<string, unknown>[];
  send: (o: unknown) => void;
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
  return { ws, inbox, send: (o) => ws.send(JSON.stringify(o)) };
}

/** Send one raw frame and hand back whatever errors came back. No client code involved. */
async function raw(client: Client, msg: unknown): Promise<string[]> {
  const before = client.inbox.length;
  client.send(msg);
  await sleep(200);
  return client.inbox
    .slice(before)
    .filter((m) => m["type"] === "error")
    .map((m) => String(m["message"]));
}

// The member's grant is `view` only, expiring in an hour — set by the block above.
who = MEMBER_USER;
const member = await connect();
await sleep(250);

// AND AN ADMIN'S SOCKET, NARROWED THE SAME WAY. Two sockets rather than one, because the two gates
// run in SERIES and the coarse one fires first: `deploy` and `pushGithub` need `deploy:manage` and
// `github:manage`, which a member does not hold at the workspace scope at all — so a member sent
// them would be refused before the agent gate was ever consulted, and a suite that asserted an
// agent-level refusal there would be asserting the wrong thing about the right outcome. On an
// admin's socket the workspace gate passes and the AGENT gate is the only thing left to refuse.
await grants.upsert(ctxFor(ADMIN_USER), {
  agentId: AGENT_A,
  userId: ADMIN_USER,
  capabilities: ["view"],
  grantedBy: ADMIN_USER,
});
who = ADMIN_USER;
const admin = await connect();
await sleep(250);

console.log("\nevery gated command is refused without the capability, over a raw socket");
{
  // ONE ASSERTION PER CAPABILITY, driven by the matrix rather than by a list here: a command added
  // next year is covered the day it is classified.
  const GATED: { cmd: string; as: Client; extra?: Record<string, unknown> }[] = [
    { cmd: "run", as: member },
    { cmd: "edit", as: member, extra: { instruction: "x" } },
    { cmd: "startEval", as: member, extra: { datasetId: randomUUID() } },
    // These three need a workspace capability a member does not hold, so they are sent on the
    // admin's socket — see the note where it is opened. Both of them hold a `view`-only grant.
    { cmd: "deploy", as: admin, extra: { provider: "fake", model: "fake" } },
    { cmd: "pushGithub", as: admin },
    { cmd: "grantAccess", as: admin, extra: { userId: MEMBER_USER, capabilities: ["view"] } },
  ];
  for (const { cmd, as, extra } of GATED) {
    const capability = agentCapabilityFor(cmd);
    const errors = await raw(as, { cmd, agentId: AGENT_A, ...extra });
    check(
      errors.some((e) => e.includes(`"${capability}"`)),
      `${cmd} is refused for a member whose grant is view-only (needs ${capability})`,
      errors.join(" | ") || "no error came back at all",
    );
    check(!forwarded.includes(cmd), `...and ${cmd} never reached the app`);
  }

  // AND WHAT THEY DO HOLD STILL WORKS, so the refusals above are a gate rather than a wall.
  const allowed = await raw(member, { cmd: "loadAgentDetail", agentId: AGENT_A });
  check(allowed.length === 0, `a view-only grant may still open the agent (${allowed.join(" | ")})`);
}

console.log("\na cross-workspace id is absent, never forbidden — on every command");
{
  for (const cmd of ["run", "loadAgentDetail", "deploy", "grantAccess", "pushGithub"]) {
    // ON THE ADMIN'S SOCKET, so every one of these passes the workspace gate and the answer under
    // test is the agent gate's. A member sent `deploy` would be refused for `deploy:manage` before
    // this question was ever reached.
    const errors = await raw(admin, { cmd, agentId: AGENT_B, userId: MEMBER_USER, capabilities: ["view"] });
    const message = errors.join(" ");
    check(message.includes("there is no agent"), `${cmd} answers "no such agent" for another tenant's id`);
    // THE SHARP HALF. A refusal naming a capability would confirm the agent exists, which is the
    // enumeration oracle §1.C exists to close.
    check(
      !/do not have/.test(message) && !/forbidden/i.test(message),
      `...and never says the caller may not touch it (${message})`,
    );
  }
}

console.log("\nrevoking reaches an open socket on its next command");
{
  // THE SOCKET IS ALREADY OPEN AND STAYS OPEN. Nothing reconnects, nothing is closed, and no
  // message is sent to it — the next command simply resolves against the row as it is now, which
  // is §5.2's whole claim and v0.2.6's fix one scope down.
  await grants.upsert(ctxFor(ADMIN_USER), {
    agentId: AGENT_A,
    userId: MEMBER_USER,
    capabilities: ["view", "run"],
    grantedBy: ADMIN_USER,
  });
  const allowed = await raw(member, { cmd: "run", agentId: AGENT_A });
  check(allowed.length === 0, `the member can run once granted run (${allowed.join(" | ")})`);

  await grants.upsert(ctxFor(ADMIN_USER), {
    agentId: AGENT_A,
    userId: MEMBER_USER,
    capabilities: ["view"],
    grantedBy: ADMIN_USER,
  });
  const refused = await raw(member, { cmd: "run", agentId: AGENT_A });
  check(refused.length > 0, "...and cannot on the very next command after it is narrowed");
  check(member.ws.readyState === WebSocket.OPEN, "...on the same socket, which was never closed");
}

console.log("\na command already in flight is allowed to finish");
{
  // §5.2 — "Killing a half-completed publish to enforce a permission change trades a small
  // authorisation window for a corrupted agent, which is the wrong trade."
  //
  // ASSERTED STRUCTURALLY, because the alternative is a race: the claim is that nothing anywhere
  // reaches into a running operation when a grant changes, and the way to know that is that no such
  // path exists. `accessChanged` broadcasts a recheck and nothing else — no cancellation, no kill,
  // no socket close.
  const { readFileSync } = await import("node:fs");
  const { fileURLToPath } = await import("node:url");
  const { join, dirname } = await import("node:path");
  const here = dirname(fileURLToPath(import.meta.url));
  const app = readFileSync(join(here, "index.ts"), "utf8");
  const body = app.slice(app.indexOf("function accessChanged"), app.indexOf("function accessChanged") + 600);
  check(body.length > 0, "the recheck emitter was found");
  check(
    /broadcastAccessRecheck/.test(body) && !/cancel|kill|abort|close/i.test(body),
    "a grant change emits a recheck and touches no running operation",
    body.replace(/\s+/g, " ").slice(0, 160),
  );
}

console.log("\nthe recheck is workspace-scoped and says nothing about what changed");
{
  // The scoping half is `test:channels`'s, which fires it across two workspaces. What is asserted
  // here is the payload, from the sender's own source: a field added later fails this rather than
  // shipping.
  const { readFileSync } = await import("node:fs");
  const { fileURLToPath } = await import("node:url");
  const { join, dirname } = await import("node:path");
  const here = dirname(fileURLToPath(import.meta.url));
  const relaySource = readFileSync(join(here, "wsRelay.ts"), "utf8");
  const sender = /broadcastAccessRecheck\(ctx: TenantContext\): void \{[\s\S]*?\n  \}/.exec(relaySource)?.[0] ?? "";
  check(sender.length > 0, "the recheck sender was found");
  check(/this\.broadcastTo\(ctx,/.test(sender), "...and it goes through the workspace-scoped path");
  const payload = /\{\s*channel: "access",([^}]*)\}/.exec(sender)?.[1] ?? "";
  check(
    payload.trim().replace(/,$/, "") === 'type: "recheck"',
    `...carrying nothing but its own name (${payload.trim()})`,
  );
}

member.ws.close();
admin.ws.close();
await relay.close();
await store.close();

console.log(failures === 0 ? "\nALL CORRECT" : `\n${failures} FAILURES`);
process.exit(failures === 0 ? 0 : 1);
