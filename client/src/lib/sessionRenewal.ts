// Keeping a session alive while somebody is using it.
//
// THE BUG. Every session ended on the hour, mid-task — "your session expired", three times in one
// afternoon — because a token lasted an hour and nothing ever renewed it. The server answer said
// "the client refreshes before this"; there was no refresh.
//
// NOW: half an hour before the token runs out, it is exchanged for a new one (`POST /v1/auth/refresh`)
// and the open socket is handed the new token, so it is not closed when the old one ends. A machine
// that slept through the timer checks again when it wakes — focus, visibility, the network coming
// back — and the server's own "expiring" warning is a prompt too.
//
// A REFUSAL IS LEFT ALONE. Signed in over a month ago, or the account gone: the expiry then signs out
// with its own sentence, which is the truthful thing. A failure to reach the server is tried again.

import { AuthFailure, refreshSession, storedToken } from "./auth.ts";
import { sendRenewSession } from "./socket.ts";
import { useSessionStore } from "../store/sessionStore.ts";

/** How long before expiry a session is renewed. */
export const RENEW_LEAD_S = 30 * 60;
/** How soon to try again after the server could not be reached. */
const RETRY_MS = 60_000;

let timer: ReturnType<typeof setTimeout> | null = null;
let inFlight = false;

/** Whether the session should be renewed now: ready, not yet expired, and inside the lead. */
export function renewalDue(expiresAt: number | null, nowS: number): boolean {
  return expiresAt !== null && expiresAt > nowS && expiresAt - nowS <= RENEW_LEAD_S;
}

/** Renew now. True when a new token was stored and handed to the socket. */
export async function renewNow(): Promise<boolean> {
  const token = storedToken();
  if (inFlight || !token || useSessionStore.getState().status !== "ready") return false;
  inFlight = true;
  try {
    const out = await refreshSession(token);
    useSessionStore.setState({ expiresAt: out.expiresAt, expiring: false });
    sendRenewSession(out.token);
    return true;
  } catch (err) {
    if (err instanceof AuthFailure && err.retryable) schedule(RETRY_MS);
    return false;
  } finally {
    inFlight = false;
  }
}

function schedule(ms: number): void {
  if (timer) clearTimeout(timer);
  timer = setTimeout(() => void renewNow(), Math.max(1_000, ms));
}

/** Set the timer for the session in hand: due `RENEW_LEAD_S` before it expires. */
function plan(): void {
  if (timer) clearTimeout(timer);
  timer = null;
  const { status, expiresAt } = useSessionStore.getState();
  if (status !== "ready" || expiresAt === null) return;
  schedule((expiresAt - RENEW_LEAD_S) * 1000 - Date.now());
}

/** A machine that slept through the timer: renew on waking if the session is already due. */
function checkOnWake(): void {
  const { status, expiresAt } = useSessionStore.getState();
  if (status === "ready" && renewalDue(expiresAt, Math.floor(Date.now() / 1000))) void renewNow();
}

let started = false;

/** Begin keeping the session alive. Once, at boot. */
export function startSessionRenewal(): void {
  if (started) return;
  started = true;
  useSessionStore.subscribe((now, before) => {
    if (now.expiresAt !== before.expiresAt || now.status !== before.status) plan();
    // THE SERVER'S WARNING IS A PROMPT TOO: it means this socket's token is minutes from ending.
    if (now.expiring && !before.expiring) void renewNow();
  });
  if (typeof window !== "undefined") {
    window.addEventListener("focus", checkOnWake);
    window.addEventListener("online", checkOnWake);
  }
  if (typeof document !== "undefined") document.addEventListener("visibilitychange", checkOnWake);
  plan();
}
