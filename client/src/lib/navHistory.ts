// The two halves that connect `historyStore` to the application: what records a visit, and what
// puts one back.
//
// A HOOK RATHER THAN A SUBSCRIPTION IN THE STORE, because the thing being watched is React state
// and the recording has to happen after the render that changed it — a `zustand` subscriber firing
// mid-update would record a spot the screen has not reached yet. Mounted once, in App.

import { useEffect } from "react";
import { useBuildStore } from "../store/buildStore.ts";
import { useHistoryStore, type Spot } from "../store/historyStore.ts";
import { useUiStore } from "../store/uiStore.ts";
import { selectAgent } from "./selection.ts";

/** Record where we are, whenever that changes. Mounted once. */
export function useNavigationHistory(): void {
  const nav = useUiStore((s) => s.navView);
  const agentId = useBuildStore((s) => s.activeAgentId);

  useEffect(() => {
    useHistoryStore.getState().record({ nav, agentId });
  }, [nav, agentId]);
}

/**
 * Put a spot back on screen.
 *
 * `restoring` IS SET AROUND THE WHOLE APPLICATION, not around each call, because both `selectAgent`
 * and the nav change land in the same React commit — and the effect above runs once, after it. A
 * flag cleared between the two would be false by the time the recorder looked.
 *
 * CLEARED IN A MICROTASK rather than synchronously, for the same reason: the effect that reads it
 * has not run yet when this function returns.
 */
function apply(spot: Spot | null): void {
  if (spot === null) return;
  const history = useHistoryStore.getState();
  const ui = useUiStore.getState();
  history.setRestoring(true);
  // The agent first: a destination that lists agents should already be pointed at the right one
  // when it appears, rather than visibly correcting itself a frame later.
  selectAgent(spot.agentId);
  if (spot.nav === null) ui.closeNav();
  else ui.openNav(spot.nav);
  queueMicrotask(() => useHistoryStore.getState().setRestoring(false));
}

export const goBack = (): void => apply(useHistoryStore.getState().back());
export const goForward = (): void => apply(useHistoryStore.getState().forward());
