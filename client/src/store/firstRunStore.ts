// Whether this MACHINE is set up, and how far along it is.
//
// A STORE OF ITS OWN RATHER THAN A CORNER OF `hostStore`, for the reason `sessionStore` is not a
// corner of `uiStore`: this decides whether anything is rendered at all. `hostStore` holds what the
// shell says about a PROCESS — the backend is preparing, started, restarting, failed — and every
// consumer of it renders a strip inside a working application. This one takes the screen.
//
// AND THE TWO ANSWER DIFFERENT QUESTIONS ABOUT THE SAME LAUNCH. A first launch has both a backend
// that is not up yet and a machine that is not set up yet, and only one of those is worth showing:
// the setup screen is the honest description, and "connecting…" underneath it would be a second
// spinner for a server nobody has asked for anything yet.
//
// THE SUBSCRIPTION IS INSTALLED FROM `main.tsx`, not from a component, for `hostBackend`'s reason
// and one more of its own. The shell settles most of first-run during startup, which is before
// React has mounted anything — so a subscriber inside a component would miss the whole sequence on
// exactly the launches this exists for. The extra reason is `dismissed` below: a component that
// remounted would re-read a progress that says `required: true` and put the setup screen back over
// an app somebody had already been let into.

import { create } from "zustand";
import { firstRunSnapshot, onFirstRun, type FirstRunProgress } from "../lib/firstRun.ts";

interface FirstRunState {
  /**
   * What the shell last said, or null.
   *
   * NULL IS THE BROWSER'S PERMANENT STATE and also the first frame of every desktop launch, and
   * both mean the same thing to every reader: do not render the setup screen. That collapse is
   * deliberate — a page that flashed a welcome screen for one frame while it waited for a snapshot
   * would be doing it on every launch, not only the first.
   */
  progress: FirstRunProgress | null;
  /**
   * Whether the person has pressed "Continue to sign in".
   *
   * HERE RATHER THAN IN THE COMPONENT, because the transition it drives is one-way and has to
   * survive a re-render. `progress.complete` stays true for the rest of the session — the marker is
   * on disk and the steps are done — so without this the ready screen would be the app's permanent
   * state and there would be no way past it.
   */
  dismissed: boolean;

  apply: (progress: FirstRunProgress) => void;
  dismiss: () => void;
  /** Ask the shell once, then subscribe. Returns an unsubscribe; called once, from main.tsx. */
  watch: () => () => void;
}

export const useFirstRunStore = create<FirstRunState>((set, get) => ({
  progress: null,
  dismissed: false,

  apply: (progress) =>
    set((s) => ({
      progress,
      // A RETRY UN-DISMISSES NOTHING AND A FAILURE RE-CLAIMS THE SCREEN. The only way `dismissed`
      // goes back to false is a relaunch, because the only thing it means is "this person has been
      // shown the ready screen and pressed the button". A step failing afterwards — an upgrade that
      // could not re-sync months later — must not throw a setup screen over a working app, and
      // `required` being false on that launch is what already stops it.
      dismissed: s.dismissed,
    })),

  dismiss: () => set({ dismissed: true }),

  watch: () => {
    // SUBSCRIBE BEFORE ASKING, and then let the snapshot lose a race it can only lose harmlessly.
    // The other order has a gap: an event emitted between the snapshot returning and the listener
    // attaching reaches nobody, and on a fast machine that gap is where "storage done" lives.
    const stop = onFirstRun((progress) => get().apply(progress));
    void firstRunSnapshot().then((progress) => {
      if (!progress) return;
      // A snapshot that arrives after a live event would be OLDER than what the store already
      // holds — it is what the shell said at the moment it was asked, and events have moved since.
      // Applied only when nothing has arrived yet, which is the whole of the ordering care needed.
      if (get().progress === null) get().apply(progress);
    });
    return stop;
  },
}));

/**
 * Whether the first-run screens should be on screen right now.
 *
 * A FUNCTION RATHER THAN A FIELD, so there is one place that decides and no chance of two readers
 * answering differently. Three conditions and every one of them is load-bearing:
 *
 *   the shell has said something          — null is a browser, and a browser has no machine to set up
 *   it said this launch is a first one    — decided once from the marker, never from live state
 *   the person has not pressed past it    — see `dismissed`
 */
export function firstRunOnScreen(state: {
  progress: FirstRunProgress | null;
  dismissed: boolean;
}): boolean {
  return state.progress !== null && state.progress.required && !state.dismissed;
}
