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

/**
 * One open connection, as the server describes it — see `LiveSession` in wsRelay.ts.
 *
 * THE ABSENCES ARE THE CONTRACT. No IP, no ticket, no raw User-Agent. Restated here rather than
 * imported for the reason every wire shape in this client is restated: the server and the client
 * are two programs, and a field added to a payload should be a deliberate decision to render.
 */
export interface LiveSession {
  id: string;
  userId: string | null;
  name: string;
  device: string | null;
  startedAt: string;
  onThisAgent: boolean;
}

/** An open invitation to the WORKSPACE, surfaced here — see the server's `PendingInvite`. */
export interface PendingInvite {
  id: string;
  /** null is §13.4's link invitation — "Anyone with the link", which is a different sentence. */
  email: string | null;
  role: string;
  createdAt: string;
  expiresAt: string;
  /** Older than seven days. Decided server-side so one clock decides — see `STALE_INVITE_MS`. */
  stale: boolean;
}

/** One row of §15's history. `scope` is the field the section exists for. */
export interface AccessHistoryEntry {
  id: number;
  action: string;
  scope: "agent" | "workspace";
  actorName: string;
  summary: string;
  createdAt: string;
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
  /** §12 — the WORKSPACE's open invitations. Not the agent's; invitations are to a workspace. */
  invites: PendingInvite[];
}

interface AccessState {
  /** Keyed by the agent uuid the server answered with, never by the slug the client asked with. */
  byAgent: Record<string, AgentAccess>;
  /**
   * slug → uuid, so a guard holding either spelling finds the same entry.
   *
   * THIS EXISTS BECAUSE THE CLIENT GENUINELY HOLDS BOTH, and pretending otherwise would push the
   * problem into every call site. The Agents grid has the uuid; `buildStore.activeAgentId` — which
   * the composer, the Deploy panel, the GitHub panel and the title bar all read — is the SLUG, and
   * has been since before agents had uuids. A guard in the Deploy panel cannot produce a uuid
   * without a lookup, and a guard that did the lookup itself would be forty call sites each
   * deciding what to do when it fails.
   *
   * ONE MAP, WRITTEN FROM THE SERVER'S OWN ANSWER. `loadAccess` returns both spellings for the
   * agent it answered about, so the alias is a fact the server stated rather than a join this
   * client performed — which matters because slugs are unique per WORKSPACE and this map is
   * emptied on a switch along with everything else here.
   */
  bySlug: Record<string, string>;
  exposure: Record<string, Exposure>;
  /**
   * Open connections, keyed by the agent whose panel asked.
   *
   * KEYED BY AGENT EVEN THOUGH THE LIST IS WORKSPACE-WIDE, because `onThisAgent` is computed
   * against the agent that asked — the same sockets answered for a different agent are the same
   * rows with a different flag. One shared list would be right until two panels were open.
   */
  sessions: Record<string, LiveSession[]>;
  /** §15's rows, keyed by agent. Admin-only; a non-admin never receives them. */
  history: Record<string, AccessHistoryEntry[]>;
  /** Which agent ids have a `loadAccess` in flight, so a panel can say "loading" rather than "nobody". */
  loading: Record<string, boolean>;
  error: string | null;

  setAccess: (access: AgentAccess) => void;
  setExposure: (exposure: Exposure) => void;
  setSessions: (agentId: string, sessions: LiveSession[]) => void;
  setHistory: (agentId: string, entries: AccessHistoryEntry[]) => void;
  markLoading: (agentId: string) => void;
  setError: (message: string | null) => void;
  /** §8.2 — the recheck invalidates everything, because a role change moves every ceiling at once. */
  invalidate: () => void;
}

const EMPTY = {
  byAgent: {} as Record<string, AgentAccess>,
  bySlug: {} as Record<string, string>,
  exposure: {} as Record<string, Exposure>,
  sessions: {} as Record<string, LiveSession[]>,
  history: {} as Record<string, AccessHistoryEntry[]>,
  loading: {} as Record<string, boolean>,
  error: null as string | null,
};

export const useAccessStore = create<AccessState>((set) => ({
  ...EMPTY,

  setAccess: (access) =>
    set((s) => ({
      byAgent: { ...s.byAgent, [access.agentId]: access },
      bySlug: { ...s.bySlug, [access.agentSlug]: access.agentId },
      // BOTH SPELLINGS ARE MARKED SETTLED, because either could have been the one asked with —
      // `sendLoadAccess` takes whatever the caller had. Clearing only the uuid would leave a panel
      // that asked by slug rendering a spinner over an answer that has already arrived.
      loading: { ...s.loading, [access.agentId]: false, [access.agentSlug]: false },
      error: null,
    })),

  setExposure: (exposure) =>
    set((s) => ({ exposure: { ...s.exposure, [exposure.agentId]: exposure } })),

  setSessions: (agentId, sessions) =>
    set((s) => ({ sessions: { ...s.sessions, [agentId]: sessions } })),

  setHistory: (agentId, entries) =>
    set((s) => ({ history: { ...s.history, [agentId]: entries } })),

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
  // The alias map goes with it. It is derived from the answers, so keeping it would leave slugs
  // pointing at uuids whose entries no longer exist — a lookup that resolves to nothing, which is
  // the same as no alias and one more thing to be wrong.
  // THE SESSION LIST GOES TOO, and for a different reason from the grants: it is not invalidated by
  // a permission change, it is simply the most perishable thing in this store. A list of who is
  // connected is stale within seconds of anything happening, and the recheck is the one moment the
  // panel is already going to ask again.
  // THE HISTORY GOES TOO, and for the reason the grants do rather than the reason the sessions do:
  // every event this section shows is exactly the kind of thing that fires a recheck, so a list
  // left in place would be missing the row explaining why everything above it just moved.
  invalidate: () => set({ byAgent: {}, bySlug: {}, sessions: {}, history: {}, loading: {} }),
}));

/**
 * One agent's cached access, found by uuid OR slug.
 *
 * THE ONE PLACE THE TWO SPELLINGS ARE RECONCILED. Every guard, the panel and the hooks go through
 * this, so a call site never has to know which kind of id it is holding — and the day a third
 * spelling appears, there is one function to teach rather than forty.
 */
export function accessFor(
  state: Pick<AccessState, "byAgent" | "bySlug">,
  agentId: string | null | undefined,
): AgentAccess | undefined {
  if (!agentId) return undefined;
  return state.byAgent[agentId] ?? state.byAgent[state.bySlug[agentId] ?? ""];
}

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
  return accessFor(useAccessStore.getState(), agentId)?.viewer ?? null;
}
