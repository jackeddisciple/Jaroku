// §3.4's lifecycle: archiving keeps everything, and deleting is one guarded path.
//
// Archiving is easy to test and easy to get right. The part worth a suite is the GUARD on the other
// half: a chat can now be removed for good, and "only in one place, and only by the owner" is a claim
// about every file in the server rather than about one function. So the third section is a structural
// audit — it reads the source and fails on a second statement that deletes a thread, a second command
// that asks for it, or a command that any member could send.
//
// WHY THAT MATTERS BEYOND TIDINESS. In a Team workspace every member sees every chat. Archiving somebody
// else's is reversible in one click, so any member may; deleting it is not, so it is gated where
// deleting an agent is — `workspace:manage`, the owner — and the menu asks before it sends. A delete
// path added anywhere else, or at a looser capability, would be an unguarded destroy of another
// member's work, and this audit is what makes that impossible to do quietly.
//
//   npm run test:thread-archive

import { randomUUID } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import { COMMAND_CAPABILITY } from "./auth/capabilities.ts";
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

// --- 3. the guard: one statement, one command, and only the owner may send it ---------------
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

  // A DELETE naming the THREAD table, anywhere but the store. `lifecycle/deletion.ts` deletes a whole
  // workspace by iterating a table list, so it contains no such statement and needs no exception here.
  const deleters = sources.filter((f) => /DELETE\s+FROM\s+threads\b/i.test(f.text)).map((f) => f.path);
  check(
    "only the thread store deletes a thread",
    deleters.length === 1 && deleters[0] === "threadStore.ts",
    deleters.join(", "),
  );

  // THE ITEMS ARE A DIFFERENT PROMISE, and exactly two files may touch them. A deleted chat's items
  // still go by the cascading key rather than by a statement of their own; what may sweep them is
  // retention — only alongside the runs and evals that orphaned the rows — and, since the product
  // owner's call on 2026-09-15, the store's `rewindTo`: somebody editing their own message and
  // sending it again, which asks for the turns under it to go. Pinned below to that one method.
  const itemDeleters = sources
    .filter((f) => /DELETE\s+FROM\s+thread_items\b/i.test(f.text))
    .map((f) => f.path)
    .sort();
  check(
    "only the retention sweeper and the store's rewind remove items",
    itemDeleters.join(",") === "lifecycle/retention.ts,threadStore.ts",
    itemDeleters.join(", "),
  );
  const retention = sources.find((f) => f.path === "lifecycle/retention.ts")?.text ?? "";
  check(
    "...never a message, a plan, a generation or a proposal",
    (retention.match(/DELETE\s+FROM\s+thread_items[\s\S]{0,200}?kind\s*=\s*'(run|eval)'/gi) ?? []).length === 2,
  );

  // The relay's channel table is the whole command surface, so a destructive command has to appear in
  // it to be routed at all — and there is exactly one.
  const destructive = Object.keys(COMMAND_CHANNEL).filter((c) => /^(delete|destroy|purge|remove)Thread/i.test(c));
  check("one command on the socket deletes a chat", destructive.length === 1 && destructive[0] === "deleteThread",
    destructive.join(", "));
  check("...and only the owner may send it", COMMAND_CAPABILITY["deleteThread"] === "workspace:manage",
    String(COMMAND_CAPABILITY["deleteThread"]));

  // And one method on the store, by any of its usual names.
  const storeSource = sources.find((f) => f.path === "threadStore.ts")?.text ?? "";
  check("found the thread store's source", storeSource.length > 0);
  const removers = [...storeSource.matchAll(/\basync ((?:delete|remove|destroy|purge)\w*)\s*\(/g)].map((m) => m[1]);
  check("the store has exactly one method that removes one", removers.length === 1 && removers[0] === "deleteForGood",
    removers.join(", "));

  // AND THE STORE'S ONE ITEM DELETE IS THE REWIND, naming the rows it takes. The interesting refusal
  // is the statement this must never become: a `WHERE thread_id = ?` with no list beside it empties
  // a conversation, which is `deleteForGood`'s job and has none of its gates — one owner-only
  // command, confirmed in the menu. An edit takes the turns from one message down, and says which.
  const itemDeletes = storeSource.match(/DELETE\s+FROM\s+thread_items[\s\S]{0,200}?`/gi) ?? [];
  check("the store deletes items in exactly one statement", itemDeletes.length === 1, String(itemDeletes.length));
  check("...inside the rewind", /async rewindTo\([\s\S]{0,1200}?DELETE\s+FROM\s+thread_items/i.test(storeSource));
  check("...naming the thread and the rows it takes",
    /WHERE workspace_id = \? AND thread_id = \? AND id IN \(/.test(itemDeletes[0] ?? ""),
    itemDeletes[0] ?? "");
}

// --- 4. deleting takes the chat and what hangs off it, and nothing else --------------------
{
  const t = await threads.create(ctx, { title: "Delete me" });
  await threads.addItem(ctx, t.id, { kind: "message", role: "user", body: "a message that goes with it" });
  const runId = randomUUID();
  await store.upsertRun(ctx, {
    id: runId, agent_id: "stripe_webhook", provider: "fake", model: "fake-dry-run",
    status: "completed", started_at: new Date().toISOString(), ended_at: new Date().toISOString(),
    cost: 0, tokens: 0, error: null,
  });
  await threads.addItem(ctx, t.id, { kind: "run", refId: runId });
  const fork = await threads.create(ctx, { title: "Branched from it" });
  await db.run(`UPDATE threads SET parent_thread_id = ?, branch_from_turn = 1 WHERE workspace_id = ? AND id = ?`,
    [t.id, ctx.workspaceId, fork.id]);
  const itemsBefore = (await threads.allItems(ctx)).length;

  await threads.deleteForGood(ctx, t.id);
  check("the chat is gone", (await threads.get(ctx, t.id)) === undefined);
  check("...and its items went with it", (await threads.allItems(ctx)).length === itemsBefore - 2);
  check("the run it started is still a run", (await store.getRun(ctx, runId)) !== undefined);
  const branched = await threads.get(ctx, fork.id);
  check("a fork of it stays", branched !== undefined);
  check("...no longer pointing at a chat that is gone", branched?.parent_thread_id === null && branched?.branch_from_turn === null);
}

await store.close();

console.log(fail === 0 ? "\nALL CORRECT" : `\n${fail} FAILURES`);
process.exit(fail === 0 ? 0 : 1);
