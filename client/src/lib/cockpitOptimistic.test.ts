// §24's `test:cockpit-optimistic`: "a refused dispatch leaves a failed row and restores the composer
// text — it never vanishes".
//
// "DID IT RUN OR NOT" IS THE ONE QUESTION THIS TAB EXISTS TO NEVER LEAVE OPEN — §19, and every
// assertion here is a way that question could be left open. A row that appears and then disappears
// asks it. A row that settles by being removed and re-added asks a smaller version of it, because
// the reader watching the row they just made sees it move. A composer that clears on
// acknowledgement rather than on press asks it in the other direction: the text sits there while
// the job is already gone, so a second press sends it twice.
//
// THE HARD PART IS THE IDENTITY. An optimistic row has no server id, so the acknowledgement cannot
// be matched to it by id — and the two wrong answers are both plausible. Matching by (agent, input,
// time) is wrong the first time somebody sends the same job twice on purpose; leaving the
// placeholder and inserting the real row beside it is a duplicate that §19's "settles in place"
// rules out in as many words. A reference minted here and echoed by the server is the only one that
// works, and that is what these fixtures exercise.
//
//   npm run test:cockpit-optimistic

import {
  isOptimistic, mergeDelta, optimisticRow, refuseOptimistic, settleOptimistic, type LiveList,
} from "./workLive.ts";
import type { WorkItemView } from "../types.ts";

let fail = 0;
const check = (name: string, ok: boolean, detail = ""): void => {
  if (ok) console.log(`  ok   ${name}`);
  else { fail++; console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ""}`); }
};

const job = (id: string, patch: Partial<WorkItemView> = {}): WorkItemView => ({
  id, agent_id: "a", agent_name: "billing_bot", deployment_id: "d", run_id: `r-${id}`,
  created_by: "u", created_by_name: "Tester", input_preview: `job ${id}`,
  status: "succeeded", output_preview: null, error: null, failure_kind: null,
  created_at: "2026-08-28T12:00:00.000Z", started_at: null, ended_at: null,
  cost_usd: null, tokens: null, duration_ms: null, cost_complete: true,
  ...patch,
});

const drawn = (ref: string, text = "refund order 4471"): WorkItemView => optimisticRow({
  ref, agentId: "a", agentName: "billing_bot", deploymentId: "d",
  createdBy: "u", createdByName: "Tester", text,
});

/** Twenty settled rows with one optimistic row at the head — the shape after a press. */
const afterPress = (ref = "ref-1"): LiveList => ({
  items: [drawn(ref), ...Array.from({ length: 20 }, (_, i) => job(`w-${i}`))],
  pending: [],
});

const ids = (list: WorkItemView[]): string => list.map((i) => i.id).join(",");

// --- 1. a row appears immediately, at queued, at the top -------------------------------------------

console.log("\nsomething must be on screen");
{
  const row = drawn("ref-1", "refund order 4471");
  check("it is queued", row.status === "queued", row.status);
  check("it carries what was typed", row.input_preview === "refund order 4471", row.input_preview);
  check("it names the agent it went to", row.agent_name === "billing_bot");
  check("it is marked as not yet acknowledged", isOptimistic(row), row.id);
  check("...and a real row is not", !isOptimistic(job("w-1")), job("w-1").id);

  // NULL AND NOT ZERO, exactly as a real row would be — nothing has been priced because nothing has
  // run. A `$0.00` here would be the one made-up figure on the tab whose argument is that its
  // numbers are real.
  check("it claims no cost", row.cost_usd === null);
  check("...no tokens", row.tokens === null);
  check("...and no duration", row.duration_ms === null);
  check("...and no run, because there is not one yet", row.run_id === null);
}

// --- 2. on acknowledgement it settles, in place, with no motion ------------------------------------

console.log("\nit was already in the right position");
{
  const before = afterPress();
  const real = job("w-real", { status: "queued" });
  const after = settleOptimistic(before, "ref-1", real);

  check("the real row is in the list", after.items.some((i) => i.id === "w-real"));
  check("the placeholder is gone", !after.items.some((i) => isOptimistic(i)), ids(after.items).slice(0, 40));
  // THE ASSERTION §19 IS ACTUALLY ABOUT. The tempting wrong version — remove the placeholder, then
  // unshift the real row — produces a correct list and moves every row below it by one, at the
  // exact moment the reader is watching the row they just created.
  check("the list is not one longer", after.items.length === before.items.length,
    `${after.items.length} vs ${before.items.length}`);
  check("...and the real row is at the placeholder's index", after.items[0]!.id === "w-real");
  check("...and everything below it is untouched",
    ids(after.items.slice(1)) === ids(before.items.slice(1)));

  // AN ACKNOWLEDGEMENT FOR A ROW THIS CLIENT DID NOT DRAW is a job sent from somewhere else — a
  // retry from the detail panel, a second window — and the honest thing is to treat it as an
  // ordinary arrival rather than to drop it.
  const foreign = settleOptimistic({ items: [job("w-1")], pending: [] }, "unknown-ref", job("w-new"));
  check("an answer with no placeholder is still shown", foreign.items.length === 2, ids(foreign.items));
  check("...at the head, because it is the newest thing", foreign.items[0]!.id === "w-new");

  // AND IT IS NOT SHOWN TWICE. A snapshot can land between the press and the answer, so the real
  // row may already be on the page.
  const already = settleOptimistic({ items: [job("w-new"), job("w-1")], pending: [] }, "gone", job("w-new"));
  check("a row the page already holds is not added twice", already.items.length === 2, ids(already.items));
}

// --- 3. on refusal it does not vanish --------------------------------------------------------------

console.log("\nthe one question this tab exists to never leave open");
{
  const before = afterPress();
  const after = refuseOptimistic(before, "ref-1", "That agent is not accepting work.");

  check("the row is still there", after.items.length === before.items.length,
    `${after.items.length} vs ${before.items.length}`);
  check("...at its own index", after.items[0]!.id === before.items[0]!.id);
  check("...wearing failed", after.items[0]!.status === "failed", after.items[0]!.status);
  check("...and carrying the reason", after.items[0]!.error === "That agent is not accepting work.",
    String(after.items[0]!.error));
  check("...with an end time, because it is over", after.items[0]!.ended_at !== null);

  // `failure_kind` IS LEFT NULL ON PURPOSE. The six kinds describe what happened to a job that
  // reached a container; a dispatch the server would not accept never did, so claiming one would
  // file a refusal under a category that does not fit — and the row's failure sentence would then
  // be about something that did not happen.
  check("it claims none of the six failure kinds", after.items[0]!.failure_kind === null,
    String(after.items[0]!.failure_kind));

  // AND IT KEEPS WHAT WAS TYPED, so the reader can see which job was refused. A failed row whose
  // input had been cleared would be a row that says something went wrong and not what.
  check("it still says what was asked", after.items[0]!.input_preview === "refund order 4471",
    after.items[0]!.input_preview);

  // A REFUSAL FOR A ROW THAT IS NOT THERE CHANGES NOTHING, rather than throwing or inventing one.
  const stray = refuseOptimistic({ items: [job("w-1")], pending: [] }, "gone", "nope");
  check("a refusal with no placeholder is a no-op", stray.items.length === 1 && stray.items[0]!.status === "succeeded");
}

// --- 4. the placeholder behaves like a row while it waits ------------------------------------------

console.log("\nwhile the server is thinking");
{
  // IT IS AN ORDINARY ROW TO EVERY OTHER RULE, which is what keeps §18 and §19 from needing to know
  // about each other. An arrival while a placeholder is on screen is held behind the pill exactly
  // as any other arrival would be, and it does not disturb the placeholder.
  const before = afterPress();
  const after = mergeDelta(before, job("w-other", { status: "running" }), { belongs: true, atTop: false });
  check("an arrival during a dispatch is held behind the pill", after.pending.length === 1);
  check("...and the placeholder has not moved", after.items[0]!.id === before.items[0]!.id);
  check("...nor changed", after.items[0]!.status === "queued");

  // A DELTA THAT HAPPENS TO CARRY THE SAME id CANNOT EXIST — a server id never starts with the
  // optimistic prefix — which is the property that makes the prefix worth having rather than a flag.
  check("no server id could collide with a placeholder's", !isOptimistic(job("018f2c3d-0000-7000-8000-000000000000")));
}

console.log(fail === 0 ? "\nALL CORRECT" : `\n${fail} FAILURES`);
(globalThis as { process?: { exit(code: number): void } }).process?.exit(fail === 0 ? 0 : 1);
