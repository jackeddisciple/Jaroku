// Who may do what to each agent, cached per agent, and emptied when any of it might have moved.
//
// THIS STORE IS A CACHE AND NOTHING IT HOLDS IS A DECISION. `useCapability(cap, agentId)` reads the
// grant out of here, intersects it with the role's ceiling from `capabilities.ts`, and answers what
// to RENDER. The server resolves every command again against the same matrix, so a stale entry here
// costs a button that should not have been drawn — never an authorisation.
//
// PER AGENT, NOT ONE BLOB, because the panel is opened one agent at a time and a grant written by
// somebody else invalidates all of them at once anyway (§7's recheck carries no agent id, so there
// is nothing to invalidate selectively — see `AccessEvent` on the server for why it deliberately
// carries nothing).
//
// THE VIEWER'S OWN SET IS STORED SEPARATELY FROM THE PEOPLE LIST, and that is the load-bearing
// shape here rather than a convenience. `people` is what the panel renders — a list of colleagues
// with addresses and roles — and `viewer` is what every guard in the client reads. Deriving the
// second from the first would mean `useCapability` searching a list of people for itself on every
// render, and would tie a guard used across the whole client to a payload only an Access tab asks
// for.
//
// WORKSPACE-SCOPED STATE. Grants belong to one tenant: an agent uuid from the old workspace can
// never be asked for again, so an entry left behind would sit in this store for the life of the
// tab — and it holds email addresses, roles and live presence. Registered in `resetWorkspaceStores`
// like every other store that holds a workspace's data; `test:reset` is what would notice if it
// were not.

import { create } from "zustand";
import type { AgentCapability } from "../lib/capabilities.ts";

/** One person's row, exactly as the server assembled it. See `AccessPerson` in wsRelay.ts. */
export interface AccessPerson {
  user_id: string;
  email: string;
  display_name: string | null;
  role: string | null;
  capabilities: string[];
  fromRole: string[];
  granted: string[];
  capped: string[];
  provenance: "role" | "grant" | "expired" | "none";
  granted_by: string | null;
  granted_by_name: string | null;
  granted_at: string | null;
  expires_at: string | null;
  note: string | null;
  live: boolean;
}

export interface Exposure {
  agentId: string;
  deployed: boolean;
  url: string | null;
  status: string | null;
  version: number | null;
  deployedByName: string | null;
  deployedAt: string | null;
  /** The posture, in prose, built by the server. Never a boolean — see §13. */
  auth: string | null;
}

/** One agent's answer to `loadAccess`. */
export interface AgentAccess {
  agentId: string;
  agentSlug: string;
  people: AccessPerson[];
  /** §16 — grants belonging to people who have left. They resolve to empty and are still shown. */
  orphans: AccessPerson[];
  /** The viewer's own effective set on this agent. What every guard in the client reads. */
  viewer: AgentCapability[];
}

interface AccessState {
  /** Keyed by the agent uuid the server answered with, never by the slug the client asked with. */
  byAgent: Record<string, AgentAccess>;
  exposure: Record<string, Exposure>;
  /** Which agent ids have a `loadAccess` in flight, so a panel can say "loading" rather than "nobody". */
  loading: Record<string, boolean>;
  error: string | null;

  setAccess: (access: AgentAccess) => void;
  setExposure: (exposure: Exposure) => void;
  markLoading: (agentId: string) => void;
  setError: (message: string | null) => void;
  /** §8.2 — the recheck invalidates everything, because a role change moves every ceiling at once. */
  invalidate: () => void;
}

const EMPTY = {
  byAgent: {} as Record<string, AgentAccess>,
  exposure: {} as Record<string, Exposure>,
  loading: {} as Record<string, boolean>,
  error: null as string | null,
};

export const useAccessStore = create<AccessState>((set) => ({
  ...EMPTY,

  setAccess: (access) =>
    set((s) => ({
      byAgent: { ...s.byAgent, [access.agentId]: access },
      loading: { ...s.loading, [access.agentId]: false },
      error: null,
    })),

  setExposure: (exposure) =>
    set((s) => ({ exposure: { ...s.exposure, [exposure.agentId]: exposure } })),

  markLoading: (agentId) => set((s) => ({ loading: { ...s.loading, [agentId]: true } })),

  setError: (error) => set({ error }),

  /**
   * Empty the cache. §7's recheck, and nothing else.
   *
   * EVERYTHING, NOT ONE AGENT, and the recheck's own emptiness is why: the signal cannot say which
   * agent moved because the cause may have been a workspace ROLE change, which moves the ceiling
   * under every agent simultaneously. A store that invalidated selectively would be correct for
   * grants and quietly wrong for demotions — which is the case that matters, because it is the one
   * where somebody's access got smaller.
   *
   * THE EXPOSURE CACHE STAYS. A grant does not deploy or undeploy anything: §13.3 is explicit that
   * grants do not close a public URL, and clearing the warning when somebody's permissions changed
   * would be the panel implying a connection between the two that does not exist.
   */
  invalidate: () => set({ byAgent: {}, loading: {} }),
}));

/**
 * The viewer's effective set on an agent, or null when nothing has been fetched for it yet.
 *
 * NULL AND EMPTY MEAN DIFFERENT THINGS AND THE DIFFERENCE IS THE WHOLE OF §8.2's FALLBACK RULE. An
 * empty array is "this person may do nothing to this agent", which is a real answer a narrowing
 * grant produces. Null is "we have not asked yet" — and `useCapability` answers that with the
 * WORKSPACE-level check rather than with `false`.
 *
 * That direction is deliberate and it is the safe one: affordances appear at their workspace
 * default until the grant data lands, and may narrow once it arrives. Briefly showing a button that
 * will be removed is better than briefly hiding one that should be there, because the server
 * enforces either way — the first costs one refused click, and the second is a feature somebody
 * concludes does not exist.
 */
export function viewerCapabilities(agentId: string | null | undefined): AgentCapability[] | null {
  if (!agentId) return null;
  return useAccessStore.getState().byAgent[agentId]?.viewer ?? null;
}
