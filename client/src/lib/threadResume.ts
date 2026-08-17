// §4.5 — where a thread opens, and saying so before the click.
//
// A CONVERSATION DOES NOT OPEN AT THE BOTTOM. Every other chat product does, because in every other
// chat product the last thing said is the interesting thing. Here the interesting thing is what the
// session LEFT: an unapplied diff four turns up, a step that failed, a plan still waiting on a
// decision. Opening at the bottom means scrolling back to find the reason you came, every time.
//
// AND THE HOVER SAYS WHICH, WITH ITS SHAPE. `resume at pending diff` names the KIND of destination;
// appending the state fragment the row already computed — `· +42−11` — names it exactly, and costs
// nothing, because it is the identical string rendering one line below. The more specific the
// destination shown before the click, the less anybody has to open a thread to find out what "resume"
// means this time.
//
// BOTH HALVES ARE PURE FUNCTIONS OVER STATE THAT ALREADY EXISTS. The hint reads the row's own status
// and fragment; the anchor reads the conversation's own turn statuses. Neither asks the server for
// anything new, and neither can disagree with what is rendered beside it.

import type { ChatTurn } from "../store/chatStore.ts";
import type { ThreadView } from "../types.ts";

/**
 * What Enter will do, in words, for the hover affordance.
 *
 * Null when there is nothing outstanding: a row with nothing to resume gets no affordance rather than
 * a reassuring one. "Open" on every idle row would be four words of noise per row, and the click
 * already means that.
 */
export function resumeHint(thread: ThreadView): string | null {
  if (thread.archived_at !== null) return null;
  const kind = destinationOf(thread);
  if (!kind) return null;
  // The fragment, appended, is v2's refinement: the kind AND the shape. `diff pending +42−11` already
  // carries the word "diff", so only the numbers are taken from it — otherwise the hover would read
  // "resume at pending diff · diff pending +42−11".
  const shape = shapeOf(thread.fragment);
  return shape ? `↵ resume at ${kind} · ${shape}` : `↵ resume at ${kind}`;
}

/** Which unresolved thing this thread has, named the way a person would name it. */
function destinationOf(thread: ThreadView): string | null {
  const f = thread.fragment ?? "";
  if (f.startsWith("diff pending")) return "pending diff";
  if (f.startsWith("plan awaiting")) return "the plan";
  if (f.includes("confirmation")) return "the confirmation";
  if (f === "generation rejected") return "the refused generation";
  // ONE WORD FOR BOTH SHAPES OF FAILURE. A thread that stopped and a thread with an unretried failure
  // in the middle of it land in the same place — the earliest card with an error on it — so naming them
  // differently would promise a distinction the destination does not make. The fragment beside it
  // ("3 failed steps") is what carries how much went wrong.
  if (thread.status === "errored" || f.includes("failed step")) return "the failure";
  // A running thread has nothing waiting on a person: opening it is opening it, and Enter needs no
  // explanation for that.
  return null;
}

/** The numbers out of a fragment, when it has any. `diff pending +42−11` → `+42−11`. */
function shapeOf(fragment: string | null): string | null {
  if (!fragment) return null;
  const diff = /([+]\d+[−-]\d+)/.exec(fragment);
  if (diff) return diff[1]!;
  // `3 failed steps` carries its own number and reads as the shape already; the kind above says
  // "the failure", so this is what makes it "the failure · 3 failed steps".
  if (/^\d+ failed step/.test(fragment)) return fragment;
  return null;
}

/**
 * The first turn in the conversation that is still waiting on somebody, or null.
 *
 * READ FROM THE TURNS' OWN STATUSES rather than from the thread's derived one, and the difference is
 * the whole point: the row says THAT something is unresolved, and this says WHERE. A pending proposal
 * is a diff card with an Apply button on it; a pending plan is a card with a Generate button; an
 * errored generation is a card with the validator's problems listed under it. Each is a real element
 * with an id, which is what makes scrolling to it possible at all.
 *
 * FIRST, NOT LAST. A thread with two failures wants the earlier one — that is where the trouble
 * started, and reading forward from it is how anybody would work out what happened.
 */
export function firstUnresolvedTurnId(turns: ChatTurn[]): string | null {
  for (const t of turns) {
    if (t.role !== "jaroku") continue;
    switch (t.kind) {
      case "proposal":
        // `pending` is the diff awaiting Apply or Discard; `error` is one that failed on the way.
        if (t.status === "pending" || t.status === "error") return t.id;
        break;
      case "plan":
        if (t.status === "pending" || t.status === "error") return t.id;
        break;
      case "gen":
        if (t.status === "error") return t.id;
        break;
      default:
        break;
    }
  }
  return null;
}
