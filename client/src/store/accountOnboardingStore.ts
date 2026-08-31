// Where somebody is in §5's five steps, and what the app does about it.
//
// THE SERVER IS THE AUTHORITY AND THIS IS A CACHE OF IT. `users.onboarding_step` is the resume
// point, it arrives on every session, and every advance writes it back. That is the whole reason
// this is not `uiStore`: §5.3 asks for somebody who stops on step 3 to resume on step 3 on a
// DIFFERENT MACHINE, and a browser cannot answer that — which is exactly the argument migration
// 013 already made for `onboarded_at`.
//
// THE WRITE IS FIRE-AND-FORGET, DELIBERATELY. Advancing moves the local step immediately and posts
// the number without waiting: the person is already looking at the next screen, and a round trip
// between pressing Continue and seeing it would make a five-step flow feel like a five-step form.
// The cost of a failed write is that a resume lands one screen early, which is a considerably
// smaller price than a spinner on every step — and §9.3 already treats a resume that shows the same
// screen twice as correct behaviour for an interruption.
//
// AND `skipped` IS NOT A SERVER FACT. §5.1's "Skip setup" lands somebody in the main app with a
// persistent banner; it does not mark them onboarded, because they have not been. So the flag lives
// here, for this window, and the banner is what makes it recoverable — the next launch shows the
// flow again from wherever they were, which is the honest reading of "they have not set up yet".

import { create } from "zustand";
import { advanceOnboarding, completeOnboarding, restartOnboarding } from "../lib/onboardingApi.ts";
import { FIRST_STEP, LAST_STEP, nextStep, previousStep, type OnboardingStepNumber } from "../lib/accountOnboarding.ts";
import { useSessionStore } from "./sessionStore.ts";

interface AccountOnboardingState {
  /**
   * Which step is on screen, or null while the server has not said.
   *
   * NULL IS "NOT HYDRATED", and it is what stops the flow flashing step 1 for one frame on every
   * launch before the session lands. It becomes a number exactly once per session, from
   * `user.onboardingStep`.
   */
  step: OnboardingStepNumber | null;
  /** §5.1's "Skip setup". This window only; see the header. */
  skipped: boolean;
  /** Whether the workspace step has already produced a workspace, so a resume does not re-create. */
  workspaceNamed: boolean;
  /**
   * Whether step 4 actually started an agent, as opposed to being skipped past.
   *
   * THE LAST SCREEN IS WHAT THIS IS FOR. Its three suggestions — run it, read its graph, ask for a
   * change — are all about an agent, and step 4 has a Skip beside it, so the screen was congratulating
   * people and then telling them to run something that does not exist. `advance()` is called on both
   * paths and cannot tell them apart afterwards; this is the difference, recorded where it happens.
   *
   * LOCAL TO THIS WINDOW, like `skipped` and for the same reason: it is a fact about this pass through
   * the flow, not about the account. A resume that lands straight on step 5 reads false here, which is
   * why `ReadyStep` also asks the agent list — this is the answer for the case the list cannot give,
   * which is a generation still in flight.
   */
  agentStarted: boolean;

  /** Read the resume point off a freshly-landed session. Idempotent per session. */
  hydrate: (step: number) => void;
  /** Move forward and tell the server. §9.3: a SKIP advances, an interruption never gets here. */
  advance: () => void;
  /** Move back. Never writes: §5.3 says a step already reached is not un-reached by looking at it. */
  back: () => void;
  /** §5.1's "Skip setup" — into the app, with the banner. */
  skip: () => void;
  /** The banner's button. Back into the flow, wherever they were. */
  resume: () => void;
  /** §5's last screen. Marks the account onboarded and lets the app render. */
  finish: () => void;
  /** §5.4's restart-from-settings. Clears the flag server-side and reopens at step 1. */
  restart: () => Promise<void>;
  markWorkspaceNamed: () => void;
  /** Step 4 dispatched a sample selection or a plan. See `agentStarted`. */
  markAgentStarted: () => void;
}

export const useAccountOnboardingStore = create<AccountOnboardingState>((set, get) => ({
  step: null,
  skipped: false,
  workspaceNamed: false,
  agentStarted: false,

  hydrate: (step) =>
    set((s) => {
      // ONLY THE FIRST TIME. A session refresh mid-flow — a token renewal, a reconnect — carries
      // the step the server last heard about, which may be BEHIND where the person actually is
      // because the write is fire-and-forget. Re-reading it would walk them backwards.
      if (s.step !== null) return {};
      const clamped = Math.min(Math.max(Math.floor(step), FIRST_STEP), LAST_STEP) as OnboardingStepNumber;
      return {
        step: clamped,
        // §5.3: "Steps already completed are not re-done. Workspace already created → step 2 is
        // skipped on resume." Anybody resuming past step 2 has already named one.
        workspaceNamed: clamped > 2,
      };
    }),

  advance: () => {
    const at = get().step ?? FIRST_STEP;
    const to = nextStep(at);
    set({ step: to });
    // Not awaited. See the header: the person is already looking at the next screen.
    void advanceOnboarding(to);
  },

  back: () => set((s) => ({ step: previousStep(s.step ?? FIRST_STEP) })),

  skip: () => set({ skipped: true }),
  resume: () => set({ skipped: false }),

  finish: () => {
    set({ step: LAST_STEP, skipped: false });
    // OPTIMISTIC ON THE FLAG TOO, and this one has a real consequence if it fails: the person lands
    // in the app now and meets the flow again on their next launch. That is the right way round —
    // the alternative is a spinner on the last button of an onboarding, and a failed write that
    // shows the tour once more is recoverable in a way one that marked somebody done is not.
    const user = useSessionStore.getState().user;
    if (user) useSessionStore.getState().setUser({ ...user, onboarded: true });
    void completeOnboarding();
  },

  restart: async () => {
    await restartOnboarding();
    const user = useSessionStore.getState().user;
    if (user) useSessionStore.getState().setUser({ ...user, onboarded: false, onboardingStep: FIRST_STEP });
    // AWAITED, unlike every other write here, because the caller is a settings screen with a button
    // on it and the person is watching that button. It also has to land before the local step moves,
    // or a failure would put somebody into a flow the server still thinks they finished.
    set({ step: FIRST_STEP, skipped: false, workspaceNamed: false, agentStarted: false });
  },

  markWorkspaceNamed: () => set({ workspaceNamed: true }),
  markAgentStarted: () => set({ agentStarted: true }),
}));

/**
 * Whether the five screens should be on screen right now.
 *
 * IN ONE PLACE, so two readers cannot answer differently — the same reason `firstRunOnScreen`
 * exists. Four conditions:
 *
 *   there is a session          — every screen below reads the signed-in user's name
 *   the server says not yet     — `onboarded_at`, which is the only authority on this
 *   they have not skipped       — §5.1, and the banner is what makes that recoverable
 *   the step has hydrated       — so nothing flashes step 1 before the session lands
 */
export function accountOnboardingOnScreen(state: {
  step: OnboardingStepNumber | null;
  skipped: boolean;
}): boolean {
  const user = useSessionStore.getState().user;
  return user !== null && !user.onboarded && !state.skipped && state.step !== null;
}
