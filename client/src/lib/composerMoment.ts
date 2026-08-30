// What the composer should say, given what is happening.
//
// The placeholder was a four-branch ternary on (mode, selection): test, generate, something
// selected, otherwise edit. That covers where a message would GO and says nothing about the state
// of the session — so a composer sitting under a plan awaiting approval, under a generation
// writing files, and under a finished agent all read identically. The one input in the app was
// the one part of it that never knew what was going on.
//
// Two strings come out of here. The placeholder tells you what to type. The status tells you what
// the app is doing, and is null when the answer is "nothing" — a composer that reports "idle" is
// noise, and the empty state below it already says so.
//
// A pure function on a flat descriptor, so the branching is readable in one place instead of
// nested inside JSX, and so the order of precedence is a list rather than a shape.

import { keyHint } from "./modKey.ts";

export type ComposerSituation = {
  mode: "chat" | "test";
  /** Test mode can actually dispatch a run: connected, an agent is selected, and it is runnable. */
  canRun: boolean;
  agentName: string | null;
  /** A plan is being written or revised right now. */
  planning: boolean;
  /** Files are streaming onto disk. */
  generating: boolean;
  /** An explain answer or an edit proposal is streaming. */
  answering: boolean;
  /** A plan is on screen awaiting Generate / Discard. */
  planPending: boolean;
  /** A plan no longer describes what would be built. */
  planStale: boolean;
  /** A diff is on screen awaiting Apply / Discard. */
  proposalPending: boolean;
  /** The interactive run is executing. */
  running: boolean;
  /** The selected trace step's seq, when that step failed. */
  failedStepSeq: number | null;
  /** The composer's existing context label — a selected step or graph node. */
  contextLabel: string | null;
  /**
   * This is an OPERATE conversation (Part 3 §11), so nothing typed here changes code.
   *
   * IT IS THE FIRST RUNG BELOW TEST MODE rather than a branch at the bottom, because every sentence
   * beneath it is about building: "describe a change", "a plan is waiting", "fix step #4". Placed
   * lower, an operate composer would inherit whichever of those happened to match first — which is
   * how a box that dispatches to a live container ends up inviting somebody to describe a change.
   */
  operating?: boolean;
};

export type ComposerMoment = {
  placeholder: string;
  /** One line about what is happening. Null when nothing is. */
  status: string | null;
};

/**
 * Precedence, most specific first:
 *
 *   1. Test mode is a different job entirely — it sends the agent's own input, not a message.
 *   2. Something is in flight. What the app is doing outranks what you could ask it to do.
 *   3. A decision is waiting. The composer should say what typing means while a gate is open,
 *      because a typed message goes somewhere different then (a plan revision, not a new plan).
 *   4. Something is selected.
 *   5. Otherwise: build one, or change this one.
 */
export function composerMoment(s: ComposerSituation): ComposerMoment {
  const agent = s.agentName ?? "this agent";

  // AN OPERATE THREAD HAS TWO DESTINATIONS AND NEITHER IS AN EDIT, so it says what it can actually
  // do. The destination LABEL above the box says which of the two this particular sentence takes;
  // this says what the box is for at all.
  if (s.operating) {
    return {
      placeholder: `Ask ${agent} what it has done, or give it a job — ${keyHint("⌘↵")} to send`,
      status: null,
    };
  }

  if (s.mode === "test") {
    if (!s.canRun) {
      return {
        placeholder: "Select a runnable agent to test it",
        status: s.agentName ? `${agent} can’t run — it has no agent.py` : null,
      };
    }
    return {
      placeholder: `Run ${agent} on… — ${keyHint("⌘↵")} to run`,
      status: s.running ? "A run is in flight" : null,
    };
  }

  if (s.planning) {
    return { placeholder: "Writing the plan…", status: "Planning" };
  }
  if (s.generating) {
    return {
      placeholder: "Generating — nothing lands on disk until validation passes",
      status: "Generating",
    };
  }
  if (s.answering) {
    return { placeholder: "Working…", status: "Working" };
  }

  if (s.planStale) {
    return {
      placeholder: "Say what you want — it will be re-planned against the new selection",
      status: "This plan is out of date",
    };
  }
  if (s.planPending) {
    return {
      // Not "describe an agent". While a plan is up, a typed message is feedback on THAT plan,
      // and the composer saying otherwise is the app disagreeing with itself.
      placeholder: "Say what to change about the plan — or generate it above",
      status: "A plan is waiting for your decision",
    };
  }
  if (s.proposalPending) {
    return {
      placeholder: `Ask for something else, or apply the diff above`,
      status: "A change is waiting for your decision",
    };
  }

  if (s.running) {
    return {
      placeholder: `Ask about the run, or describe a change to ${agent}`,
      status: "A run is in flight",
    };
  }
  if (s.failedStepSeq !== null) {
    return {
      placeholder: `Ask about step #${s.failedStepSeq}, or pick an action above`,
      status: `Step #${s.failedStepSeq} failed`,
    };
  }
  // Only when there is an agent. A trace step stays selected across an agent change, and with
  // nothing selected in the sidebar the intent router sends a typed message to "plan a new
  // agent" — so offering to explain the selection would be the composer promising something it
  // is about to not do.
  if (s.contextLabel && s.agentName) {
    return {
      placeholder: "Ask about or act on the selection — e.g. “why did this fail?”",
      status: null,
    };
  }

  if (!s.agentName) {
    // SIX WORDS, NOT A WORKED EXAMPLE. The example ran to twenty-two words and wrapped to two
    // lines inside the input, which makes an empty field look pre-filled — the one thing a
    // placeholder must not do. The example itself is not lost: it belongs in the empty state
    // above the composer, where it can be read rather than typed over.
    return { placeholder: `Describe an agent — ${keyHint("⌘↵")} to send`, status: null };
  }
  return { placeholder: `Describe a change to ${agent} — ${keyHint("⌘↵")} to send`, status: null };
}
