// WHICH TURNS CAN ACTUALLY BE RE-RUN — the predicate the action row was missing.
//
// `rerunTurn` was written for one turn kind and the row was mounted on four. `AssistantTurn`
// passed `onRegenerate`/`onRegenerateWith` for every assistant turn; the handler dispatched only
// for `kind === "reply"` and let the other three fall through to a `prefillChat` that put the
// sentence back in the composer and stopped. So on a plan, a generation and an edit proposal the
// most prominent recovery control on the card rendered, promised "Re-run the same message with the
// current settings" in its tooltip, and did nothing — silently, in both directions, which is the
// shape that gets pressed twice.
//
// THE PRODUCT'S OWN RULE DECIDES THIS: "A control that does nothing is worse than no control." So
// the row asks first and renders the two regenerate affordances only where one of them can dispatch.
//
// AND ONLY A REPLY CAN. That is not a limitation of the handler, it is `rerunTurn`'s own stated
// design: a regeneration attaches a SECOND ANSWER to the turn it re-runs, as a `turn_variants` row
// beside the first, and the `‹ n/m ›` switcher exists to move between them. A generation and an
// edit publish a version and change an agent's files — running one again is a second build rather
// than a second answer, and a switcher over it would offer to "switch back" to code that has
// already been superseded on disk. A plan is spent by the generation it authorises, so re-planning
// is `Revise`, which the plan card already carries with the feedback box the operation needs.
//
// A REPLY THE SERVER HAS NOT FILED YET IS NOT RE-RUNNABLE EITHER, for the same reason Note and Pin
// gate on it: the variant is recorded against a `thread_items` row, and a turn still streaming has
// no row to attach a second answer to. The row already hides those controls rather than greying
// them, and this follows it.
//
//   npm run test:rerun

import type { ChatTurn } from "../store/chatStore.ts";

/**
 * Can this turn be regenerated — i.e. will pressing ⟳ dispatch something?
 *
 * The action row calls this to decide whether to render the regenerate button and its
 * "with different settings" menu at all. `rerunTurn` calls it as its own guard, so the two can
 * never disagree about what the control does.
 */
export function canRerunTurn(turn: ChatTurn): boolean {
  return turn.role === "jaroku" && turn.kind === "reply" && Boolean(turn.itemId);
}
