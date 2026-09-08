// Starting a new agent, spelled once.
//
// TWO CALLERS AND THEY MUST NOT DRIFT: the `New` row at the top of the sidebar and the ⌘N chord
// registered beside ⌘K and ⌘P. A shortcut that does ALMOST what its button does is the worst of
// the three possible states — worse than no shortcut, because it is discovered by somebody who
// then has to work out which of the two they actually want.
//
// IT CLOSES THE FULL-WIDTH VIEW FIRST. `selectAgent(null)` puts the composer into its empty state,
// and the composer is in the three-pane view — so from the Inbox or Activity, selecting without
// closing would set up a screen nobody is looking at and leave the destination it was invoked from
// on top of it.

import { selectAgent } from "./selection.ts";
import { useUiStore } from "../store/uiStore.ts";

export function startNewAgent(): void {
  useUiStore.getState().closeNav();
  selectAgent(null);
}
