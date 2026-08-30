// The fact pack: bounded, scoped, ordered, and the same number of statements for one agent and for
// forty.
//
// FOUR CLAIMS, AND §13 NAMES ALL FOUR. "the fact pack is bounded, scoped to one workspace, ordered
// with created_seq as tie-break, and its statement count is equal for one agent and for forty."
//
// THE STATEMENT COUNT IS ASSERTED AS AN EQUALITY, not as a threshold, for the reason the Agents
// grid's own suite gives: a threshold is a budget somebody spends. A pack assembled per question is
// an N-query risk on a busy workspace, and the version of this that is wrong is not slow — it is
// fine on the laptop it was written on and forty round trips per question in a workspace with a
// fleet.
//
// THE ORDERING TEST USES A SAME-MILLISECOND PAIR, because that is the case the tie-break exists
// for and the only one where its absence is observable. Two jobs a second apart sort correctly with
// or without it; two dispatched by a double-click sort by whatever the planner chose.
//
//   npm run test:convo-facts

import { randomUUID } from "node:crypto";

import { countingDb, openTestSqlite, testContext } from "./../db/testDb.ts";
import { newRequestId, systemContextFor } from "./../db/tenant.ts";
import { buildFactPack, FIELD_CHARS, PACK_ITEMS, type PackDeps } from "./factPack.ts";
import { WorkStore } from "./workStore.ts";
import type { Db } from "./../db/db.ts";
import type { TenantContext } from "./../db/tenant.ts";

let fail = 0;
const check = (name: string, ok: boolean, detail = ""): void => {
  if (ok) console.log(`  ok   ${name}`);
  else { fail++; console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ""}`); }
};

const A = testContext();
// A SECOND WORKSPACE, because every claim about scoping is a claim about what is NOT returned and
// a single-tenant fixture cannot observe one.
const B = systemContextFor("22222222-2222-4222-8222-222222222222", newRequestId());

/**
 * The actor a job is attributed to, per workspace.
 *
 * A CONSTANT RATHER THAN `ctx.actorUserId`, because `testContext` is a SYSTEM context and a system
 * context has no actor — which is correct, and is exactly why `work_items.created_by` is NOT NULL:
 * migration 063 refuses a job with nobody behind it, so a suite that wanted one had to invent a
 * person the same way a dispatch does.
 */
const USER: Record<string, string> = {
  [A.workspaceId]: "aaaaaaaa-0000-4000-8000-00000000000a",
  [B.workspaceId]: "bbbbbbbb-0000-4000-8000-00000000000b",
};

/** One deployment per workspace: the id is a primary key across the whole table, not per tenant. */
const deploymentFor = (ctx: TenantContext): string => `dep-${ctx.workspaceId.slice(0, 8)}`;

/** Nothing in these two reads changes with the number of agents, which is the point of injecting them. */
const deps = (model = "fake-scripted", unreviewed: string[] = []): PackDeps => ({
  modelByDeployment: async (ctx): Promise<Map<string, string>> => new Map([[deploymentFor(ctx), model]]),
  unreviewedRunIds: async (): Promise<Set<string>> => new Set(unreviewed),
});

async function seedWorkspace(db: Db, ctx: TenantContext): Promise<void> {
  const at = "2026-01-01T00:00:00.000Z";
  await db.run(
    `INSERT OR IGNORE INTO workspaces (id, slug, name, kind, plan, created_at)
     VALUES (?, ?, ?, 'personal', 'free', ?)`,
    [ctx.workspaceId, `ws-${ctx.workspaceId.slice(0, 8)}`, "Seeded", at],
  );
  const user = USER[ctx.workspaceId]!;
  await db.run(
    `INSERT OR IGNORE INTO users (id, external_id, email, created_at) VALUES (?, ?, ?, ?)`,
    [user, `ext-${user}`, `${user}@example.com`, at],
  );
}

async function seedAgent(db: Db, ctx: TenantContext, slug: string): Promise<string> {
  const id = randomUUID();
  const at = "2026-01-01T00:00:00.000Z";
  await db.run(
    `INSERT INTO agents (id, workspace_id, slug, display_name, connectors, mcp_tools,
                         required_env, default_provider, created_at)
     VALUES (?, ?, ?, ?, '[]', '[]', '[]', 'fake', ?)`,
    [id, ctx.workspaceId, slug, slug, at],
  );
  await db.run(
    `INSERT INTO deployments (id, workspace_id, agent_id, target, status, provider, model,
                              env_keys, created_at, updated_at, created_seq)
     VALUES (?, ?, ?, 'railway', 'live', 'fake', 'fake-scripted', '[]', ?, ?, 1)
     ON CONFLICT (id) DO NOTHING`,
    [deploymentFor(ctx), ctx.workspaceId, id, at, at],
  );
  return id;
}

interface JobSpec {
  status?: string;
  input?: string;
  output?: string | null;
  error?: string | null;
  failureKind?: string | null;
  createdAt?: string;
  seq?: number;
  runId?: string | null;
  endedAt?: string | null;
}

let jobN = 0;
async function seedJob(db: Db, ctx: TenantContext, agentId: string, spec: JobSpec = {}): Promise<string> {
  const id = randomUUID();
  const at = spec.createdAt ?? `2026-01-01T00:00:${String(++jobN).padStart(2, "0")}.000Z`;
  await db.run(
    `INSERT INTO work_items (id, workspace_id, agent_id, deployment_id, run_id, created_by,
                             input, status, output, error, failure_kind,
                             created_at, started_at, ended_at, created_seq)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      id, ctx.workspaceId, agentId, deploymentFor(ctx),
      spec.runId === undefined ? randomUUID() : spec.runId,
      USER[ctx.workspaceId]!, spec.input ?? "send the invoice", spec.status ?? "succeeded",
      spec.output ?? null, spec.error ?? null, spec.failureKind ?? null,
      at, at, spec.endedAt === undefined ? at : spec.endedAt, spec.seq ?? 0,
    ],
  );
  return id;
}

console.log("\nan empty record");
{
  const db = await openTestSqlite();
  await seedWorkspace(db, A);
  const agentId = await seedAgent(db, A, "tracey");
  const pack = await buildFactPack(A, db.forWorkspace(A.workspaceId), deps(),
    { agents: [{ id: agentId, name: "Tracey" }] });
  check("an agent with no jobs produces an empty pack", pack.items.length === 0);
  check("...and says the record is empty rather than truncated",
    pack.truncation.total === 0 && !pack.truncation.by_count && !pack.truncation.by_bytes);
  // A REQUEST NAMING NO AGENTS MUST NOT WIDEN INTO THE WORKSPACE. The opposite is the one bug in
  // this file that would leak: "who is this about" answered with "everybody".
  const none = await buildFactPack(A, db.forWorkspace(A.workspaceId), deps(), { agents: [] });
  check("a pack for no agents is empty, never the workspace's", none.items.length === 0);
  await db.close();
}

console.log("\nwhat a fact carries");
{
  const db = await openTestSqlite();
  await seedWorkspace(db, A);
  const agentId = await seedAgent(db, A, "tracey");
  const runId = randomUUID();
  const failed = await seedJob(db, A, agentId, {
    status: "failed", error: "SMTPAuthenticationError: 535", failureKind: "agent_error", runId,
  });
  const pack = await buildFactPack(A, db.forWorkspace(A.workspaceId), deps("fake-scripted", [runId]),
    { agents: [{ id: agentId, name: "Tracey" }] });
  const row = pack.items[0];
  // §7.4: EVERY FACT CARRIES ITS `work_items.id`. Without it a claim is unverifiable, which is the
  // whole anti-hallucination mechanism this part rests on.
  check("every fact carries its work_items.id", row?.id === failed, String(row?.id));
  check("...and the agent's display name, not just its uuid", row?.agent_name === "Tracey");
  check("...the status and the failure kind", row?.status === "failed" && row?.failure_kind === "agent_error");
  check("...and the run id, so a citation can reach the trace", row?.run_id === runId);
  check("a failure with an open inbox card reads as unreviewed", row?.trace_reviewed === false);
  // COST IS NULL FOR AN UNPRICED MODEL, NEVER ZERO. `fake-scripted` is not in the pricing table.
  check("an unpriced model reports null cost, never $0", row?.cost_usd === null, String(row?.cost_usd));
  check("and the counts are over the whole record", pack.counts.failed === 1);

  const reviewed = await buildFactPack(A, db.forWorkspace(A.workspaceId), deps("fake-scripted", []),
    { agents: [{ id: agentId, name: "Tracey" }] });
  check("the same failure with no open card reads as reviewed", reviewed.items[0]?.trace_reviewed === true);

  // ONLY A FAILURE CAN BE UNREVIEWED. A succeeded job reported as "nobody opened its trace" is true
  // and useless, and would put an action beside something that needs none.
  const okRun = randomUUID();
  await seedJob(db, A, agentId, { status: "succeeded", runId: okRun });
  const both = await buildFactPack(A, db.forWorkspace(A.workspaceId), deps("fake-scripted", [okRun]),
    { agents: [{ id: agentId, name: "Tracey" }] });
  check("a succeeded job is never 'unreviewed'",
    both.items.every((i) => i.status === "failed" || i.trace_reviewed));
  await db.close();
}

console.log("\nscoped to one workspace");
{
  const db = await openTestSqlite();
  await seedWorkspace(db, A);
  await seedWorkspace(db, B);
  const mine = await seedAgent(db, A, "tracey");
  const theirs = await seedAgent(db, B, "tracey");
  await seedJob(db, A, mine, { input: "mine" });
  await seedJob(db, B, theirs, { input: "theirs" });

  const pack = await buildFactPack(A, db.forWorkspace(A.workspaceId), deps(),
    { agents: [{ id: mine, name: "Tracey" }] });
  check("a pack holds only this workspace's jobs", pack.items.length === 1 && pack.items[0]?.input === "mine",
    pack.items.map((i) => i.input).join("|"));

  // THE NEGATIVE DIRECTION, which is the one that matters: naming ANOTHER workspace's agent id
  // resolves to nothing rather than to that workspace's record. The scoped WHERE is the whole of
  // the enforcement on this driver — migration 009 grants it no RLS at all.
  const across = await buildFactPack(A, db.forWorkspace(A.workspaceId), deps(),
    { agents: [{ id: theirs, name: "Tracey" }] });
  check("naming another workspace's agent reads as absent, not as theirs", across.items.length === 0,
    across.items.map((i) => i.input).join("|"));
  check("...and its counts are zero rather than the other workspace's", across.truncation.total === 0);
  await db.close();
}

console.log("\nordered, with created_seq as the tie-break");
{
  const db = await openTestSqlite();
  await seedWorkspace(db, A);
  const agentId = await seedAgent(db, A, "tracey");
  const same = "2026-03-01T09:00:00.000Z";
  // THE DOUBLE-CLICK. Same millisecond, different sequence — which is exactly the pair migration
  // 063 added `created_seq` for and the only case where its absence is visible.
  const first = await seedJob(db, A, agentId, { createdAt: same, seq: 1, input: "first" });
  const second = await seedJob(db, A, agentId, { createdAt: same, seq: 2, input: "second" });
  const older = await seedJob(db, A, agentId, { createdAt: "2026-03-01T08:00:00.000Z", seq: 9, input: "older" });

  const pack = await buildFactPack(A, db.forWorkspace(A.workspaceId), deps(),
    { agents: [{ id: agentId, name: "Tracey" }] });
  check("newest first", pack.items[0]?.id === second, pack.items.map((i) => i.input).join(" > "));
  check("...with created_seq breaking a same-millisecond tie", pack.items[1]?.id === first);
  check("...and the older job last", pack.items[2]?.id === older);
  await db.close();
}

console.log("\nbounded by count and by bytes");
{
  const db = await openTestSqlite();
  await seedWorkspace(db, A);
  const agentId = await seedAgent(db, A, "tracey");
  for (let i = 0; i < PACK_ITEMS + 5; i++) {
    await seedJob(db, A, agentId, { createdAt: `2026-04-01T00:${String(i).padStart(2, "0")}:00.000Z` });
  }
  const pack = await buildFactPack(A, db.forWorkspace(A.workspaceId), deps(),
    { agents: [{ id: agentId, name: "Tracey" }] });
  check("the pack stops at the item cap", pack.items.length === PACK_ITEMS, String(pack.items.length));
  check("...and says it was cut by count", pack.truncation.by_count);
  check("...and reports the true total anyway", pack.truncation.total === PACK_ITEMS + 5,
    String(pack.truncation.total));

  await db.close();
}

console.log("\nand by bytes, which is the cap a count cannot stand in for");
{
  const db = await openTestSqlite();
  await seedWorkspace(db, A);
  const agentId = await seedAgent(db, A, "tracey");
  // THIRTY JOBS, UNDER THE ITEM CAP, each answering with a document. A pack bounded only by count
  // fits until the day an agent starts returning JSON — which is exactly this fixture: every field
  // is trimmed to `FIELD_CHARS` and thirty trimmed rows are still over the byte budget.
  for (let i = 0; i < 30; i++) {
    await seedJob(db, A, agentId, {
      createdAt: `2026-05-01T00:${String(i).padStart(2, "0")}:00.000Z`,
      input: "x".repeat(5_000), output: "y".repeat(5_000),
    });
  }
  const pack = await buildFactPack(A, db.forWorkspace(A.workspaceId), deps(),
    { agents: [{ id: agentId, name: "Tracey" }] });
  check("a pack of large jobs is cut before the item cap", pack.items.length < 30, String(pack.items.length));
  check("...and says which limit it hit — bytes, not count",
    pack.truncation.by_bytes && !pack.truncation.by_count,
    `by_bytes=${pack.truncation.by_bytes} by_count=${pack.truncation.by_count}`);
  check("...and at least one job still made it in", pack.items.length >= 1);
  // EVERY FIELD IS TRIMMED, so one enormous job cannot be most of the pack on its own.
  check("...with each field trimmed rather than carried whole",
    pack.items.every((i) => i.input.length <= FIELD_CHARS + 16));
  await db.close();
}

console.log("\none agent and forty");
{
  const raw = await openTestSqlite();
  const meter = countingDb(raw);
  const db = meter.db;
  await seedWorkspace(db, A);
  const agents: { id: string; name: string }[] = [];
  for (let i = 0; i < 40; i++) {
    const id = await seedAgent(db, A, `agent_${i}`);
    agents.push({ id, name: `Agent ${i}` });
    // TWO JOBS EACH, so the forty-agent pack has real rows to page and cost — a count that only
    // held because there was nothing to read would prove nothing.
    await seedJob(db, A, id, { createdAt: `2026-06-01T00:${String(i).padStart(2, "0")}:00.000Z` });
    await seedJob(db, A, id, { createdAt: `2026-06-02T00:${String(i).padStart(2, "0")}:00.000Z` });
  }

  const q = db.forWorkspace(A.workspaceId);
  meter.reset();
  const one = await buildFactPack(A, q, deps(), { agents: agents.slice(0, 1) });
  const forOne = meter.count();

  meter.reset();
  const many = await buildFactPack(A, q, deps(), { agents });
  const forForty = meter.count();

  check("a pack for one agent reads something", one.items.length === 2, String(one.items.length));
  check("a pack for forty reads more", many.items.length === PACK_ITEMS, String(many.items.length));
  // THE EQUALITY §13 ASKS FOR. Not "about the same", not "under ten" — the same number.
  check(`forty agents cost the same statements as one (${forOne} vs ${forForty})`, forOne === forForty);
  // AND THE FIGURE ITSELF, so a change that made both eleven would be visible in the diff rather
  // than passing as "still equal". THREE: the page, the grouped counts, and one batched cost read.
  // The two injected dependencies issue no statement of their own here — in production they are the
  // caller's reads, shared with everything else that surface is already doing.
  check(`and that number is three (${forOne})`, forOne === 3, String(forOne));
  await raw.close();
}

console.log(fail === 0 ? "\nALL CORRECT" : `\n${fail} FAILURES`);
process.exit(fail === 0 ? 0 : 1);
