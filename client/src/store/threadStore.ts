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
import { archiveNotice } from "../lib/threadArchive.ts";
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
  /**
   * Where each running eval has got to, by eval id, as its progress events land (§4.3.3).
   *
   * BESIDE `liveCost` AND FOR THE SAME REASON. The snapshot's `eval_progress` is the authority and
   * is taken at a moment; this is what has arrived since, and it is what makes `done` move. Cleared
   * on every snapshot, like the cost delta, because the snapshot is the authority.
   */
  liveEvalProgress: Record<string, { done: number; total: number }>;
  /**
   * The steps already counted into `liveCost`, by step id.
   *
   * Cleared with the deltas on every snapshot, so it holds only what has arrived since the last
   * one — the same lifetime as the numbers it guards, and therefore bounded by the same thing.
   */
  countedSteps: Record<string, true>;
  /**
   * What was set aside by the last archive, when something was (§3.4).
   *
   * HELD HERE RATHER THAN IN THE VIEW because the row it describes is gone from the list by the time the
   * notice renders — that is the whole reason the notice exists — so the text has to be captured at the
   * moment of the archive and outlive the row. One slot, not a queue: archiving two threads in a row is
   * two decisions and the second notice is the one still true.
   */
  archiveNotice: { threadId: string; text: string } | null;

  setThreads: (threads: ThreadView[], counts: ThreadCounts) => void;
  /** One row, from `loadThread`. Replaces that row and nothing else — see `setThread`. */
  setThread: (thread: ThreadView) => void;
  selectThread: (id: string | null) => void;
  /** Ask the centre pane to resume at the first unresolved turn rather than at the bottom. */
  requestResume: () => void;
  /**
   * Remember what an about-to-be-archived thread had outstanding, for the notice.
   *
   * TAKES THE ROW AS IT IS NOW, before the archive lands, because afterwards `archived_at` is set and the
   * fragment has been recomputed for an archived row. Does nothing for a thread with nothing outstanding
   * — an idle archive gets no notice (§3.4).
   */
  noteArchived: (thread: ThreadView) => void;
  dismissArchiveNotice: () => void;
  /**
   * A step's cost, arriving on the trace channel, attributed to whichever thread owns its run.
   *
   * Takes the RUN id rather than the thread id, because that is what a trace event carries — the frozen
   * event schema has no thread field and must not grow one (§7, §9). The lookup is against
   * `live_run_ids` on the rows this store already holds.
   *
   * AND THE STEP ID, SO COUNTING IS IDEMPOTENT. This was a bare accumulate, and it is the one
   * consumer of the trace channel that was: `traceStore.applyEvent` is keyed by `step.id` precisely
   * because ingestion is at-least-once and a redelivered batch must not become a second step. The
   * same event reaching this twice — a duplicated dispatch, a replayed batch — inflated a running
   * thread's live figure at double rate, and a cost is the one number on the row somebody acts on.
   */
  addStepCost: (runId: string, usd: number, stepId: string) => void;
  /**
   * An eval's spend since the last progress event, attributed to whichever thread owns the eval.
   *
   * THE OTHER HALF OF §4.3.3, and the reason the spec's own worked example was unreachable. An
   * eval's runs are deliberately kept off the `trace` channel — a running eval must not steal the
   * timeline's focus — so `addStepCost` above is never called for one, and a thread running an eval
   * showed a frozen figure for the whole sweep. Takes the EVAL id, because that is what the eval
   * channel carries; the lookup is against `live_eval_ids` on the rows this store already holds.
   */
  addEvalCost: (evalId: string, usd: number) => void;
  /**
   * How far a running eval has got, from the event rather than from the next snapshot.
   *
   * §4.3.3's projection needs a `done` that MOVES: the snapshot is taken when the eval starts, when
   * `done` is 0, and `projectCost` returns null at zero — so the arrow and the `~` figure were
   * suppressed for the entire run. §7.1's protocol note names this exact remedy: derive it
   * client-side from the progress event the eval channel already broadcasts, rather than pushing a
   * snapshot per tick, which is the polling channel it refuses.
   */
  noteEvalProgress: (evalId: string, progress: { done: number; total: number }) => void;
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
  liveEvalProgress: {},
  countedSteps: {},
  archiveNotice: null,

  // A replace, with the counts that were computed beside these rows. Taking them as one argument
  // rather than two calls is deliberate: they are one snapshot, and a store that could be given rows
  // without counts is a store that can hold a count of something else.
  // A replace, and the live deltas go with it: see `liveCost` for why the snapshot is the authority.
  setThreads: (threads, counts) =>
    set({
      threads, counts, loaded: true, error: null,
      liveCost: {}, liveEvalProgress: {}, countedSteps: {},
    }),

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

  noteArchived: (thread) => {
    const text = archiveNotice(thread);
    if (!text) return;
    set({ archiveNotice: { threadId: thread.id, text } });
  },
  dismissArchiveNotice: () => set({ archiveNotice: null }),

  addStepCost: (runId, usd, stepId) =>
    set((s) => {
      // An unpriced step arrives with a null cost, which the caller passes as 0 — and adding zero must
      // not create an entry, because an entry is what makes the row re-render.
      if (!Number.isFinite(usd) || usd <= 0) return {};
      // Counted once, whatever delivers it. See `countedSteps`.
      if (s.countedSteps[stepId]) return {};
      const owner = s.threads.find((t) => t.live_run_ids.includes(runId));
      // A step from a run no thread claims — a shadow run started by a webhook, an eval job whose
      // snapshot has not arrived yet. Dropped rather than guessed at: attributing it to the wrong
      // session would put somebody else's spend on your row.
      if (!owner) return {};
      return {
        liveCost: { ...s.liveCost, [owner.id]: (s.liveCost[owner.id] ?? 0) + usd },
        countedSteps: { ...s.countedSteps, [stepId]: true },
      };
    }),

  addEvalCost: (evalId, usd) =>
    set((s) => {
      // Same three guards as `addStepCost`, and the same reasons: adding nothing must not create an
      // entry (an entry is what re-renders the row), and a delta for an eval no thread claims is
      // dropped rather than guessed at.
      if (!Number.isFinite(usd) || usd <= 0) return {};
      const owner = s.threads.find((t) => t.live_eval_ids.includes(evalId));
      if (!owner) return {};
      return { liveCost: { ...s.liveCost, [owner.id]: (s.liveCost[owner.id] ?? 0) + usd } };
    }),

  // A REPLACE, NOT AN ACCUMULATE. The event carries where the eval IS, not how far it moved — so
  // this is the newest answer to a question, and a duplicate delivery is harmless.
  noteEvalProgress: (evalId, progress) =>
    set((s) => ({ liveEvalProgress: { ...s.liveEvalProgress, [evalId]: progress } })),

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

/**
 * How far this thread's running eval has got: the newest answer, whoever gave it (§4.3.3).
 *
 * A SELECTOR, LIKE `threadSpend`, so there is one definition of "where is this eval" and no
 * component combines the snapshot and the live events differently. The snapshot's figure is taken
 * at the moment the eval STARTS — when `done` is 0 and `projectCost` correctly refuses to
 * extrapolate — so without the live half the projection never appeared at all.
 */
export function threadEvalProgress(
  thread: ThreadView,
  live: Record<string, { done: number; total: number }>,
): { done: number; total: number } | null {
  for (const evalId of thread.live_eval_ids) {
    const seen = live[evalId];
    // The LAST live eval wins if there are two, matching the server's own rule: a row has one
    // fragment and one projection, and the newest is the one whose numbers are still moving.
    if (seen) return seen;
  }
  return thread.eval_progress;
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
