// Starting a new conversation, spelled once.
//
// A CONVERSATION, NOT AN AGENT — the product owner's call on 2026-09-15: "the New on top of sidebar
// should always start a new convo, it doesn't mean start a new agent". What it opens is the empty
// composer, which is where a conversation begins; describing an agent into it is one thing such a
// conversation can be, not what pressing this promises.
//
// THREE CALLERS AND THEY MUST NOT DRIFT: the `New` row at the top of the sidebar, the ⌘N chord
// registered beside ⌘K and ⌘P, and the × on the composer's agent tray. A shortcut that does ALMOST
// what its button does is the worst of the three possible states — worse than no shortcut, because
// it is discovered by somebody who then has to work out which of the two they actually want.
//
// IT CLOSES THE FULL-WIDTH VIEW FIRST. `selectAgent(null)` puts the composer into its empty state,
// and the composer is in the three-pane view — so from the Inbox or Activity, selecting without
// closing would set up a screen nobody is looking at and leave the destination it was invoked from
// on top of it.
//
// AND IT DROPS THE OPEN CONVERSATION ITSELF, which `selectAgent` alone could not be relied on to do:
// it returns early when the agent is not changing, so pressing New while a chat with no agent was
// open — anything from Recents — left that chat on screen and started nothing at all.

import { selectAgent } from "./selection.ts";
import { useThreadStore } from "../store/threadStore.ts";
import { useUiStore } from "../store/uiStore.ts";

export function startNewChat(): void {
  useUiStore.getState().closeNav();
  useThreadStore.getState().selectThread(null);
  selectAgent(null);
}
