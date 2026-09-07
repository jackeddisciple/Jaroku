// Whether this LAUNCH has been through the welcome screen yet.
//
// A STORE FOR ONE BOOLEAN, for `firstRunStore`'s reason rather than out of habit: the flag decides
// whether anything else is rendered at all, and it is one-way. A component holding it in `useState`
// would put the welcome screen back on any remount — and the remount that matters is the one a
// sign-out causes, which is exactly when somebody has just arrived at the sign-in screen on purpose.
//
// AND IT IS PER LAUNCH RATHER THAN PER DEVICE, which is the whole difference between this and
// `firstRunStore` next to it. First-run is gated by a marker file on disk because setting up
// `~/.jaroku` happens once ever. This is not a setup step and writes nothing: it is the front door,
// and a front door that only appears on the first launch after an install is a door most people
// would see exactly once. So it lives in memory and comes back on the next launch.
//
// WHAT DISMISSES IT IS THE BUTTON AND NOTHING ELSE. Not a timer, not a session arriving, not a
// route — because the window is a different SIZE while this is true, and a screen that dismissed
// itself would resize somebody's window out from under them.

import { create } from "zustand";

interface SplashState {
  /**
   * False once "Get started" has been pressed, for the rest of this launch.
   *
   * It starts true even in a browser, where the screen never renders: `splashOnScreen` is where the
   * host check lives, so that a suite can assert the decision without a bridge and this stays one
   * fact rather than two that can disagree.
   */
  pending: boolean;
  dismiss: () => void;
}

export const useSplashStore = create<SplashState>((set) => ({
  pending: true,
  dismiss: () => set({ pending: false }),
}));

/**
 * Whether the welcome screen is what should be on screen right now.
 *
 * A HOST ONLY, and the argument is the one `FirstRun` makes one file over: this screen exists to
 * introduce an APPLICATION — it names the platform it is running on and it resizes a native window
 * on the way out — and neither of those is true of a browser tab. `npm run dev` in a tab renders
 * exactly what it always did, which is also what keeps the change reviewable.
 *
 * IT TAKES THE HOST CHECK AS AN ARGUMENT rather than calling it, so that the rule above is a
 * function of two booleans and can be asserted as one. `App.tsx` supplies the real answer.
 */
export function splashOnScreen(pending: boolean, underHost: boolean): boolean {
  return pending && underHost;
}
