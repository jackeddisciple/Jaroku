// Who is signed in, and which workspace this tab is acting in.
//
// A store of its own rather than a corner of `uiStore`, for the reason the other stores are
// separated: uiStore owns view intent — which tab is showing, whether the composer is in Test
// mode — and none of that has a correctness requirement. This one decides whether anything is
// shown at all, and it is the store every other store gets RESET from when a workspace
// changes. Folding it into uiStore would put the reset trigger inside the thing being reset.
//
// THE STATUS IS THE POINT. Five states, and the two that matter most are the two that look
// identical if you are not careful:
//
//   `connecting`  — we are trying. Keep trying. This is a dropped network, a server restart,
//                   a laptop lid. It resolves itself and the UI should say so quietly.
//   `signed_out`  — we are not allowed. STOP trying, and show the sign-in screen. Retrying a
//                   401 forever behind a spinner is the failure this distinction exists to
//                   prevent, and it is the one the spec calls out by name.
//
// Nothing here holds a token. The token lives in lib/auth.ts, which is the only module that
// reads or writes it — a store that held it would put a credential in every devtools snapshot
// of the React tree.

import { create } from "zustand";
import {
  markOnboarded as markOnboardedOnServer,
  setAdminMode as setAdminModeOnServer,
  storedToken,
  storeWorkspace,
  type SessionUser,
  type SessionView,
  type SessionWorkspace,
} from "../lib/auth.ts";

export type SessionStatus =
  /** Nothing has happened yet. The first paint, before the token is even read. */
  | "unknown"
  /** Trying: acquiring a session, fetching a ticket, opening a socket. Retryable. */
  | "connecting"
  /** A session and an open socket. The app is usable. */
  | "ready"
  /** Not allowed, or never signed in. The sign-in screen, and no retry loop. */
  | "signed_out"
  /** Something failed in a way that is worth saying out loud and worth retrying. */
  | "error";

interface SessionState {
  status: SessionStatus;
  user: SessionUser | null;
  workspaces: SessionWorkspace[];
  /** The workspace this tab acts in. One socket, one workspace, for the tab's whole life. */
  workspaceId: string | null;
  /** Unix seconds, from the token. Drives the "your session is ending" notice. */
  expiresAt: number | null;
  /** Set when the server said the session is nearly over, so the UI can offer to renew. */
  expiring: boolean;
  message: string | null;
  /** Whether this server offers the local dev sign-in, so the screen knows what to render. */
  localIssuer: boolean;

  setStatus: (status: SessionStatus, message?: string | null) => void;
  applySession: (view: SessionView, workspaceId: string) => void;
  setWorkspaces: (workspaces: SessionWorkspace[]) => void;
  /**
   * Replace the signed-in user with what the server just answered with.
   *
   * FROM THE SERVER, NEVER FROM WHAT WAS TYPED. The one caller is §3.4's name screen, and the
   * server trims, bounds and may refuse — so believing the local value would mean the app rendering
   * a name one character longer than the one actually saved, which nobody notices until somebody's
   * name is truncated everywhere except here.
   *
   * It is also what moves the gate: the name screen is shown while `displayName` is null, so this
   * is the write that ends it. A screen that navigated as well would be a second answer to a
   * question the gate already answers.
   */
  setUser: (user: SessionUser) => void;
  setLocalIssuer: (available: boolean) => void;
  setExpiring: (expiring: boolean) => void;
  /** Record that this person has finished onboarding, here and on the server. */
  markOnboarded: () => void;
  /**
   * Turn admin mode on or off. Rejects if the server refuses, and the caller surfaces that.
   *
   * Async and awaited, unlike `markOnboarded`: this flag decides whether an unmissable banner is on
   * screen, and believing it optimistically would mean a failed request leaves somebody thinking
   * they are bypassing every limit when they are not, or the reverse.
   */
  setAdminMode: (on: boolean) => Promise<void>;
  signOut: (message?: string | null) => void;
  /** The role this tab holds in its current workspace, or null. Drives what the UI offers. */
  role: () => string | null;
}

export const useSessionStore = create<SessionState>((set, get) => ({
  status: "unknown",
  user: null,
  workspaces: [],
  workspaceId: null,
  expiresAt: null,
  expiring: false,
  message: null,
  localIssuer: false,

  setStatus: (status, message = null) => set({ status, message }),

  applySession: (view, workspaceId) =>
    set({
      user: view.user,
      workspaces: view.workspaces,
      workspaceId,
      expiresAt: view.expiresAt,
      // A fresh session is a fresh token, so whatever the last one was warning about is over.
      expiring: false,
      message: null,
    }),

  setWorkspaces: (workspaces) => set({ workspaces }),
  setUser: (user) => set({ user }),
  setLocalIssuer: (localIssuer) => set({ localIssuer }),
  setExpiring: (expiring) => set({ expiring }),

  /**
   * Turn admin mode on or off, and only believe the server's answer.
   *
   * THE OPPOSITE OF `markOnboarded` BESIDE IT, deliberately. That one moves the flag locally first,
   * because the worst case is being offered a welcome screen twice. This one waits, because the
   * flag decides whether an unmissable "you are bypassing every limit" banner is on screen — and
   * showing that optimistically would mean a failed request leaves somebody believing they are in
   * admin mode when they are not, or the reverse. There is exactly one authority for this and it is
   * not the browser.
   */
  setAdminMode: async (on) => {
    const { user } = get();
    if (!user) return;
    const result = await setAdminModeOnServer(on);
    set({ user: { ...user, isAdmin: result.isAdmin, adminMode: result.adminMode } });
  },

  markOnboarded: () => {
    const { user } = get();
    if (!user || user.onboarded) return;
    // Locally first, so the app moves on at the moment the loop closed. Waiting for the round
    // trip would hold somebody on the last onboarding screen after the thing it was waiting
    // for has visibly happened.
    set({ user: { ...user, onboarded: true } });
    const token = storedToken();
    if (!token) return;
    // Nothing is retried and nothing is surfaced. The worst case is being offered onboarding
    // once more on the next sign-in, which is a smaller harm than an error about a flag —
    // and it is the same direction the migration chose for existing rows.
    void markOnboardedOnServer(token).catch(() => {});
  },

  signOut: (message = null) => {
    // The remembered workspace goes too. Signing out and back in as somebody else must not
    // land in the previous account's workspace and get a 403 nobody can explain.
    storeWorkspace(null);
    set({
      status: "signed_out",
      user: null,
      workspaces: [],
      workspaceId: null,
      expiresAt: null,
      expiring: false,
      message,
    });
  },

  role: () => {
    const { workspaceId, workspaces } = get();
    return workspaces.find((w) => w.id === workspaceId)?.role ?? null;
  },
}));
