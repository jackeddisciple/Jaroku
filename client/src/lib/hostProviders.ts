// Asking the shell which provider CLIs this machine has, and telling the server.
//
// THE FOURTH FILE IN THIS CLIENT THAT KNOWS A HOST MAY EXIST, after the session vault, the
// deep-link listener and the backend status. It is here rather than folded into one of those
// because it is a different fact with a different lifetime: a vault answers once, a link arrives
// from outside, backend status changes while the page is open, and this changes when the USER goes
// and signs in somewhere else — which is a thing they do deliberately, and then come back.
//
// IT IS A NO-OP IN A BROWSER, like all three of the others. `readHostProviders` resolves to an
// empty list, nothing is reported, and every provider reads as not connected — which is the truth
// for a browser tab: there is no local CLI for it to sign in with, and no amount of asking changes
// that.
//
// WHY THE PAGE CARRIES THE REPORT RATHER THAN THE SHELL. The shell could open its own socket to the
// relay, and that would be a second authenticated connection, a second session to expire, and a
// second place for the tenancy context to be wrong. The page already holds an authenticated socket
// with a session the server trusts, so the report rides that: the shell observes, the page relays.
// The shell keeps the one job only it can do, and gains none of the ones it would do worse.
//
// EVERY PAYLOAD IS VALIDATED, for the reason `hostConfig.ts` validates its injection: the risk is
// not malice — the host is the application — but a host that is WRONG. An older shell with a field
// this build has never heard of, or a rename on one side of a seam nothing typechecks. A
// half-parsed report that reached the server would claim a provider was signed in when it was not.

/** One provider CLI as the shell found it. Mirrors `HostProvider` in src-tauri/src/provider_auth.rs. */
export interface HostProviderReport {
  provider: string;
  installed: boolean;
  version: string | null;
  signedIn: boolean;
  account: string | null;
  /** How that CLI is authenticated, normalised. Null when it is not signed in. */
  authMode: string | null;
  /** A sentence worth showing when `signedIn` is false for a reason a user would want named. */
  note: string | null;
}

type Invoke = (cmd: string, args?: Record<string, unknown>) => Promise<unknown>;

/** The shell's command surface, or null in a browser. Reached through the global, never imported. */
function invoker(): Invoke | null {
  const tauri = (globalThis as { __TAURI__?: { core?: { invoke?: Invoke } } }).__TAURI__;
  return tauri?.core?.invoke ?? null;
}

/** Whether a host is present at all. Everything below is a no-op when this is false. */
export function hasHost(): boolean {
  return invoker() !== null;
}

function validate(raw: unknown): HostProviderReport | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  if (typeof r.provider !== "string" || r.provider.length === 0) return null;
  // BOOLEANS ARE COMPARED, NOT COERCED. A truthy string from a host that got its serialisation
  // wrong would otherwise read as a sign-in, which is the one field here worth being strict about.
  return {
    provider: r.provider,
    installed: r.installed === true,
    version: typeof r.version === "string" ? r.version : null,
    signedIn: r.signedIn === true,
    account: typeof r.account === "string" ? r.account : null,
    authMode: typeof r.authMode === "string" ? r.authMode : null,
    note: typeof r.note === "string" ? r.note : null,
  };
}

/**
 * The probe in flight, shared by everybody who asks while it runs.
 *
 * A PROBE IS SEVERAL PROCESS SPAWNS, and the page asks from several places at once — the socket
 * opening, the Settings panel mounting, Check again pressed twice. The desktop log showed fifteen
 * probes in a minute, six of them 316ms apart. Asked again while one is running, the answer is that
 * one.
 */
let inFlight: Promise<HostProviderReport[]> | null = null;

/**
 * Ask the shell what it can see. Empty in a browser, and empty on any error.
 *
 * NEVER THROWS. This runs on mount and after a sign-in, and the worst honest outcome is "we could
 * not tell" — which is already what an empty list means. A rejected promise here would take out
 * whatever rendered the composer.
 */
export function readHostProviders(): Promise<HostProviderReport[]> {
  if (!inFlight) inFlight = probeHost().finally(() => { inFlight = null; });
  return inFlight;
}

async function probeHost(): Promise<HostProviderReport[]> {
  const invoke = invoker();
  if (!invoke) return [];
  try {
    const raw = await invoke("provider_hosts");
    if (!Array.isArray(raw)) return [];
    return raw.map(validate).filter((r): r is HostProviderReport => r !== null);
  } catch {
    return [];
  }
}

/**
 * How long after one re-ask a return to the window may ask again.
 *
 * LONGER THAN ONE RETURN, SHORTER THAN ANY SIGN-IN. Coming back fires `focus` and `visibilitychange`
 * together, flicking between two windows fires them every second, and the shell caches its own answer
 * for 1.5s besides. Nobody finishes `codex login` in a terminal and comes back inside three seconds.
 */
export const RETURN_GAP_MS = 3_000;

/**
 * A handler for "somebody came back to the window" that asks the machine again, at most once per gap.
 *
 * STARTS AS IF IT HAD JUST ASKED, because it is installed straight after the socket's own report on
 * connect — a window focused in that same moment has nothing new to tell.
 */
export function reprobeOnReturn(probe: () => void, gapMs = RETURN_GAP_MS, now: () => number = Date.now): () => void {
  let last = now();
  return () => {
    const t = now();
    if (t - last < gapMs) return;
    last = t;
    probe();
  };
}
