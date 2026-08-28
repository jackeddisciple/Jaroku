// §24's `test:work-live`: "the list never moves under the reader — an item arriving above the
// scroll position increments the pill and does not insert; a status change updates in place and
// never reorders".
//
// THE PROPERTY IS AN ABSENCE OF MOVEMENT, which is the hardest kind to see by looking. Every
// version of this rule renders a correct list: the rows are all there, they are all up to date,
// they are all in the right order. What differs is WHERE THEY WERE A FRAME AGO, and the only way to
// assert that is to hold the identity and position of a row across a delta and check both.
//
// SO EVERY CASE HERE PINS AN INDEX. §18's sentence is "an item inserted at the top while somebody
// is reading row twenty moves row twenty, and they lose their place on a surface whose whole job is
// letting them keep it" — so the fixture reads row twenty, and the assertion is that row twenty is
// still row twenty.
//
// AND THE TEMPTING WRONG VERSION IS ONE CHARACTER SHORTER. Updating a changed row by removing it
// and unshifting the new one is a single line, produces a list containing exactly the right rows,
// and reorders on every status change — which on a busy workspace is a list that shuffles itself
// under a cursor several times a second.
//
//   npm run test:work-live

import { admitPending, mergeDelta, resetPending, type LiveList } from "./workLive.ts";
import type { WorkItemView, WorkStatus } from "../types.ts";

let fail = 0;
const check = (name: string, ok: boolean, detail = ""): void => {
  if (ok) console.log(`  ok   ${name}`);
  else { fail++; console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ""}`); }
};

const job = (id: string, status: WorkStatus = "succeeded"): WorkItemView => ({
  id, agent_id: "a", agent_name: "billing_bot", deployment_id: "d", run_id: `r-${id}`,
  created_by: "u", created_by_name: "Tester", input_preview: `job ${id}`,
  status, output_preview: null, error: null, failure_kind: null,
  created_at: "2026-08-28T12:00:00.000Z", started_at: null, ended_at: null,
  cost_usd: null, tokens: null, duration_ms: null, cost_complete: true,
});

/** Forty rows, so "row twenty" is a real position with rows above and below it. */
const forty = (): LiveList => ({
  items: Array.from({ length: 40 }, (_, i) => job(`w-${i}`)),
  pending: [],
});

const ids = (list: WorkItemView[]): string => list.map((i) => i.id).join(",");

// --- 1. an arrival above the reader does not insert -------------------------------------------------

console.log("\nrow twenty is still row twenty");
{
  const before = forty();
  const twenty = before.items[20]!.id;

  const after = mergeDelta(before, job("new-1", "queued"), { belongs: true, atTop: false });

  check("the new row is not in the list", !after.items.some((i) => i.id === "new-1"),
    ids(after.items).slice(0, 60));
  check("it is waiting behind the pill", after.pending.length === 1 && after.pending[0]!.id === "new-1",
    ids(after.pending));
  check("the list is exactly as long as it was", after.items.length === 40, String(after.items.length));
  // THE ASSERTION §18 IS ACTUALLY ABOUT.
  check("row twenty has not moved", after.items[20]!.id === twenty, after.items[20]!.id);
  check("...and neither has anything else", ids(after.items) === ids(before.items));

  // THE PILL COUNTS UP RATHER THAN REPLACING. Three arrivals is three behind one pill.
  let list = before;
  for (const id of ["new-1", "new-2", "new-3"]) {
    list = mergeDelta(list, job(id, "queued"), { belongs: true, atTop: false });
  }
  check(`three arrivals make a pill of three (${list.pending.length})`, list.pending.length === 3,
    ids(list.pending));
  check("...and the list still has not moved", ids(list.items) === ids(before.items));
  // NEWEST FIRST BEHIND THE PILL TOO, so pressing it lands them in the order the list is in.
  check("the held rows are newest first", ids(list.pending) === "new-3,new-2,new-1", ids(list.pending));
}

// --- 2. an arrival while the reader is at the top goes straight in ---------------------------------

console.log("\nnothing below the fold to protect");
{
  const before = forty();
  const after = mergeDelta(before, job("new-1", "queued"), { belongs: true, atTop: true });

  check("it inserts directly", after.items[0]!.id === "new-1", after.items[0]!.id);
  check("...with no pill", after.pending.length === 0, ids(after.pending));
  check("...at the head, because the list is newest first", after.items.length === 41);
  check("...and everything else keeps its order",
    ids(after.items.slice(1)) === ids(before.items));
}

// --- 3. a status change updates in place and never reorders ----------------------------------------

console.log("\nthe version that is one character shorter");
{
  const before = forty();
  const target = before.items[20]!;

  const after = mergeDelta(before, { ...target, status: "failed" }, { belongs: true, atTop: false });

  check("the row is updated", after.items[20]!.status === "failed", after.items[20]!.status);
  // THE TEMPTING WRONG VERSION — remove and unshift — produces a list with exactly the right rows
  // and moves the changed one to the top. This is the assertion that fails on it.
  check("it did NOT move to the head", after.items[0]!.id !== target.id, after.items[0]!.id);
  check("it is still at index twenty", after.items[20]!.id === target.id, after.items[20]!.id);
  check("and the whole order is untouched", ids(after.items) === ids(before.items));
  check("...and nothing was held back", after.pending.length === 0);

  // A CHANGE AT THE TOP OF THE LIST IS ALSO IN PLACE, which is the case where "unshift" happens to
  // look right and therefore the one that hides the bug.
  const head = mergeDelta(before, { ...before.items[0]!, status: "running" }, { belongs: true, atTop: true });
  check("a change to the first row does not duplicate it", head.items.length === 40, String(head.items.length));
  check("...and it stays first", head.items[0]!.status === "running");

  // A CHANGE ARRIVING WHILE THE READER IS AT THE TOP IS STILL NOT AN ARRIVAL. `atTop` decides where
  // a NEW row goes and has nothing to say about an existing one.
  const atTop = mergeDelta(before, { ...target, status: "failed" }, { belongs: true, atTop: true });
  check("being at the top does not turn a change into an insert",
    atTop.items.length === 40 && atTop.items[20]!.id === target.id, String(atTop.items.length));
}

// --- 4. a row that leaves the filter is removed ----------------------------------------------------

console.log("\nthe one movement that is correct");
{
  const before = forty();
  const target = before.items[20]!;
  const after = mergeDelta(before, { ...target, status: "succeeded" }, { belongs: false, atTop: false });

  check("it is gone", !after.items.some((i) => i.id === target.id), String(after.items.length));
  check("...and the list is one shorter", after.items.length === 39);
  check("...and nothing else was reordered",
    ids(after.items) === ids(before.items.filter((i) => i.id !== target.id)));

  // A ROW THAT NEVER MATCHED AND STILL DOES NOT IS NOT AN ARRIVAL. Every delta is broadcast to
  // every socket in the workspace, so a client showing "mine, failed" receives a colleague's
  // running job — and holding it behind a pill would be a pill promising rows the list will refuse.
  const foreign = mergeDelta(before, job("someone-else", "running"), { belongs: false, atTop: false });
  check("a delta the filter refuses is not held behind the pill", foreign.pending.length === 0);
  check("...nor inserted", foreign.items.length === 40);
}

// --- 5. a held row can change while it is held -----------------------------------------------------

console.log("\nthe pill does not promise what it cannot deliver");
{
  let list = mergeDelta(forty(), job("new-1", "queued"), { belongs: true, atTop: false });
  list = mergeDelta(list, job("new-1", "succeeded"), { belongs: true, atTop: false });

  check("it is still one row, not two", list.pending.length === 1, ids(list.pending));
  check("...and it is the current version", list.pending[0]!.status === "succeeded",
    list.pending[0]!.status);
  check("...and it is still not in the list", list.items.length === 40);

  // AND A HELD ROW THAT LEAVES THE FILTER LEAVES THE PILL. Otherwise pressing it would insert a row
  // the filter refuses, and the list would immediately have to remove it again — a flash of a job
  // that does not belong, caused by the control that was supposed to be a promise.
  const gone = mergeDelta(list, job("new-1", "cancelled"), { belongs: false, atTop: false });
  check("a held row that stops matching stops being held", gone.pending.length === 0, ids(gone.pending));
  check("...and does not appear in the list either", gone.items.length === 40);
}

// --- 6. pressing the pill ---------------------------------------------------------------------------

console.log("\nadmitting what was held");
{
  let list = forty();
  for (const id of ["new-1", "new-2", "new-3"]) {
    list = mergeDelta(list, job(id, "queued"), { belongs: true, atTop: false });
  }
  const admitted = admitPending(list);

  check("all three land", admitted.items.length === 43, String(admitted.items.length));
  check("...at the head", ids(admitted.items.slice(0, 3)) === "new-3,new-2,new-1",
    ids(admitted.items.slice(0, 3)));
  check("...and the pill empties", admitted.pending.length === 0);
  check("...and the forty below them are in the order they were",
    ids(admitted.items.slice(3)) === ids(forty().items));

  // IDEMPOTENT AND DEDUPLICATING. A snapshot can land between the arrival and the press, so the
  // server's page may already hold a row this is about to unshift — and a list with the same job
  // twice is worse than a list that was one row stale.
  const already: LiveList = { items: [job("new-2"), ...forty().items], pending: [job("new-2"), job("new-1")] };
  const merged = admitPending(already);
  check("a row the page already holds is not added twice",
    merged.items.filter((i) => i.id === "new-2").length === 1,
    String(merged.items.filter((i) => i.id === "new-2").length));

  check("admitting nothing changes nothing", admitPending(forty()).items.length === 40);
  check("...and returns the same list rather than a copy", admitPending(list).pending.length === 0);
}

// --- 7. a snapshot clears what was held ------------------------------------------------------------

console.log("\na fresh page is a different question");
{
  const fresh = resetPending([job("a"), job("b")]);
  check("the page is what the server sent", ids(fresh.items) === "a,b", ids(fresh.items));
  check("...and nothing is held over from the last one", fresh.pending.length === 0);
}

console.log(fail === 0 ? "\nALL CORRECT" : `\n${fail} FAILURES`);
(globalThis as { process?: { exit(code: number): void } }).process?.exit(fail === 0 ? 0 : 1);
