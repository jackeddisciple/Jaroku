// Collecting §3.3's inputs: which of a thread's owned things are still outstanding.
//
// THE DERIVER IS PURE AND SO IS THIS, and that is the reason the two are separate files. What is
// outstanding lives in six different places — the editor's proposal map, the planner's slot, the MCP
// confirm queue, `runs.status`, `eval_runs.status`, the deploy store — and a collector that reached
// into all six could only be tested by standing the whole app up. So the caller gathers them (one
// query each, in `index.ts`) and this turns them into facts per thread.
//
// OWNERSHIP FROM `thread_items`, LIVENESS FROM THE OWNER. A row in that table says a run happened in
// a session; whether it is still running is `runs.status` and nothing else. This is where that split
// pays off: a proposal does not survive a restart, so after one the editor's map is empty, no thread
// claims a pending diff, and the list says idle — which is exactly true. A durable "pending" flag
// would have gone on claiming an unapplied diff that no longer exists anywhere, and the row would
// have kept asking somebody to go and apply it.

import type { ThreadFacts, PendingDiff } from "./threadStatus.ts";
import { NO_FACTS } from "./threadStatus.ts";
import type { ThreadItem } from "./threadStore.ts";

/** What a run's own row says about how it went. */
export interface RunFact {
  status: "running" | "completed" | "error";
  /**
   * Steps in this run that failed.
   *
   * COUNTED ONLY FOR A RUN THAT ENDED IN ERROR, by the caller's query. §3.3 says "failed run in this
   * thread" and "was not retried", and a run that recorded a failed step and then completed is a run
   * that retried it — surfacing that as blocked work would put an amber ◆ on a thread whose problem
   * solved itself, which teaches people to ignore the glyph.
   */
  failedSteps: number;
}

/** What an eval's own row says. `total` is the denominator §4.3.3's projection needs. */
export interface EvalFact {
  running: boolean;
  done: number;
  total: number;
  /**
   * The eval's jobs that are executing right now, by run id.
   *
   * An eval is a batch of ORDINARY runs (ADR-011), so its cost arrives as per-step events on those
   * runs like any other. A thread showing `eval 34/120` therefore needs their ids to increment its own
   * figure — the eval row itself emits nothing per step.
   */
  liveRunIds: string[];
}

/** Everything the collector reads, gathered by the caller. */
export interface FactsInput {
  threads: { id: string; agent_id: string | null; archived_at: string | null }[];
  /** Every item in the workspace, oldest first. Order matters — see `lastEndedInError`. */
  items: ThreadItem[];
  /** runId -> how that run went. Missing means the run is gone or was never ours. */
  runs: Map<string, RunFact>;
  /** evalId -> progress. Missing means finished and swept. */
  evals: Map<string, EvalFact>;
  /** Proposal ids the editor is still holding, with their sizes. §4.3's `+42−11`. */
  proposals: Map<string, PendingDiff>;
  /** Plan ids awaiting a Generate or a revision. */
  plans: Set<string>;
  /**
   * THREAD ids whose latest generation the validator refused and nobody has retried.
   *
   * Keyed by thread rather than by generation id, because that is the only question asked of it —
   * "does this session have a refused generation" — and because the per-generation keying could not
   * be cleared: the caller minted a fresh uuid and deleted THAT, which is a guaranteed no-op, so a
   * thread that was ever refused once stayed blocked through every later success.
   */
  rejectedGenerations: Set<string>;
  /** runId -> high-impact MCP calls halting that run, waiting on a person. */
  confirms: Map<string, number>;
  /** Agent uuids with something live on a public URL. §4.3's `deployed` fragment. */
  deployedAgents: Set<string>;
}

export interface ThreadDerivation {
  facts: ThreadFacts;
  /**
   * The runs of this thread that are in flight, by id (§4.3.3).
   *
   * ON THE SNAPSHOT RATHER THAN ON A NEW MESSAGE TYPE, which is what §7.1's protocol note requires: a
   * running thread's cost increments from the per-step cost events the trace and eval channels ALREADY
   * broadcast, and a client can only attribute one of those to a session if it knows which runs the
   * session owns. Sending the ids once, on a state transition, is what makes the live figure derivable
   * client-side without turning a full-snapshot channel into a polling one.
   *
   * Empty for anything not running. A finished run's cost is in the figure already.
   */
  liveRunIds: string[];
  /**
   * §4.3's preview: the last USER message, never Jaroku's reply.
   *
   * Null for a thread nobody has spoken in yet — a row created a moment ago, or one whose work was
   * started by something other than a person. The row renders two lines instead of three rather
   * than an empty quoted string, which would read as somebody having said nothing.
   */
  preview: string | null;
  /** The first user message, for §5's auto-title. Null once there is nothing to title from. */
  firstMessage: string | null;
}

/**
 * One pass over the workspace's items, producing facts per thread.
 *
 * EVERY THREAD GETS AN ENTRY, including the ones that own nothing: a thread with no items is a real
 * state (§3.1's planning stage, before anything has been said) and a caller that had to distinguish
 * "no entry" from "no facts" would be doing this function's job twice.
 */
export function collectThreadFacts(input: FactsInput): Map<string, ThreadDerivation> {
  const out = new Map<string, ThreadDerivation>();
  for (const t of input.threads) {
    out.set(t.id, {
      facts: {
        ...NO_FACTS,
        archivedAt: t.archived_at,
        deployed: t.agent_id !== null && input.deployedAgents.has(t.agent_id),
        // Read off the thread rather than counted per item: the fact is "this session's latest
        // generation was refused", which is one thing about the session and not a tally of every
        // attempt it has ever made. `isBlocked` and the fragment only ever ask whether it is > 0.
        rejectedGenerations: input.rejectedGenerations.has(t.id) ? 1 : 0,
      },
      preview: null,
      firstMessage: null,
      liveRunIds: [],
    });
  }

  /**
   * Whether the thread's last thing with an outcome ended badly.
   *
   * Tracked as it goes rather than computed at the end, because the items arrive in order and
   * "nothing was retried after it" is exactly "no later item succeeded". A run that failed and was
   * followed by one that worked leaves this `ok`, and the thread reads as needs_you at worst rather
   * than as stopped.
   */
  const lastOutcome = new Map<string, "ok" | "error">();

  for (const item of input.items) {
    const entry = out.get(item.thread_id);
    // An item whose thread is gone. The cascade should have taken it, so this is a belt-and-braces
    // skip rather than a case: what it must not do is invent a thread that is not in the list.
    if (!entry) continue;
    const f = entry.facts;

    switch (item.kind) {
      case "message":
        if (item.role === "user" && item.body) {
          entry.preview = item.body;
          entry.firstMessage ??= item.body;
        }
        break;

      case "run": {
        const run = item.ref_id ? input.runs.get(item.ref_id) : undefined;
        if (!run) break;
        if (run.status === "running") {
          f.liveRuns++;
          entry.liveRunIds.push(item.ref_id!);
        }
        f.failedSteps += run.failedSteps;
        // A halted graph is waiting on a person, not on a machine. Counted per run because the queue
        // is per run — a node can fire several high-impact calls in one turn and each blocks alone.
        f.pendingConfirms += (item.ref_id && input.confirms.get(item.ref_id)) || 0;
        if (run.status !== "running") lastOutcome.set(item.thread_id, run.status === "error" ? "error" : "ok");
        break;
      }

      case "eval": {
        const ev = item.ref_id ? input.evals.get(item.ref_id) : undefined;
        if (!ev) break;
        if (ev.running) {
          f.liveRuns++;
          // The LAST running eval wins if there are two, which there can be. A row has one fragment
          // and one projection, and the newest is the one whose numbers are still moving.
          f.evalProgress = { done: ev.done, total: ev.total };
          entry.liveRunIds.push(...ev.liveRunIds);
        }
        break;
      }

      case "proposal": {
        const diff = item.ref_id ? input.proposals.get(item.ref_id) : undefined;
        if (!diff) break;
        // Summed rather than replaced: two unapplied proposals in one thread is twice as much work
        // about to be lost, and the fragment should say so as one number.
        f.pendingDiff = f.pendingDiff
          ? { added: f.pendingDiff.added + diff.added, removed: f.pendingDiff.removed + diff.removed }
          : diff;
        break;
      }

      case "plan":
        if (item.ref_id && input.plans.has(item.ref_id)) f.awaitingPlans++;
        break;

      // A generation item establishes ownership and nothing else; whether the latest one was
      // refused is the thread's own fact, read once above.
      case "generation":
        break;
    }
  }

  for (const [threadId, outcome] of lastOutcome) {
    const entry = out.get(threadId);
    if (entry) entry.facts.lastEndedInError = outcome === "error";
  }

  return out;
}
