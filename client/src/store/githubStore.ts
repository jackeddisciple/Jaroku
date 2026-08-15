// GitHub state, mirrored from the server.
//
// Modelled on deployStore: the server owns every fact here and the client only reflects it, so
// every `state` message REPLACES rather than merges. `loaded` matters for the same reason it does
// there — before the first snapshot lands, "not connected" and "we have not been told yet" look
// identical, and the tab would show §2.1's connect screen to somebody whose agent is linked.
//
// ONE SNAPSHOT PER AGENT, KEYED. The panel shows one agent at a time, but the SIDEBAR shows the
// Synced filter across all of them and the tab badge has to be right the instant somebody switches
// agents — so views are held per agent id rather than as a single "current" object that would go
// briefly wrong on every selection change.
//
// WHAT THIS STORE DOES NOT HOLD: a token, obviously, but also any DERIVED sync state. The verdict,
// the badge and the counts all arrive computed. Recomputing them here would be a second
// implementation of `githubSync.ts` in a language with different null semantics, and the day the
// two disagree the user is looking at the one that is wrong.

import { create } from "zustand";
import type {
  GithubLinkRow, GithubRefusal, GithubRepoRow, GithubView,
} from "../types.ts";

/** A push or pull in flight, as §2.4's rail renders it. */
export interface GithubProgress {
  op: "push" | "pull";
  /** Stage id -> how it went. Absent means not started, which the rail draws as a hollow dot. */
  stages: Record<string, "active" | "done" | "error">;
  /** Which stage is live, for the header line. Null once everything has settled. */
  current: string | null;
  startedAt: number;
}

/**
 * Which of §1's four regions are folded away, per agent.
 *
 * PER AGENT, NOT PER PANEL, and in localStorage rather than in memory — §A.5. Somebody who
 * collapses History because they only care about pushing today should not have to re-collapse it
 * on every visit, and the agent they were pushing has nothing to do with the one they open next.
 *
 * KEYED BY WORKSPACE AS WELL, for the reason `uiStore.inputKey` is: agent slugs stopped being
 * globally unique in Session 1 and are unique PER workspace, so `jaroku.github.regions.weather`
 * names two different agents belonging to two different tenants. This holds nothing but four
 * booleans — no leak, and no reason to make the key wrong anyway.
 *
 * NOT IN THE STORE'S RESET LIST BY ACCIDENT: it IS reset with the store, and that is harmless —
 * localStorage is re-read on the next render, which is exactly the behaviour a per-agent
 * preference should have.
 */
export type RegionId = "header" | "sync" | "changes" | "history";

const REGION_KEY_PREFIX = "jaroku.github.regions.";

/** The default: everything open. A panel that opens folded hides the answer somebody came for. */
const ALL_OPEN: Record<RegionId, boolean> = { header: true, sync: true, changes: true, history: true };

function regionKey(workspaceId: string | null, agentId: string): string {
  return `${REGION_KEY_PREFIX}${workspaceId ?? "_"}.${agentId}`;
}

export function readRegions(workspaceId: string | null, agentId: string): Record<RegionId, boolean> {
  try {
    const raw = localStorage.getItem(regionKey(workspaceId, agentId));
    if (!raw) return ALL_OPEN;
    const parsed = JSON.parse(raw) as Partial<Record<RegionId, boolean>>;
    // FIELD BY FIELD, because this is user-editable storage that survives across versions: a blob
    // written by an older build must degrade to the default rather than put `undefined` where the
    // panel expects a boolean and render a region that is neither open nor closed.
    return {
      header: parsed.header !== false,
      sync: parsed.sync !== false,
      changes: parsed.changes !== false,
      history: parsed.history !== false,
    };
  } catch {
    // Storage can be unavailable (private mode, a locked-down browser). Everything open is a far
    // better failure than a panel that will not render.
    return ALL_OPEN;
  }
}

export function writeRegions(
  workspaceId: string | null,
  agentId: string,
  regions: Record<RegionId, boolean>,
): void {
  try {
    localStorage.setItem(regionKey(workspaceId, agentId), JSON.stringify(regions));
  } catch {
    /* see readRegions — an unwritable store must not break the panel in front of somebody */
  }
}

interface GithubState {
  /** See deployStore.loaded — distinguishes "not connected" from "not told yet". */
  loaded: boolean;
  connected: boolean;
  accountLogin: string | null;
  /** Every live link in the workspace, for the sidebar's Synced filter. */
  links: GithubLinkRow[];
  /** agent slug -> its whole reconciliation. */
  views: Record<string, GithubView>;
  /** agent slug -> what is happening to it right now. */
  progress: Record<string, GithubProgress>;
  /** agent slug -> the pull the validator turned away. Cleared by the next attempt. */
  refusals: Record<string, GithubRefusal>;
  /** §2.2's existing-repo search results. */
  repos: GithubRepoRow[];
  reposLoading: boolean;
  /** §2.2's live availability check, for the name currently in the field. */
  nameCheck: { name: string; available: boolean } | null;
  /**
   * agent slug -> a commit message the model just wrote, waiting to be adopted.
   *
   * A ONE-SHOT INTENT, cleared by whoever consumes it, for the reason `uiStore.secretsAddProvider`
   * is: it describes something that HAPPENED rather than a preference. Left set, it would re-fill
   * the box every time somebody came back to the tab, over whatever they had since typed.
   */
  generated: Record<string, string>;
  generating: Record<string, boolean>;
  error: string | null;
  notice: string | null;

  applyState: (msg: {
    agentId: string | null;
    connected: boolean;
    accountLogin: string | null;
    links: GithubLinkRow[];
    view: GithubView | null;
  }) => void;
  setRepos: (repos: GithubRepoRow[]) => void;
  startRepos: () => void;
  setNameCheck: (name: string, available: boolean) => void;
  startGenerating: (agentId: string) => void;
  setGenerated: (agentId: string, message: string) => void;
  clearGenerated: (agentId: string) => void;
  applyStage: (
    agentId: string,
    op: "push" | "pull",
    stage: string,
    status: "active" | "done" | "error",
  ) => void;
  setRefusal: (refusal: GithubRefusal) => void;
  clearRefusal: (agentId: string) => void;
  setError: (error: string | null) => void;
  setNotice: (notice: string | null) => void;
}

export const useGithubStore = create<GithubState>((set) => ({
  loaded: false,
  connected: false,
  accountLogin: null,
  links: [],
  views: {},
  progress: {},
  refusals: {},
  repos: [],
  reposLoading: false,
  nameCheck: null,
  generated: {},
  generating: {},
  error: null,
  notice: null,

  /**
   * A snapshot settles everything an in-flight request could still be waiting on.
   *
   * THE PROGRESS ENTRY IS CLEARED FOR THE AGENT THE SNAPSHOT IS ABOUT, and only for that one. A
   * snapshot arrives after a push finishes, so leaving the rail up would strand it at its last
   * stage forever; clearing every agent's would wipe the rail of a second agent pushing in another
   * tab. Same reasoning as deployStore clearing `planning` and `testing` wholesale — with the
   * scope narrowed to what the message actually reports on.
   */
  applyState: (msg) =>
    set((s) => {
      const views = { ...s.views };
      if (msg.agentId && msg.view) views[msg.agentId] = msg.view;
      // A snapshot naming an agent with no view means it is UNLINKED, which is a fact and not an
      // absence. Deleting the entry is what makes the panel fall back to §2.2's picker rather than
      // keep rendering the link that was just removed.
      else if (msg.agentId) delete views[msg.agentId];
      const progress = { ...s.progress };
      if (msg.agentId) delete progress[msg.agentId];
      return {
        loaded: true,
        connected: msg.connected,
        accountLogin: msg.accountLogin,
        links: msg.links,
        views,
        progress,
      };
    }),

  startRepos: () => set({ reposLoading: true }),
  setRepos: (repos) => set({ repos, reposLoading: false }),
  setNameCheck: (name, available) => set({ nameCheck: { name, available } }),

  startGenerating: (agentId) => set((s) => ({ generating: { ...s.generating, [agentId]: true } })),
  setGenerated: (agentId, message) =>
    set((s) => ({
      generated: { ...s.generated, [agentId]: message },
      generating: withoutKey(s.generating, agentId),
    })),
  clearGenerated: (agentId) =>
    set((s) => ({
      generated: withoutKey(s.generated, agentId),
      generating: withoutKey(s.generating, agentId),
    })),

  /**
   * One phase transition.
   *
   * MERGED RATHER THAN REPLACED, because the rail's whole job is to show what has already happened
   * next to what is happening now — a stage map that only held the current stage would be a
   * spinner with a caption.
   *
   * A NEW OPERATION RESETS THE MAP. Pushing, failing, and pushing again must not show the first
   * attempt's completed stages under the second attempt's live one, which would read as progress
   * that never happened.
   */
  applyStage: (agentId, op, stage, status) =>
    set((s) => {
      const existing = s.progress[agentId];
      const fresh = !existing || existing.op !== op;
      const base: GithubProgress = fresh
        ? { op, stages: {}, current: null, startedAt: Date.now() }
        : existing;
      return {
        progress: {
          ...s.progress,
          [agentId]: {
            ...base,
            stages: { ...base.stages, [stage]: status },
            current: status === "active" ? stage : base.current === stage ? null : base.current,
          },
        },
        // A stage that started is an attempt that supersedes the last refusal. Leaving the old
        // card up beside a live rail would have the panel refusing and working at the same time.
        refusals: status === "active" ? withoutKey(s.refusals, agentId) : s.refusals,
      };
    }),

  setRefusal: (refusal) =>
    set((s) => ({ refusals: { ...s.refusals, [refusal.agentId]: refusal } })),
  clearRefusal: (agentId) => set((s) => ({ refusals: withoutKey(s.refusals, agentId) })),

  // An error ends anything it could describe, for the same reason a snapshot does — a generate
  // that failed must not leave its button spinning.
  setError: (error) => set({ error, reposLoading: false, generating: {} }),
  setNotice: (notice) => set({ notice }),
}));

function withoutKey<T>(record: Record<string, T>, key: string): Record<string, T> {
  if (!(key in record)) return record;
  const next = { ...record };
  delete next[key];
  return next;
}

// --- selectors (pure module functions, never re-derived per component) ---

/**
 * The badge for the tab label, or null.
 *
 * READ OFF THE VIEW rather than computed. `githubSync.badgeFor` already decided this on the server,
 * where the numbers come from, and a second implementation here would be a second opinion about
 * what ↕ means — in a language where `null` and `0` are easier to confuse than in the one that
 * produced them.
 */
export function badgeFor(views: Record<string, GithubView>, agentId: string | null): string | null {
  if (!agentId) return null;
  return views[agentId]?.badge ?? null;
}

/** Whether an agent is linked at all. What §2.1 vs §2.3 turns on. */
export function viewFor(views: Record<string, GithubView>, agentId: string | null): GithubView | null {
  return agentId ? (views[agentId] ?? null) : null;
}

/** Agents with a live link, by uuid-free slug. What the sidebar's Synced filter counts. */
export function syncedAgentIds(links: GithubLinkRow[]): Set<string> {
  return new Set(links.map((l) => l.agent_id));
}
