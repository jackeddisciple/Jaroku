// UI intent store — the small amount of cross-component UI state the command palette and
// keyboard shortcuts need to reach (which right-tab is showing, focusing the chat, and the
// run provider/model so the palette can run or switch provider). Kept separate from the trace
// and build stores, which own real data; this is ephemeral view state only.

import { create } from "zustand";
import { useSessionStore } from "./sessionStore.ts";

export type RightTab = "graph" | "trace" | "evals" | "mcp" | "deploy" | "code";

// The single composer has two send modes: "chat" talks to Jaroku (generate/edit/explain/…),
// "test" sends the agent's runtime input (a Run). Lifted here so it survives re-renders and the
// R-rerun / palette paths can read it.
export type ComposerMode = "chat" | "test";

// Test-input persistence (doc §4.7.6): the last input per agent is remembered so R re-runs it
// instantly and the palette's re-run reads it. In localStorage — the single source of truth for
// "the last input sent in Test mode" (no component owns it).
//
// KEYED BY WORKSPACE AS WELL AS AGENT, and that is a tenancy requirement rather than tidiness.
// Agent slugs stopped being globally unique in Session 1 — they are unique PER WORKSPACE — so
// `jaroku.input.support_bot` named two different agents belonging to two different tenants, and
// BuildPane loads it straight into the composer when the agent changes. Two workspaces with a
// same-named agent on one browser meant one tenant's last test input appearing in the other's
// composer, and `R` re-running it. A test input is whatever the user typed to drive the agent: a
// real customer email, a real order id.
//
// It reads the workspace HERE rather than taking it as a parameter, so every call site is
// scoped by construction and one added later cannot forget. `resetWorkspaceStores` cannot help
// with this: localStorage is not a store, which is exactly why `test:reset` could not see it.
export const inputKey = (agentId: string | null): string => {
  const workspaceId = useSessionStore.getState().workspaceId;
  return `jaroku.input.${workspaceId ?? "_"}.${agentId ?? "_"}`;
};

/** The prefix every remembered test input shares, for the sweep on sign-out. */
export const INPUT_KEY_PREFIX = "jaroku.input.";

// --- first-run onboarding ----------------------------------------------------------------
//
// UI-only state, and that is why it lives here rather than anywhere else. Which screen a
// first-run user is on has no correctness requirement the way traceStore's ordering does —
// getting it wrong shows the wrong panel, not a trace that lies — so it belongs in the store
// that owns view intent and nowhere else.
//
// Persisted with raw localStorage under a `jaroku.` key, which is the precedent this file
// already set with `inputKey` above. No persist middleware: the app has no such dependency and
// three fields do not justify introducing one.
//
// All three share ONE key rather than three, so a half-written onboarding state is not
// representable — you cannot end up "complete but on step 2" because the parts were written
// separately.

export type OnboardingStep = "welcome" | "provider" | "prompt" | "run";

/** The one-time hints shown so far, by id. A list rather than a boolean per hint, so adding a
 *  second hint later is data rather than another field. */
export type HintId = "trace";

const ONBOARDING_KEY = "jaroku.onboarding";

interface OnboardingState {
  complete: boolean;
  step: OnboardingStep;
  hintsShown: string[];
}

const DEFAULT_ONBOARDING: OnboardingState = { complete: false, step: "welcome", hintsShown: [] };

function readOnboarding(): OnboardingState {
  try {
    const raw = localStorage.getItem(ONBOARDING_KEY);
    if (!raw) return DEFAULT_ONBOARDING;
    const parsed = JSON.parse(raw) as Partial<OnboardingState>;
    return {
      // Field by field, because this is user-editable storage that survives across versions:
      // a blob written by an older build (or by hand) must degrade to the default rather than
      // put `undefined` where the app expects a step name.
      complete: parsed.complete === true,
      step: parsed.step === "provider" || parsed.step === "prompt" || parsed.step === "run"
        ? parsed.step
        : "welcome",
      hintsShown: Array.isArray(parsed.hintsShown) ? parsed.hintsShown.filter((h) => typeof h === "string") : [],
    };
  } catch {
    // Storage can be unavailable (private mode, a locked-down browser). Onboarding showing
    // again is a far better failure than the app refusing to start.
    return DEFAULT_ONBOARDING;
  }
}

function writeOnboarding(state: OnboardingState): void {
  try {
    localStorage.setItem(ONBOARDING_KEY, JSON.stringify(state));
  } catch {
    /* see readOnboarding — an unwritable store must not break the session in progress */
  }
}

/** Whether anything has been recorded yet, i.e. this browser has never seen the app. */
export function hasOnboardingRecord(): boolean {
  try {
    return localStorage.getItem(ONBOARDING_KEY) !== null;
  } catch {
    return false;
  }
}

export const RUN_PROVIDERS = [
  { id: "fake", label: "Dry run (free)", models: ["fake-dry-run"] },
  { id: "anthropic", label: "Claude", models: ["claude-haiku-4-5", "claude-sonnet-5", "claude-opus-4-8"] },
  { id: "openai", label: "OpenAI", models: ["gpt-4o-mini", "gpt-4o"] },
] as const;

interface UiState {
  paletteOpen: boolean;
  setPaletteOpen: (v: boolean) => void;

  // The right panel's active tab, lifted here so the palette / shortcuts can switch it while
  // RightPanel's own auto-follow (generation → code, new run → trace) still writes the same field.
  rightTab: RightTab;
  setRightTab: (t: RightTab) => void;

  // Bumped to ask the chat composer to take focus (Cmd+/). A nonce, not a boolean, so repeated
  // requests always fire an effect.
  focusChatNonce: number;
  focusChat: () => void;

  // One-Click Fix: pre-fill the composer with error + code context, then let the user send it
  // through the normal edit/fix loop. The nonce fires the effect even for identical text.
  chatPrefill: string;
  chatPrefillNonce: number;
  prefillChat: (text: string) => void;

  // Which send mode the single composer is in.
  composerMode: ComposerMode;
  setComposerMode: (m: ComposerMode) => void;

  // Unified composer context: the graph node the user last clicked (trace-step selection already
  // lives globally in traceStore). Lifted here so the one composer can route "explain this" to the
  // selected node. Cleared on a pane click or when a trace step becomes the active context.
  selectedNodeId: string | null;
  setSelectedNodeId: (id: string | null) => void;

  // Run config, lifted from RunTrigger so the palette can run and switch provider.
  provider: string;
  model: string;
  setProvider: (id: string) => void;
  setModel: (m: string) => void;

  // Code is an on-demand overlay (doc §4.1), not a permanent tab — opened from a diff-card
  // file row or Cmd+P, dismissed with Escape / close.
  codeOverlayOpen: boolean;
  setCodeOverlay: (v: boolean) => void;

  // The provider-keys panel: where a key is added after onboarding. Lifted here because it has
  // two openers — the provider chip in the top bar, which is where the current provider is
  // named, and Settings in the sidebar, which is where a first-run user was told to look. One
  // panel, two doors; a second copy of it would be a second set of promises about the key.
  providerPanelOpen: boolean;
  setProviderPanel: (v: boolean) => void;

  // First run. `onboardingComplete` is the single gate App reads; `onboardingStep` is only
  // consulted while it is false, and exists so a reload mid-flow resumes where the user was
  // rather than starting them over at Welcome.
  onboardingComplete: boolean;
  onboardingStep: OnboardingStep;
  onboardingHintsShown: string[];
  setOnboardingStep: (step: OnboardingStep) => void;
  completeOnboarding: () => void;
  markHintShown: (id: HintId) => void;
}

const onboarding = readOnboarding();

export const useUiStore = create<UiState>((set) => ({
  paletteOpen: false,
  setPaletteOpen: (paletteOpen) => set({ paletteOpen }),

  rightTab: "trace",
  setRightTab: (rightTab) => set({ rightTab }),

  focusChatNonce: 0,
  focusChat: () => set((s) => ({ focusChatNonce: s.focusChatNonce + 1 })),

  chatPrefill: "",
  chatPrefillNonce: 0,
  prefillChat: (text) => set((s) => ({ chatPrefill: text, chatPrefillNonce: s.chatPrefillNonce + 1 })),

  composerMode: "chat",
  setComposerMode: (composerMode) => set({ composerMode }),

  selectedNodeId: null,
  setSelectedNodeId: (selectedNodeId) => set({ selectedNodeId }),

  provider: "fake",
  model: "fake-dry-run",
  setProvider: (id) =>
    set({
      provider: id,
      model: RUN_PROVIDERS.find((p) => p.id === id)?.models[0] ?? "",
    }),
  setModel: (model) => set({ model }),

  codeOverlayOpen: false,
  setCodeOverlay: (codeOverlayOpen) => set({ codeOverlayOpen }),

  providerPanelOpen: false,
  setProviderPanel: (providerPanelOpen) => set({ providerPanelOpen }),

  onboardingComplete: onboarding.complete,
  onboardingStep: onboarding.step,
  onboardingHintsShown: onboarding.hintsShown,

  // Each setter writes the whole blob back. Cheap (three fields, on a user action), and it
  // means there is no path where memory and storage disagree about which step you are on.
  setOnboardingStep: (step) =>
    set((s) => {
      if (s.onboardingComplete || s.onboardingStep === step) return {};
      writeOnboarding({ complete: false, step, hintsShown: s.onboardingHintsShown });
      return { onboardingStep: step };
    }),

  completeOnboarding: () =>
    set((s) => {
      if (s.onboardingComplete) return {};
      // The step is kept rather than cleared. It costs nothing and it is the difference
      // between "finished" and "finished, and here is where they came in" if this ever needs
      // to be looked at.
      writeOnboarding({ complete: true, step: s.onboardingStep, hintsShown: s.onboardingHintsShown });
      return { onboardingComplete: true };
    }),

  markHintShown: (id) =>
    set((s) => {
      if (s.onboardingHintsShown.includes(id)) return {};
      const hintsShown = [...s.onboardingHintsShown, id];
      writeOnboarding({ complete: s.onboardingComplete, step: s.onboardingStep, hintsShown });
      return { onboardingHintsShown: hintsShown };
    }),
}));
