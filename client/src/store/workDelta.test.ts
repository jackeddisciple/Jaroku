// A delta can ADD a row, UPDATE one, and REMOVE one — and the list is only live if it does all three.
//
// THIS IS THE SUITE FOR THE ONE DECISION `workStore` MAKES. §5 sends a transition as a single item
// broadcast to every socket in the workspace, which is what makes the Cockpit cheap; the price of
// that is that the FILTER lives on the client, and a client that gets it wrong shows a list that is
// quietly wrong rather than one that is obviously broken.
//
// THE UPDATE CASE IS THE ONE EVERYBODY WRITES. The other two are the ones that were missing when
// this was first driven by hand, and each is a different kind of wrong:
//
//   NOT ADDING makes the list a page that AGES. A job dispatched by a colleague — or by this very
//   client — arrives as a delta for a row the page does not hold, and a store that only ever
//   updated would show it after the next snapshot and not before. On a board whose whole claim is
//   "what is happening right now", that is the claim failing.
//
//   NOT REMOVING makes the list a record of WHAT ONCE MATCHED. Somebody filtered to `running`
//   watches a job succeed and it stays on the page, so the answer to "what is running" grows
//   monotonically until they reload.
//
// AND THE VIEWER IS AN ARGUMENT, WHICH IS WHY THE LAST CASE READS `socket.ts`. `matchesFilters`
// treats a null viewer as "no scope opinion" — deliberately, because the store must not import the
// session — so a call site that forgets to pass it does not fail loudly. It shows a colleague's
// jobs under a page that says "mine", which is the same class of bug `test:reset` exists for.
//
//   npm run test:work-delta

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { matchesFilters, useWorkStore } from "./workStore.ts";
import type { WorkCounts, WorkFilters, WorkItemDetailView, WorkItemView } from "../types.ts";

let failures = 0;
const check = (name: string, ok: boolean, detail = ""): void => {
  if (ok) console.log(`  ok   ${name}`);
  else {
    failures++;
    console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ""}`);
  }
};

const ME = "user-me";
const THEM = "user-them";

const NO_COUNTS: WorkCounts = {
  queued: 0, running: 0, waiting: 0, succeeded: 0, failed: 0, cancelled: 0,
};

const item = (patch: Partial<WorkItemView> & { id: string }): WorkItemView => ({
  agent_id: "agent-1",
  agent_name: "Support triage",
  deployment_id: "dep-1",
  run_id: null,
  created_by: ME,
  created_by_name: "Me",
  input_preview: "a customer email",
  status: "queued",
  output_preview: null,
  error: null,
  failure_kind: null,
  created_at: "2026-08-27T10:00:00.000Z",
  started_at: null,
  ended_at: null,
  cost_usd: null,
  tokens: null,
  duration_ms: null,
  cost_complete: true,
  ...patch,
});

const MINE: WorkFilters = { scope: "mine", status: null, agentId: null };

/** Put the store in a known state. Each case starts from a page, not from whatever the last left. */
const seed = (items: WorkItemView[], filters: WorkFilters = MINE, counts: WorkCounts = NO_COUNTS): void => {
  useWorkStore.getState().setSnapshot({ items, nextCursor: null, counts, filters });
};

const ids = (): string[] => useWorkStore.getState().items.map((i) => i.id);

console.log("\nmatchesFilters — the rule the delta is applied through\n");
{
  const mine = item({ id: "a" });
  const theirs = item({ id: "b", created_by: THEM });
  const all: WorkFilters = { scope: "all", status: null, agentId: null };
  const onlyMine: WorkFilters = MINE;

  check("`all` takes anybody's", matchesFilters(theirs, all, ME));
  check("`mine` takes mine", matchesFilters(mine, onlyMine, ME));
  check("`mine` drops theirs", !matchesFilters(theirs, onlyMine, ME));
  // The deliberate hole, asserted so it is a decision rather than an accident. See the header.
  check("`mine` with no viewer takes everything", matchesFilters(theirs, onlyMine, null));

  check("a status filter drops another status", !matchesFilters(mine, { ...all, status: "failed" }, ME));
  check("an agent filter drops another agent", !matchesFilters(mine, { ...all, agentId: "agent-2" }, ME));
}

console.log("\nnoteItem — update\n");
{
  seed([item({ id: "a" }), item({ id: "b" })]);
  useWorkStore.getState().noteItem(item({ id: "a", status: "running", started_at: "2026-08-27T10:00:01.000Z" }), ME);

  check("the row is replaced in place", ids().join(",") === "a,b", ids().join(","));
  check("...with the new status", useWorkStore.getState().items[0]!.status === "running");
}

console.log("\nnoteItem — add\n");
{
  seed([item({ id: "a" })]);
  useWorkStore.getState().noteItem(item({ id: "new" }), ME);

  check("a job the page did not hold joins it", ids().includes("new"));
  // Newest-first is the list's order, so the row that has just come into existence goes on top.
  check("...at the head", ids()[0] === "new", ids().join(","));
}

console.log("\nnoteItem — and only when it belongs\n");
{
  seed([item({ id: "a" })]);
  useWorkStore.getState().noteItem(item({ id: "theirs", created_by: THEM }), ME);
  check("a colleague's job does not join a page that says `mine`", !ids().includes("theirs"), ids().join(","));

  seed([item({ id: "a" })], { scope: "all", status: "failed", agentId: null });
  useWorkStore.getState().noteItem(item({ id: "running-one", status: "running" }), ME);
  check("...nor a running job a page filtered to `failed`", !ids().includes("running-one"), ids().join(","));
}

console.log("\nnoteItem — remove\n");
{
  seed([item({ id: "a", status: "running" }), item({ id: "b", status: "running" })], { scope: "all", status: "running", agentId: null });
  useWorkStore.getState().noteItem(item({ id: "a", status: "succeeded", ended_at: "2026-08-27T10:00:09.000Z" }), ME);

  check("a row that stops matching leaves the page", !ids().includes("a"), ids().join(","));
  check("...and the rest of the page is untouched", ids().join(",") === "b", ids().join(","));
}

console.log("\nthe counts move with the row, because they feed the badge\n");
{
  seed([item({ id: "a", status: "running" })], undefined, { ...NO_COUNTS, running: 1 });
  useWorkStore.getState().noteItem(item({ id: "a", status: "waiting" }), ME);

  const c = useWorkStore.getState().counts;
  check("the old status is decremented", c.running === 0, String(c.running));
  check("...and the new one raised", c.waiting === 1, String(c.waiting));

  // A DELTA FOR A ROW WE DID NOT HOLD IS AN ARRIVAL, and that is true whether or not it is on the
  // page: the counts are the WORKSPACE's, so a colleague's job going to `waiting` must light the
  // badge for everybody even though it never appears on a page filtered to `mine`.
  seed([], undefined, NO_COUNTS);
  useWorkStore.getState().noteItem(item({ id: "theirs", created_by: THEM, status: "waiting" }), ME);
  check("a job that never joins the page still counts", useWorkStore.getState().counts.waiting === 1);
  check("...and still does not join it", ids().length === 0, ids().join(","));

  // Re-sending the same transition must not count it twice. Deltas are re-broadcast on a
  // reconnect, and a badge that climbed on every duplicate would be a badge nobody trusted.
  seed([item({ id: "a", status: "waiting" })], undefined, { ...NO_COUNTS, waiting: 1 });
  useWorkStore.getState().noteItem(item({ id: "a", status: "waiting" }), ME);
  check("the same status twice is not counted twice", useWorkStore.getState().counts.waiting === 1);

  // A count cannot go below zero. The snapshot's counts and the page can legitimately disagree —
  // a page is fifty rows and the workspace may hold thousands — so this is arithmetic on a partial
  // view, and a negative badge is worse than a stale one.
  seed([item({ id: "a", status: "running" })], undefined, NO_COUNTS);
  useWorkStore.getState().noteItem(item({ id: "a", status: "succeeded" }), ME);
  check("a count never goes negative", useWorkStore.getState().counts.running === 0);
}

console.log("\nthe open panel moves with the row it is showing\n");
{
  const detail: WorkItemDetailView = { ...item({ id: "a", status: "running" }), input: "the whole email", output: null };
  seed([item({ id: "a", status: "running" })]);
  useWorkStore.getState().openItem(detail);
  useWorkStore.getState().noteItem(item({ id: "a", status: "succeeded", output_preview: "done" }), ME);

  const open = useWorkStore.getState().open;
  check("the panel takes the new status", open?.status === "succeeded");
  // THE ROW DOES NOT CARRY `input`, so merging one over a detail must not erase what the panel has.
  check("...without losing what a row does not carry", open?.input === "the whole email");

  useWorkStore.getState().noteItem(item({ id: "other", status: "failed" }), ME);
  check("a delta for another job leaves the panel alone", useWorkStore.getState().open?.id === "a");
}

console.log("\nand the socket passes the viewer\n");
{
  // The audit half. `matchesFilters` cannot fail loudly on a missing viewer — see the header — so
  // the call site is read instead. This is the same shape as `test:work-badge`'s sidebar read.
  const here = fileURLToPath(import.meta.url);
  const socket = readFileSync(here.replace(/store[\\/]workDelta\.test\.ts$/, "lib/socket.ts"), "utf8");

  const calls = socket.match(/w\.noteItem\([^)]*\)/g) ?? [];
  check("the socket files deltas through the store", calls.length > 0);
  check(
    "...and every call names the viewer",
    calls.every((c) => /,/.test(c)),
    calls.join(" | "),
  );
  // And it must not do the store's job for it: a call gated on the filter cannot add or remove.
  check(
    "...and does not filter before it gets there",
    !/if\s*\(matchesFilters[^)]*\)\s*w\.noteItem/.test(socket),
  );
}

console.log(failures === 0 ? "\nALL CORRECT\n" : `\n${failures} FAILED\n`);
// The client has no `@types/node` on purpose — see `node-shims.d.ts` — so `process` is reached the
// way `reset.test.ts` reaches it rather than by widening the shim for one line.
if (failures > 0) (globalThis as { process?: { exitCode?: number } }).process!.exitCode = 1;
