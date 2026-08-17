// The thread store: what a snapshot does to it, and what one row does not.
//
// Two rules are worth holding down here, and both are about the same failure — a list assembled out of
// two moments:
//
//   A SNAPSHOT REPLACES. Every message on this channel is the whole list plus the counts computed
//   beside it, so a store that merged could show four rows and a count of three. The nav badge (§2.1)
//   is drawn from those same counts, so the mismatch would appear twice and in two places a person
//   compares.
//
//   ONE ROW DOES NOT TOUCH THE COUNTS, AND DOES NOT NAVIGATE. `loadThread` answers the client that
//   asked with a single thread; updating counts from it would be exactly the partial-update
//   reconciliation §7.1 refuses, and selecting from it would make an ordinary refresh navigate.
//
//   npm run test:thread-store

import { agentChipLabel, threadById, useThreadStore } from "./threadStore.ts";
import type { ThreadCounts, ThreadView } from "../types.ts";

let fail = 0;
const check = (name: string, ok: boolean, detail = ""): void => {
  if (ok) console.log(`  ok   ${name}`);
  else { fail++; console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ""}`); }
};

const thread = (over: Partial<ThreadView> = {}): ThreadView => ({
  id: "t1",
  agent_id: "a1",
  agent_name: "stripe_webhook",
  agent_deleted: false,
  title: "Stripe webhook retry logic",
  title_is_custom: false,
  created_by: "u1",
  created_at: "2026-08-01T00:00:00.000Z",
  last_activity_at: "2026-08-01T00:00:00.000Z",
  archived_at: null,
  status: "needs_you",
  fragment: "diff pending +42−11",
  cost_usd: 0.04,
  cost_known: true,
  preview: "add exponential backoff to the retry handler",
  ...over,
});

const counts = (over: Partial<ThreadCounts> = {}): ThreadCounts => ({
  all: 1, needs_you: 1, running: 0, recent: 0, archived: 0, ...over,
});

const state = () => useThreadStore.getState();
const reset = (): void => useThreadStore.setState(useThreadStore.getInitialState(), true);

// --- 1. before the first snapshot ------------------------------------------------------------
{
  reset();
  // §9's no-spinners rule needs this to be its own state: "not told yet" renders skeleton rows and
  // "there are none" renders the sentence that names the workspace. One flag, two screens.
  check("a fresh store has not been told anything yet", state().loaded === false);
  check("...and holds no rows", state().threads.length === 0);
  check("...and no counts, rather than counts of nothing in particular", state().counts.all === 0);
  check("...and nothing selected, which is a real state (§3.1's planning stage)",
    state().activeThreadId === null);
}

// --- 2. a snapshot replaces ------------------------------------------------------------------
{
  reset();
  state().setThreads([thread({ id: "t1" }), thread({ id: "t2" })], counts({ all: 2, needs_you: 2 }));
  check("a snapshot lands", state().threads.length === 2);
  check("...and marks the store loaded", state().loaded === true);
  check("...with the counts computed beside those rows", state().counts.needs_you === 2);

  // The archived thread left the list on the server, so the next snapshot simply does not contain it.
  // A merge would keep it and the counts would then describe a different list to the rows.
  state().setThreads([thread({ id: "t2" })], counts({ all: 1, needs_you: 1 }));
  check("the next snapshot replaces rather than merges", state().threads.length === 1);
  check("...and it is the row the server sent", state().threads[0]?.id === "t2");
  check("...with counts that match what is rendered", state().counts.all === 1);
}

// --- 3. an error is shown, not swallowed, and the next snapshot clears it --------------------
{
  reset();
  state().setError("a thread needs a name — Escape cancels the edit");
  check("a refusal is held for the strip to render", state().error !== null);
  state().setThreads([thread()], counts());
  check("...and a fresh snapshot clears it, because the list is now right", state().error === null);
}

// --- 4. one row updates that row and nothing else --------------------------------------------
{
  reset();
  state().setThreads([thread({ id: "t1", title: "old" }), thread({ id: "t2" })], counts({ all: 2, needs_you: 2 }));
  state().setThread(thread({ id: "t1", title: "new" }));
  check("the named row is replaced", threadById(state().threads, "t1")?.title === "new");
  check("...its neighbour is untouched", threadById(state().threads, "t2")?.title === "Stripe webhook retry logic");
  check("...the counts are left alone, because one row cannot describe the list",
    state().counts.all === 2);
  check("...and nothing was selected by it", state().activeThreadId === null);

  // A row the list has not been told about yet — a thread just created, arriving before the snapshot
  // that will include it. Appended rather than dropped: the client asked for it by id.
  state().setThread(thread({ id: "t3" }));
  check("a row the list did not have is added rather than dropped", state().threads.length === 3);
}

// --- 5. selecting is the view's decision -----------------------------------------------------
{
  reset();
  state().setThreads([thread()], counts());
  state().selectThread("t1");
  check("the view can select a thread", state().activeThreadId === "t1");
  state().selectThread(null);
  check("...and unselect it, which is the composer with no session yet",
    state().activeThreadId === null);
}

// --- 6. the agent chip's three readings (§4.3) ------------------------------------------------
{
  check("a live agent reads as its name",
    agentChipLabel(thread()) === "stripe_webhook");
  check("a deleted one keeps the name and says so",
    agentChipLabel(thread({ agent_id: null, agent_deleted: true })) === "stripe_webhook (deleted)");
  check("one that never had an agent says so instead",
    agentChipLabel(thread({ agent_id: null, agent_name: null, agent_deleted: false })) === "(no agent)");
  // The pair is what tells the middle case from the last. A snapshot missing the flag must not read
  // as "(agent deleted)" — the whole reason the snapshot column exists is that the NAME survives.
  check("a name with no id and no flag still renders the name rather than an apology",
    agentChipLabel(thread({ agent_id: null })) === "stripe_webhook");
}

// --- 7. lookups ------------------------------------------------------------------------------
{
  reset();
  state().setThreads([thread({ id: "t1" })], counts());
  check("a thread can be found by id", threadById(state().threads, "t1")?.id === "t1");
  check("...an unknown id is undefined, not a guess", threadById(state().threads, "nope") === undefined);
  check("...and no id at all is undefined too", threadById(state().threads, null) === undefined);
}

console.log(fail === 0 ? "\nALL CORRECT" : `\n${fail} FAILURES`);
// `globalThis.process` rather than `process`: the client tsconfig has no node types, which is
// correct — nothing in the app may reach for one. Same spelling as lib/title.test.ts.
(globalThis as { process?: { exit(code: number): void } }).process?.exit(fail === 0 ? 0 : 1);
