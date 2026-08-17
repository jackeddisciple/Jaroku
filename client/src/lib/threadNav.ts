// Opening a thread, which is one action across three stores (§2).
//
// SELECTING IS THE TRANSITION. There is no confirm step and no second click: picking a row loads that
// thread in the centre pane, its agent in the right panel, and collapses the full-screen view back to
// the three panes. All three happen here so that a row cannot do two of them — which is the same
// reason `lib/selection.ts` exists for the agent/run pair.
//
// WHY IT IS NOT IN `selection.ts` DESPITE BEING ITS NEIGHBOUR. That module's whole subject is one
// invariant: the run on screen belongs to the agent in the header. This is a navigation, and it uses
// that module rather than reimplementing it — `selectAgent` is what keeps the invariant, so the thread
// side never has to know about runs at all.

import { sendLoadThread } from "./socket.ts";
import { selectAgent } from "./selection.ts";
import { useThreadStore } from "../store/threadStore.ts";
import { useUiStore } from "../store/uiStore.ts";
import type { ThreadView } from "../types.ts";

/**
 * Open a thread into the three-pane view.
 *
 * THE ORDER MATTERS ONCE: `selectAgent` closes the full-screen view (§2's "going back without picking
 * anything" is the same call), so the thread is selected first and the agent second. Reversed, the
 * view would collapse before the centre pane knew which conversation to render, and the composer
 * would paint one frame of the previous thread.
 *
 * A thread with no agent still opens. §3.1's planning stage is a real session — a description, a plan
 * card, two revisions and no Generate yet — and it belongs in the centre pane with the right panel
 * left exactly as it was.
 */
export function openThread(
  thread: ThreadView,
  /**
   * The conversation is already in hand, so do not ask for it again.
   *
   * The one caller is the answer to `createThread`, which carries the row AND its (empty) items —
   * asking for them a second time would be a round trip to be told the same nothing.
   */
  opts?: { haveConversation?: boolean },
): void {
  useThreadStore.getState().selectThread(thread.id);
  // §4.5: the conversation opens at the first unresolved turn, not at the bottom. Requested here —
  // where opening happens — rather than in the pane, so every route in (a row, Enter, the palette)
  // resumes the same way and none of them can forget to.
  useThreadStore.getState().requestResume();
  if (!opts?.haveConversation) sendLoadThread(thread.id);
  // `keepThread`, because the row that was just clicked IS the session — and `selectAgent`
  // otherwise resolves the agent's most recently active one, which for any agent with two threads
  // is usually not this one.
  if (thread.agent_id) selectAgent(thread.agent_id, { keepThread: true });
  else useUiStore.getState().closeNav();
}

/**
 * Go to the agent a row names, rather than into the thread (§4.3).
 *
 * The chip and the row are one pixel apart and lead to different places, which is exactly why this is
 * a named function: "the chip navigates to that agent, not into the thread" is a rule somebody has to
 * be able to find, and a `selectAgent` call inline in a row's JSX is not where they would look.
 */
export function openThreadAgent(agentId: string): void {
  selectAgent(agentId);
}
