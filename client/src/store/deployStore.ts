// Deploy state, mirrored from the server.
//
// Modelled on providerStore: the server owns every fact here and the client only reflects it,
// so every `deployments` message REPLACES rather than merges. `loaded` matters for the same
// reason it does there — before the first snapshot lands, "nothing is deployed" and "we have
// not been told yet" look identical, and the sidebar would show an empty Deployed tab to
// someone who has a live agent.
//
// The log is modelled on buildStore's streaming files instead: a keyed record plus an
// arrival-order array, because a build log is a log and not a sorted list. It is capped, the
// way traceStore caps its own — a container that installs its dependencies noisily should not
// be able to grow a tab's memory without bound.
//
// Nothing on this store ever holds a credential, with one deliberate exception: `serveToken`,
// which the server sends exactly once because it keeps no copy. It lives in memory for as
// long as the user has the panel open, is never written to localStorage, and is cleared with
// the rest of the state on a fresh snapshot.

import { create } from "zustand";
import type {
  Deployment, DeployLogLine, DeploySecretStatus, DeployStatus,
} from "../types.ts";
import { isDeployInFlight } from "../types.ts";

/** How many log lines one deployment keeps in memory. Mirrors traceStore's LOG_CAP idea. */
const LOG_CAP = 2000;

export interface DeployPlan {
  agentId: string;
  secrets: DeploySecretStatus[];
  problems: string[];
  warnings: string[];
}

export interface ServeTokenReveal {
  deploymentId: string;
  url: string;
  token: string;
}

interface DeployState {
  deployments: Deployment[];
  /** Whether a Railway token is configured server-side. A boolean, never a value. */
  railwayConfigured: boolean;
  /** See providerStore.loaded — distinguishes "nothing deployed" from "not told yet". */
  loaded: boolean;
  /** The plan for the agent currently in the deploy form, or null. */
  plan: DeployPlan | null;
  planning: boolean;
  /** deploymentId -> log lines, in arrival order. */
  logs: Record<string, DeployLogLine[]>;
  /** deploymentId -> the stage its narrative is on. */
  stage: Record<string, string>;
  /** The one-shot bearer token for a freshly live endpoint. Shown, never stored. */
  serveToken: ServeTokenReveal | null;
  /** Which deployment the panel is looking at. */
  selectedId: string | null;
  testing: boolean;
  testResult: { ok: boolean; message: string | null } | null;
  error: string | null;
  notice: string | null;

  setDeployments: (deployments: Deployment[], railwayConfigured: boolean) => void;
  setPlan: (plan: DeployPlan) => void;
  startPlanning: () => void;
  setStage: (deploymentId: string, stage: string) => void;
  appendLog: (line: DeployLogLine) => void;
  setLogs: (deploymentId: string, lines: DeployLogLine[]) => void;
  setServeToken: (reveal: ServeTokenReveal) => void;
  dismissServeToken: () => void;
  select: (deploymentId: string | null) => void;
  startTest: () => void;
  setTestResult: (result: { ok: boolean; message: string | null }) => void;
  setError: (error: string | null) => void;
  setNotice: (notice: string | null) => void;
}

function appendCapped(existing: DeployLogLine[] | undefined, line: DeployLogLine): DeployLogLine[] {
  const next = existing ? [...existing, line] : [line];
  return next.length > LOG_CAP ? next.slice(next.length - LOG_CAP) : next;
}

export const useDeployStore = create<DeployState>((set) => ({
  deployments: [],
  railwayConfigured: false,
  loaded: false,
  plan: null,
  planning: false,
  logs: {},
  stage: {},
  serveToken: null,
  selectedId: null,
  testing: false,
  testResult: null,
  error: null,
  notice: null,

  // A snapshot settles every question an in-flight request could still be waiting on, so
  // `planning` and `testing` are cleared wholesale rather than by key — a failure nobody
  // anticipated cannot leave a control stuck. Same reasoning as providerStore.setProviders.
  setDeployments: (deployments, railwayConfigured) =>
    set((s) => ({
      deployments,
      railwayConfigured,
      loaded: true,
      planning: false,
      testing: false,
      // Follow the live one, unless the user has deliberately selected something else.
      selectedId:
        s.selectedId && deployments.some((d) => d.id === s.selectedId)
          ? s.selectedId
          : (deployments.find((d) => isDeployInFlight(d.status))?.id ?? deployments[0]?.id ?? null),
    })),

  setPlan: (plan) => set({ plan, planning: false, error: null }),
  startPlanning: () => set({ planning: true, error: null }),

  // "done" is a sentinel meaning the deploy settled, not a phase — the deployment's own
  // status carries that. Recording it would erase which phase was last reached, which is the
  // only thing that says how far a FAILED deploy got.
  setStage: (deploymentId, stage) =>
    set((s) => ({
      stage: stage === "done" ? s.stage : { ...s.stage, [deploymentId]: stage },
      selectedId: deploymentId,
    })),

  appendLog: (line) =>
    set((s) => ({
      logs: { ...s.logs, [line.deployment_id]: appendCapped(s.logs[line.deployment_id], line) },
    })),

  // A backfill replaces rather than merges: it is the server's whole answer for that id, and
  // interleaving it with what arrived live would duplicate the overlap.
  setLogs: (deploymentId, lines) =>
    set((s) => ({ logs: { ...s.logs, [deploymentId]: lines.slice(-LOG_CAP) } })),

  setServeToken: (reveal) => set({ serveToken: reveal }),
  dismissServeToken: () => set({ serveToken: null }),

  select: (deploymentId) => set({ selectedId: deploymentId }),

  startTest: () => set({ testing: true, testResult: null, error: null }),
  setTestResult: (result) => set({ testing: false, testResult: result }),

  // An error ends anything it could describe, for the same reason a snapshot does.
  setError: (error) => set({ error, planning: false, testing: false }),
  setNotice: (notice) => set({ notice }),
}));

// --- selectors (pure module functions, never re-derived per component) ---

export function deploymentFor(deployments: Deployment[], agentId: string): Deployment | null {
  const mine = deployments.filter((d) => d.agent_id === agentId);
  return mine.find((d) => isDeployInFlight(d.status)) ?? mine[0] ?? null;
}

/** The deployment the panel should be showing, resolved from selection then liveness. */
export function selectedDeployment(state: {
  deployments: Deployment[];
  selectedId: string | null;
}): Deployment | null {
  return state.deployments.find((d) => d.id === state.selectedId) ?? null;
}

export function anyInFlight(deployments: Deployment[]): Deployment | null {
  return deployments.find((d) => isDeployInFlight(d.status)) ?? null;
}

/** Agents with something live. What the sidebar's Deployed filter counts. */
export function liveAgentIds(deployments: Deployment[]): Set<string> {
  return new Set(deployments.filter((d) => d.status === "live").map((d) => d.agent_id));
}

export type { Deployment, DeployStatus };
