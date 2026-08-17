// UI intent store — the small amount of cross-component UI state the command palette and
// keyboard shortcuts need to reach (which right-tab is showing, focusing the chat, and the
// run provider/model so the palette can run or switch provider). Kept separate from the trace
// and build stores, which own real data; this is ephemeral view state only.

import { create } from "zustand";
import { useSessionStore } from "./sessionStore.ts";
import { defaultModelFor, useProviderStore } from "./providerStore.ts";
import type { GithubAttachment } from "../types.ts";

/**
 * The sidebar's four top-level destinations (§2).
 *
 * All four are named now even though only Threads is built here, because the shell is generic on
 * purpose: the other three are specified separately and plug into the same mechanism. Naming them in
 * the type rather than adding them later is what makes "the shell is generic" checkable — a
 * destination the shell cannot render is a compile error, not a blank screen.
 */
export type NavDestination = "threads" | "agents" | "memory" | "activity";

/**
 * Which part of the workspace panel is showing, or null for closed.
 *
 * A SECTION RATHER THAN A BOOLEAN, because every section has a second door: Members is opened from
 * the workspace switcher, and the sections beside it are opened from the surfaces that name the
 * thing they change. A boolean would open the panel and leave the caller's actual intent to be
 * re-navigated by hand.
 */
export type WorkspaceSection = "members" | "audit" | "data";

export type RightTab =
  | "secrets"
  | "github"
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

// --- pinned agents (§2, §4.7's P) -----------------------------------------------------------
//
// The sidebar holds pinned agents above the active ones, and `P` on a selected thread pins or unpins
// THAT THREAD'S AGENT — so pinning is a fact about an agent, and a fact one person holds rather than
// the workspace. Two people sharing a Team workspace pin different things for different reasons, and a
// shared pin list would be one of them rearranging the other's sidebar.
//
// SO IT IS `localStorage`, NOT A TABLE AND NOT A CHANNEL. It is a per-person view preference about
// which rows sit at the top of one column: nothing else reads it, nothing depends on it being durable
// across machines, and a round trip per pin would be a round trip for a bookmark.
//
// KEYED BY WORKSPACE, for the reason `inputKey` is: agent slugs are unique per workspace, not
// globally, so one key per workspace is what stops a `support_bot` pinned in one appearing pinned in
// another. Read at call time so every call site is scoped by construction.
export const PINNED_KEY_PREFIX = "jaroku.pinned.";

const pinnedKey = (): string => `${PINNED_KEY_PREFIX}${useSessionStore.getState().workspaceId ?? "_"}`;

function readPinned(): string[] {
  try {
    const raw = localStorage.getItem(pinnedKey());
    if (!raw) return [];
    const parsed = JSON.parse(raw) as unknown;
    return Array.isArray(parsed) ? parsed.filter((v): v is string => typeof v === "string") : [];
  } catch {
    // Storage can be unavailable (private mode, a locked-down browser). No pins is a perfectly good
    // sidebar; refusing to render one would not be.
    return [];
  }
}

function writePinned(slugs: string[]): void {
  try {
    localStorage.setItem(pinnedKey(), JSON.stringify(slugs));
  } catch {
    /* see readPinned — an unwritable store must not break the column it decorates */
  }
}

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

// `provider` is gone: pasting an API key is no longer a wall in front of the product. Credentials
// live in one place now — the Secrets tab — and onboarding goes welcome → prompt → run.
export type OnboardingStep = "welcome" | "prompt" | "run";

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
      // A BROWSER STOPPED ON THE REMOVED STEP LANDS ON `prompt`, NOT `welcome`. This is
      // user-editable storage that survives across versions, and somebody who was midway through
      // the old flow has already seen the welcome screen — sending them back to it would be the
      // one thing `users.onboarded_at` exists to stop. `prompt` is where the provider step used
      // to hand off to, so they resume exactly where they would have.
      step:
        parsed.step === "prompt" || parsed.step === "run"
          ? parsed.step
          : (parsed.step as string) === "provider"
            ? "prompt"
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

// THE SELECTABLE CATALOGUE USED TO BE HERE, as a hardcoded array, and it was the source for every
// model selector in the product: the composer's run picker, the palette's provider switch, the eval
// target matrix and the deploy configuration. It had drifted four models behind
// `runtime/pricing.json` — whose own header calls itself the single source of truth and warns about
// exactly this — so `claude-opus-5`, the newest priced model, could not be selected for a run, added
// as an eval leg, or deployed with, and nothing anywhere failed.
//
// It comes from the server now, off the same price sheet the estimator and the Python interceptor
// read: see `providerStore.runProviders`. What is left here is which provider and model THIS TAB has
// chosen, which is view state and belongs in this store.

interface UiState {
  paletteOpen: boolean;
  setPaletteOpen: (v: boolean) => void;

  /**
   * Which full-screen destination is showing, or null for the ordinary three panes (§2).
   *
   * ONE NULLABLE FIELD IS THE WHOLE MECHANISM, and the deliberate omissions are why it stays one
   * field. There is no Escape-to-close, no back button, no breadcrumb and no "last active" fallback
   * to remember — the sidebar is the single source of navigation and is already displaying what you
   * would fall back to, so the app never has to store an answer to "where was I". That is the Claude
   * desktop model, and it removes an entire category of state management rather than hiding it.
   *
   * IT LIVES IN `uiStore` BECAUSE IT IS VIEW STATE, which is also why it survives a workspace switch:
   * §6 says switching keeps the user on the Threads tab and re-fetches for the new scope. A store
   * that was reset would drop them back into a conversation belonging to the workspace they just
   * left.
   */
  navView: NavDestination | null;
  openNav: (destination: NavDestination) => void;
  closeNav: () => void;

  /**
   * Agent slugs this person has pinned, in the order they pinned them (§2's PINNED section).
   *
   * In the store as well as in `localStorage` because the sidebar re-renders from it; storage is where
   * it survives a reload, and this is what a component subscribes to.
   */
  pinnedAgents: string[];
  /** Re-read the pins for the workspace this tab is in. Called when the session lands. */
  loadPinnedAgents: () => void;
  /** §4.7's `P`, on the selected thread's agent. */
  togglePinnedAgent: (agentId: string) => void;

  // The right panel's active tab, lifted here so the palette / shortcuts can switch it while
  // RightPanel's own auto-follow (generation → code, new run → trace) still writes the same field.
  rightTab: RightTab;
  setRightTab: (t: RightTab) => void;

  /**
   * Which provider the Secrets tab should open its add form for, when it was reached from a dead
   * end rather than from the tab bar.
   *
   * §5.2: `+ Add a provider key…` opens the Secrets tab "with the add dialog pre-opened for that
   * provider". Switching the tab was the whole of what happened, so somebody who clicked out of a
   * disabled model arrived at a list and had to work out for themselves that the next step was
   * Add, then which UPPER_SNAKE_CASE name the provider wanted.
   *
   * A one-shot intent rather than persistent state, cleared by whoever consumes it: it describes a
   * navigation that has happened, not a preference. Left set, the add form would reopen every time
   * somebody came back to the tab.
   */
  secretsAddProvider: string | null;
  openSecretsForProvider: (providerId: string | null) => void;
  clearSecretsAddProvider: () => void;

  /**
   * Open the GitHub tab WITH ITS BRANCH SWITCHER SHOWING — §A.7.
   *
   * A nonce rather than a boolean, and a one-shot intent rather than persistent state, for exactly
   * the reasons `secretsAddProvider` is both: it describes a navigation that has happened, not a
   * preference, and left set it would re-open the switcher every time somebody came back to the
   * tab. A nonce because clicking the chip twice is two requests and a boolean would fire an
   * effect only for the first.
   *
   * It exists at all because the chip's click implies a specific action. Switching the tab was the
   * whole of what a naive version would do, and somebody who clicked the thing naming their branch
   * would arrive at a panel and have to find the branch control themselves.
   */
  githubBranchNonce: number;
  openGithubBranches: () => void;

  /**
   * §B.5.1's Fix in Jaroku, as a request rather than a call.
   *
   * A ONE-SHOT INTENT, exactly like `secretsAddProvider`, and for a structural reason: the
   * attachment list is local state inside `useGithubAttachments`, which lives in the composer's
   * column — and the button that wants to add to it lives in the GitHub panel, on the other side of
   * the app. Lifting the whole attachment list into this store to solve that would put a
   * per-composer working set in global state so that one button could reach it.
   *
   * CLEARED BY WHOEVER CONSUMES IT, because it describes something that HAPPENED. Left set, it
   * would re-attach the same two chips every time somebody came back to the tab, over whatever they
   * had since assembled.
   */
  githubAttachRequest: GithubAttachment[] | null;
  requestGithubAttach: (attachments: GithubAttachment[]) => void;
  clearGithubAttachRequest: () => void;

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

  /**
   * The workspace panel: who is in this workspace, and everything else true of the workspace
   * itself rather than of an agent in it.
   *
   * Null is closed. It is view state and therefore here, and it deliberately survives nothing:
   * unlike `navView`, a workspace switch should not leave a members list from the workspace you
   * have just left on screen — the store behind it is reset, so the panel would render an empty
   * one. `switchWorkspace` closes it.
   */
  workspaceSection: WorkspaceSection | null;
  openWorkspacePanel: (section: WorkspaceSection) => void;
  closeWorkspacePanel: () => void;

  /**
   * What happened to the invitation this tab was opened with, if it was opened with one.
   *
   * HERE RATHER THAN IN `memberStore`, and the reason is the one thing it has to survive: accepting
   * an invitation switches workspace, and a switch empties every workspace store. The notice would
   * be destroyed by the navigation it is reporting on. It is also not a fact about a workspace's
   * membership — it is a fact about this browser's arrival — which is what this store is for.
   *
   * Nullable and dismissible rather than timed: "you have joined Acme as an admin" is worth
   * keeping on screen until it has been read, and a failure ("that invitation has expired") is the
   * only explanation the person will ever get for a link that did nothing.
   */
  inviteNotice: { ok: boolean; message: string } | null;
  setInviteNotice: (notice: { ok: boolean; message: string } | null) => void;

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

  navView: null,
  openNav: (navView) => set({ navView }),
  // Called by the sidebar's own selections as well as by picking a row inside a view: selecting IS
  // the transition (§2), so there is nothing here that asks first and nothing that remembers where
  // it came from.
  closeNav: () => set({ navView: null }),

  // Empty at module load, for the reason onboarding progress is: there is no session yet, so there is
  // no workspace to read the pins OF. `loadPinnedAgents` runs once one lands.
  pinnedAgents: [],
  loadPinnedAgents: () => set({ pinnedAgents: readPinned() }),
  togglePinnedAgent: (agentId) =>
    set((s) => {
      const pinnedAgents = s.pinnedAgents.includes(agentId)
        ? s.pinnedAgents.filter((a) => a !== agentId)
        : [...s.pinnedAgents, agentId];
      writePinned(pinnedAgents);
      return { pinnedAgents };
    }),

  rightTab: "trace",
  setRightTab: (rightTab) => set({ rightTab }),

  secretsAddProvider: null,
  // Both fields in one call, so the tab and the reason for being there can never be set apart.
  openSecretsForProvider: (secretsAddProvider) => set({ rightTab: "secrets", secretsAddProvider }),
  clearSecretsAddProvider: () => set({ secretsAddProvider: null }),

  githubBranchNonce: 0,
  // Both fields in one call, so the tab and the reason for being there can never be set apart.
  openGithubBranches: () => set((s) => ({ rightTab: "github", githubBranchNonce: s.githubBranchNonce + 1 })),

  githubAttachRequest: null,
  // The chips and the focus in one call, for the reason above: attaching without moving somebody to
  // the composer would leave two chips in a box they cannot see.
  requestGithubAttach: (githubAttachRequest) =>
    set((s) => ({ githubAttachRequest, focusChatNonce: s.focusChatNonce + 1 })),
  clearGithubAttachRequest: () => set({ githubAttachRequest: null }),

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
  // The provider's first model in the catalogue, read at call time rather than captured: the
  // catalogue arrives on the providers snapshot, so a module-level copy would be empty on the one
  // render that matters — the first — and a default chosen from it would be blank forever after.
  setProvider: (id) =>
    set({
      provider: id,
      model: defaultModelFor(useProviderStore.getState().models, id),
    }),
  setModel: (model) => set({ model }),

  codeOverlayOpen: false,
  setCodeOverlay: (codeOverlayOpen) => set({ codeOverlayOpen }),

  providerPanelOpen: false,
  setProviderPanel: (providerPanelOpen) => set({ providerPanelOpen }),

  workspaceSection: null,
  // The provider popover is closed on the way in: both are overlays anchored to the top bar's
  // right-hand group, and two of them open at once is one covering the other.
  openWorkspacePanel: (workspaceSection) => set({ workspaceSection, providerPanelOpen: false }),
  closeWorkspacePanel: () => set({ workspaceSection: null }),

  inviteNotice: null,
  setInviteNotice: (inviteNotice) => set({ inviteNotice }),

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
