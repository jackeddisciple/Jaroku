// Opening an agent, which is one action across four stores (§2, §6).
//
// SELECTING IS THE TRANSITION. There is no confirm step and no second click: picking a card loads
// that agent's record, scopes the composer to it, and collapses the full-screen view back to the
// three panes. All of it happens here so that a card cannot do three of the four — which is the same
// reason `lib/threadNav.ts` exists for the thread side and `lib/selection.ts` for the agent/run pair.
//
// WHY IT IS NOT IN `selection.ts` DESPITE BEING ITS NEIGHBOUR. That module's whole subject is one
// invariant — the run on screen belongs to the agent in the header — and it is used here rather than
// reimplemented: `selectAgent` is what keeps that invariant, so the Agents tab never has to know
// runs exist.
//
// §2'S LAYOUT LAW, WHICH THESE TWO FUNCTIONS ARE THE WHOLE IMPLEMENTATION OF:
//
//   Clicking a card restores the 3-pane layout with that agent selected.
//   Clicking `+ New thread` on a card SKIPS the detail view entirely — create the thread with
//   `agent_id` preset, restore 3-pane, focus the composer.
//   There is no back button anywhere. Returning to the grid is clicking the already-active sidebar
//   item, which `Sidebar` does by calling `openNav("agents")` again.
//   The sidebar item stays visually active throughout, in both states.
//
// THE LAST OF THOSE IS WHY `openAgentDetail` DOES NOT CLEAR `navView` ITSELF. `selectAgent` closes
// the full-screen view — that is §2's "going back without picking anything" and it is the same call
// — and the nav item's active state is a separate fact held in `uiStore.navSection`, which survives.

import { sendCreateThread, sendLoadAgentDetail } from "./socket.ts";
import { selectAgent } from "./selection.ts";
import { useAgentGridStore } from "../store/agentGridStore.ts";
import { useUiStore } from "../store/uiStore.ts";

/**
 * Open an agent's §6 detail into the three-pane view.
 *
 * THE ORDER MATTERS ONCE, and it is the same ordering `openThread` documents: `selectAgent` closes
 * the full-screen view, so the detail is requested first and the agent selected second. Reversed,
 * the view would collapse before the panes knew which agent to render and the detail would paint one
 * frame of the previous one.
 */
export function openAgentDetail(slug: string): void {
  sendLoadAgentDetail(slug);
  // The right pane's Agent tab is what §6's five tabs live in, so opening a card puts the panel
  // there. Somebody who then wants the trace clicks Trace; nothing is taken away.
  useUiStore.getState().setRightTab("agent");
  selectAgent(slug, { fromNav: true });
}

/**
 * §6's `+ New thread` on a card: skip the detail entirely.
 *
 * The thread is created with `agent_id` preset, the three panes come back, and the composer takes
 * focus. `createThread`'s answer carries the new row AND opens it, so there is nothing here that
 * has to guess which thread was just made — see the socket's handler for `reason: "created"`.
 *
 * IT DOES NOT LOAD THE DETAIL, which is the whole point of the shortcut: somebody pressing this has
 * decided what they want to do, and fetching an agent's version history on the way to a composer is
 * a round trip nobody asked for.
 */
export function startAgentThread(slug: string): void {
  useAgentGridStore.getState().closeDetail();
  sendCreateThread(slug);
  selectAgent(slug, { fromNav: true });
  useUiStore.getState().focusChat();
}

/** Leave the detail and go back to the grid. The sidebar's already-active item is the only door. */
export function closeAgentDetail(): void {
  useAgentGridStore.getState().closeDetail();
}
