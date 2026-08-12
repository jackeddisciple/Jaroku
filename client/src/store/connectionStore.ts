// The connections store — which third-party accounts this workspace has authorised.
//
// Separate from providerStore for the reason every store here is separate: a different invariant.
// A provider key is a credential this workspace HOLDS; a connection is a grant somebody else's
// system made to us. The second can be revoked from the far end while nobody is looking, which is
// why `reauth_required` exists and why a component must never be able to set a status — the only
// thing that makes a connection active is the server having a working token, and a store that let
// the UI assert otherwise would let a button claim an integration works when it does not.
//
// Every message on this channel is a FULL SNAPSHOT, so `setConnections` is a replace and never a
// merge — the same discipline as mcpStore, providerStore and evalStore.
//
// AND NOTHING IN HERE EVER HOLDS A TOKEN. `status`, `scopes`, `account` — that is the whole of
// what the browser is told, and the `authorize` URL below is the one thing that even resembles a
// credential: it is a consent link bound to one flow, it is not stored, and it is consumed by
// navigating to it.

import { create } from "zustand";
import type { ConnectionView } from "../types.ts";

interface ConnectionState {
  connections: ConnectionView[];
  /**
   * Whether the first snapshot has landed.
   *
   * Load-bearing rather than cosmetic, for the same reason `providerStore.loaded` is: before it
   * arrives, "nothing is connected" and "we have not been told yet" look identical, and a panel
   * that rendered the first would flash "Connect Gmail" at somebody who already has.
   */
  loaded: boolean;
  /** Connectors with a flow being started, so the button can say it is working. */
  connecting: Record<string, true>;
  error: string | null;
  notice: string | null;

  setConnections: (connections: ConnectionView[]) => void;
  startConnecting: (connectorId: string) => void;
  setError: (message: string | null) => void;
  setNotice: (message: string | null) => void;
}

export const useConnectionStore = create<ConnectionState>((set) => ({
  connections: [],
  loaded: false,
  connecting: {},
  error: null,
  notice: null,

  // A snapshot settles every question a flow could still be waiting on, so in-flight state is
  // cleared wholesale rather than by key — a failure nobody anticipated cannot leave a spinner
  // running forever. Same reasoning as `providerStore.setProviders`.
  setConnections: (connections) => set({ connections, loaded: true, connecting: {} }),

  startConnecting: (connectorId) =>
    set((s) => ({ connecting: { ...s.connecting, [connectorId]: true }, error: null })),

  // An error ends any flow it could describe. Without this the button spins until reload.
  setError: (error) => set({ error, connecting: {} }),
  setNotice: (notice) => set({ notice, connecting: {} }),
}));

// --- selectors ---------------------------------------------------------------
// Exported as pure functions so no component re-derives them differently.

/** Whether a named connector is usable right now. False before the first snapshot lands. */
export function isConnected(connections: ConnectionView[], connectorId: string): boolean {
  return connections.some((c) => c.connectorId === connectorId && c.status === "active");
}

/**
 * Connections a person has to do something about.
 *
 * `reauth_required` only. A `revoked` one is a decision somebody made and does not need chasing,
 * and a `disconnected` one was never connected — treating either as an alert would train people
 * to ignore the banner that matters.
 */
export function needsAttention(connections: ConnectionView[]): ConnectionView[] {
  return connections.filter((c) => c.status === "reauth_required");
}

/** Human words for a status, in one place so two components cannot disagree about them. */
export const CONNECTION_STATUS_LABEL: Record<string, string> = {
  active: "connected",
  reauth_required: "needs reconnecting",
  revoked: "disconnected",
  disconnected: "not connected",
};

/**
 * What to tell somebody when a flow failed, from the KIND the callback put on the URL.
 *
 * The kind rather than a message, deliberately: the server never puts provider text on a redirect,
 * because a string an attacker chooses by choosing what to send to our callback is a string that
 * would then be rendered under our own domain. These words are ours.
 */
export const CONNECT_FAILURE_MESSAGE: Record<string, string> = {
  denied: "that authorisation was declined, so nothing was connected",
  reauth_required: "the provider says that authorisation is no longer valid — try connecting again",
  transient: "the provider did not answer — try again in a moment",
  config: "this deployment's OAuth app is not set up for that connector yet",
  error: "that authorisation did not complete",
};
