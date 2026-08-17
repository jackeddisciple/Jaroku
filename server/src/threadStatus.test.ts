// §3.3's derivation, one fixture per rung and one per argument.
//
// The precedence is the whole of this file's subject, and two rungs are worth a test each on their
// own account:
//
//   NEEDS_YOU BEATS RUNNING. A four-day-old pending diff in a thread somebody just started a run in
//   renders as blocked, not as running. The nav badge counts blocked threads, so the opposite
//   ordering would let a new run hide a forgotten diff from the one count that exists to surface it.
//
//   ARCHIVED BEATS EVERYTHING. A thread archived with a diff still pending must not ask for
//   attention from under the filter it was explicitly put behind — but it must still SAY what was
//   set aside, because §3.4's undo toast is built from that.
//
//   npm run test:thread-status

import {
  NO_FACTS, activePerAgent, deriveThreadStatus, isBlocked, type ThreadFacts,
} from "./threadStatus.ts";

let fail = 0;
const check = (name: string, ok: boolean, detail = ""): void => {
  if (ok) console.log(`  ok   ${name}`);
  else { fail++; console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ""}`); }
};

const facts = (over: Partial<ThreadFacts> = {}): ThreadFacts => ({ ...NO_FACTS, ...over });
const derive = (over: Partial<ThreadFacts> = {}) => deriveThreadStatus(facts(over));

// --- 1. the five statuses, each from the fact that produces it -----------------------------
{
  check("nothing outstanding is idle", derive().status === "idle");
  check("...with no fragment at all, because a dot separator needs a fact to sit beside",
    derive().fragment === null);

  const diff = derive({ pendingDiff: { added: 42, removed: 11 } });
  check("an unapplied diff needs you", diff.status === "needs_you");
  check("...and says how big it is", diff.fragment === "diff pending +42−11", String(diff.fragment));

  check("a plan awaiting confirm needs you", derive({ awaitingPlans: 1 }).status === "needs_you");
  check("...and says so", derive({ awaitingPlans: 1 }).fragment === "plan awaiting");

  check("an MCP confirmation halting a graph needs you",
    derive({ pendingConfirms: 1 }).status === "needs_you");
  check("...singular reads as one thing", derive({ pendingConfirms: 1 }).fragment === "confirmation waiting");
  check("...and two read as two", derive({ pendingConfirms: 2 }).fragment === "2 confirmations waiting");

  check("a refused generation needs you", derive({ rejectedGenerations: 1 }).status === "needs_you");
  check("...and names the refusal rather than the run",
    derive({ rejectedGenerations: 1 }).fragment === "generation rejected");

  const failed = derive({ failedSteps: 3 });
  check("failed steps nobody retried need you", failed.status === "needs_you");
  check("...counted, because how much went wrong is the decision", failed.fragment === "3 failed steps");
  check("one failed step is not '1 failed steps'", derive({ failedSteps: 1 }).fragment === "1 failed step");

  const live = derive({ liveRuns: 1 });
  check("a live run is running", live.status === "running");
  check("...and says so when there is no denominator to show", live.fragment === "running");

  const ev = derive({ liveRuns: 1, evalProgress: { done: 34, total: 120 } });
  check("a running eval is running", ev.status === "running");
  check("...and shows the progress the projection is computed from", ev.fragment === "eval 34/120");

  const errored = derive({ lastEndedInError: true, failedSteps: 2 });
  check("a thread whose last operation ended in error is errored", errored.status === "errored");
  check("...and carries the count", errored.fragment === "2 failed steps");
  check("an error with no step count still says something",
    derive({ lastEndedInError: true }).fragment === "failed");
}

// --- 2. precedence -------------------------------------------------------------------------
{
  // THE ONE THAT MATTERS. Both are true; the badge counts the first.
  const both = derive({ pendingDiff: { added: 6, removed: 0 }, liveRuns: 1 });
  check("a pending diff beside a live run renders as blocked, not as running",
    both.status === "needs_you", both.status);
  check("...and the fragment is the diff, which is the thing that will be lost",
    both.fragment === "diff pending +6−0");

  // A thread that stopped is not the same as a thread with an old failure in the middle of it.
  const stopped = derive({ lastEndedInError: true, pendingDiff: { added: 1, removed: 1 } });
  check("a thread that stopped in error reads as errored even with a diff pending",
    stopped.status === "errored");

  const archived = derive({
    archivedAt: "2026-02-02T00:00:00.000Z",
    pendingDiff: { added: 42, removed: 11 },
    liveRuns: 2,
  });
  check("archived beats every live fact there is", archived.status === "archived");
  check("...but still names what was set aside, which is what the undo toast reads",
    archived.fragment === "diff pending +42−11");

  const evalAndBlocked = derive({ awaitingPlans: 1, evalProgress: { done: 3, total: 9 } });
  check("an eval running under an awaiting plan is still blocked", evalAndBlocked.status === "needs_you");
}

// --- 3. the blocked fragment picks one fact, most expensive first ---------------------------
{
  const all = derive({
    pendingDiff: { added: 1, removed: 2 },
    rejectedGenerations: 1,
    pendingConfirms: 1,
    awaitingPlans: 1,
    failedSteps: 4,
  });
  check("with everything blocked at once, the diff wins", all.fragment === "diff pending +1−2");
  check("...then the refused generation",
    derive({ rejectedGenerations: 1, pendingConfirms: 1, awaitingPlans: 1, failedSteps: 4 }).fragment
      === "generation rejected");
  check("...then the confirmation, which is on a timer",
    derive({ pendingConfirms: 1, awaitingPlans: 1, failedSteps: 4 }).fragment === "confirmation waiting");
  check("...then the plan", derive({ awaitingPlans: 1, failedSteps: 4 }).fragment === "plan awaiting");
  check("...and the failed steps last", derive({ failedSteps: 4 }).fragment === "4 failed steps");
}

// --- 4. deployed is a fact about an idle thread, not a sixth status -------------------------
{
  const shipped = derive({ deployed: true });
  check("a deployed thread with nothing outstanding is idle", shipped.status === "idle");
  check("...and says the one thing worth saying about it", shipped.fragment === "deployed");
  check("a deployed thread with a diff pending says the diff instead",
    derive({ deployed: true, pendingDiff: { added: 3, removed: 3 } }).fragment === "diff pending +3−3");
}

// --- 5. the predicate the badge and the collision marker share -----------------------------
{
  check("nothing blocked", !isBlocked(facts()));
  check("a live run alone is not blocked", !isBlocked(facts({ liveRuns: 4 })));
  check("a diff is", isBlocked(facts({ pendingDiff: { added: 0, removed: 0 } })));
  check("a zero-line diff still counts, because the proposal is still unresolved",
    isBlocked(facts({ pendingDiff: { added: 0, removed: 0 } })));
  check("and so is every other waiting fact",
    [
      facts({ awaitingPlans: 1 }), facts({ pendingConfirms: 1 }),
      facts({ rejectedGenerations: 1 }), facts({ failedSteps: 1 }),
    ].every(isBlocked));
}

// --- 6. purity -----------------------------------------------------------------------------
{
  const input = facts({ pendingDiff: { added: 2, removed: 2 }, failedSteps: 1 });
  const before = JSON.stringify(input);
  deriveThreadStatus(input);
  check("the deriver does not touch what it was handed", JSON.stringify(input) === before);
  check("...and the same facts twice give the same answer",
    JSON.stringify(deriveThreadStatus(input)) === JSON.stringify(deriveThreadStatus(input)));
}

// --- 7. §4.3.4's collision count ------------------------------------------------------------
{
  const rows = [
    { agent_id: "api_gateway", status: "needs_you" as const },
    { agent_id: "api_gateway", status: "running" as const },
    { agent_id: "api_gateway", status: "idle" as const },
    { agent_id: "api_gateway", status: "archived" as const },
    { agent_id: "auth_agent", status: "errored" as const },
    { agent_id: null, status: "needs_you" as const },
  ];
  const active = activePerAgent(rows);

  check("two live sessions on one agent count as two", active.get("api_gateway") === 2, String(active.get("api_gateway")));
  check("...and the idle one on the same agent is history, not a collision",
    active.get("api_gateway") !== 3);
  check("a thread that stopped in error is live work somebody has to deal with",
    active.get("auth_agent") === 1);
  check("a thread with no agent cannot collide with anything", !active.has("null") && active.size === 2);

  // The marker renders at 2 or more, so a single live thread on an agent must not produce one.
  const alone = activePerAgent([{ agent_id: "docs_agent", status: "running" }]);
  check("one live thread on an agent is not a collision", alone.get("docs_agent") === 1);
  check("...and an agent with nothing live has no entry at all",
    !activePerAgent([{ agent_id: "docs_agent", status: "idle" }]).has("docs_agent"));
}

console.log(fail === 0 ? "\nALL CORRECT" : `\n${fail} FAILURES`);
process.exit(fail === 0 ? 0 : 1);
