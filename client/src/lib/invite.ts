// An invitation, from the link the inviter copies to the membership the invitee ends up with.
//
// THE SERVER SENDS A TOKEN, NOT A LINK, and that is the right division: it has no idea what
// origin this app is served from, and it deliberately has no mailer — `inviteMember` answers the
// asking socket with the secret exactly once, because only a hash of it is stored. So the link is
// assembled here, out of this tab's own origin, and the redemption is the other end of the same
// string.
//
// WHY A QUERY PARAMETER RATHER THAN A ROUTE. This client has no router: `App` renders one of four
// things from store state, and adding a path would mean adding one. A parameter needs nothing —
// the invitee opens the link, the sign-in screen appears because there is no session, and the
// token is still sitting in the URL when one arrives.
//
// AND IT IS REMOVED FROM THE URL THE MOMENT IT IS SPENT. An invitation is single-use, so a URL
// still carrying one after it has been redeemed is a link that fails if it is reloaded, bookmarked
// or shared — and a failure whose cause ("already accepted") reads exactly like a forgery.

import { acceptInvite, storedToken } from "./auth.ts";
import { useSessionStore } from "../store/sessionStore.ts";

/** The one parameter. Named for what it is rather than for `token`, which the URL already has. */
export const INVITE_PARAM = "invite";

/**
 * The invitation token in a query string, or null.
 *
 * Takes the string rather than reading `window.location`, so it is testable under `tsx` where
 * there is no window — the same reason `viteEnv` in auth.ts is a function.
 */
export function inviteTokenFrom(search: string): string | null {
  let params: URLSearchParams;
  try {
    params = new URLSearchParams(search.startsWith("?") ? search.slice(1) : search);
  } catch {
    return null;
  }
  const raw = params.get(INVITE_PARAM);
  if (!raw) return null;
  const token = raw.trim();
  // THE SHAPE IS `<workspace_id>.<secret>`, and the workspace id in it authorises nothing — it
  // selects which rows the server searches. Checking for the separator here is not a security
  // check; it is what stops a truncated paste being sent as a redemption attempt and coming back
  // as "that invitation is not valid", which reads as the invitation being wrong rather than the
  // link being cut short.
  if (!token.includes(".")) return null;
  return token;
}

/** The link an inviter copies. The token is percent-encoded; nothing else is added to it. */
export function inviteUrl(origin: string, token: string): string {
  const base = origin.replace(/\/+$/, "");
  return `${base}/?${INVITE_PARAM}=${encodeURIComponent(token)}`;
}

/** Whatever invitation this tab was opened with, or null. */
export function pendingInvite(): string | null {
  try {
    return inviteTokenFrom(window.location.search);
  } catch {
    return null;
  }
}

/** Take the invitation out of the address bar without reloading or adding a history entry. */
export function forgetInvite(): void {
  try {
    const url = new URL(window.location.href);
    if (!url.searchParams.has(INVITE_PARAM)) return;
    url.searchParams.delete(INVITE_PARAM);
    window.history.replaceState(null, "", `${url.pathname}${url.search}${url.hash}`);
  } catch {
    /* a browser that refuses history rewriting still has a working membership */
  }
}

export type RedeemOutcome =
  | { kind: "none" }
  | { kind: "accepted"; workspaceId: string; name: string; role: string }
  | { kind: "failed"; message: string };

/**
 * Redeem the invitation in the URL, if there is one and there is a session to redeem it with.
 *
 * IT DOES NOT SWITCH WORKSPACE ITSELF. Switching closes the socket and empties every store, which
 * is a decision about navigation; this function's job is the membership. The caller does both in
 * the order it wants them, which is also what keeps this importable by a test.
 *
 * A FAILURE IS RETURNED RATHER THAN THROWN, and the token is forgotten either way. Every reason a
 * redemption fails is final — expired, revoked, already used, addressed to somebody else — so a
 * retry on the next reload would only produce the same refusal against a URL the user cannot fix.
 */
export async function redeemPendingInvite(): Promise<RedeemOutcome> {
  const invite = pendingInvite();
  if (!invite) return { kind: "none" };
  const token = storedToken();
  // Not signed in yet. The token stays in the URL on purpose — the sign-in screen is about to
  // appear, and this runs again once there is a session.
  if (!token) return { kind: "none" };

  try {
    const result = await acceptInvite(token, invite);
    forgetInvite();
    // The list the server just answered with, which is the one that includes the workspace this
    // person has this second become a member of. Written before any switch, so the switcher's
    // membership check can see it.
    useSessionStore.getState().setWorkspaces(result.workspaces);
    return {
      kind: "accepted",
      workspaceId: result.workspace.id,
      name: result.workspace.name,
      role: result.role,
    };
  } catch (err) {
    forgetInvite();
    return { kind: "failed", message: (err as Error).message || "that invitation could not be accepted" };
  }
}
