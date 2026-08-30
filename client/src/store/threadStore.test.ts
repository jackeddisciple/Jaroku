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

import {
  agentChipLabel, threadById, threadEvalProgress, threadSpend, useThreadStore,
} from "./threadStore.ts";
import { fmtRunningCost } from "../lib/threadCost.ts";
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
  // Part 3's three, at their empty values: nothing asked, and a build thread — which is what
  // every row these fixtures stand in for is.
  ask_cost_usd: null,
  ask_cost_known: true,
  mode: "build",
  preview: "add exponential backoff to the retry handler",
  live_run_ids: [],
  live_eval_ids: [],
  eval_progress: null,
  agent_active: 1,
  cost_share_high: false,
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

// --- 8. the live cost delta (§4.3.3) ---------------------------------------------------------
{
  reset();
  state().setThreads(
    [
      thread({ id: "running", status: "running", cost_usd: 0.8, live_run_ids: ["run-1", "run-2"] }),
      thread({ id: "quiet", status: "idle", cost_usd: 0.04, live_run_ids: [] }),
    ],
    counts({ all: 2, needs_you: 0, running: 1, recent: 1 }),
  );

  state().addStepCost("run-1", 0.01, "s1");
  state().addStepCost("run-2", 0.01, "s2");
  check("a step's cost lands on the thread that owns its run", state().liveCost["running"] === 0.02);
  check("...and the sum is what a row renders",
    threadSpend(state().threads[0]!, state().liveCost)?.toFixed(2) === "0.82");
  check("a thread with no live run gets nothing", state().liveCost["quiet"] === undefined);
  check("...and renders the ledger's figure alone",
    threadSpend(state().threads[1]!, state().liveCost) === 0.04);

  // A run nothing claims: a shadow run a webhook started, or an eval job whose snapshot has not arrived
  // yet. Attributing it to the wrong session would put somebody else's spend on your row.
  state().addStepCost("run-nobodys", 5, "s3");
  check("a step from an unclaimed run is dropped rather than guessed at",
    Object.values(state().liveCost).reduce((a, b) => a + b, 0).toFixed(2) === "0.02");

  // THE SAME STEP TWICE. Ingestion is at-least-once and dispatch can be duplicated (a second socket
  // after a workspace switch mid-backoff used to do exactly that), and this was the one consumer of
  // the trace channel that accumulated blindly — so a running thread's live figure inflated at
  // double rate. `traceStore.applyEvent` has been keyed by step id from the start, for this reason.
  state().addStepCost("run-1", 0.01, "s1");
  check("the same step counted twice contributes once", state().liveCost["running"] === 0.02);

  // An unpriced step arrives as null and reaches this as 0. It must not create an entry — unknown is
  // not zero, and a zero entry is a claim that this thread has live spend of nothing.
  state().addStepCost("run-1", 0, "s4");
  check("a zero contributes nothing and creates no entry", state().liveCost["running"] === 0.02);

  // THE SNAPSHOT IS THE AUTHORITY. Keeping a delta across one would eventually count it twice.
  state().setThreads(
    [thread({ id: "running", status: "running", cost_usd: 0.82, live_run_ids: ["run-1"] })],
    counts({ all: 1, needs_you: 0, running: 1, recent: 0 }),
  );
  check("a fresh snapshot clears the deltas it has caught up with",
    Object.keys(state().liveCost).length === 0);
  check("...and the figure is now the ledger's alone",
    threadSpend(state().threads[0]!, state().liveCost) === 0.82);

  // And a thread with no ledger figure at all: live spend alone is still a figure, and no spend at all is
  // still null rather than zero.
  reset();
  state().setThreads([thread({ id: "new", cost_usd: null, live_run_ids: ["r"] })], counts());
  check("a thread with nothing recorded and nothing live has no figure",
    threadSpend(state().threads[0]!, state().liveCost) === null);
  state().addStepCost("r", 0.005, "s5");
  check("...and one with only live spend has one",
    threadSpend(state().threads[0]!, state().liveCost) === 0.005);
}

// --- 9. an EVAL's live cost and moving denominator (§4.3.3's worked example) ------------------
{
  // An eval's runs are deliberately kept off the `trace` channel — a running eval must not steal the
  // timeline's focus — so `addStepCost` is never called for one. Without the eval channel carrying a
  // cost, the row showed a frozen figure; and because the only snapshot is taken when the eval
  // STARTS, `done` was 0 and `projectCost` correctly refused to extrapolate, so the projection never
  // appeared either. The two halves of §4.3.3 were mutually exclusive in the shipped product.
  reset();
  state().setThreads(
    [thread({
      id: "sweep", status: "running", cost_usd: 0.5,
      live_run_ids: ["job-1"], live_eval_ids: ["ev-1"],
      eval_progress: { done: 0, total: 120 },
    })],
    counts({ all: 1, needs_you: 0, running: 1, recent: 0 }),
  );
  const row = () => state().threads[0]!;

  check("at eval start there is no denominator to project from",
    fmtRunningCost(threadSpend(row(), state().liveCost), true,
      threadEvalProgress(row(), state().liveEvalProgress)) === "$0.50");

  state().addEvalCost("ev-1", 0.32);
  state().noteEvalProgress("ev-1", { done: 34, total: 120 });
  check("an eval's spend lands on the thread that owns the eval", state().liveCost["sweep"] === 0.32);
  check("...and the denominator moves with it",
    threadEvalProgress(row(), state().liveEvalProgress)?.done === 34);
  check("...which is the spec's own worked example",
    fmtRunningCost(threadSpend(row(), state().liveCost), true,
      threadEvalProgress(row(), state().liveEvalProgress)) === "$0.82 → ~$2.89",
    fmtRunningCost(threadSpend(row(), state().liveCost), true,
      threadEvalProgress(row(), state().liveEvalProgress)) ?? "null");

  state().addEvalCost("ev-nobodys", 9);
  check("a delta for an eval no thread claims is dropped rather than guessed at",
    state().liveCost["sweep"] === 0.32);

  // Progress is a REPLACE, not an accumulate: the event says where the eval is, so a duplicate
  // delivery is harmless.
  state().noteEvalProgress("ev-1", { done: 34, total: 120 });
  check("a repeated progress event does not advance anything",
    threadEvalProgress(row(), state().liveEvalProgress)?.done === 34);
}

console.log(fail === 0 ? "\nALL CORRECT" : `\n${fail} FAILURES`);
// `globalThis.process` rather than `process`: the client tsconfig has no node types, which is
// correct — nothing in the app may reach for one. Same spelling as lib/title.test.ts.
(globalThis as { process?: { exit(code: number): void } }).process?.exit(fail === 0 ? 0 : 1);
