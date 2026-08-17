// The thread store — every build session in the workspace, as the server derived it.
//
// SEPARATED BY INVARIANT, NOT BY CONVENIENCE, which is this codebase's stated rule for stores and the
// reason this is not a slice of `traceStore`. That store has correctness rules that keep the trace
// honest: steps arrive in seq order, a run's status is never guessed, the frozen event schema is
// never reinterpreted. A thread list has none of those needs and would inherit all of that machinery
// to hold a list of rows. It shares the socket and nothing else (§7.2).
//
// EVERY MESSAGE ON THIS CHANNEL IS A FULL SNAPSHOT, so every reducer here is a replace and never a
// merge — the same discipline `evalStore` and `mcpStore` hold. A merge would let this store assemble a
// view out of two different moments, and the §4.4 counts would then be a count of one moment beside
// rows from another. That mismatch is exactly what §2.1 refuses for the nav badge, which is drawn from
// the same numbers.
//
// WHAT THIS STORE DOES NOT DECIDE. It does not derive status (§3.3 is a function of things only the
// server can see), it does not sort (§4.2's grouping is its own module, so the rule can be tested
// without a store), and it does not persist a filter — §4.4 says filter state is per session and
// reopening Threads starts at All, so that lives in the view.

import { create } from "zustand";
import type { ThreadCounts, ThreadView } from "../types.ts";

/** What a socket knows before the first snapshot lands. §4.6's three empty states need this apart
 *  from "the workspace has no threads": one shows skeleton rows, the other names the workspace. */
const NO_COUNTS: ThreadCounts = { all: 0, needs_you: 0, running: 0, recent: 0, archived: 0 };

interface ThreadState {
  threads: ThreadView[];
  counts: ThreadCounts;
  /**
   * False until the first snapshot arrives on this connection.
   *
   * §9's no-spinners rule needs this to be a distinct state: "we have not been told yet" renders
   * skeleton rows, and "there are none" renders the empty state that names the workspace. Collapsing
   * the two would put "No threads in Acme Corp yet" in front of somebody whose list is on its way.
   */
  loaded: boolean;
  /**
   * The thread the centre pane is showing, or null.
   *
   * Held here rather than in `uiStore` because it is not view state: it decides which conversation is
   * loaded and which session new work is attributed to. Null is a real state — the composer before
   * anything has been said, which is §3.1's planning stage.
   */
  activeThreadId: string | null;
  /** The last refusal on this channel, shown as a dismissible strip rather than swallowed. */
  error: string | null;
  /**
   * Bumped when a thread is opened, so the conversation resumes at its first unresolved turn (§4.5).
   *
   * A NONCE RATHER THAN A FLAG, and rather than a turn id. A flag would fire an effect only for the
   * first open, so re-opening the same thread — the most common way somebody comes back to a pending
   * diff — would land at the bottom. And a turn id would put the CONVERSATION's business in this
   * store: which turn is unresolved is a question about chatStore's own contents, so the request is
   * "resume" and the answer is found where the turns are.
   */
  resumeNonce: number;
  /**
   * What a running thread has spent SINCE the snapshot that described it (§4.3.3).
   *
   * WHY A DELTA AND NOT A TOTAL. The snapshot's `cost_usd` is the ledger's answer and is authoritative;
   * this is the per-step cost that has arrived on the trace channel since, which the ledger has not
   * caught up with yet (metering is deliberately floating and asynchronous — a generation must never
   * fail because a usage row could not be written). Displayed as the sum of the two, so the figure moves
   * while a run does rather than sitting still beside a progress count that visibly changes, which
   * §4.3.3 calls the most literal violation of the no-spinners rule available to fix.
   *
   * CLEARED ON EVERY SNAPSHOT, because the snapshot is the authority and a delta kept across one would
   * eventually be counted twice. The cost of that reset is honest and small: for the moment between a
   * state transition and the ledger catching up, the figure can dip by a step or two. The alternative —
   * keeping the delta and hoping — is a number that only ever grows too large.
   */
  liveCost: Record<string, number>;

  setThreads: (threads: ThreadView[], counts: ThreadCounts) => void;
  /** One row, from `loadThread`. Replaces that row and nothing else — see `setThread`. */
  setThread: (thread: ThreadView) => void;
  selectThread: (id: string | null) => void;
  /** Ask the centre pane to resume at the first unresolved turn rather than at the bottom. */
  requestResume: () => void;
  /**
   * A step's cost, arriving on the trace channel, attributed to whichever thread owns its run.
   *
   * Takes the RUN id rather than the thread id, because that is what a trace event carries — the frozen
   * event schema has no thread field and must not grow one (§7, §9). The lookup is against
   * `live_run_ids` on the rows this store already holds.
   */
  addStepCost: (runId: string, usd: number) => void;
  setError: (message: string | null) => void;
}

export const useThreadStore = create<ThreadState>((set) => ({
  threads: [],
  counts: NO_COUNTS,
  loaded: false,
  activeThreadId: null,
  error: null,
  resumeNonce: 0,
  liveCost: {},

  // A replace, with the counts that were computed beside these rows. Taking them as one argument
  // rather than two calls is deliberate: they are one snapshot, and a store that could be given rows
  // without counts is a store that can hold a count of something else.
  // A replace, and the live deltas go with it: see `liveCost` for why the snapshot is the authority.
  setThreads: (threads, counts) => set({ threads, counts, loaded: true, error: null, liveCost: {} }),

  /**
   * The one row `loadThread` answers with.
   *
   * IT DOES NOT SELECT ANYTHING. Opening a thread is the view's decision (§2: selecting IS the
   * transition), and a store that also selected would make an ordinary refresh of one row navigate
   * somewhere. It also does not touch `counts` — those describe the whole list, and updating them
   * from one row would be exactly the partial-update reconciliation §7.1 refuses.
   */
  setThread: (thread) =>
    set((s) => ({
      threads: s.threads.some((t) => t.id === thread.id)
        ? s.threads.map((t) => (t.id === thread.id ? thread : t))
        : [...s.threads, thread],
    })),

  selectThread: (activeThreadId) => set({ activeThreadId }),
  requestResume: () => set((s) => ({ resumeNonce: s.resumeNonce + 1 })),

  addStepCost: (runId, usd) =>
    set((s) => {
      // An unpriced step arrives with a null cost, which the caller passes as 0 — and adding zero must
      // not create an entry, because an entry is what makes the row re-render.
      if (!Number.isFinite(usd) || usd <= 0) return {};
      const owner = s.threads.find((t) => t.live_run_ids.includes(runId));
      // A step from a run no thread claims — a shadow run started by a webhook, an eval job whose
      // snapshot has not arrived yet. Dropped rather than guessed at: attributing it to the wrong
      // session would put somebody else's spend on your row.
      if (!owner) return {};
      return { liveCost: { ...s.liveCost, [owner.id]: (s.liveCost[owner.id] ?? 0) + usd } };
    }),
  setError: (error) => set({ error }),
}));

// --- selectors ---------------------------------------------------------------
// Exported as pure functions so no component re-derives them differently.

/**
 * What a row should render as its cost: the ledger's figure plus what has arrived since (§4.3.3).
 *
 * A SELECTOR RATHER THAN A FIELD, so there is exactly one definition of "what this thread has spent" and
 * no component can add the two halves differently. Null stays null — a thread that has spent nothing and
 * has no live steps has no cost cell at all, which is not the same as zero.
 */
export function threadSpend(thread: ThreadView, liveCost: Record<string, number>): number | null {
  const live = liveCost[thread.id] ?? 0;
  if (thread.cost_usd === null) return live > 0 ? live : null;
  return thread.cost_usd + live;
}

/** One thread by id, or undefined. */
export function threadById(threads: ThreadView[], id: string | null): ThreadView | undefined {
  return id ? threads.find((t) => t.id === id) : undefined;
}

/**
 * How the agent chip should read (§4.3), as one decision rather than three conditions per renderer.
 *
 * Returns null when there is nothing to render at all, which never happens today — a thread with no
 * agent renders `(no agent)` — but keeps the caller from having to distinguish "no chip" from "a chip
 * saying nothing".
 */
export function agentChipLabel(thread: ThreadView): string {
  if (thread.agent_deleted && thread.agent_name) return `${thread.agent_name} (deleted)`;
  return thread.agent_name ?? "(no agent)";
}
