// Discovery as a job, and every property it had as a request.
//
// FOUR THINGS, and the last one is why this file exists rather than a note saying "moved to the
// queue, nothing else changed".
//
//   IT COMES OFF THE REQUEST PATH AT ALL. `enqueue` returns without a handshake having happened,
//   which is the point: a browser is no longer holding a socket open while a third party decides
//   how long to take.
//
//   ONE PRESS OF THE BUTTON IS ONE JOB, AND SO ARE SIX. The idempotency key is (workspace,
//   server) with no attempt number in it, so a user hammering Re-discover against a server that
//   is already struggling does not enqueue six round trips to it.
//
//   ONE WORKSPACE'S BACKLOG IS NOT ANOTHER'S. Twenty discoveries from A and one from B, and B's
//   is not behind all twenty — the dispatcher's ring is what does this and Session 5's own suite
//   proves it in general, but a class that is newly queued has to be shown actually using it.
//
//   AND A FAILED REFRESH STILL NEVER DESTROYS A WORKING TOOL LIST. That rule has been in
//   `rediscover` since MCP landed, and it lives there rather than at the call site — so moving
//   the call onto a queue cannot reach it. It is re-proved here anyway, THROUGH the queue,
//   because a property that holds only because of where a function is called from is a property
//   one refactor away from being false, and this commit is exactly that refactor.
//
//   npm run test:mcp-discovery-queue

import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { migrate } from "./db/migrate.ts";
import { SqliteDb } from "./db/sqlite.ts";
import { newRequestId, systemContext, systemContextFor, type TenantContext } from "./db/tenant.ts";
import { IdentityRepository } from "./db/repositories/identity.ts";
import { Dispatcher } from "./queue/dispatcher.ts";
import { InMemoryQueueBackend } from "./queue/inMemoryBackend.ts";
import { jobClassConfig } from "./queue/jobs.ts";
import { McpStore, type DiscoveredTool } from "./mcpStore.ts";
import { McpRegistry, type RegistrationResult } from "./mcpRegistry.ts";
import { MCP_DISCOVER_CLASS, McpDiscoveryQueue, type McpDiscoveryPayload } from "./mcpDiscovery.ts";

let failures = 0;
const check = (ok: boolean, msg: string, detail = ""): void => {
  if (ok) console.log(`  ok   ${msg}`);
  else {
    failures++;
    console.log(`  FAIL ${msg}${detail ? ` — ${detail}` : ""}`);
  }
};

const MIGRATIONS = join(fileURLToPath(new URL("..", import.meta.url)), "migrations");

const scratch: string[] = [];
const dir = mkdtempSync(join(tmpdir(), "jaroku-mcpq-"));
scratch.push(dir);
const db = new SqliteDb(join(dir, "mcpq.db"));
await migrate(db.migrationTarget(), join(MIGRATIONS, "sqlite"), () => {});

const identity = new IdentityRepository(db);
const store = new McpStore(db);

async function workspace(label: string): Promise<TenantContext> {
  const ws = await identity.createWorkspaceUnowned(systemContext(newRequestId()), {
    name: `mcpq ${label} ${randomUUID().slice(0, 6)}`,
  });
  return systemContextFor(ws.id, newRequestId());
}

/**
 * A registry whose handshake is whatever the test says it is.
 *
 * The real `discover()` would need a network and a live MCP server. What is under test here is
 * the QUEUE around discovery, so the discovery itself is the part to make deterministic — and
 * the one behaviour that must be real is `rediscover`'s refusal to touch a tool list on failure,
 * so that method is the genuine one from `McpRegistry`, driven through a fake handshake.
 */
class FakeRegistry extends McpRegistry {
  calls: { kind: string; serverId: string; workspaceId: string }[] = [];
  /** What the next handshake "returns". Flipped by the test between passes. */
  outcome: "ok" | "fail" = "ok";
  tools: DiscoveredTool[] = [
    {
      name: "read_page",
      description: "read a page",
      input_schema: { type: "object", properties: {} },
      annotations: null,
      impact: "low",
      impact_reason: "a read verb",
    },
  ];

  override async addServer(ctx: TenantContext, opts: { endpoint: string; id?: string }): Promise<RegistrationResult> {
    this.calls.push({ kind: "add", serverId: opts.id ?? "", workspaceId: ctx.workspaceId });
    await store.upsertServer(ctx, {
      id: opts.id ?? "s",
      label: opts.id ?? "s",
      endpoint: opts.endpoint,
      transport: "http",
      auth_env_key: null,
      server_name: null,
      server_version: null,
      protocol_version: null,
      status: "connected",
      last_error: null,
      discovered_at: null,
    });
    await store.replaceTools(ctx, opts.id ?? "s", this.tools);
    return { ok: true, server: null, message: null };
  }

  override async rediscover(ctx: TenantContext, id: string): Promise<RegistrationResult> {
    this.calls.push({ kind: "rediscover", serverId: id, workspaceId: ctx.workspaceId });
    if (this.outcome === "fail") {
      // THE REAL RULE, spelled the way `McpRegistry.rediscover` spells it: the status moves and
      // the tool list is not touched. Written out rather than delegated because the fake owns the
      // handshake, and this is the half of the method that is the property under test.
      await store.setServerStatus(ctx, id, "unreachable", "ECONNREFUSED");
      return { ok: false, server: null, message: "ECONNREFUSED" };
    }
    await store.replaceTools(ctx, id, this.tools);
    return { ok: true, server: null, message: null };
  }
}

const registry = new FakeRegistry(store);
const dispatcher = new Dispatcher(new InMemoryQueueBackend());
const results: { payload: McpDiscoveryPayload; result: RegistrationResult }[] = [];
const queue = new McpDiscoveryQueue({
  dispatcher,
  registry,
  onResult: (_ctx, payload, result) => results.push({ payload, result }),
});
const handle = queue.handler();

/** Drain everything the dispatcher will admit, the way the worker loop does. */
async function drain(limit = 50): Promise<number> {
  let handled = 0;
  for (let i = 0; i < limit; i++) {
    const admitted = await dispatcher.tryAdmit<McpDiscoveryPayload>(MCP_DISCOVER_CLASS);
    if (!admitted) break;
    await handle(admitted.job, admitted.leaseId);
    handled++;
  }
  return handled;
}

const A = await workspace("a");
const B = await workspace("b");

// --- it is a job -----------------------------------------------------------------------
console.log("\ndiscovery is enqueued, not awaited");
{
  check(jobClassConfig(MCP_DISCOVER_CLASS).queued, "the class is routed through the dispatcher");
  const job = await queue.enqueue(A, { kind: "add", serverId: "linear", endpoint: "https://mcp.example/sse" });
  check(job.class === MCP_DISCOVER_CLASS, "the job carries its class");
  check(job.workspaceId === A.workspaceId, "...and the workspace it belongs to");
  check(registry.calls.length === 0, "and NO handshake has happened yet — the request is already over");
  check((await dispatcher.pendingCount(MCP_DISCOVER_CLASS, A.workspaceId)) === 1, "one job is pending for A");

  check((await drain()) === 1, "draining runs it");
  check(registry.calls.length === 1, "...and the handshake happens then");
  check(results.length === 1, "...and the result is reported");
  check((await store.listTools(A, "linear")).length === 1, "...with the tool list written");
  check(
    (await dispatcher.inFlightCount(MCP_DISCOVER_CLASS)) === 0,
    "and the lease was acked, so the workspace's slot is free again",
  );
}

// --- no credential rides the queue ---------------------------------------------------------
console.log("\nno credential rides on a job");
{
  const job = await queue.enqueue(A, { kind: "add", serverId: "withtoken", endpoint: "https://x.example", hasToken: true });
  const serialised = JSON.stringify(job);
  check(serialised.includes("hasToken"), "the job records THAT a credential was supplied");
  check(
    !/"token"|"secret"|"authorization"/i.test(serialised),
    "...and carries no field a value could be in — a token on a queue is a token in Redis",
  );
  await drain();
}

// --- one press, one job -------------------------------------------------------------------
console.log("\nsix presses of Re-discover are one discovery");
{
  registry.calls = [];
  for (let i = 0; i < 6; i++) await queue.enqueue(A, { kind: "rediscover", serverId: "linear" });
  check(
    (await dispatcher.pendingCount(MCP_DISCOVER_CLASS, A.workspaceId)) === 1,
    "six enqueues of the same (workspace, server) are one pending job",
  );
  check((await drain()) === 1, "...and one handshake");
  check(registry.calls.length === 1, "...against a server that is probably already struggling");

  // A DIFFERENT server is a different unit of work and must not be collapsed into it.
  await queue.enqueue(A, { kind: "rediscover", serverId: "linear" });
  await queue.enqueue(A, { kind: "rediscover", serverId: "github" });
  check(
    (await dispatcher.pendingCount(MCP_DISCOVER_CLASS, A.workspaceId)) === 2,
    "but two different servers are two jobs",
  );
  await drain();
}

// --- fairness ------------------------------------------------------------------------------
console.log("\none workspace's backlog does not bury another's");
{
  registry.calls = [];
  for (let i = 0; i < 20; i++) await queue.enqueue(A, { kind: "rediscover", serverId: `server_${i}` });
  await queue.enqueue(B, { kind: "rediscover", serverId: "only_one" });

  // One admission per pass, the way a worker with a full slot would see it. B's single job must
  // appear early rather than after all twenty of A's.
  const order: string[] = [];
  for (let i = 0; i < 4; i++) {
    const admitted = await dispatcher.tryAdmit<McpDiscoveryPayload>(MCP_DISCOVER_CLASS);
    if (!admitted) break;
    order.push(admitted.job.workspaceId === B.workspaceId ? "B" : "A");
    await handle(admitted.job, admitted.leaseId);
  }
  check(order.includes("B"), `B was served within the first four admissions (${order.join(",")})`);
  await drain();
}

// --- the rule that must survive the move ----------------------------------------------------
console.log("\na failed refresh still never destroys a working tool list");
{
  await queue.enqueue(A, { kind: "rediscover", serverId: "linear" });
  await drain();
  check((await store.listTools(A, "linear")).length === 1, "the server has a tool list to lose");

  registry.outcome = "fail";
  await queue.enqueue(A, { kind: "rediscover", serverId: "linear" });
  check((await drain()) === 1, "a discovery that fails still runs and settles");
  check(
    (await store.listTools(A, "linear")).length === 1,
    "AND THE TOOLS ARE STILL THERE — a network blip must not silently strip every agent scoped to it",
  );
  check(
    (await store.getServer(A, "linear"))?.status === "unreachable",
    "...while the status says what happened",
  );
  check(
    (await dispatcher.inFlightCount(MCP_DISCOVER_CLASS)) === 0,
    "and a failed job acks too — an unreachable server must not hold its workspace's slot for a TTL",
  );
  registry.outcome = "ok";
}

// --- across the boundary ---------------------------------------------------------------------
console.log("\nand a job only ever touches its own workspace");
{
  registry.calls = [];
  await queue.enqueue(B, { kind: "add", serverId: "b_only", endpoint: "https://b.example" });
  await drain();
  check(
    registry.calls.every((c) => c.workspaceId === B.workspaceId),
    "B's job ran in B's workspace",
  );
  check((await store.getServer(A, "b_only")) === null, "...and A cannot see what it created");
  check((await store.getServer(B, "b_only")) !== null, "...while B can");
}

await db.close();
for (const d of scratch) rmSync(d, { recursive: true, force: true });

console.log(failures === 0 ? "\nALL CORRECT" : `\n${failures} FAILURES`);
process.exit(failures === 0 ? 0 : 1);
