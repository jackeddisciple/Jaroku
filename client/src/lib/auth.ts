// The client's half of authentication: get a token, get a session, get a ticket.
//
// Three requests, in that order, and the ordering is not incidental:
//
//   1. a TOKEN proves who you are. It comes from the auth provider — or, with no provider
//      configured, from this server's own local issuer, which is a real RS256 issuer rather
//      than a bypass. See server/src/auth/config.ts.
//   2. a SESSION turns that into an account and the list of workspaces you may act in. It is
//      also what provisions you on first sight.
//   3. a TICKET is a single-use, thirty-second credential for opening exactly one socket, in
//      exactly one workspace. A browser cannot put a header on a WebSocket, and a long-lived
//      token in a query string lands in access logs forever.
//
// WHERE THE TOKEN LIVES. `localStorage`, deliberately and with the trade-off stated: it
// survives a reload (so a refresh does not sign you out) and it is readable by any script that
// gets onto the page. The alternative — memory only — trades a real usability cost for a
// defence against an attacker who, having achieved script execution, can simply use the token
// from memory or mint a fresh one through the same API. The mitigation that matters is the
// Content-Security-Policy in Session 8, not the storage choice.
//
// THAT ARGUMENT IS ABOUT A BROWSER, and it stops holding in a desktop application, where local
// storage is a file on a disk any program running as this user can open. So the four accessors
// below go through `sessionVault.ts`, which is `localStorage` in a browser — byte for byte what
// this file did before — and the operating system's own credential store under a host that has
// one. The KEYS stay here, because this module is what they belong to and because `test:reset`
// audits every `jaroku.*` key in the client source and should keep finding them where they are.
//
// Nothing here is provider-specific. Swapping in Clerk's SDK means changing `acquireToken`,
// and the two functions below it do not know the difference.

import { hostWsUrl } from "./hostConfig.ts";
import { hydrate as hydrateVault, read as readVault, write as writeVault } from "./sessionVault.ts";

/**
 * Read a Vite build-time variable, safely.
 *
 * `import.meta.env` exists only under Vite. Reading it directly throws at MODULE LOAD anywhere
 * else — under `tsx`, which is what every test suite in this repo runs on, and in any future
 * server-side render. A module that cannot be imported outside a bundler is a module that
 * cannot be tested, and this one holds the retry-versus-sign-out decision.
 */
function viteEnv(name: string): string | undefined {
  const env = (import.meta as { env?: Record<string, string | undefined> }).env;
  return env?.[name];
}

/**
 * The relay's HTTP origin, resolved per call.
 *
 * A FUNCTION RATHER THAN A CONSTANT, AND THAT WAS A BUG RATHER THAN A STYLE CHOICE. It was
 * `const BASE = …`, evaluated once at module load, which is fine while the answer cannot change
 * and is wrong the moment it can: the desktop shell re-resolves the backend's port when a
 * restart finds the old one taken, and a value captured at load time would send every request
 * afterwards to a port nothing is listening on — while the socket, which resolves per call,
 * reconnected perfectly well. Two halves of one client disagreeing about where the server is, is
 * the hardest kind of "it works sometimes" to read.
 *
 * Exported because `http.ts` needs the identical answer and used to compute its own — see the
 * note there on what that cost.
 */
export function apiBase(): string {
  return viteEnv("VITE_JAROKU_API") ?? wsOrigin().replace(/^ws/, "http");
}

/**
 * The relay's WebSocket origin, from the most specific source that has an answer.
 *
 * THE HOST WINS, and that ordering is the whole point rather than a detail. A host is a process
 * that started the backend and therefore KNOWS which port it got; `VITE_JAROKU_WS` is a constant
 * somebody baked in at build time and cannot know that 4317 was taken on this particular
 * machine. Preferring the constant would mean a desktop launch that had to move the port spent
 * the session failing to reach a backend that was running one port up. With no host — every
 * browser, every `npm run dev`, every deployment — this is exactly the expression it replaced.
 */
function wsOrigin(): string {
  return hostWsUrl() ?? (viteEnv("VITE_JAROKU_WS") ?? "ws://localhost:4317").replace(/\/+$/, "");
}

const TOKEN_KEY = "jaroku.token";
const WORKSPACE_KEY = "jaroku.workspace";

export interface SessionUser {
  id: string;
  email: string;
  displayName: string | null;
  /**
   * Whether this PERSON has finished first-run onboarding.
   *
   * From the server, because "is this user new" and "is this browser new" are different
   * questions and the flow only ever wanted the first. Answered from `localStorage`, a new
   * account on a used browser skipped onboarding entirely — inheriting whatever step the
   * previous person stopped on — and a returning user on a second device was walked through a
   * welcome screen for a product they use daily.
   */
  onboarded: boolean;
}

export interface SessionWorkspace {
  id: string;
  slug: string;
  name: string;
  kind: string;
  role: string;
  /**
   * Which plan this workspace is on, and the label to render.
   *
   * THE LABEL IS THE SERVER'S. `planFor` is the same function the budget gate resolves limits
   * through, so the plan named in the sidebar and the plan named in the Usage panel are one
   * computation — a client that mapped ids to names itself would be a second copy of the plan
   * table, and a paid workspace reading "Free" in one place and "Pro" in the other is worse than
   * showing nothing at all.
   */
  plan: { id: string; label: string };
}

export interface SessionView {
  user: SessionUser;
  workspaces: SessionWorkspace[];
  defaultWorkspaceId: string;
  /** Unix seconds. */
  expiresAt: number;
}

/**
 * A failure with the one bit the caller needs: is this worth retrying?
 *
 * "The network dropped" and "you are not allowed" look identical to a `fetch` that rejects,
 * and treating the second as the first is how a client ends up retrying a 401 forever while
 * showing a spinner. `retryable` is the whole reason this class exists.
 */
export class AuthFailure extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly retryable: boolean,
  ) {
    super(message);
    this.name = "AuthFailure";
  }
}

/**
 * Load the session out of whatever is storing it, before anything reads it.
 *
 * A NO-OP IN A BROWSER, where `localStorage` is already synchronous and there is nothing to
 * load. It exists for the host case: a credential store is asynchronous, the four accessors
 * below are not and cannot become so, and the gap is closed by filling a cache once before the
 * first render. `main.tsx` awaits this; nothing else needs to know it happened.
 */
export function hydrateSession(): Promise<void> {
  return hydrateVault([TOKEN_KEY, WORKSPACE_KEY]);
}

export function storedToken(): string | null {
  return readVault(TOKEN_KEY);
}

export function storeToken(token: string | null): void {
  writeVault(TOKEN_KEY, token);
}

/** The workspace this browser was last in, so a reload lands where it left off. */
export function storedWorkspace(): string | null {
  return readVault(WORKSPACE_KEY);
}

export function storeWorkspace(id: string | null): void {
  writeVault(WORKSPACE_KEY, id);
}

async function post<T>(path: string, body: unknown, token?: string | null): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`${apiBase()}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) },
      body: JSON.stringify(body ?? {}),
    });
  } catch (err) {
    // The request never reached a server. Always retryable — this is the offline case, and
    // showing a sign-in screen for it would be a lie about what went wrong.
    throw new AuthFailure((err as Error).message || "could not reach the server", 0, true);
  }
  if (res.ok) return (await res.json()) as T;

  const text = await res.text();
  let message = text.slice(0, 300);
  try {
    message = (JSON.parse(text) as { error?: { message?: string } })?.error?.message ?? message;
  } catch {
    /* not an error envelope; the raw text is the best available */
  }
  // 5xx is ours and may pass; 401/403 is the user's and will not. The server is careful about
  // this distinction too — see the 503 it returns when the ISSUER is unreachable rather than
  // signing everybody out over somebody else's outage.
  throw new AuthFailure(message || res.statusText, res.status, res.status >= 500 || res.status === 429);
}

/**
 * Whether this server has a local issuer — i.e. whether the dev sign-in exists at all.
 *
 * UNREACHABLE IS NOT AN ANSWER, and treating it as one shipped a sign-in screen with no form on
 * it. This function used to return `false` on a thrown fetch, which is the same collapse
 * `AuthFailure.retryable` exists to prevent, in the other direction: "there is no local issuer"
 * and "nothing is listening yet" are different facts, and only the first is a reason to render
 * the external-provider branch — a screen with nothing to click, reached permanently, because
 * the check runs once at mount.
 *
 * IT WAS UNREACHABLE FOR A GOOD REASON. In a browser you start the server and then open the
 * page, so the very first request cannot precede the listener. The desktop shell inverts that:
 * it opens the window BEFORE starting the backend, on purpose, so that a first launch — which
 * unpacks a Node runtime and a Python environment before anything can listen — shows a window
 * with a state in it rather than nothing at all. The cost of that choice is exactly this: for
 * the first few seconds there is no server, and a client that mistook that for a verdict got
 * stuck on it.
 *
 * So: retry while the request cannot be made, and answer the moment one is. An HTTP response of
 * any kind is a real answer — 200 means the issuer is there, 404 means it is not — and neither
 * is retried. The caller renders "Checking how this server signs people in…" throughout, which
 * is the honest description of what is happening.
 */
export async function localIssuerAvailable(): Promise<boolean> {
  // Roughly ninety seconds in total, which is longer than any backend start this has to survive
  // and short enough that a genuinely absent server eventually says so rather than spinning for
  // ever. Bounded rather than infinite: a screen that never resolves is its own kind of stuck.
  const waits = [250, 250, 500, 500, 1000, 1000, 2000, 2000, 2000, 3000, 3000, 3000, 5000, 5000, 5000, 5000, 5000,
                 5000, 5000, 5000, 5000, 5000, 5000, 5000, 5000, 5000, 5000, 5000];
  for (let attempt = 0; ; attempt++) {
    try {
      const res = await fetch(`${apiBase()}/v1/auth/jwks.json`);
      return res.ok;
    } catch {
      // The request never reached a server. Not a verdict — see above.
      if (attempt >= waits.length) return false;
      await new Promise((resolve) => setTimeout(resolve, waits[attempt]));
    }
  }
}

/** Sign in against the local issuer. There is no password; see server/src/auth/localIssuer.ts. */
export async function devSignIn(email: string, name?: string): Promise<string> {
  const out = await post<{ token: string }>("/v1/auth/dev-login", { email, name });
  storeToken(out.token);
  return out.token;
}

/** Exchange the stored token for the account and its workspaces. Provisions on first sight. */
export async function fetchSession(token: string): Promise<SessionView> {
  return post<SessionView>("/v1/auth/session", {}, token);
}

/**
 * Record that the caller has finished onboarding.
 *
 * Sends no user id — the only person it can mark is whoever holds the token, which is why
 * there is nothing here to get wrong. Idempotent on the server, so a second tab or a re-render
 * firing it again is not a problem worth guarding here.
 */
export async function markOnboarded(token: string): Promise<void> {
  await post<{ onboarded: boolean }>("/v1/auth/onboarded", {}, token);
}

/**
 * A single-use ticket for opening one socket.
 *
 * `workspaceId` is a request, not an instruction: the server checks membership and refuses
 * with a 403 if the answer is no. Passing null asks for the default, which the server computes
 * with the same rule it reported in the session — see identity.defaultWorkspace.
 */
export async function fetchTicket(
  token: string,
  workspaceId: string | null,
): Promise<{ ticket: string; workspaceId: string; role: string }> {
  return post("/v1/ws-ticket", workspaceId ? { workspaceId } : {}, token);
}

/**
 * Create a workspace, owned by whoever is signed in.
 *
 * HTTP rather than a socket command for the reason `acceptInvite` is: a socket is scoped to a
 * workspace by its ticket, and this is the request that brings one into existence. Answers with
 * the full workspace list, so the switcher can render the new one without a second round trip.
 *
 * `kind` is deliberately not optional. It decides whether the workspace has a members list, an
 * author column and roles at all — a caller that had not decided should not be able to omit it.
 */
export async function createWorkspace(
  token: string,
  input: { name: string; kind: "personal" | "team" },
): Promise<{
  workspace: { id: string; slug: string; name: string; kind: string };
  role: string;
  workspaces: SessionWorkspace[];
}> {
  return post("/v1/workspaces", input, token);
}

/** Redeem an invitation. Provisions the account first if this is also their first sight. */
export async function acceptInvite(
  token: string,
  inviteToken: string,
): Promise<{ workspace: { id: string; slug: string; name: string }; role: string; workspaces: SessionWorkspace[] }> {
  return post("/v1/invites/accept", { token: inviteToken }, token);
}

/** The socket URL, with a ticket on it. The only place a credential goes in a query string. */
export function socketUrl(ticket: string): string {
  // Derived from `wsOrigin` rather than from `apiBase`. The two are the same origin by
  // construction, but `apiBase` has already rewritten the scheme to http:// — deriving the
  // socket URL back from it would mean spelling that rewrite twice and in opposite directions.
  return `${wsOrigin()}/?ticket=${encodeURIComponent(ticket)}`;
}
