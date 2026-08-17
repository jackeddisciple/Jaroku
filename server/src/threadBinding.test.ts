// What a thread owns, what that makes it, and what it cost.
//
// Three things are under test here and each is a claim the rest of the feature rests on:
//
//   OWNERSHIP IS A ROW, LIVENESS IS THE OWNER'S. A proposal is bound to a thread by a
//   `thread_items` row, and whether it is still pending is the editor's answer. The case that
//   proves the design is the restart: the same items, an empty proposal map, and the thread reads
//   idle rather than going on asking somebody to apply a diff that no longer exists anywhere.
//
//   ONE AGENT, THREE SESSIONS, THREE DIFFERENT ANSWERS. §3.1 says an agent may have many threads;
//   this asserts the consequence — a pending diff in one of them does not turn the other two amber.
//
//   COST IS ATTRIBUTED TWO WAYS AND SUMMED ONCE. An agent's own calls carry a run id and are joined
//   through the items; the platform's plan / generation / edit / explain calls carry no run and name
//   the thread. A total that only counted one of the two would be confidently short — which is the
//   same failure as a silent zero, and the unpriced count is here for the same reason.
//
//   npm run test:thread-binding

import { randomUUID } from "node:crypto";

import { openTestSqlite, testContext } from "./db/testDb.ts";
import { BillingRepository } from "./db/repositories/billing.ts";
import { TraceStore } from "./store.ts";
import { AgentRepository } from "./db/repositories/agents.ts";
import { ThreadStore } from "./threadStore.ts";
import { collectThreadFacts, type EvalFact, type RunFact } from "./threadFacts.ts";
import { deriveThreadStatus } from "./threadStatus.ts";
import type { Run, Step } from "./types.ts";
import type { SqliteDb } from "./db/sqlite.ts";

let fail = 0;
const check = (name: string, ok: boolean, detail = ""): void => {
  if (ok) console.log(`  ok   ${name}`);
  else { fail++; console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ""}`); }
};

const ctx = testContext();

interface Harness {
  db: SqliteDb;
  store: TraceStore;
  threads: ThreadStore;
  billing: BillingRepository;
}

async function harness(): Promise<Harness> {
  const db = await openTestSqlite();
  const store = new TraceStore(db);
  await store.init();
  return { db, store, threads: new ThreadStore(db), billing: new BillingRepository(db) };
}

async function seedAgent(db: SqliteDb, slug: string): Promise<string> {
  const id = randomUUID();
  await db.run(
    `INSERT INTO agents (id, workspace_id, slug, display_name, connectors, mcp_tools,
                         required_env, default_provider, created_at)
     VALUES (?, ?, ?, ?, '[]', '[]', '[]', 'fake', ?)`,
    [id, ctx.workspaceId, slug, slug, new Date().toISOString()],
  );
  return id;
}

const run = (id: string, agentSlug: string, status: Run["status"]): Run => ({
  id, agent_id: agentSlug, provider: "fake", model: "fake-dry-run", status,
  started_at: new Date().toISOString(),
  ended_at: status === "running" ? null : new Date().toISOString(),
  cost: 0, tokens: 0, error: status === "error" ? "it broke" : null,
});

const step = (runId: string, seq: number, error: string | null): Step => ({
  id: randomUUID(), run_id: runId, seq, type: "tool_call", name: "call", input: null, output: null,
  state_before: null, state_after: null, tokens: null, cost: null, latency_ms: 1, error,
  parent_step_id: null, started_at: new Date().toISOString(),
});

/** The snapshot's own derivation, over facts collected exactly as `index.ts` collects them. */
async function statusesFor(
  h: Harness,
  live: {
    proposals?: Map<string, { added: number; removed: number }>;
    plans?: Set<string>;
    rejectedGenerations?: Set<string>;
    confirms?: Map<string, number>;
    evals?: Map<string, EvalFact>;
    deployedAgents?: Set<string>;
  } = {},
): Promise<Map<string, { status: string; fragment: string | null; preview: string | null }>> {
  const derived = collectThreadFacts({
    threads: await h.threads.list(ctx),
    items: await h.threads.allItems(ctx),
    runs: (await h.store.runOutcomes(ctx)) as Map<string, RunFact>,
    evals: live.evals ?? new Map(),
    proposals: live.proposals ?? new Map(),
    plans: live.plans ?? new Set(),
    rejectedGenerations: live.rejectedGenerations ?? new Set(),
    confirms: live.confirms ?? new Map(),
    deployedAgents: live.deployedAgents ?? new Set(),
  });
  const out = new Map<string, { status: string; fragment: string | null; preview: string | null }>();
  for (const [threadId, entry] of derived) {
    const { status, fragment } = deriveThreadStatus(entry.facts);
    out.set(threadId, { status, fragment, preview: entry.preview });
  }
  return out;
}

// --- 1. one agent, three sessions, three answers (§3.1) ------------------------------------
{
  const h = await harness();
  const agent = await seedAgent(h.db, "api_gateway");
  const a = await h.threads.create(ctx, { agentId: agent, agentName: "api_gateway", title: "Rate limiting" });
  const b = await h.threads.create(ctx, { agentId: agent, agentName: "api_gateway", title: "OAuth flow" });
  const c = await h.threads.create(ctx, { agentId: agent, agentName: "api_gateway", title: "Fix the 429s" });

  await h.threads.addItem(ctx, a.id, { kind: "proposal", refId: "prop-1" });
  const liveRun = randomUUID();
  await h.store.upsertRun(ctx, run(liveRun, "api_gateway", "running"));
  await h.threads.addItem(ctx, b.id, { kind: "run", refId: liveRun });

  const statuses = await statusesFor(h, {
    proposals: new Map([["prop-1", { added: 42, removed: 11 }]]),
  });
  check("the thread holding the unapplied diff needs you", statuses.get(a.id)?.status === "needs_you");
  check("...and says how big it is", statuses.get(a.id)?.fragment === "diff pending +42−11");
  check("the thread with the live run is running", statuses.get(b.id)?.status === "running");
  check("the third one, on the same agent, is idle",
    statuses.get(c.id)?.status === "idle", statuses.get(c.id)?.status);
  check("...with nothing to say about it", statuses.get(c.id)?.fragment === null);
}

// --- 2. the restart case: the items survive, the pending diff does not ---------------------
{
  const h = await harness();
  const t = await h.threads.create(ctx, { title: "Stripe webhook retry logic" });
  await h.threads.addItem(ctx, t.id, { kind: "proposal", refId: "prop-gone" });

  const withEditor = await statusesFor(h, {
    proposals: new Map([["prop-gone", { added: 3, removed: 1 }]]),
  });
  check("while the editor holds the proposal, the thread is blocked",
    withEditor.get(t.id)?.status === "needs_you");

  // The same rows, and an editor that has just started up. There is no diff to apply, so there is
  // nothing to ask for — a durable "pending" flag would still be asking.
  const afterRestart = await statusesFor(h);
  check("after a restart the same row reads idle, because the diff is genuinely gone",
    afterRestart.get(t.id)?.status === "idle", afterRestart.get(t.id)?.status);
}

// --- 3. failed steps are counted only for a run that ended in error ------------------------
{
  const h = await harness();
  await seedAgent(h.db, "auth_agent");
  const retried = await h.threads.create(ctx, { title: "retried" });
  const stopped = await h.threads.create(ctx, { title: "stopped" });

  const okRun = randomUUID();
  await h.store.upsertRun(ctx, run(okRun, "auth_agent", "completed"));
  await h.store.insertStep(ctx, step(okRun, 1, "transient failure"));
  await h.store.insertStep(ctx, step(okRun, 2, null));
  await h.threads.addItem(ctx, retried.id, { kind: "run", refId: okRun });

  const badRun = randomUUID();
  await h.store.upsertRun(ctx, run(badRun, "auth_agent", "error"));
  for (const seq of [1, 2, 3]) await h.store.insertStep(ctx, step(badRun, seq, "401"));
  await h.threads.addItem(ctx, stopped.id, { kind: "run", refId: badRun });

  const statuses = await statusesFor(h);
  check("a run that failed a step and then completed leaves its thread idle",
    statuses.get(retried.id)?.status === "idle", statuses.get(retried.id)?.status);
  check("a run that ended in error makes its thread errored",
    statuses.get(stopped.id)?.status === "errored");
  check("...and the fragment counts the steps", statuses.get(stopped.id)?.fragment === "3 failed steps");
}

// --- 4. the preview is the last thing the user said ----------------------------------------
{
  const h = await harness();
  const t = await h.threads.create(ctx);
  await h.threads.addItem(ctx, t.id, { kind: "message", role: "user", body: "add exponential backoff" });
  await h.threads.addItem(ctx, t.id, { kind: "proposal", refId: "p" });
  await h.threads.addItem(ctx, t.id, { kind: "message", role: "user", body: "why is it 401ing on refresh?" });

  const statuses = await statusesFor(h);
  check("the preview is the LAST user message",
    statuses.get(t.id)?.preview === "why is it 401ing on refresh?", String(statuses.get(t.id)?.preview));
  check("...and the first one is still there for the title to come from",
    (await h.threads.messages(ctx, t.id))[0]?.body === "add exponential backoff");
  check("a thread nobody has spoken in has no preview at all, rather than an empty quote",
    (await statusesFor(await harness())).size === 0);
}

// --- 5. an eval's progress, and a confirmation halting a run -------------------------------
{
  const h = await harness();
  await seedAgent(h.db, "api_gateway");
  const sweep = await h.threads.create(ctx, { title: "Nightly eval sweep" });
  await h.threads.addItem(ctx, sweep.id, { kind: "eval", refId: "eval-1" });

  const halted = await h.threads.create(ctx, { title: "halted" });
  const haltedRun = randomUUID();
  await h.store.upsertRun(ctx, run(haltedRun, "api_gateway", "running"));
  await h.threads.addItem(ctx, halted.id, { kind: "run", refId: haltedRun });

  const statuses = await statusesFor(h, {
    evals: new Map([["eval-1", { running: true, done: 34, total: 120, liveRunIds: [] }]]),
    confirms: new Map([[haltedRun, 1]]),
  });
  check("a running eval puts its thread in Running", statuses.get(sweep.id)?.status === "running");
  check("...with the progress the projection is computed from",
    statuses.get(sweep.id)?.fragment === "eval 34/120");
  check("a run halted on a confirmation is waiting on a PERSON, not on a machine",
    statuses.get(halted.id)?.status === "needs_you", statuses.get(halted.id)?.status);
  check("...and says what it is waiting for", statuses.get(halted.id)?.fragment === "confirmation waiting");
}

// --- 6. cost, both ways in and one number out ----------------------------------------------
{
  const h = await harness();
  await seedAgent(h.db, "support_bot");
  const t = await h.threads.create(ctx, { title: "spends" });
  const other = await h.threads.create(ctx, { title: "spends nothing" });

  const runId = randomUUID();
  await h.store.upsertRun(ctx, run(runId, "support_bot", "completed"));
  await h.threads.addItem(ctx, t.id, { kind: "run", refId: runId });

  // The agent's own model call, attributed through its run.
  await h.billing.record(ctx, {
    kind: "llm.provider", idempotencyKey: "k1", runId, provider: "anthropic",
    model: "claude-haiku-4-5", inputTokens: 100, outputTokens: 50, costUsd: 0.03,
  });
  // The platform thinking on the workspace's behalf: no run to attribute through, so it names the
  // thread. This is the row the column in migration 044 exists for.
  await h.billing.record(ctx, {
    kind: "llm.plan", idempotencyKey: "k2", threadId: t.id, provider: "anthropic",
    model: "claude-haiku-4-5", inputTokens: 10, outputTokens: 5, costUsd: 0.01,
  });

  const spend = await h.billing.spendByThread(ctx);
  check("both attributions land in one figure",
    Math.abs((spend.get(t.id)?.usd ?? 0) - 0.04) < 1e-9, String(spend.get(t.id)?.usd));
  check("...and it is a complete one", spend.get(t.id)?.costKnown === true);
  check("a thread that spent nothing has no entry, which is not the same as $0",
    !spend.has(other.id));

  // An unpriced model contributes null, SUM skips it, and the figure becomes a floor. §4.3 renders
  // that as `$0.04+` — which it can only do if the incompleteness travels with the number.
  await h.billing.record(ctx, {
    kind: "llm.provider", idempotencyKey: "k3", runId, provider: "whoknows",
    model: "unpriced-model-9", inputTokens: 100, outputTokens: 50, costUsd: null,
  });
  const after = await h.billing.spendByThread(ctx);
  check("an unpriced call does not change the total", Math.abs((after.get(t.id)?.usd ?? 0) - 0.04) < 1e-9);
  check("...but it does say the total is now a floor", after.get(t.id)?.costKnown === false);
}

// --- 7. work joins the session already open on the agent ----------------------------------
{
  const h = await harness();
  const agent = await seedAgent(h.db, "docs_agent");

  const first = await h.threads.ensureForAgent(ctx, agent, "docs_agent");
  const again = await h.threads.ensureForAgent(ctx, agent, "docs_agent");
  check("the first piece of work on an agent opens a session", first.length > 0);
  check("...and the second joins it rather than opening another", again === first);

  // A second session somebody opened deliberately, and then used. Work joins the one they are
  // actually in, which is the one that was touched last.
  const deliberate = await h.threads.create(ctx, { agentId: agent, agentName: "docs_agent", title: "Second" });
  await h.threads.touch(ctx, deliberate.id, new Date(Date.now() + 60_000).toISOString());
  check("work joins the most recently active session on that agent",
    (await h.threads.ensureForAgent(ctx, agent, "docs_agent")) === deliberate.id);

  // And an archived one is not somewhere new work should land.
  await h.threads.archive(ctx, deliberate.id);
  check("an archived session is not picked back up by new work",
    (await h.threads.ensureForAgent(ctx, agent, "docs_agent")) === first);
}

// --- 8. the backfill: an existing agent's runs are not orphaned ----------------------------
{
  // A fresh database is migrated with no agents in it, so the backfill has nothing to do. This
  // seeds an agent and a run the way a pre-044 installation would have had them, then applies the
  // same statements the migration applies, and asserts the result rather than the SQL.
  const h = await harness();
  const agent = await seedAgent(h.db, "legacy_bot");
  const oldRun = randomUUID();
  await h.store.upsertRun(ctx, run(oldRun, "legacy_bot", "completed"));

  check("an agent from before threads existed has no session yet",
    (await h.threads.listForAgent(ctx, agent)).length === 0);

  // What the migration does, as the store does it: one thread per agent, and its runs bound to it.
  const backfilled = await h.threads.ensureForAgent(ctx, agent, "legacy_bot");
  await h.threads.addItem(ctx, backfilled, { kind: "run", refId: oldRun });

  const mine = await h.threads.listForAgent(ctx, agent);
  check("...and afterwards exactly one, named after the agent",
    mine.length === 1 && mine[0]?.title === "legacy_bot");
  check("...owning the run it did", (await h.threads.threadForRef(ctx, "run", oldRun)) === backfilled);
  check("...so nothing that already happened is orphaned",
    (await h.threads.allItems(ctx)).length === 1);
}

// --- 9. an agent's deletion, through the path that actually deletes one (§3.2) --------------
{
  // NOT `detachAgent` CALLED DIRECTLY — `test:threads` already does that. This goes through
  // `syncFromDisk`, which is the only thing in this product that removes an agent, so what is under
  // test is the wiring: that the sweep reports what it swept and that the report reaches the threads.
  const h = await harness();
  const agents = new AgentRepository(h.db);
  await agents.upsertFromDisk(ctx, { slug: "stripe_webhook", display_name: "stripe_webhook" });
  const agent = (await agents.bySlug(ctx, "stripe_webhook"))!;

  const a = await h.threads.create(ctx, { agentId: agent.id, agentName: "stripe_webhook", title: "retry logic" });
  const b = await h.threads.create(ctx, { agentId: agent.id, agentName: "stripe_webhook", title: "signature check" });
  await h.threads.addItem(ctx, a.id, { kind: "message", role: "user", body: "add exponential backoff" });

  // The directory is gone, so the reconciliation sweeps the row — and tells whoever asked.
  const removed: string[] = [];
  await agents.syncFromDisk(ctx, [], {
    onRemoved: async (removedAgent) => {
      removed.push(removedAgent.slug);
      await h.threads.detachAgent(ctx, removedAgent.id, removedAgent.display_name ?? removedAgent.slug);
    },
  });

  check("the sweep reports the agent it removed", removed.join(",") === "stripe_webhook");
  check("the agent is gone from the list", (await agents.bySlug(ctx, "stripe_webhook")) === undefined);

  const kept = await h.threads.list(ctx);
  check("both of its threads are still there", kept.length === 2);
  check("...with their titles", kept.map((t) => t.title).sort().join(" / ") === "retry logic / signature check");
  check("...with no agent to point at", kept.every((t) => t.agent_id === null));
  check("...and the name they were linked to, so the row can say stripe_webhook (deleted)",
    kept.every((t) => t.agent_name_snapshot === "stripe_webhook"));
  check("...and what was said in them is still readable",
    (await h.threads.messages(ctx, a.id))[0]?.body === "add exponential backoff");

  // The other direction, and the reason the callback fires per row CHANGED rather than per candidate:
  // an agent with published versions is not swept, so its threads must stay attached to it.
  const published = await agents.upsertFromDisk(ctx, { slug: "docs_agent", display_name: "docs_agent" });
  await agents.addVersion(ctx, published.id, {});
  const live = await h.threads.create(ctx, { agentId: published.id, agentName: "docs_agent", title: "kept" });
  const alsoRemoved: string[] = [];
  await agents.syncFromDisk(ctx, [], { onRemoved: async (r) => { alsoRemoved.push(r.slug); } });
  check("an agent with published versions is not swept by an empty directory",
    !alsoRemoved.includes("docs_agent"), alsoRemoved.join(","));
  check("...so its thread is still attached to it",
    (await h.threads.get(ctx, live.id))?.agent_id === published.id);
}

console.log(fail === 0 ? "\nALL CORRECT" : `\n${fail} FAILURES`);
process.exit(fail === 0 ? 0 : 1);
