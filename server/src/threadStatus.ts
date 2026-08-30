// §3.3's derivation: what a thread's glyph says, and the one fact beside it.
//
// COMPUTED, NEVER STORED AS AN INPUT. Status is a function of things the server already knows — an
// unapplied diff, a run in flight, a step that failed and was never retried, a plan waiting on a
// person, an MCP confirmation halting a graph. A `status` column somebody could POST would be a
// sixth source of truth about all five of those, and it would be wrong within minutes of any of
// them moving. The column in migration 043 is a cache of what this file concluded; this file is the
// authority.
//
// A PURE FUNCTION OVER A FACTS STRUCT, rather than a method that goes and asks. The facts come from
// five different places — the editor's proposals, the planner's slot, the MCP registry's confirm
// queue, the run pool, the eval queue — and a deriver that reached into all five would be
// untestable except by standing the whole app up. Collecting them is the caller's job (§7.1's
// snapshot), and the interesting half is the precedence, which is here and has a fixture per rung.
//
// PRECEDENCE, and each step is a decision rather than an ordering that fell out:
//
//   1. ARCHIVED wins over everything. §3.4: the row has left the default list, and a thread that
//      rendered as `needs_you` from under the Archived filter would be asking for attention it was
//      explicitly told not to ask for.
//
//   2. ERRORED, when the thread's last operation ended in error and nothing was retried after it.
//      Distinct from a failed step somewhere in the middle: that is unresolved work (needs_you),
//      whereas this is a thread that stopped. Both group into Needs You (§4.2), so the distinction
//      costs nothing in the layout and buys the red ✕ its meaning.
//
//   3. NEEDS_YOU beats RUNNING, and this is the one that is genuinely arguable. A thread with a
//      four-day-old pending diff that somebody just started a new run in is both. It renders as
//      blocked, because a run ends by itself and an unapplied diff does not — and because the nav
//      badge (§2.1) counts exactly this, so letting a new run hide a forgotten diff would make the
//      badge answer "is anything blocked" with "no, something else is happening", which is the
//      forgetting §4.2 says is the most expensive failure this view can prevent.
//
//   4. RUNNING, when something is genuinely in flight. Cost is ticking (§4.2).
//
//   5. IDLE. Nothing outstanding, and the row shows no state fragment at all.
//
// PART 3 ADDS NO RUNG. §9 asks for a `waiting` work item to be `needs_you`, a running one to be
// `running`, and a failure nobody has looked at to be `errored` — which is the ladder above,
// unchanged, with three more facts fed into rungs that already exist. That is the difference
// between extending a derivation and putting a second one beside it: an operate thread is graded
// against the same five rungs in the same order, so the glyph means the same thing on both kinds
// of conversation and `archived` still wins over all of it.
//
// AND THE ONE THING THAT LOOKS LIKE A NEW RUNG AND IS NOT. "A failed job nobody has looked at" is
// rung 2, not a sixth: `lastEndedInError` already means "the last thing with an outcome went wrong
// and nothing came after it", and nothing coming after it is what "nobody has looked at" amounts
// to in a conversation. A failure with later work on top of it stays rung 3, exactly as a failed
// STEP in the middle of a thread does — §9 says work items reproduce that shape and they do.
//
// THE FRAGMENT IS DERIVED HERE TOO, from the same facts, and that is deliberate rather than scope
// creep: §4.3 defines it as "the single most decision-relevant fact, CONTEXTUAL TO STATUS", so it
// is the same decision as the glyph rendered as words. Deriving it anywhere else would mean a row
// that could show a pending-diff fragment beside a running ● — two answers to one question, from
// two places that each thought they knew.

import type { ThreadStatus } from "./threadStore.ts";

/** An unapplied edit proposal, and how big it is. `+42−11` on the row. */
export interface PendingDiff {
  /** Lines added across the proposal's files. */
  added: number;
  removed: number;
}

/** A run of an eval attributed to this thread, part-way through. `eval 34/120`. */
export interface EvalProgress {
  done: number;
  /** The denominator. Known for an eval, and the reason §4.3.3 can project a cost at all. */
  total: number;
}

/**
 * Everything the derivation reads, collected by the caller.
 *
 * Counts rather than booleans wherever the row wants a number: `3 failed steps` is the fragment,
 * and a boolean would have to be turned back into a count by somebody who no longer has the rows.
 */
export interface ThreadFacts {
  /** Null means active. From the row itself — the one fact here that is stored. */
  archivedAt: string | null;
  /** Proposals awaiting Apply or Discard. The most common blocked state in this product. */
  pendingDiff: PendingDiff | null;
  /** Plans awaiting a Generate or a revision (§3.3's "plan awaiting confirm"). */
  awaitingPlans: number;
  /** High-impact MCP calls halting a graph, waiting on a person (§3.3). */
  pendingConfirms: number;
  /** Generations the validator refused. Blocked, not errored: the next move is a person's. */
  rejectedGenerations: number;
  /** Steps that failed and were never retried. `3 failed steps`. */
  failedSteps: number;
  /** Runs, generations or evals in flight and attributed to this thread. */
  liveRuns: number;
  /**
   * Jobs this conversation gave a deployed agent that are parked on a person's answer (§9).
   *
   * THE SAME THING AS `pendingConfirms`, SEEN FROM THE OTHER SIDE. A high-impact MCP call halting a
   * graph is what produces both: on a local run the confirm queue knows about it and the run item
   * carries it, and on a deployed run the container's request moved `work_items.status` to
   * `waiting`. They are counted separately rather than added together because they are collected
   * from different places and an operate thread has only the second — merging them would mean a
   * single number nothing could explain the provenance of.
   */
  waitingWork: number;
  /** Jobs of this conversation the container is executing right now. Cost is ticking. */
  runningWork: number;
  /**
   * Jobs that failed and were not the last thing to happen here.
   *
   * THE SAME DISTINCTION `failedSteps` DRAWS, and §9 says work items reproduce it exactly: a job
   * that failed and was followed by one that worked is unresolved work, and a thread whose LAST job
   * failed is a thread that stopped. The second is `lastEndedInError`, which the collector sets from
   * the same items — so a failure is counted here or read as a stop, never both.
   */
  failedWork: number;
  /** The eval this thread started, if one is part-way through. */
  evalProgress: EvalProgress | null;
  /**
   * The thread's last operation terminated in error and nothing came after it.
   *
   * Separate from `failedSteps` on purpose. A run with three failed steps that later succeeded is
   * unresolved work; a thread whose last act was a run ending in error has stopped. The caller
   * decides which by looking at what came last, which is a question only it can answer.
   */
  lastEndedInError: boolean;
  /** This thread's work reached a live URL. The fragment says `deployed`; the glyph stays idle. */
  deployed: boolean;
}

/** Nothing outstanding. The base every fixture and every caller starts from. */
export const NO_FACTS: ThreadFacts = {
  archivedAt: null,
  pendingDiff: null,
  awaitingPlans: 0,
  pendingConfirms: 0,
  rejectedGenerations: 0,
  failedSteps: 0,
  liveRuns: 0,
  waitingWork: 0,
  runningWork: 0,
  failedWork: 0,
  evalProgress: null,
  lastEndedInError: false,
  deployed: false,
};

export interface DerivedStatus {
  status: ThreadStatus;
  /**
   * §4.3's state fragment, or null when there is nothing decision-relevant to say.
   *
   * Null rather than an empty string, because "omitted entirely when idle" is the rule and an
   * empty string still renders a separator dot in a row built out of `·`.
   */
  fragment: string | null;
}

/** `+42−11`. A real minus sign, as the spec writes it and as the diff bar already renders it. */
const diffFragment = (d: PendingDiff): string => `diff pending +${d.added}−${d.removed}`;

/**
 * Is anything waiting on a person?
 *
 * Exported because §4.3.4's collision marker counts "needs_you or running threads against the same
 * agent" and §2.1's badge counts the blocked ones, and both are better asked of one predicate than
 * re-derived from a status string somebody might spell differently.
 */
export function isBlocked(f: ThreadFacts): boolean {
  return (
    f.pendingDiff !== null ||
    f.awaitingPlans > 0 ||
    f.pendingConfirms > 0 ||
    f.rejectedGenerations > 0 ||
    f.failedSteps > 0 ||
    // §9'S TWO. A job parked on a confirmation is the deployed twin of `pendingConfirms` and is
    // blocked in exactly the same sense — a container is halted and a person is the only thing that
    // can move it. A job that failed and was followed by other work is unresolved work, which is
    // what `failedSteps` means one layer down.
    f.waitingWork > 0 ||
    f.failedWork > 0
  );
}

/**
 * §3.3, in the order the header states.
 *
 * The fragment picks the MOST decision-relevant fact rather than concatenating what is true: a row
 * has one line for this, and a person scanning for what to do next is served by one fact chosen for
 * them rather than by four they have to weigh. Where a thread is blocked in two ways at once, the
 * one that costs money to leave alone wins — an unapplied diff over a failed step, because the diff
 * is work already paid for that is about to be lost.
 */
export function deriveThreadStatus(f: ThreadFacts): DerivedStatus {
  if (f.archivedAt !== null) {
    // Archived rows still say what they were archived WITH, because §3.4's undo toast names it and
    // the Archived filter is where somebody goes to find the thing they set aside.
    return { status: "archived", fragment: f.pendingDiff ? diffFragment(f.pendingDiff) : null };
  }

  if (f.lastEndedInError) {
    return {
      status: "errored",
      // The step count when there is one, because "3 failed steps" tells you how much went wrong
      // and "failed" only tells you that something did.
      fragment: f.failedSteps > 0 ? `${f.failedSteps} failed step${f.failedSteps === 1 ? "" : "s"}` : "failed",
    };
  }

  if (isBlocked(f)) {
    return { status: "needs_you", fragment: blockedFragment(f) };
  }

  if (f.liveRuns > 0 || f.runningWork > 0 || f.evalProgress !== null) {
    return {
      status: "running",
      // THE EVAL'S NUMBERS FIRST, because they are the only ones with a denominator. Then the job
      // count, because "2 jobs running" is a fact about the real world that "running" is not — and
      // an operate thread's whole reason to exist is that somebody wants to know what their agent
      // is doing right now. A build thread has no work items, so it reads exactly as it did.
      fragment: f.evalProgress
        ? `eval ${f.evalProgress.done}/${f.evalProgress.total}`
        : f.runningWork > 0
          ? `${f.runningWork} job${f.runningWork === 1 ? "" : "s"} running`
          : "running",
    };
  }

  // Idle, and `deployed` is the one fact worth saying about a thread with nothing outstanding: it
  // is the difference between a session that ended and one that ended by shipping.
  return { status: "idle", fragment: f.deployed ? "deployed" : null };
}

/** Which blocked fact to show, most expensive to ignore first. See `deriveThreadStatus`. */
function blockedFragment(f: ThreadFacts): string {
  if (f.pendingDiff) return diffFragment(f.pendingDiff);
  // Before the plan, because a refused generation is a thing that already ran and cost money.
  if (f.rejectedGenerations > 0) return "generation rejected";
  // ABOVE `pendingConfirms`, AND THE TWO NEVER MEET IN PRACTICE. They are the same event on the two
  // kinds of run — a high-impact call halting a graph — and a thread has work items or run items
  // and not both, so this ordering decides nothing today. It is written in the order it would
  // matter if that ever stopped being true: the halted graph on the far side of a deployment is
  // holding a container somebody is paying for, and the local one is holding this process.
  if (f.waitingWork > 0) {
    return f.waitingWork === 1 ? "job waiting on you" : `${f.waitingWork} jobs waiting on you`;
  }
  // Before the plan too: a confirmation is halting a graph on a timer, and the plan is not.
  if (f.pendingConfirms > 0) {
    return f.pendingConfirms === 1 ? "confirmation waiting" : `${f.pendingConfirms} confirmations waiting`;
  }
  if (f.awaitingPlans > 0) return "plan awaiting";
  // BEFORE THE FAILED STEPS, because a failed JOB is something that did not happen in the world and
  // a failed step is something that did not happen inside a graph. The person reading this row
  // decides what to do next, and "the refund did not go out" outranks "a node threw".
  if (f.failedWork > 0) return `${f.failedWork} job${f.failedWork === 1 ? "" : "s"} failed`;
  return `${f.failedSteps} failed step${f.failedSteps === 1 ? "" : "s"}`;
}

/**
 * §4.3.4: how many of each agent's threads are blocked or running.
 *
 * A SECOND PASS OVER DERIVED STATUSES, and it has to be, because this is a fact about an AGENT: how many
 * of its sessions are live cannot be known until every one of them has been derived. Here rather than in
 * the snapshot builder so the rule — which statuses count — is stated once, beside the derivation it
 * reads, and can be asserted without a database.
 *
 * `needs_you`, `errored` AND `running` COUNT. The first two are the Needs You section's own membership
 * (§4.2) and the third is work in flight; an `idle` or `archived` thread on the same agent is not a
 * collision, it is history, and counting it would put a warning on every agent anybody has used twice.
 *
 * The count INCLUDES the thread it will be rendered on, which is what makes `⚠ 2 active` read correctly:
 * this one and one other.
 */
export function activePerAgent(
  rows: readonly { agent_id: string | null; status: ThreadStatus }[],
): Map<string, number> {
  const out = new Map<string, number>();
  for (const row of rows) {
    if (!row.agent_id) continue;
    if (row.status !== "needs_you" && row.status !== "errored" && row.status !== "running") continue;
    out.set(row.agent_id, (out.get(row.agent_id) ?? 0) + 1);
  }
  return out;
}
