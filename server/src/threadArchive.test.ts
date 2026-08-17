// §3.4's lifecycle, and the absence it depends on.
//
// Archiving is easy to test and easy to get right. The part worth a suite is the NOT: this product
// has no way to destroy a thread, and "has no way" is a claim about every file in the server rather
// than about one function. So the second half of this file is a structural audit — it reads the
// source and fails on a statement that would delete one, which is the only kind of check that
// survives somebody adding a `deleteThread` command in six months without reading §3.4.
//
// WHY THAT MATTERS BEYOND TIDINESS. §3.4 spells out the knock-on: the delete-confirmation dialog
// specified for this redesign — the one naming the creator, as a safety net for Team workspaces where
// any member can destroy another member's work — applies to Agents and NOT to threads, because there
// is no delete path to confirm. If a delete path ever appears, that reasoning silently becomes wrong
// and a Team workspace gets an unguarded destroy. This audit is what makes that impossible to do
// quietly.
//
//   npm run test:thread-archive

import { randomUUID } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import { openTestSqlite, testContext } from "./db/testDb.ts";
import { BillingRepository } from "./db/repositories/billing.ts";
import { TraceStore } from "./store.ts";
import { ThreadStore } from "./threadStore.ts";
import { COMMAND_CHANNEL } from "./wsRelay.ts";
import type { Run } from "./types.ts";

let fail = 0;
const check = (name: string, ok: boolean, detail = ""): void => {
  if (ok) console.log(`  ok   ${name}`);
  else { fail++; console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ""}`); }
};

const ctx = testContext();
const db = await openTestSqlite();
const store = new TraceStore(db);
await store.init();
const threads = new ThreadStore(db);
const billing = new BillingRepository(db);

// --- 1. archiving keeps everything and hides the row --------------------------------------
{
  const agentId = randomUUID();
  await db.run(
    `INSERT INTO agents (id, workspace_id, slug, display_name, connectors, mcp_tools,
                         required_env, default_provider, created_at)
     VALUES (?, ?, 'stripe_webhook', 'stripe_webhook', '[]', '[]', '[]', 'fake', ?)`,
    [agentId, ctx.workspaceId, new Date().toISOString()],
  );

  const t = await threads.create(ctx, {
    agentId, agentName: "stripe_webhook", title: "Stripe webhook retry logic",
  });
  await threads.addItem(ctx, t.id, { kind: "message", role: "user", body: "add exponential backoff" });
  const runId = randomUUID();
  const run: Run = {
    id: runId, agent_id: "stripe_webhook", provider: "fake", model: "fake-dry-run",
    status: "completed", started_at: new Date().toISOString(), ended_at: new Date().toISOString(),
    cost: 0, tokens: 0, error: null,
  };
  await store.upsertRun(ctx, run);
  await threads.addItem(ctx, t.id, { kind: "run", refId: runId });
  await billing.record(ctx, {
    kind: "llm.provider", idempotencyKey: `k-${runId}`, runId, provider: "anthropic",
    model: "claude-haiku-4-5", inputTokens: 100, outputTokens: 50, costUsd: 0.04,
  });

  await threads.archive(ctx, t.id);
  const archived = await threads.get(ctx, t.id);
  check("the row is still there", archived !== undefined);
  check("...stamped with when it was set aside", archived?.archived_at !== null);
  check("...still titled what it was", archived?.title === "Stripe webhook retry logic");
  check("...still pointing at its agent", archived?.agent_id === agentId);
  check("...still owning what happened in it", (await threads.allItems(ctx)).length === 2);
  check("...and still costing what it cost",
    Math.abs(((await billing.spendByThread(ctx)).get(t.id)?.usd ?? 0) - 0.04) < 1e-9);

  // A thread holds what was thought, what was generated and what it cost — the record survives the
  // artefact (§3.2), and archiving is not an exception to that.
  check("the message it was about is readable afterwards",
    (await threads.messages(ctx, t.id))[0]?.body === "add exponential backoff");

  await threads.restore(ctx, t.id);
  check("restore is one click and clears the timestamp",
    (await threads.get(ctx, t.id))?.archived_at === null);
  check("...and hands the glyph back to the deriver", (await threads.get(ctx, t.id))?.status === "idle");
}

// --- 2. the lifecycle refuses what it should ----------------------------------------------
{
  const t = await threads.create(ctx, { title: "twice" });
  await threads.archive(ctx, t.id, "2026-01-01T00:00:00.000Z");
  await threads.archive(ctx, t.id, "2026-06-06T00:00:00.000Z");
  check("archiving an already-archived thread does not move the timestamp",
    (await threads.get(ctx, t.id))?.archived_at === "2026-01-01T00:00:00.000Z");

  const active = await threads.create(ctx, { title: "active" });
  await threads.restore(ctx, active.id);
  check("restoring an active thread changes nothing",
    (await threads.get(ctx, active.id))?.archived_at === null);
  check("...and does not reset a status it had no business touching",
    (await threads.get(ctx, active.id))?.status === "idle");
}

// --- 3. the absence: nothing in this server can destroy a thread ---------------------------
{
  const HERE = dirname(fileURLToPath(import.meta.url));

  /** Every server source file, recursively, tests excluded — a test may of course write anything. */
  const sources: { path: string; text: string }[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name.endsWith(".ts") && !entry.name.endsWith(".test.ts")) {
        sources.push({ path: full.slice(HERE.length + 1).replace(/\\/g, "/"), text: readFileSync(full, "utf8") });
      }
    }
  };
  walk(HERE);
  check(`read the server's own source (${sources.length} files)`, sources.length > 100);

  // A DELETE naming the THREAD table, anywhere. `lifecycle/deletion.ts` deletes a whole workspace by
  // iterating a table list, so it contains no such statement and needs no exception here — which is
  // the right shape: deleting a workspace is deleting everything, and there is no path that reaches
  // one thread.
  const deleters = sources.filter((f) => /DELETE\s+FROM\s+threads\b/i.test(f.text));
  check(
    "no statement anywhere deletes a thread",
    deleters.length === 0,
    deleters.map((f) => f.path).join(", "),
  );

  // THE ITEMS ARE A DIFFERENT PROMISE, and this is the one exemption. §3.4 is about the SESSION —
  // what was asked for, what it was called, what it cost — and none of that is in `thread_items`,
  // which is a join table naming rows in `runs` and `eval_runs` by a plain text ref with no foreign
  // key. When retention takes the run, the row it points at is gone and the row itself is an orphan
  // that nothing can render: left in place it made this the one table in the schema that only ever
  // grows, read in full on every thread snapshot. So exactly one file may sweep it, and only
  // alongside the runs and evals that orphaned the rows.
  const itemDeleters = sources
    .filter((f) => /DELETE\s+FROM\s+thread_items\b/i.test(f.text))
    .map((f) => f.path);
  check(
    "only the retention sweeper removes items, and only ones whose run or eval is gone",
    itemDeleters.length === 1 && itemDeleters[0] === "lifecycle/retention.ts",
    itemDeleters.join(", "),
  );
  const retention = sources.find((f) => f.path === "lifecycle/retention.ts")?.text ?? "";
  check(
    "...never a message, a plan, a generation or a proposal",
    // Both statements are scoped to a kind, so a `message` — the one prose a thread stores, and the
    // one §4.3's preview and §5's title are read from — can never be caught by either.
    (retention.match(/DELETE\s+FROM\s+thread_items[\s\S]{0,200}?kind\s*=\s*'(run|eval)'/gi) ?? []).length === 2,
  );

  // And no command a client could send. The relay's channel table is the whole command surface, so a
  // `deleteThread` would have to appear in it to be routed at all.
  const destructive = Object.keys(COMMAND_CHANNEL).filter((c) => /^(delete|destroy|purge|remove)Thread/i.test(c));
  check(
    "no command on the socket asks to delete one",
    destructive.length === 0,
    destructive.join(", "),
  );

  // And no method on the store, by any of its usual names. `test:threads` asserts this on the
  // instance; this asserts it on the source, so a method added and not yet called still fails.
  const storeSource = sources.find((f) => f.path === "threadStore.ts")?.text ?? "";
  check("found the thread store's source", storeSource.length > 0);
  check(
    "the store has no method that would remove one",
    !/\basync (delete|remove|destroy|purge)\w*\s*\(/.test(storeSource),
  );
}

await store.close();

console.log(fail === 0 ? "\nALL CORRECT" : `\n${fail} FAILURES`);
process.exit(fail === 0 ? 0 : 1);
