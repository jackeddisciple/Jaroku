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
// Nothing here is provider-specific. Swapping in Clerk's SDK means changing `acquireToken`,
// and the two functions below it do not know the difference.

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

const BASE = viteEnv("VITE_JAROKU_API") ?? inferBase();

/** The API origin, derived from the socket URL so one variable configures both. */
function inferBase(): string {
  const ws = viteEnv("VITE_JAROKU_WS") ?? "ws://localhost:4317";
  return ws.replace(/^ws/, "http").replace(/\/+$/, "");
}

const TOKEN_KEY = "jaroku.token";
const WORKSPACE_KEY = "jaroku.workspace";

export interface SessionUser {
  id: string;
  email: string;
  displayName: string | null;
}

export interface SessionWorkspace {
  id: string;
  slug: string;
  name: string;
  kind: string;
  role: string;
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

export function storedToken(): string | null {
  try {
    return localStorage.getItem(TOKEN_KEY);
  } catch {
    // Private browsing, or storage disabled. Not fatal: the session lives in memory for as
    // long as the tab does, and a reload asks again.
    return null;
  }
}

export function storeToken(token: string | null): void {
  try {
    if (token === null) localStorage.removeItem(TOKEN_KEY);
    else localStorage.setItem(TOKEN_KEY, token);
  } catch {
    /* see storedToken */
  }
}

/** The workspace this browser was last in, so a reload lands where it left off. */
export function storedWorkspace(): string | null {
  try {
    return localStorage.getItem(WORKSPACE_KEY);
  } catch {
    return null;
  }
}

export function storeWorkspace(id: string | null): void {
  try {
    if (id === null) localStorage.removeItem(WORKSPACE_KEY);
    else localStorage.setItem(WORKSPACE_KEY, id);
  } catch {
    /* see storedToken */
  }
}

async function post<T>(path: string, body: unknown, token?: string | null): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`${BASE}${path}`, {
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

/** Whether this server has a local issuer — i.e. whether the dev sign-in exists at all. */
export async function localIssuerAvailable(): Promise<boolean> {
  try {
    const res = await fetch(`${BASE}/v1/auth/jwks.json`);
    return res.ok;
  } catch {
    return false;
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

/** Redeem an invitation. Provisions the account first if this is also their first sight. */
export async function acceptInvite(
  token: string,
  inviteToken: string,
): Promise<{ workspace: { id: string; slug: string; name: string }; role: string; workspaces: SessionWorkspace[] }> {
  return post("/v1/invites/accept", { token: inviteToken }, token);
}

/** The socket URL, with a ticket on it. The only place a credential goes in a query string. */
export function socketUrl(ticket: string): string {
  const base = viteEnv("VITE_JAROKU_WS") ?? "ws://localhost:4317";
  return `${base.replace(/\/+$/, "")}/?ticket=${encodeURIComponent(ticket)}`;
}
