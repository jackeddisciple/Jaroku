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

import { KNOWN_JOBS, LOG_LINES_KEPT, matchesFilters, mergeLogs, useWorkStore } from "./workStore.ts";
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
  agent_slug: null,
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
  tool_refusals: [],
  stop_requested_at: null,
  ...patch,
});

const MINE: WorkFilters = { scope: "mine", status: null, agentId: null };

/** Put the store in a known state. Each case starts from a page, not from whatever the last left. */
const seed = (
  items: WorkItemView[],
  filters: WorkFilters = MINE,
  counts: WorkCounts = NO_COUNTS,
  workspaceCounts: WorkCounts = counts,
): void => {
  useWorkStore.getState().setSnapshot({ items, nextCursor: null, counts, workspaceCounts, filters });
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

  // A COLLEAGUE'S JOB MOVES THE BADGE AND NOT THE CHIPS, which is the whole reason they are two
  // numbers. The badge is the workspace's — a confirmation blocks whoever can answer it, not the
  // person who dispatched it — while the chips describe the list under them, and a chip that
  // counted a job the page will never show is a chip promising something clicking it cannot give.
  seed([], undefined, NO_COUNTS, NO_COUNTS);
  useWorkStore.getState().noteItem(item({ id: "theirs", created_by: THEM, status: "waiting" }), ME);
  check("a colleague's job lights the badge", useWorkStore.getState().workspaceCounts.waiting === 1);
  check("...without moving the chips over a page filtered to mine",
    useWorkStore.getState().counts.waiting === 0, String(useWorkStore.getState().counts.waiting));
  check("...and still does not join the page", ids().length === 0, ids().join(","));

  // AND UNDER "EVERYONE'S" THE SAME DELTA MOVES BOTH, because the page is then about that job too.
  seed([], { scope: "all", status: null, agentId: null }, NO_COUNTS, NO_COUNTS);
  useWorkStore.getState().noteItem(item({ id: "theirs", created_by: THEM, status: "waiting" }), ME);
  check("under Everyone's, a colleague's job moves the chips as well",
    useWorkStore.getState().counts.waiting === 1 && useWorkStore.getState().workspaceCounts.waiting === 1);

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

console.log("\nthe counts a dispatch moves, and the server's own counts after it\n");
{
  // EVERY DISPATCH LEFT A "QUEUED 1" BEHIND FOR GOOD. The placeholder was counted `queued`, the
  // real row arrived already `running`, and nothing moved either count: six dispatches read nine.
  seed([], MINE, NO_COUNTS);
  const w = () => useWorkStore.getState();
  w().drawOptimistic(item({ id: "pending:r1", status: "queued" }));
  check("a drawn row is counted queued", w().counts.queued === 1);
  w().settleOptimistic("r1", item({ id: "job-1", status: "running" }));
  check("settled, it leaves queued", w().counts.queued === 0, JSON.stringify(w().counts));
  check("...and is counted as what it really is", w().counts.running === 1, JSON.stringify(w().counts));
  w().noteItem(item({ id: "job-1", status: "running" }), ME);
  check("the broadcast that follows does not count it a second time", w().counts.running === 1);
  w().noteItem(item({ id: "job-1", status: "succeeded" }), ME);
  check("...and its ending moves it, once",
    w().counts.running === 0 && w().counts.succeeded === 1 && w().counts.queued === 0, JSON.stringify(w().counts));

  // A DELTA CAN BEAT THE ANSWER: the real row is already held when the dispatch is settled.
  seed([], MINE, NO_COUNTS);
  w().drawOptimistic(item({ id: "pending:r2", status: "queued" }));
  w().noteItem(item({ id: "job-2", status: "running" }), ME);
  w().settleOptimistic("r2", item({ id: "job-2", status: "running" }));
  check("a row a delta already counted is not counted twice when it settles",
    w().counts.running === 1 && w().counts.queued === 0, JSON.stringify(w().counts));

  // AND THE SERVER HAS THE LAST WORD, under the filters the page is still showing.
  seed([], MINE, { ...NO_COUNTS, queued: 13 });
  w().setCounts({ counts: { ...NO_COUNTS, running: 4 }, workspaceCounts: { ...NO_COUNTS, running: 5 }, filters: MINE });
  check("re-read counts replace the drifted ones", w().counts.queued === 0 && w().counts.running === 4);
  check("...and the badge's own", w().workspaceCounts.running === 5);
  w().setCounts({
    counts: { ...NO_COUNTS, failed: 9 }, workspaceCounts: { ...NO_COUNTS, failed: 9 },
    filters: { scope: "all", status: null, agentId: null },
  });
  check("counts for a filter the page has left do not move the chips", w().counts.failed === 0);
  check("...though the workspace's figures, which no filter moves, still do", w().workspaceCounts.failed === 9);
}

console.log("\na followed log window adds to the pane rather than replacing it\n");
{
  // THE PANE BLANKED ITSELF FOUR SECONDS AFTER OPENING: the first follow poll asked for lines newer
  // than the last one shown, got none, and replaced the window with that.
  const line = (t: string, m: string) => ({ timestamp: `2026-10-04T07:34:${t}.000000000Z`, message: m, severity: null });
  const first = { deploymentId: "dep-1", lines: [line("01", "Starting Container"), line("02", "[serve] up")], cursor: "c2" };
  const empty = mergeLogs(first, { deploymentId: "dep-1", lines: [], cursor: "c2" });
  check("an empty follow keeps what was shown", empty.lines.length === 2, JSON.stringify(empty.lines));
  const more = mergeLogs(empty, { deploymentId: "dep-1", lines: [line("02", "[serve] up"), line("03", "job 1")], cursor: "c3" });
  check("a new line is added once, after the others",
    more.lines.map((l) => l.message).join("|") === "Starting Container|[serve] up|job 1", JSON.stringify(more.lines));
  check("...and the cursor moves on", more.cursor === "c3");
  check("a late answer to an older poll does not walk the cursor back",
    mergeLogs(more, { deploymentId: "dep-1", lines: [], cursor: "c2" }).cursor === "c3");
  check("another deployment's window starts afresh",
    mergeLogs(more, { deploymentId: "dep-2", lines: [line("09", "other")], cursor: "x" }).lines.length === 1);
  const many = { deploymentId: "dep-1", lines: Array.from({ length: LOG_LINES_KEPT + 50 }, (_, i) =>
    ({ timestamp: `2026-10-04T08:${String(Math.floor(i / 60)).padStart(2, "0")}:${String(i % 60).padStart(2, "0")}Z`, message: `l${i}`, severity: null })), cursor: "z" };
  check(`the pane keeps the newest ${LOG_LINES_KEPT}`, mergeLogs(null, many).lines.length === LOG_LINES_KEPT
    && mergeLogs(null, many).lines.at(-1)?.message === `l${LOG_LINES_KEPT + 49}`);
}

console.log("\na late answer does not reopen a panel somebody closed\n");
{
  const w = () => useWorkStore.getState();
  const detail = (id: string) => ({ ...item({ id }), input: "the full input", output: null }) as WorkItemDetailView;
  seed([]);
  w().closeItem();
  w().openingItem("job-a");
  w().closeItem();
  w().receiveDetail(detail("job-a"));
  check("an answer arriving after the panel was closed leaves it closed", w().open === null);
  w().openingItem("job-b");
  w().receiveDetail(detail("job-a"));
  check("...and an answer for another job does not take the place of the one asked for",
    w().open === null && w().openingId === "job-b");
  w().receiveDetail(detail("job-b"));
  check("the answer the panel is waiting for opens it", w().open?.id === "job-b" && w().openingId === null);
  w().receiveDetail({ ...detail("job-b"), output: "done" });
  check("...and a re-read of the open job refreshes it", w().open?.output === "done");
  w().closeItem();
}

console.log("\nwhat a conversation can show of a job it gave\n");
{
  // AN OPERATE THREAD HOLDS A REFERENCE ONLY, and the job may be on no page the Cockpit shows — so
  // it showed "Gave the agent a job" and neither what was asked nor what came back.
  const w = () => useWorkStore.getState();
  seed([], { scope: "mine", status: "failed", agentId: null });
  w().noteItem(item({ id: "job-t", status: "running", created_by: THEM }), ME);
  check("a job off every page is still known", w().known["job-t"]?.status === "running");
  w().receiveDetail({ ...item({ id: "job-t", status: "succeeded" }), input: "what is 17 times 23?", output: "391" } as WorkItemDetailView);
  check("its detail is kept without opening the panel", w().open === null && (w().known["job-t"] as WorkItemDetailView).output === "391");
  w().noteItem(item({ id: "job-t", status: "succeeded", output_preview: "391" }), ME);
  const kept = w().known["job-t"] as WorkItemDetailView;
  check("a later row of the same job does not throw away what was asked and answered",
    kept.input === "what is 17 times 23?" && kept.output === "391", JSON.stringify(kept));
  for (let i = 0; i < KNOWN_JOBS + 20; i++) w().noteItem(item({ id: `bulk-${i}` }), ME);
  check(`at most ${KNOWN_JOBS} are kept, forgetting the oldest`,
    Object.keys(w().known).length === KNOWN_JOBS && !w().known["job-t"] && Boolean(w().known[`bulk-${KNOWN_JOBS + 19}`]));
}

console.log(failures === 0 ? "\nALL CORRECT\n" : `\n${failures} FAILED\n`);
// The client has no `@types/node` on purpose — see `node-shims.d.ts` — so `process` is reached the
// way `reset.test.ts` reaches it rather than by widening the shim for one line.
if (failures > 0) (globalThis as { process?: { exitCode?: number } }).process!.exitCode = 1;
