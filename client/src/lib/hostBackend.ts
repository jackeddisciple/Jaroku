// What the host says about the backend it is supervising.
//
// WHY THIS EXISTS AT ALL. In a browser the server is already running before anybody opens the
// page, so "is the backend up" is not a question the client has ever had to ask — it opens a
// socket, and if that fails it retries, which is right. A desktop shell inverts it: the window
// opens BEFORE the backend, on purpose, so a first launch that has a hundred megabytes to unpack
// shows something rather than nothing. From then on the page and the truth can differ, and
// everything that can go wrong reaches the page as the same single fact — the socket did not
// open. Extraction failed, the payload is missing, the port is held by something else, the
// backend crashed three times and the supervisor stopped: one symptom, five causes, and a
// "reconnecting" strip that will reconnect in exactly none of them.
//
// So the shell says which. This module is the page's side of that, and it is the THIRD file in
// this client that knows a host may exist — after the session vault and the deep-link listener —
// which is one more than the desktop work set out to add. It is here rather than folded into one
// of those two because it is a different fact with a different lifetime: a vault answers once, a
// link arrives from outside, and this changes while the page is open.
//
// IT IS A NO-OP IN A BROWSER, like both of the others: `onBackendStatus` returns an unsubscribe
// that does nothing and no status ever arrives, so every reader's "no host has said anything"
// branch is the browser's permanent state and needs no `if` of its own.
//
// EVERY PAYLOAD IS VALIDATED, for the reason `hostConfig.ts` validates its injection. The risk is
// not malice — the host is the application — it is a host that is WRONG: an older shell with a
// phase this build has never heard of, a field renamed on one side of a seam that nothing
// typechecks. A status that half-parses would put an empty error screen over a working
// application, which is worse than not having the feature.

import { applyHostWsUrl } from "./hostConfig.ts";

/** Must match `src-tauri/src/status.rs`'s `Phase`. */
const PHASES = ["preparing", "started", "restarting", "failed"] as const;

export type BackendPhase = (typeof PHASES)[number];

export interface BackendStatus {
  phase: BackendPhase;
  /** Where the backend is, or will be. The page was told this at load time and it can move. */
  wsUrl: string;
  /** One sentence somebody can act on, when there is one. */
  message: string | null;
  /** Where the shell wrote everything down. Offered, never printed — a log is not a UI. */
  logPath: string | null;
}

/**
 * Read a status the host sent, or answer `null`.
 *
 * `null` for every failure with one value, for the reason `parseDeepLink` gives: a caller that
 * distinguished "unknown phase" from "not an object" would do the same thing in both cases, and
 * that thing is to keep rendering what the page already knows.
 */
export function parseBackendStatus(raw: unknown): BackendStatus | null {
  if (typeof raw !== "object" || raw === null) return null;
  const value = raw as Record<string, unknown>;
  const phase = value.phase;
  if (typeof phase !== "string" || !(PHASES as readonly string[]).includes(phase)) return null;
  if (typeof value.wsUrl !== "string" || value.wsUrl === "") return null;
  return {
    phase: phase as BackendPhase,
    wsUrl: value.wsUrl,
    message: typeof value.message === "string" && value.message !== "" ? value.message : null,
    logPath: typeof value.logPath === "string" && value.logPath !== "" ? value.logPath : null,
  };
}

// ---------------------------------------------------------------------------------------------
// The subscription.
// ---------------------------------------------------------------------------------------------

/** The event the shell emits. Must match `src-tauri/src/status.rs`'s `EVENT`. */
const EVENT = "jaroku:backend";

interface TauriBridge {
  event?: { listen(event: string, handler: (message: { payload: unknown }) => void): Promise<() => void> };
  core?: { invoke(command: string, args?: unknown): Promise<unknown> };
}

function bridge(): TauriBridge | undefined {
  return (globalThis as { __TAURI__?: TauriBridge }).__TAURI__;
}

/**
 * Subscribe to what the host says about its backend. Returns a function that unsubscribes.
 *
 * THE LISTENER IS ATTACHED BEFORE THE SNAPSHOT IS ASKED FOR, and the snapshot is then discarded
 * if anything arrived in the meantime. The shell settles its status during startup, which is
 * before React has mounted anything — so a page that only listened would never hear the one that
 * matters on a launch that failed early. Asking as well closes that; asking FIRST would open the
 * opposite hole, where a status that arrived mid-flight is overwritten by the older one the
 * round trip was already carrying.
 *
 * The socket URL on every status is applied here rather than by the caller, so a moved port is
 * corrected by the fact of the status arriving rather than by somebody remembering to.
 */
/**
 * Ask the host to start its backend again. Answers null on success, or a sentence to render.
 *
 * A HOST THAT CANNOT DO THIS ANSWERS SO, rather than the caller branching on whether it is inside
 * one. In a browser there is no backend to restart and nothing that could have stopped one, so the
 * sentence says that and the button that called it was never rendered anyway — the failure panel
 * only exists under a host.
 */
export async function restartBackend(): Promise<string | null> {
  const invoke = bridge()?.core?.invoke;
  if (!invoke) return "This build has no backend of its own to restart.";
  try {
    await invoke("restart_backend");
    return null;
  } catch (err) {
    // The shell's own refusal — "already starting", "nothing to start" — which is a sentence
    // somebody can act on rather than a stack trace.
    return String((err as { message?: string })?.message ?? err);
  }
}

export function onBackendStatus(handler: (status: BackendStatus) => void): () => void {
  const tauri = bridge();
  if (!tauri?.event?.listen) return () => {};

  let cancelled = false;
  let heard = false;
  let unlisten: (() => void) | null = null;

  const deliver = (raw: unknown, live: boolean): void => {
    const status = parseBackendStatus(raw);
    if (!status) {
      console.warn("[jaroku] ignored a backend status this build does not understand");
      return;
    }
    if (live) heard = true;
    applyHostWsUrl(status.wsUrl);
    handler(status);
  };

  void (async () => {
    const stop = await tauri.event!.listen(EVENT, (message) => deliver(message.payload, true));
    if (cancelled) {
      stop();
      return;
    }
    unlisten = stop;
    const settled = await tauri.core?.invoke("backend_status").catch(() => null);
    if (!cancelled && !heard && settled) deliver(settled, false);
  })();

  return () => {
    cancelled = true;
    unlisten?.();
  };
}
