// §10: asking costs money, it is attributed to the thread, and it is counted separately from what
// the agent itself spends.
//
// THE TWO CLAIMS §13 ASKS FOR ARE NOT THE SAME CLAIM, and the second is the one with a design
// behind it. "Attributed to `usage_events.thread_id`" is plumbing — a column that already existed
// since migration 044, filled in by the answering path. "Counted separately from the agent's
// provider spend" is §10's actual argument: the explainer runs on one model for every question, so
// folding it into an agent's figure adds a CONSTANT to each and makes a cheap agent look expensive.
//
// AND SEPARATE DOES NOT MEAN UNCOUNTED. §10 is explicit: "It still counts toward true spend and
// toward whatever ceiling applies." So the assertions run in both directions — an explain must NOT
// appear under the agent, and it MUST appear in the workspace's total and in the thread's own.
//
// THE THIRD CLAIM IS ONE §10 IMPLIES RATHER THAN STATES, and it is a bug this suite exists to have
// caught: an operate thread's DISPATCHED work is bound to it as a `work` item, not a `run` one, so
// the join `spendByThread` used before Part 3 could not see it. A conversation that spent fourpence
// asking and eleven pounds doing would have rendered fourpence.
//
//   npm run test:convo-spend

import { randomUUID } from "node:crypto";

import { openTestSqlite, testContext } from "../db/testDb.ts";
import { BillingRepository } from "../db/repositories/billing.ts";
import { UsageMeter } from "../billing/usage.ts";
import { ThreadStore } from "../threadStore.ts";
import type { Db } from "../db/db.ts";
import type { TenantContext } from "../db/tenant.ts";

let fail = 0;
const check = (name: string, ok: boolean, detail = ""): void => {
  if (ok) console.log(`  ok   ${name}`);
  else { fail++; console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ""}`); }
};

const ctx = testContext();
const USER = "aaaaaaaa-0000-4000-8000-0000000000sa";
const DEPLOYMENT = "dep-spend";
const AT = "2026-01-01T00:00:00.000Z";

async function seedAgent(db: Db, slug: string): Promise<string> {
  await db.run(
    `INSERT OR IGNORE INTO users (id, external_id, email, created_at) VALUES (?, ?, ?, ?)`,
    [USER, `ext-${USER}`, `${USER}@example.com`, AT],
  );
  const agentId = randomUUID();
  await db.run(
    `INSERT INTO agents (id, workspace_id, slug, display_name, connectors, mcp_tools,
                         required_env, default_provider, created_at)
     VALUES (?, ?, ?, ?, '[]', '[]', '[]', 'fake', ?)`,
    [agentId, ctx.workspaceId, slug, slug, AT],
  );
  await db.run(
    `INSERT INTO deployments (id, workspace_id, agent_id, target, status, provider, model,
                              env_keys, created_at, updated_at, created_seq)
     VALUES (?, ?, ?, 'railway', 'live', 'fake', 'fake-scripted', '[]', ?, ?, 1)
     ON CONFLICT (id) DO NOTHING`,
    [DEPLOYMENT, ctx.workspaceId, agentId, AT, AT],
  );
  return agentId;
}

/** A run row, so `spendByAgent`'s join through `runs` has something to find. */
async function seedRun(db: Db, slug: string): Promise<string> {
  const runId = randomUUID();
  await db.run(
    `INSERT INTO runs (id, workspace_id, agent_id, provider, model, status, started_at)
     VALUES (?, ?, ?, 'fake', 'fake-scripted', 'completed', ?)`,
    [runId, ctx.workspaceId, slug, AT],
  );
  return runId;
}

/** A dispatched job, bound to a thread as §5 binds one: a `work` item carrying the item's id. */
async function seedJob(db: Db, agentId: string, runId: string): Promise<string> {
  const id = randomUUID();
  await db.run(
    `INSERT INTO work_items (id, workspace_id, agent_id, deployment_id, run_id, created_by,
                             input, status, created_at, started_at, ended_at, created_seq)
     VALUES (?, ?, ?, ?, ?, ?, 'send the invoice', 'succeeded', ?, ?, ?, 0)`,
    [id, ctx.workspaceId, agentId, DEPLOYMENT, runId, USER, AT, AT, AT],
  );
  return id;
}

/** What the answering path writes, through the same repository `meterPlatformCall` uses. */
async function meterAsk(
  billing: BillingRepository, threadId: string, usd: number | null,
): Promise<void> {
  await billing.record(ctx, {
    // AT-LEAST-ONCE INGESTION IS WHAT THIS COLUMN IS FOR, so every row here mints its own rather
    // than reusing one — two questions in a thread are two calls and two charges.
    idempotencyKey: randomUUID(),
    kind: "llm.explain",
    // NO RUN ID, and that is the whole of why this is separate from the agent's spend: `llm.explain`
    // is the platform's own thinking, `spendByAgent` groups through `runs`, and a row with no run
    // therefore cannot land under an agent. Asserted below rather than assumed.
    runId: null,
    threadId,
    model: "claude-haiku-4-5",
    provider: "anthropic",
    inputTokens: 900,
    outputTokens: 120,
    totalTokens: 1020,
    costUsd: usd,
    payer: "platform",
    occurredAt: AT,
  });
}

console.log("\nattributed to the thread it was asked in");
{
  const db = await openTestSqlite();
  const billing = new BillingRepository(db);
  const threads = new ThreadStore(db);
  const agentId = await seedAgent(db, "tracey");
  const opA = await threads.create(ctx, { agentId, agentName: "Tracey", title: "A", mode: "operate" });
  const opB = await threads.create(ctx, { agentId, agentName: "Tracey", title: "B", mode: "operate" });

  await meterAsk(billing, opA.id, 0.004);
  await meterAsk(billing, opA.id, 0.002);
  await meterAsk(billing, opB.id, 0.001);

  const ask = await billing.askSpendByThread(ctx);
  check("§10: what asking cost is attributed to usage_events.thread_id",
    Math.abs((ask.get(opA.id)?.usd ?? 0) - 0.006) < 1e-9, String(ask.get(opA.id)?.usd));
  check("...per thread, not per workspace",
    Math.abs((ask.get(opB.id)?.usd ?? 0) - 0.001) < 1e-9, String(ask.get(opB.id)?.usd));
  // A THREAD NOBODY HAS ASKED IN IS ABSENT rather than zero, which is what lets the client render
  // nothing instead of `$0.00` — the same three-case rule the total beside it follows.
  const build = await threads.create(ctx, { agentId, agentName: "Tracey", title: "C" });
  check("a thread nobody has asked in has no entry at all", !ask.has(build.id));
  await db.close();
}

console.log("\nand counted separately from the agent's own spend");
{
  const db = await openTestSqlite();
  const billing = new BillingRepository(db);
  const threads = new ThreadStore(db);
  const agentId = await seedAgent(db, "tracey");
  const op = await threads.create(ctx, { agentId, agentName: "Tracey", title: "ops", mode: "operate" });

  // The agent's own provider call, on its run.
  const runId = await seedRun(db, "tracey");
  await billing.record(ctx, {
    idempotencyKey: randomUUID(), kind: "llm.provider", runId, threadId: null,
    model: "claude-haiku-4-5", provider: "anthropic",
    inputTokens: 100, outputTokens: 50, totalTokens: 150, costUsd: 0.5,
    payer: "platform", occurredAt: AT,
  });
  // And three questions about it.
  for (const usd of [0.004, 0.004, 0.004]) await meterAsk(billing, op.id, usd);

  const byAgent = await billing.spendByAgent(ctx, "2020-01-01T00:00:00.000Z");
  const mine = byAgent.find((r) => r.agentId === "tracey");
  // §10: FOLDING IT IN WOULD ADD A CONSTANT TO EVERY AGENT. Asserted as an exact equality with the
  // provider call alone — "roughly right" would pass with one of the three explains included.
  check("§10: the agent's figure is its own calls and nothing else",
    Math.abs((mine?.usd ?? 0) - 0.5) < 1e-9, String(mine?.usd));
  // AND THE EXPLAINS ARE NOT LOST — they are in the null-agent bucket, beside the generations and
  // the judge verdicts, which is where §10 says they belong.
  const unattributed = byAgent.find((r) => r.agentId === null);
  check("...and the questions are under no agent rather than dropped",
    Math.abs((unattributed?.usd ?? 0) - 0.012) < 1e-9, String(unattributed?.usd));

  // SEPARATE IS NOT UNCOUNTED. §10: "It still counts toward true spend and toward whatever ceiling
  // applies." The workspace total is the sum of both.
  const total = await billing.spendSince(ctx, "2020-01-01T00:00:00.000Z");
  check("§10: it still counts toward true spend",
    Math.abs(total.usd - 0.512) < 1e-9, String(total.usd));

  // AND THE THREAD'S OWN TOTAL INCLUDES IT, which is the figure the row renders.
  const byThread = await billing.spendByThread(ctx);
  check("the thread's total includes what asking cost",
    Math.abs((byThread.get(op.id)?.usd ?? 0) - 0.012) < 1e-9, String(byThread.get(op.id)?.usd));
  await db.close();
}

console.log("\nand a job dispatched from an operate thread is not invisible");
{
  const db = await openTestSqlite();
  const billing = new BillingRepository(db);
  const threads = new ThreadStore(db);
  const agentId = await seedAgent(db, "tracey");
  const op = await threads.create(ctx, { agentId, agentName: "Tracey", title: "ops", mode: "operate" });

  // A JOB, BOUND AS §5 BINDS ONE — a `work` item whose `ref_id` is the work item's id, NOT a run
  // item. This is the shape the old join could not see.
  const runId = await seedRun(db, "tracey");
  const jobId = await seedJob(db, agentId, runId);
  await threads.addItem(ctx, op.id, { kind: "work", refId: jobId });
  await billing.record(ctx, {
    idempotencyKey: randomUUID(), kind: "llm.provider", runId, threadId: null,
    model: "claude-haiku-4-5", provider: "anthropic",
    inputTokens: 100, outputTokens: 50, totalTokens: 150, costUsd: 11.0,
    payer: "platform", occurredAt: AT,
  });
  await meterAsk(billing, op.id, 0.04);

  const byThread = await billing.spendByThread(ctx);
  check("a conversation that dispatched work shows what the work cost",
    Math.abs((byThread.get(op.id)?.usd ?? 0) - 11.04) < 1e-9, String(byThread.get(op.id)?.usd));
  const ask = await billing.askSpendByThread(ctx);
  check("...and the asking figure is the SUBSET, not the total",
    Math.abs((ask.get(op.id)?.usd ?? 0) - 0.04) < 1e-9, String(ask.get(op.id)?.usd));
  // THE SUBSET RELATION IS THE THING A CLIENT COULD GET WRONG BY ADDING THEM. Stated as an
  // assertion so that a future change making `ask` a separate total fails here rather than on
  // somebody's invoice.
  check("...so the ask is never larger than the total",
    (ask.get(op.id)?.usd ?? 0) <= (byThread.get(op.id)?.usd ?? 0));
  await db.close();
}

console.log("\nand it survives the path production actually takes");
{
  /**
   * THROUGH `UsageMeter.meterModelCall` RATHER THAN `BillingRepository.record`.
   *
   * Everything above this block writes rows through the repository, which is the right level for
   * asserting what the AGGREGATES do — and is one level below where the bug was. `meterPlatformCall`
   * declares `threadId` and hands its argument to `meterModelCall`, whose parameter type did not
   * have the field; structural typing accepts an object with an extra property when it arrives as a
   * variable, so it compiled, and every plan, generation, edit and explanation wrote
   * `thread_id = NULL` in silence. The per-thread cost column had been showing agents' runs only
   * since it shipped.
   *
   * So this asserts the seam, not the store: a call metered the way production meters one lands in
   * the thread it names.
   */
  const db = await openTestSqlite();
  const billing = new BillingRepository(db);
  const meter = new UsageMeter(billing, async () => null);
  const threads = new ThreadStore(db);
  const agentId = await seedAgent(db, "tracey");
  const op = await threads.create(ctx, { agentId, agentName: "Tracey", title: "ops", mode: "operate" });

  await meter.meterModelCall(ctx, "llm.explain", {
    model: "claude-haiku-4-5",
    inputTokens: 900,
    outputTokens: 120,
    payer: "platform",
    threadId: op.id,
  });

  // THE COLUMN ITSELF, read directly. `recentEvents` does not select `thread_id` — it is a feed of
  // what was spent, not of what caused it — and asserting through an aggregate would pass against a
  // NULL that some other row happened to cover. The claim is about this column on this row.
  const row = await db.get<{ thread_id: string | null }>(
    `SELECT thread_id FROM usage_events WHERE workspace_id = ? AND kind = 'llm.explain'`,
    [ctx.workspaceId],
  );
  check("a metered explain names the thread it happened in", row?.thread_id === op.id,
    `thread_id=${String(row?.thread_id)}`);
  const ask = await billing.askSpendByThread(ctx);
  check("...so the ask figure finds it", (ask.get(op.id)?.usd ?? 0) > 0, String(ask.get(op.id)?.usd));
  const byThread = await billing.spendByThread(ctx);
  check("...and so does the thread's total", (byThread.get(op.id)?.usd ?? 0) > 0);
  await db.close();
}

console.log("\nunknown is not zero, here as everywhere");
{
  const db = await openTestSqlite();
  const billing = new BillingRepository(db);
  const threads = new ThreadStore(db);
  const agentId = await seedAgent(db, "tracey");
  const op = await threads.create(ctx, { agentId, agentName: "Tracey", title: "ops", mode: "operate" });

  await meterAsk(billing, op.id, 0.004);
  // A QUESTION ON A MODEL WITH NO PRICING ENTRY. SUM skips the null, so the figure that comes back
  // is a FLOOR — and the only thing that says so is the flag beside it. §10's last paragraph.
  await meterAsk(billing, op.id, null);

  const ask = await billing.askSpendByThread(ctx);
  check("an unpriced question makes the ask figure a floor", ask.get(op.id)?.costKnown === false);
  check("...and the sum is what IS known rather than nothing",
    Math.abs((ask.get(op.id)?.usd ?? 0) - 0.004) < 1e-9, String(ask.get(op.id)?.usd));
  const byThread = await billing.spendByThread(ctx);
  check("...and the thread's total says the same", byThread.get(op.id)?.costKnown === false);
  await db.close();
}

console.log(fail === 0 ? "\nALL CORRECT" : `\n${fail} FAILURES`);
process.exit(fail === 0 ? 0 : 1);
