// §6.3 — editing a message forks the thread, and the original is never touched.
//
// THE ASSERTION THIS SUITE EXISTS FOR is §6.5's: "editing turn 3 of a 5-turn thread produces a new
// thread with 2 copied turns and leaves the original 5-turn thread BYTE-IDENTICAL, asserted in a
// test." Byte-identical is a stronger claim than "still has five turns", and it is the one worth
// making — a fork that re-stamped a copied row's `created_at`, or renumbered an id, or touched the
// parent's `last_activity_at`, would pass a count check and would have quietly rewritten history.
//
// So the parent is read in full BEFORE and AFTER and compared as JSON. Nothing about which columns
// matter has to be decided in advance, which is the point: a future column that the fork starts
// touching fails here without anybody remembering to assert it.
//
// AND THE ACCOUNTING HALF, which §6.3 does not spell out and which follows from it: the fork
// deliberately does not copy `turn_variants`. Copying them would duplicate every recorded cost into
// a conversation that never spent it, so a fork of an expensive thread would appear to have cost
// what its parent did — and §10's rule that a thread's row total equals the sum of its turns would
// be false for both of them at once.
//
//   npm run test:thread-branch

import { randomUUID } from "node:crypto";

import { openTestSqlite, testContext } from "./db/testDb.ts";
import { newRequestId, systemContextFor } from "./db/tenant.ts";
import { ThreadNotHere, ThreadStore } from "./threadStore.ts";
import { sideEffectsAfter } from "./sideEffects.ts";
import { TurnVariantStore } from "./turnVariants.ts";
import type { Db } from "./db/db.ts";
import type { TenantContext } from "./db/tenant.ts";

let fail = 0;
const check = (name: string, ok: boolean, detail = ""): void => {
  if (ok) console.log(`  ok   ${name}`);
  else { fail++; console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ""}`); }
};

const A = testContext();
const B = systemContextFor("55555555-5555-4555-8555-555555555555", newRequestId());

async function harness(): Promise<{ db: Db; threads: ThreadStore; variants: TurnVariantStore; close: () => Promise<void> }> {
  const db = await openTestSqlite();
  const at = "2026-01-01T00:00:00.000Z";
  for (const ctx of [A, B]) {
    await db.run(
      `INSERT OR IGNORE INTO workspaces (id, slug, name, kind, plan, created_at)
       VALUES (?, ?, 'Seeded', 'personal', 'free', ?)`,
      [ctx.workspaceId, `ws-${ctx.workspaceId.slice(0, 8)}`, at],
    );
  }
  return { db, threads: new ThreadStore(db), variants: new TurnVariantStore(db), close: () => db.close() };
}

/** A thread's whole state, as JSON — the row and every item. What "byte-identical" is measured on. */
async function snapshotOf(db: Db, ctx: TenantContext, threads: ThreadStore, id: string): Promise<string> {
  const row = await db.forWorkspace(ctx.workspaceId).get<Record<string, unknown>>(
    `SELECT * FROM threads WHERE workspace_id = ? AND id = ?`, [ctx.workspaceId, id],
  );
  const items = await db.forWorkspace(ctx.workspaceId).all<Record<string, unknown>>(
    `SELECT * FROM thread_items WHERE workspace_id = ? AND thread_id = ? ORDER BY created_at ASC, id ASC`,
    [ctx.workspaceId, id],
  );
  void threads;
  return JSON.stringify({ row, items });
}

// --- §6.5: a five-turn thread, forked at three ------------------------------------------------

console.log("\n§6.5 — the original is byte-identical afterwards");
{
  const h = await harness();
  const parent = await h.threads.create(A, { title: "rate limiting" });
  // FIVE TURNS, alternating a question and what it caused, because a thread of nothing but messages
  // would not exercise the one thing the copy has to carry across: a `run` item's `ref_id`.
  const ids: string[] = [];
  for (const [kind, body] of [
    ["message", "why is it 429ing?"],
    ["run", null],
    ["message", "add a retry"],
    ["proposal", null],
    ["message", "and a jitter"],
  ] as const) {
    ids.push(await h.threads.addItem(A, parent.id, {
      kind, ...(kind === "message" ? { role: "user" as const, body } : { refId: randomUUID() }),
    }));
  }
  const before = await snapshotOf(h.db, A, h.threads, parent.id);
  check("the parent has five turns", (await h.threads.itemsFor(A, parent.id)).length === 5);

  const fork = await h.threads.branch(A, parent.id, 3, { title: "add a retry, differently" });

  // THE CLAIM §6.5 ASKS FOR, and the reason it is JSON rather than a count: a fork that re-stamped
  // a copied row's timestamp or touched the parent's `last_activity_at` would pass every count.
  const after = await snapshotOf(h.db, A, h.threads, parent.id);
  check("the parent is byte-identical", before === after,
    before === after ? "" : `\n  before: ${before.slice(0, 300)}\n  after:  ${after.slice(0, 300)}`);

  // TURNS 1..N−1, so the edited message REPLACES turn 3 rather than following it.
  const copied = await h.threads.itemsFor(A, fork.id);
  check("the fork has two copied turns", copied.length === 2, String(copied.length));
  check("...the first two, in order",
    copied[0]?.body === "why is it 429ing?" && copied[1]?.kind === "run",
    JSON.stringify(copied.map((i) => [i.kind, i.body])));
  check("...and not the turn being edited", !copied.some((i) => i.body === "add a retry"));
  check("...nor anything after it", !copied.some((i) => i.body === "and a jitter"));

  // FRESH IDS. `thread_items.id` is what notes, pins, feedback and variants hang off, so a copy
  // that kept the parent's ids would put a note from the parent's turn 2 on the fork's.
  check("copied turns get their own ids", copied.every((i) => !ids.includes(i.id)),
    JSON.stringify(copied.map((i) => i.id)));
  // AND THE SAME MOMENTS. `created_at` is the only ordering these rows have; re-stamping the whole
  // prefix would compress it into one millisecond and leave the monotonic clock to invent an order.
  const parentItems = await h.threads.itemsFor(A, parent.id);
  check("...and keep the moments they happened at",
    copied[0]?.created_at === parentItems[0]?.created_at && copied[1]?.created_at === parentItems[1]?.created_at);
  // A `run` ITEM'S REFERENCE IS CARRIED, not dropped: the fork's history has to be able to say
  // which run it was.
  check("a run item keeps pointing at its run", copied[1]?.ref_id === parentItems[1]?.ref_id);

  // §6.3's LINEAGE, mirroring `parent_run_id` / `branch_from_seq` exactly.
  check("lineage names the parent", fork.parent_thread_id === parent.id, String(fork.parent_thread_id));
  check("...and the turn it forked at", fork.branch_from_turn === 3, String(fork.branch_from_turn));
  check("the parent has no lineage of its own", (await h.threads.get(A, parent.id))?.parent_thread_id === null);
  // AND IT IS FINDABLE FROM THE PARENT, which is what the Threads list renders from.
  const kids = await h.threads.childrenOf(A, parent.id);
  check("the parent can find its fork", kids.length === 1 && kids[0]?.id === fork.id);

  // INHERITED, NOT INVENTED: the agent, the snapshot name and the mode. A fork of a build thread is
  // a build thread — §4's enforcement would refuse the copied items otherwise.
  check("the fork inherits the mode", fork.mode === parent.mode);
  check("...and is not marked custom-titled", fork.title_is_custom === false);
  check("...and starts idle and unarchived", fork.status === "idle" && fork.archived_at === null);

  await h.close();
}

// --- §16: branch a branch, and edit turn 1 of a 1-turn thread ---------------------------------

console.log("\n§16's fork attacks");
{
  const h = await harness();
  const t1 = await h.threads.create(A, { title: "one" });
  await h.threads.addItem(A, t1.id, { kind: "message", role: "user", body: "only turn" });

  // EDIT TURN 1 OF A 1-TURN THREAD. The prefix is empty, which is a real fork rather than an error:
  // somebody rephrasing their opening message wants a conversation that starts differently.
  const f1 = await h.threads.branch(A, t1.id, 1);
  check("editing turn 1 forks with an empty prefix", (await h.threads.itemsFor(A, f1.id)).length === 0);
  check("...and still records lineage", f1.parent_thread_id === t1.id && f1.branch_from_turn === 1);
  check("...and the original still has its turn", (await h.threads.itemsFor(A, t1.id)).length === 1);

  // BRANCH A BRANCH. Lineage is one level deep by design — a fork names its immediate parent, the
  // way `parent_run_id` does — so a chain reads as a chain rather than flattening.
  await h.threads.addItem(A, f1.id, { kind: "message", role: "user", body: "a different opening" });
  await h.threads.addItem(A, f1.id, { kind: "message", role: "user", body: "and a follow-up" });
  const f2 = await h.threads.branch(A, f1.id, 2);
  check("a branch can be branched", f2.parent_thread_id === f1.id && f2.branch_from_turn === 2);
  check("...and its grandparent is not claimed", f2.parent_thread_id !== t1.id);
  check("...and the middle thread is untouched", (await h.threads.itemsFor(A, f1.id)).length === 2);

  // A TURN INDEX PAST THE END copies everything there is rather than throwing: the honest reading of
  // "fork at turn 9" in a two-turn thread is a fork of the whole conversation.
  const f3 = await h.threads.branch(A, f1.id, 9);
  check("a turn index past the end copies the whole prefix", (await h.threads.itemsFor(A, f3.id)).length === 2);

  // AND THE POSITIONS THAT ARE NOT POSITIONS. `branch @0` would render as a fork before the
  // conversation began.
  for (const bad of [0, -1, 1.5]) {
    let threw = false;
    try { await h.threads.branch(A, f1.id, bad); } catch { threw = true; }
    check(`a turn index of ${bad} is refused`, threw);
  }

  await h.close();
}

// --- §13's tenancy direction ------------------------------------------------------------------

console.log("\nforking across a tenant boundary");
{
  const h = await harness();
  const mine = await h.threads.create(A, { title: "mine" });
  await h.threads.addItem(A, mine.id, { kind: "message", role: "user", body: "mine" });

  // ABSENT, NOT FORBIDDEN — and the same sentence a deleted thread gets. A refusal that told them
  // apart would confirm the id exists somewhere, which turns the socket into an enumeration oracle.
  let refused: unknown = null;
  try { await h.threads.branch(B, mine.id, 1); } catch (err) { refused = err; }
  check("another workspace cannot fork this thread", refused instanceof ThreadNotHere);
  check("...with the same sentence a missing thread gets",
    (refused as Error)?.message === "no such thread in this workspace", String((refused as Error)?.message));
  // AND NOTHING WAS WRITTEN. A refused fork that had already inserted the row would leave an empty
  // thread in the OTHER workspace's list.
  check("...and no row was created", (await h.threads.list(B)).length === 0, String((await h.threads.list(B)).length));

  let gone: unknown = null;
  try { await h.threads.branch(A, randomUUID(), 1); } catch (err) { gone = err; }
  check("a thread that never existed is refused the same way", gone instanceof ThreadNotHere);

  await h.close();
}

// --- the accounting half: variants are deliberately NOT copied --------------------------------

console.log("\nwhat a fork does not copy");
{
  const h = await harness();
  const parent = await h.threads.create(A, { title: "expensive" });
  const turn = await h.threads.addItem(A, parent.id, { kind: "message", role: "user", body: "a question" });
  const v = await h.variants.begin(A, turn, { modelId: "claude-haiku-4-5", provider: "anthropic" });
  await h.variants.settle(A, v.id, { body: "an answer", costUsd: 0.0042, tokensIn: 1200, tokensOut: 90 });

  await h.threads.addItem(A, parent.id, { kind: "message", role: "user", body: "a second question" });
  const fork = await h.threads.branch(A, parent.id, 2);
  const copied = await h.threads.itemsFor(A, fork.id);
  check("the question is copied", copied.length === 1 && copied[0]?.body === "a question");
  // THE ANSWER'S COST IS NOT. Copying it would duplicate money the parent already accounted for
  // into a thread that never spent it — so §10's "a thread's row total equals the sum of its turns"
  // would be false for both at once.
  check("its recorded answer is not", (await h.variants.forTurn(A, copied[0]!.id)).length === 0);
  check("...and the parent still has it", (await h.variants.forTurn(A, turn)).length === 1);
  check("...with its cost intact", (await h.variants.forTurn(A, turn))[0]?.cost_usd === 0.0042);

  await h.close();
}

// --- §6.5: editing a turn that produced a side effect -----------------------------------------
//
// §6.5's ACCEPTANCE: "attempting to edit a turn that applied an edit is refused with an explanation
// NAMING THE SIDE EFFECT." And §6.3's rule behind it: "a turn that produced a side effect — an
// applied edit, a confirmed plan, a started run — is not editable IN PLACE. Those turns fork from
// the point BEFORE the side effect and say so, because the side effect already happened on disk and
// a fork cannot unhappen it."
//
// THIS HAD NO COVERAGE UNTIL THIS PASS, which is why it is here rather than in the feature commit:
// `sideEffectsAfter` decides what a fork says about itself, and it is a pure function over the
// items — so every case is checkable and none of them was checked.

console.log("\n§6.5 — what a turn's consequences are called");
{
  const items = (...rows: [string, "user" | null, string | null][]) =>
    rows.map(([kind, role, body], i) => ({ id: `i${i}`, kind: kind as never, role, body }));

  // THE WINDOW IS "UNTIL THE NEXT USER MESSAGE", because that is what "this turn produced" means in
  // a conversation: everything between what somebody said and what they said next.
  const withEdit = items(
    ["message", "user", "add a retry"],
    ["proposal", null, null],
    ["message", "user", "and a jitter"],
    ["run", null, null],
  );
  const effects = sideEffectsAfter(withEdit, "i0");
  check("a message that produced a proposal names it", effects.length === 1, effects.join(" | "));
  check("...in the words the record can support",
    effects[0] === "a change to the code was proposed", String(effects[0]));
  // NOT THE NEXT MESSAGE'S CONSEQUENCES. The run belongs to "and a jitter", not to "add a retry".
  check("...and not the next message's", !effects.some((e) => e.includes("run")), effects.join(" | "));

  // THE SECOND MESSAGE'S OWN.
  const second = sideEffectsAfter(withEdit, "i2");
  check("the second message names its run", second[0] === "a run was started", String(second[0]));

  // A MESSAGE THAT CAUSED NOTHING SAYS NOTHING, which is the ordinary case — most turns in a chat
  // thread are a question and an answer.
  const plain = items(["message", "user", "why?"], ["message", "user", "and?"]);
  check("a message with no consequences names none", sideEffectsAfter(plain, "i0").length === 0);

  // EVERY KIND THAT CANNOT BE UNHAPPENED, each named for what the RECORD holds rather than for what
  // §6.3's prose guesses. §6.3 says "an applied edit"; `thread_items` holds a `proposal` row and
  // whether it was ever APPLIED lives in the editor's memory — so this says "a change was
  // proposed". Saying "applied" about one somebody discarded would be the product lying about its
  // own state, which §8.3 treats as the most serious class there is.
  for (const [kind, expected] of [
    ["generation", "an agent was generated"],
    ["proposal", "a change to the code was proposed"],
    ["run", "a run was started"],
    ["work", "a job was given to a deployed agent"],
    ["eval", "an eval was run"],
  ] as const) {
    const one = sideEffectsAfter(items(["message", "user", "do it"], [kind, null, null]), "i0");
    check(`${kind} is named "${expected}"`, one[0] === expected, one.join(" | "));
  }

  // A PLAN IS DELIBERATELY NOT A SIDE EFFECT. §6.3 lists "a confirmed plan" — and a plan ROW is a
  // plan that was WRITTEN, not one that was confirmed: confirming it produces the `generation` row
  // above. A fork before a written-but-unconfirmed plan unhappens nothing, so claiming otherwise
  // would be a sentence about a consequence that did not occur.
  const planned = sideEffectsAfter(items(["message", "user", "a support agent"], ["plan", null, null]), "i0");
  check("a written plan is not a side effect", planned.length === 0, planned.join(" | "));

  // DE-DUPLICATED: three runs from one message read as one sentence. What the line is about is what
  // KIND of thing cannot be unhappened, not how many there were.
  const three = sideEffectsAfter(
    items(["message", "user", "run it"], ["run", null, null], ["run", null, null], ["run", null, null]),
    "i0",
  );
  check("three runs read as one consequence", three.length === 1, three.join(" | "));

  // A TURN THAT IS NOT IN THE LIST NAMES NOTHING rather than throwing — a client's id that this
  // workspace does not own resolves to no items at all, and the fork refuses it separately.
  check("an unknown turn names nothing", sideEffectsAfter(withEdit, "nope").length === 0);
}

console.log(fail === 0 ? "\nALL CORRECT" : `\n${fail} FAILURES`);
process.exit(fail === 0 ? 0 : 1);
