// §18's one rule: NEVER MOVE CONTENT UNDER THE READER.
//
// "The single hardest problem in this tab. A work list on a busy workspace changes while somebody
// is reading it." Everything below is that sentence made mechanical, and each of the four cases is
// a different answer to the same question — what does an arrival do to a reader's place?
//
//   A NEW ITEM ARRIVING ABOVE THE SCROLL POSITION DOES NOT INSERT. It increments a count, and a
//   pill — "3 new" — appears pinned at the top. §18: "This is the only correct answer; an item
//   inserted at the top while somebody is reading row twenty moves row twenty, and they lose their
//   place on a surface whose whole job is letting them keep it."
//
//   AN ITEM ARRIVING WHILE THE READER IS ALREADY AT THE TOP INSERTS DIRECTLY, with no pill and no
//   animation. There is nothing below the fold to move, so holding it back would be ceremony — and
//   a pill over a list somebody is watching live is a control that asks them to click to see what
//   they were already looking at.
//
//   A STATUS CHANGING UPDATES IN PLACE AND NEVER REORDERS. §18: "Sort is by creation time and
//   creation time does not change. If you ever find yourself re-sorting on status, stop — that is a
//   list that rearranges itself under a cursor." So a row that changes is written back AT ITS OWN
//   INDEX, and the index is never recomputed.
//
//   A ROW THAT LEAVES THE FILTER IS REMOVED, which is the one case that does move the rows under
//   it and is still right: a job filtered to `running` that succeeds is no longer an answer to the
//   question on screen, and leaving it would make the list a record of what once matched. It is
//   also the one the reader caused, by choosing that filter.
//
// A PURE FUNCTION OVER TWO ARRAYS, in its own module, because every one of the four cases looks
// obviously right in a screenshot and three of them are wrong in the case nobody had that day.
// `workStore` keeps the counts — they are a different fact with a different scope rule — and calls
// this for the list.
//
// WHAT IS DELIBERATELY NOT HERE: the scroll position. "At the top" arrives as a boolean because a
// store that read a DOM offset would be a store that cannot be tested and a rule that changes
// answer depending on when it is asked. The view owns the scroller and tells this what it knows.
//
//   npm run test:work-live

import type { WorkItemView } from "../types.ts";

/** The two lists the rule moves rows between: what is rendered, and what is waiting to be. */
export interface LiveList {
  items: WorkItemView[];
  /**
   * Arrivals held back because the reader is not at the top. Newest first, like `items`.
   *
   * THE ROWS THEMSELVES AND NOT A COUNT, which is the difference between a pill that works and one
   * that lies. A counter would have to re-ask the server for the rows when it was pressed, and
   * between the count and the fetch a job can finish, be cancelled, or leave the filter — so the
   * pill would promise three and deliver two. Holding the rows means pressing it is a local
   * operation that cannot fail.
   */
  pending: WorkItemView[];
}

/**
 * One delta, applied.
 *
 * `belongs` IS THE FILTER'S ANSWER AND NOT THIS FUNCTION'S. `workStore.matchesFilters` owns it,
 * because it needs the viewer's id and the page's filters — and a rule about scroll position that
 * also decided what matched would be two decisions in one place, only one of which is about §18.
 */
export function mergeDelta(
  list: LiveList,
  item: WorkItemView,
  opts: { belongs: boolean; atTop: boolean },
): LiveList {
  const at = list.items.findIndex((i) => i.id === item.id);

  // 1. A ROW WE ARE SHOWING. In place, or gone — never moved.
  if (at >= 0) {
    if (!opts.belongs) {
      const items = [...list.items];
      items.splice(at, 1);
      return { items, pending: list.pending };
    }
    const items = [...list.items];
    // AT ITS OWN INDEX. This is the line §18's "never reorders" is about, and the tempting wrong
    // version — remove and unshift — is one character shorter.
    items[at] = item;
    return { items, pending: list.pending };
  }

  // 2. A ROW ALREADY WAITING BEHIND THE PILL. It can change while it is held: a job dispatched by a
  // colleague can succeed before the reader ever scrolls up. It is updated where it is, so the
  // pill's count does not move and the row that lands when it is pressed is the current one.
  const held = list.pending.findIndex((i) => i.id === item.id);
  if (held >= 0) {
    const pending = [...list.pending];
    if (!opts.belongs) pending.splice(held, 1);
    else pending[held] = item;
    return { items: list.items, pending };
  }

  // 3. SOMETHING NEW. Nothing to do if it is not ours to show.
  if (!opts.belongs) return list;

  // 4. AT THE TOP: STRAIGHT IN. Nothing below the fold is displaced, so there is nothing to protect
  // and a pill would be ceremony. Below the top: HELD, and the pill counts it.
  return opts.atTop
    ? { items: [item, ...list.items], pending: list.pending }
    : { items: list.items, pending: [item, ...list.pending] };
}

/**
 * The pill was pressed: everything held becomes visible, at the head, in one step.
 *
 * IDEMPOTENT AND DEDUPLICATING, because a snapshot can land between the arrival and the press — the
 * server's page would then already contain a row this is about to unshift, and a list with the same
 * job twice is worse than a list that was one row stale.
 *
 * IT DOES NOT SORT. The held rows are newest-first and the list is newest-first, so concatenating
 * them is already in order — and a sort here would be the second opinion about ordering §18 rules
 * out one paragraph after ruling out re-ordering on status.
 */
export function admitPending(list: LiveList): LiveList {
  if (list.pending.length === 0) return list;
  const have = new Set(list.items.map((i) => i.id));
  return {
    items: [...list.pending.filter((i) => !have.has(i.id)), ...list.items],
    pending: [],
  };
}

/**
 * A snapshot replaces everything, INCLUDING what was held back.
 *
 * BECAUSE THE PILL IS A PROMISE ABOUT A PARTICULAR LIST. A fresh page is a new answer to the
 * question on screen and already contains whatever was waiting; carrying the held rows across would
 * either duplicate them or leave a pill offering rows the new page has in it already. A filter
 * change is the commonest case and the clearest: the reader asked a different question, and the
 * three jobs waiting behind the pill were answers to the old one.
 */
export function resetPending(items: WorkItemView[]): LiveList {
  return { items, pending: [] };
}

// ─── §19: OPTIMISTIC DISPATCH ───────────────────────────────────────────────────────────────────
//
// "Between the user pressing confirm and the server acknowledging, something must be on screen, and
// WHAT IT IS MATTERS." Three rules, and the third is the one the whole section turns on.
//
//   A ROW APPEARS IMMEDIATELY, at `queued`, at the top, "marked as not yet acknowledged in a way
//   that is visible but quiet — reduced opacity is enough".
//
//   ON ACKNOWLEDGEMENT IT SETTLES, IN PLACE, WITH NO MOTION. "It was already in the right
//   position." So the acknowledgement replaces the placeholder at its own index and does not
//   insert a second row beside it — which is what a naive implementation does, because the real
//   row arrives with a different id.
//
//   ON REFUSAL IT DOES NOT VANISH. "It becomes a failed row carrying the refusal reason. A row that
//   appears and then disappears makes the user wonder whether the job ran, and 'DID IT RUN OR NOT'
//   is the one question this tab exists to never leave open."
//
// THE ID IS THE PROBLEM AND `client_ref` IS THE ANSWER. The optimistic row has no server id — the
// row does not exist yet — so the acknowledgement cannot be matched to it by id. It is matched by a
// reference this client minted and sent with the dispatch, which the server echoes back on the
// `dispatched` event. Without that the only options are to guess by (agent, input, time), which is
// wrong the moment somebody sends the same job twice on purpose, or to leave the placeholder and
// insert the real row beside it, which is the duplicate §19's "settles in place" rules out.

/** A row this client has drawn before the server has agreed to it. */
export interface OptimisticRow {
  /** The reference sent with the dispatch and echoed on the answer. Never a server id. */
  ref: string;
  item: WorkItemView;
  /** What the server said when it refused, or null while it has not answered. */
  refusal: string | null;
}

/**
 * Whether a row is one this client drew and the server has not answered for.
 *
 * READ FROM THE ID rather than carried as a field, because the id is what everything else keys on:
 * a row whose id is a client reference is by construction one no server has seen. The prefix makes
 * that legible in a devtools panel and impossible to collide with a uuid.
 */
export const OPTIMISTIC_PREFIX = "pending:";

export function isOptimistic(item: WorkItemView): boolean {
  return item.id.startsWith(OPTIMISTIC_PREFIX);
}

/** A row to draw immediately, at `queued`, from what the composer already knows. */
export function optimisticRow(input: {
  ref: string;
  agentId: string;
  agentName: string | null;
  deploymentId: string;
  createdBy: string;
  createdByName: string | null;
  text: string;
}): WorkItemView {
  return {
    id: `${OPTIMISTIC_PREFIX}${input.ref}`,
    agent_id: input.agentId,
    agent_name: input.agentName,
    deployment_id: input.deploymentId,
    run_id: null,
    created_by: input.createdBy,
    created_by_name: input.createdByName,
    input_preview: input.text,
    status: "queued",
    output_preview: null,
    error: null,
    failure_kind: null,
    created_at: new Date().toISOString(),
    started_at: null,
    ended_at: null,
    // NULL AND NOT ZERO, exactly as a real row would be: nothing has been priced because nothing
    // has run. A `$0.00` here would be the one made-up figure on the tab whose argument is that its
    // numbers are real.
    cost_usd: null,
    tokens: null,
    duration_ms: null,
    cost_complete: true,
  };
}

/**
 * The server answered — the placeholder becomes the real row, AT ITS OWN INDEX.
 *
 * IN PLACE, WHICH IS §19's "it settles, in place, with no motion. It was already in the right
 * position." The tempting wrong version removes the placeholder and unshifts the real row: it
 * produces a correct list and moves every row below it by one, at the exact moment the reader is
 * watching the row they just created.
 *
 * AND IT FALLS BACK TO AN ORDINARY ARRIVAL. A `dispatched` answer with no placeholder to replace is
 * a job this client did not send — a retry from the detail panel, a second window — and the honest
 * thing is to treat it as what it is rather than to drop it.
 */
export function settleOptimistic(list: LiveList, ref: string, real: WorkItemView): LiveList {
  const id = `${OPTIMISTIC_PREFIX}${ref}`;
  const at = list.items.findIndex((i) => i.id === id);
  if (at < 0) {
    const have = list.items.some((i) => i.id === real.id);
    return have ? list : { items: [real, ...list.items], pending: list.pending };
  }
  const items = [...list.items];
  items[at] = real;
  return { items, pending: list.pending };
}

/**
 * The server refused — the placeholder BECOMES A FAILED ROW rather than vanishing.
 *
 * §19: "A row that appears and then disappears makes the user wonder whether the job ran, and 'did
 * it run or not' is the one question this tab exists to never leave open." So the row stays, at its
 * own index, wearing `failed` and carrying the reason the server gave.
 *
 * `failure_kind` IS DELIBERATELY LEFT NULL. The six kinds describe what happened to a job that
 * reached a container; a dispatch the server would not accept never did, so claiming one of them
 * would be filing a refusal under a category that does not fit. The row carries the server's own
 * sentence in `error` instead, which the detail panel renders under "What went wrong".
 */
export function refuseOptimistic(list: LiveList, ref: string, reason: string): LiveList {
  const id = `${OPTIMISTIC_PREFIX}${ref}`;
  const at = list.items.findIndex((i) => i.id === id);
  if (at < 0) return list;
  const items = [...list.items];
  items[at] = { ...items[at]!, status: "failed", error: reason, ended_at: new Date().toISOString() };
  return { items, pending: list.pending };
}
