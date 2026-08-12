// UI intent store — the small amount of cross-component UI state the command palette and
// keyboard shortcuts need to reach (which right-tab is showing, focusing the chat, and the
// run provider/model so the palette can run or switch provider). Kept separate from the trace
// and build stores, which own real data; this is ephemeral view state only.

import { create } from "zustand";
import { useSessionStore } from "./sessionStore.ts";

export type RightTab =
  | "graph" | "trace" | "evals" | "mcp" | "connections" | "deploy" | "usage" | "code";

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
// WHETHER somebody has onboarded is NOT here. It is `sessionStore.user.onboarded`, from the
// server, because it is a fact about a PERSON and this store is a browser. Answered here it
// answered the wrong question — "has this BROWSER seen the app" — so a new account on a used
// machine skipped the flow and inherited whatever step the last person stopped on, while a
// returning user in a private window was welcomed to a product they use daily. See migration
// 013 and `useOnboarding`.
//
// WHAT IS STILL HERE is where somebody is UP TO: which of the four screens, and which one-time
// hints have been shown. That genuinely is view state — it only means anything while an
// onboarding is unfinished, it is worth surviving a reload mid-flow, and it is not worth a
// round trip per step.
//
// KEYED BY USER, for the reason `inputKey` above is keyed by workspace: two accounts share a
// browser, and the second must not resume the first's progress. A key nobody has written yet
// reads as the default, which is exactly right for somebody new.
//
// Both fields share ONE key rather than two, so a half-written state is not representable.

export type OnboardingStep = "welcome" | "provider" | "prompt" | "run";

/** The one-time hints shown so far, by id. A list rather than a boolean per hint, so adding a
 *  second hint later is data rather than another field. */
export type HintId = "trace";

/** The prefix every per-user onboarding record shares. */
export const ONBOARDING_KEY_PREFIX = "jaroku.onboarding.";

const onboardingKey = (userId: string | null): string => `${ONBOARDING_KEY_PREFIX}${userId ?? "_"}`;

interface OnboardingProgress {
  step: OnboardingStep;
  hintsShown: string[];
}

const DEFAULT_PROGRESS: OnboardingProgress = { step: "welcome", hintsShown: [] };

function readProgress(userId: string | null): OnboardingProgress {
  try {
    const raw = localStorage.getItem(onboardingKey(userId));
    if (!raw) return DEFAULT_PROGRESS;
    const parsed = JSON.parse(raw) as Partial<OnboardingProgress>;
    return {
      // Field by field, because this is user-editable storage that survives across versions:
      // a blob written by an older build (or by hand) must degrade to the default rather than
      // put `undefined` where the app expects a step name.
      step: parsed.step === "provider" || parsed.step === "prompt" || parsed.step === "run"
        ? parsed.step
        : "welcome",
      hintsShown: Array.isArray(parsed.hintsShown) ? parsed.hintsShown.filter((h) => typeof h === "string") : [],
    };
  } catch {
    // Storage can be unavailable (private mode, a locked-down browser). Starting the flow at
    // the beginning is a far better failure than the app refusing to start.
    return DEFAULT_PROGRESS;
  }
}

function writeProgress(userId: string | null, state: OnboardingProgress): void {
  try {
    localStorage.setItem(onboardingKey(userId), JSON.stringify(state));
  } catch {
    /* see readProgress — an unwritable store must not break the session in progress */
  }
}

/** Whoever is signed in, or null before the session lands. Read at call time, never captured. */
const currentUserId = (): string | null => useSessionStore.getState().user?.id ?? null;

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

  // First run. WHETHER it is over is `sessionStore.user.onboarded`, not here — see the note
  // above the reader. `onboardingStep` is only consulted while that is false, and exists so a
  // reload mid-flow resumes where the user was rather than starting them over at Welcome.
  onboardingStep: OnboardingStep;
  onboardingHintsShown: string[];
  /** Re-read the signed-in user's progress. Called when the session lands or the user changes. */
  loadOnboarding: () => void;
  setOnboardingStep: (step: OnboardingStep) => void;
  completeOnboarding: () => void;
  markHintShown: (id: HintId) => void;
}

// The default, not a read. At module load there is no session yet, so there is no user to read
// FOR — `loadOnboarding` runs once the session lands. Reading here is what made the previous
// person's progress the starting point for the next one.
const onboarding = DEFAULT_PROGRESS;

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

  onboardingStep: onboarding.step,
  onboardingHintsShown: onboarding.hintsShown,

  loadOnboarding: () => {
    const progress = readProgress(currentUserId());
    set({ onboardingStep: progress.step, onboardingHintsShown: progress.hintsShown });
  },

  // Each setter writes the whole blob back. Cheap (two fields, on a user action), and it means
  // there is no path where memory and storage disagree about which step you are on.
  setOnboardingStep: (step) =>
    set((s) => {
      if (s.onboardingStep === step) return {};
      writeProgress(currentUserId(), { step, hintsShown: s.onboardingHintsShown });
      return { onboardingStep: step };
    }),

  // The step is kept rather than cleared: it costs nothing, and it is the difference between
  // "finished" and "finished, and here is where they came in".
  //
  // The FACT of being finished goes to the session store, which owns it and tells the server.
  // Writing it here as well would be two answers to one question, and the local one would win
  // on the machine where it was written and lose everywhere else.
  completeOnboarding: () => {
    useSessionStore.getState().markOnboarded();
  },

  markHintShown: (id) =>
    set((s) => {
      if (s.onboardingHintsShown.includes(id)) return {};
      const hintsShown = [...s.onboardingHintsShown, id];
      writeProgress(currentUserId(), { step: s.onboardingStep, hintsShown });
      return { onboardingHintsShown: hintsShown };
    }),
}));
