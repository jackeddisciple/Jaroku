// What the host says about the backend, for the two surfaces that render it.
//
// A STORE OF ITS OWN, for the reason every store in this directory is its own: a distinct
// invariant. `traceStore.connection` is what THIS TAB can see — open, connecting, closed — and it
// is right about that and says nothing about why. This is what the process that started the
// backend knows, which is a different fact from a different source with a different lifetime, and
// folding it into the connection state would produce a field whose meaning depends on which of
// two writers last touched it.
//
// IT IS EMPTY IN A BROWSER AND STAYS EMPTY. Nothing subscribes outside a host, so `status` is null
// for the whole life of a browser tab and every reader's null branch is the browser's behaviour —
// which is the same shape `sessionVault` and `deepLink` take, and the reason `npm run dev` needs
// no `if` anywhere for any of this.
//
// NOT IN `reset.ts`. Every workspace-scoped store is cleared when the workspace changes; this one
// is not scoped to a workspace, or to a session, or to an account. It describes the machine's own
// backend process, which does not change because somebody switched workspace — and clearing it on
// a switch would blank a failure notice at the exact moment somebody was reading it.

import { create } from "zustand";
import type { BackendStatus } from "../lib/hostBackend.ts";

interface HostState {
  /** The last thing the host said, or null where there is no host. */
  status: BackendStatus | null;
  setStatus: (status: BackendStatus) => void;
}

export const useHostStore = create<HostState>((set) => ({
  status: null,
  setStatus: (status) => set({ status }),
}));

/**
 * Whether the host has given up on the backend.
 *
 * A selector rather than a field, because it is a reading of the phase rather than a second thing
 * to keep in step with it — and because it is the one question every reader actually has. The
 * other three phases are all "wait", which is what the app does anyway.
 */
export function backendHasFailed(status: BackendStatus | null): boolean {
  return status?.phase === "failed";
}
