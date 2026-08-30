// §9's rungs: what a job an agent was given does to the conversation it happened in.
//
// TWO HALVES, AND THE SECOND IS THE ONE THAT COULD SHIP BROKEN. The first is the deriver, driven by
// fixtures like `test:thread-status` drives it — a fact goes in, a status and a fragment come out.
// The second is the COLLECTOR: real `thread_items` rows and a map of what their jobs' rows say,
// through `collectThreadFacts` and out the other side. A ladder can be perfect and still never fire
// if nothing turns a `work` item into a fact, and a fixture-only suite cannot tell the two apart.
//
// §9 ASKS FOR FOUR THINGS AND EVERY ONE OF THEM IS HERE BY NAME: waiting → needs_you, running →
// running, an unreviewed failure → errored, and archived still winning over all of them.
//
// AND ONE THING §9 ASKS FOR OBLIQUELY. "Note the file's existing distinction between a failed step
// in the middle of a thread and a thread that stopped, because work items reproduce exactly that
// shape." So the pair that matters most here is a failure with later work on top of it (unresolved
// work — needs_you) against a failure that was the last thing to happen (a thread that stopped —
// errored). Getting that backwards is invisible in a screenshot of either one alone.
//
//   npm run test:thread-status-work

import { collectThreadFacts, type WorkFact } from "./threadFacts.ts";
import { NO_FACTS, deriveThreadStatus, isBlocked, type ThreadFacts } from "./threadStatus.ts";
import type { ThreadItem } from "./threadStore.ts";
import type { WorkStatus } from "./work/workStore.ts";

let fail = 0;
const check = (name: string, ok: boolean, detail = ""): void => {
  if (ok) console.log(`  ok   ${name}`);
  else { fail++; console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ""}`); }
};

const facts = (over: Partial<ThreadFacts> = {}): ThreadFacts => ({ ...NO_FACTS, ...over });
const derive = (over: Partial<ThreadFacts> = {}) => deriveThreadStatus(facts(over));

console.log("\nthe deriver, one fixture per rung");
{
  const waiting = derive({ waitingWork: 1 });
  check("§9: a waiting job needs you", waiting.status === "needs_you", waiting.status);
  check("...and the fragment says who is being waited on",
    waiting.fragment === "job waiting on you", String(waiting.fragment));
  check("...and two read as two",
    derive({ waitingWork: 2 }).fragment === "2 jobs waiting on you",
    String(derive({ waitingWork: 2 }).fragment));

  const running = derive({ runningWork: 1 });
  check("§9: a running job is running", running.status === "running", running.status);
  check("...and the fragment counts them rather than saying 'running'",
    running.fragment === "1 job running", String(running.fragment));
  check("...and two read as two",
    derive({ runningWork: 2 }).fragment === "2 jobs running",
    String(derive({ runningWork: 2 }).fragment));

  // THE THIRD RUNG IS RUNG 2, NOT A NEW ONE. `lastEndedInError` is what "nobody has looked at it"
  // means in a conversation: nothing came after it.
  const stopped = derive({ lastEndedInError: true });
  check("§9: a failure nothing came after is errored", stopped.status === "errored", stopped.status);

  // AND THE OTHER HALF OF THE PAIR. A failure with later work on top is unresolved work.
  const unresolved = derive({ failedWork: 1 });
  check("a failure that was NOT the last thing is needs_you, not errored",
    unresolved.status === "needs_you", unresolved.status);
  check("...and says how many jobs failed",
    unresolved.fragment === "1 job failed", String(unresolved.fragment));
  check("...and two read as two", derive({ failedWork: 2 }).fragment === "2 jobs failed");

  check("a waiting job is blocked work", isBlocked(facts({ waitingWork: 1 })));
  check("a failed job is blocked work", isBlocked(facts({ failedWork: 1 })));
  check("a running job is not", !isBlocked(facts({ runningWork: 1 })));
}

console.log("\nand the ordering between them");
{
  // NEEDS_YOU STILL BEATS RUNNING, which is rung 3's whole argument applied to jobs: a fleet with
  // one job parked on somebody's answer and one job executing is a fleet that needs a person, and
  // letting the running one hide it would make the badge answer "is anything blocked" with "no,
  // something else is happening".
  check("a waiting job beats a running one",
    derive({ waitingWork: 1, runningWork: 3 }).status === "needs_you");
  // AND A STOP BEATS BOTH. A thread whose last job failed is stopped even if an earlier one is
  // somehow still running — the fragment then names the failure, which is the thing to act on.
  check("a stop beats a waiting job",
    derive({ lastEndedInError: true, waitingWork: 1 }).status === "errored");
  // §9: ARCHIVED STILL WINS OVER ALL OF THEM. The reason the ladder already gives — a thread told
  // not to ask for attention must not ask for it — does not stop applying because the thing asking
  // is a live container.
  for (const over of [
    { waitingWork: 1 }, { runningWork: 1 }, { failedWork: 1 }, { lastEndedInError: true },
  ]) {
    const archived = derive({ ...over, archivedAt: "2026-01-01T00:00:00.000Z" });
    check(`§9: archived beats ${Object.keys(over)[0]}`, archived.status === "archived", archived.status);
  }
  // AND A BUILD THREAD IS UNCHANGED. Every fact this part adds is zero there, so the rungs read
  // exactly as they did — asserted rather than assumed, because "we only added to it" is the claim
  // every regression in a shared deriver is made under.
  check("a thread with no jobs is still idle", derive().status === "idle");
  check("a pending diff still outranks a running job",
    derive({ pendingDiff: { added: 1, removed: 0 }, runningWork: 1 }).status === "needs_you");
  check("a pending diff still owns the fragment",
    derive({ pendingDiff: { added: 42, removed: 11 }, waitingWork: 1 }).fragment === "diff pending +42−11");
}

// --- the collector, which is where a rung actually gets its fact ------------------------------

const THREAD = "11111111-1111-4111-8111-111111111111";
let seq = 0;
const item = (kind: ThreadItem["kind"], refId: string | null): ThreadItem => ({
  id: `i${++seq}`,
  thread_id: THREAD,
  kind,
  ref_id: refId,
  role: kind === "message" ? "user" : null,
  body: kind === "message" ? "did that mail go out?" : null,
  // ONE MILLISECOND APART, because the collector's `lastOutcome` reads the items IN ORDER and the
  // order is the whole of how "nothing came after it" is decided.
  created_at: new Date(Date.UTC(2026, 0, 1, 0, 0, seq)).toISOString(),
});

function collect(
  items: ThreadItem[],
  work: Record<string, WorkStatus>,
  archivedAt: string | null = null,
): ThreadFacts {
  const derived = collectThreadFacts({
    threads: [{ id: THREAD, agent_id: "agent-1", archived_at: archivedAt }],
    items,
    runs: new Map(),
    evals: new Map(),
    work: new Map<string, WorkFact>(Object.entries(work).map(([id, status]) => [id, { status }])),
    proposals: new Map(),
    plans: new Set(),
    rejectedGenerations: new Set(),
    confirms: new Map(),
    deployedAgents: new Set(),
  });
  return derived.get(THREAD)!.facts;
}

console.log("\nthe collector, from real items");
{
  seq = 0;
  const waiting = collect([item("message", null), item("work", "w1")], { w1: "waiting" });
  check("a work item whose row says waiting produces waitingWork", waiting.waitingWork === 1);
  check("...and the thread reads needs_you end to end",
    deriveThreadStatus(waiting).status === "needs_you");

  seq = 0;
  for (const status of ["queued", "running"] as const) {
    const live = collect([item("work", "w1")], { w1: status });
    check(`a ${status} job is in flight`, live.runningWork === 1, String(live.runningWork));
    check(`...and the thread reads running`, deriveThreadStatus(live).status === "running");
    seq = 0;
  }

  seq = 0;
  const succeeded = collect([item("work", "w1")], { w1: "succeeded" });
  check("a succeeded job leaves nothing outstanding",
    deriveThreadStatus(succeeded).status === "idle", deriveThreadStatus(succeeded).status);

  // CANCELLED IS NOT A FAILURE. Somebody asked for it to stop and it stopped; a red ✕ would report
  // a decision as a fault.
  seq = 0;
  const cancelled = collect([item("work", "w1")], { w1: "cancelled" });
  check("a cancelled job is not an error", deriveThreadStatus(cancelled).status === "idle",
    deriveThreadStatus(cancelled).status);

  // §9'S THIRD RUNG, END TO END.
  seq = 0;
  const stopped = collect([item("message", null), item("work", "w1")], { w1: "failed" });
  check("a failed job nothing came after stops the thread", stopped.lastEndedInError);
  check("...and it is errored rather than needs_you",
    deriveThreadStatus(stopped).status === "errored", deriveThreadStatus(stopped).status);
  // AND IT IS NOT ALSO COUNTED AS OUTSTANDING. One job, one outcome — counting it twice would put
  // "1 job failed" beside a glyph that is already about that failure.
  check("...and the same failure is not also an outstanding one", stopped.failedWork === 0,
    String(stopped.failedWork));

  // THE PAIR. Same failure, something after it.
  seq = 0;
  const retried = collect(
    [item("work", "w1"), item("work", "w2")],
    { w1: "failed", w2: "succeeded" },
  );
  check("a failure with a success after it is unresolved work, not a stop", !retried.lastEndedInError);
  check("...it is counted as outstanding", retried.failedWork === 1, String(retried.failedWork));
  check("...and the thread needs you rather than showing a red ✕",
    deriveThreadStatus(retried).status === "needs_you", deriveThreadStatus(retried).status);

  // A JOB WHOSE ROW IS GONE. Retention sweeps `work_items` on its own window, so an old thread can
  // reference a job that no longer exists — and the honest reading of that is nothing outstanding,
  // never a status invented from the item alone.
  seq = 0;
  const swept = collect([item("work", "gone")], {});
  check("a work item whose row has been swept contributes nothing",
    swept.waitingWork === 0 && swept.runningWork === 0 && swept.failedWork === 0
      && !swept.lastEndedInError);
  check("...and the thread is idle rather than guessing", deriveThreadStatus(swept).status === "idle");

  // AND ARCHIVED, THROUGH THE COLLECTOR RATHER THAN THE FIXTURE, because `archived_at` is the one
  // fact here that comes off the thread row instead of out of an item.
  seq = 0;
  const archived = collect([item("work", "w1")], { w1: "waiting" }, "2026-01-01T00:00:00.000Z");
  check("§9: an archived thread with a job waiting on somebody is still archived",
    deriveThreadStatus(archived).status === "archived");
}

console.log(fail === 0 ? "\nALL CORRECT" : `\n${fail} FAILURES`);
process.exit(fail === 0 ? 0 : 1);
