// The client's half of signing in: ask what is offered, start a flow, spend the ticket it produces.
//
// IT SITS BESIDE `auth.ts` RATHER THAN INSIDE IT, and the split is by lifetime. `auth.ts` is what a
// signed-in client does forever — read the token, fetch the session, get a socket ticket — and every
// function in it runs on every reconnect. This is what happens ONCE, before any of that is possible,
// and it is the only module in the client that knows a sign-in has stages.
//
// THE NONCE IS THE ONE PIECE OF STATE THIS MODULE OWNS, and it is the reason the flow is here rather
// than in a component. §3.2 binds the OAuth state to this app instance through a value generated
// locally, kept in memory, and presented again at the exchange — so it has to outlive the button
// that started the flow, outlive the browser hop, outlive the operating system waking the window
// back up, and never touch disk. A module-level variable is exactly that: gone on relaunch, which
// is correct, because a flow that spanned a relaunch is a flow whose ticket expired forty seconds
// into it anyway.
//
// WHY IT MUST NOT TOUCH DISK. `jaroku://` is a URL scheme, and any program on this machine can
// register one. The nonce is what makes an intercepted deep link useless: whoever grabbed it cannot
// produce a value that only ever existed in this process's memory. Writing it to the keychain — or
// worse, to `localStorage` — would hand it to exactly the class of program the binding defends
// against.

import { apiBase, storeToken, type SessionUser, type SessionWorkspace } from "./auth.ts";
import { openExternal } from "./openExternal.ts";

/** Which sign-in paths this server actually has. Every one is a control the screen may render. */
export interface SignInMethods {
  google: boolean;
  magicLink: boolean;
  /** The development sign-in, which on a desktop install is also the real session issuer. */
  localIssuer: boolean;
}

/** What a completed exchange yields: a durable token, and the session that goes with it. */
export interface ExchangedSession {
  token: string;
  expiresAt: number;
  provider: "google" | "magic_link";
  user: SessionUser;
  workspaces: SessionWorkspace[];
  defaultWorkspaceId: string;
}

/**
 * A failure with the one bit a caller needs. Mirrors `AuthFailure` in auth.ts rather than reusing
 * it, because the interesting distinction here is different: `retryable` is about the network, and
 * `expired` is about a ticket, which is not retryable and is not the person's fault either.
 */
export class SignInFailure extends Error {
  constructor(
    message: string,
    readonly kind: "network" | "expired" | "refused" | "server",
  ) {
    super(message);
    this.name = "SignInFailure";
  }
}

async function post<T>(path: string, body: unknown): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`${apiBase()}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body ?? {}),
    });
  } catch (err) {
    throw new SignInFailure((err as Error).message || "could not reach the server", "network");
  }
  if (res.ok) return (await res.json()) as T;

  const text = await res.text();
  let message = text.slice(0, 300);
  try {
    message = (JSON.parse(text) as { error?: { message?: string } })?.error?.message ?? message;
  } catch {
    /* not an error envelope; the raw text is the best available */
  }
  // 401 ON A TICKET EXCHANGE IS `expired`, and telling it apart from every other refusal is the
  // whole of §4.5's failure table on this side: the screen says "that link expired, try signing in
  // again" and offers a way back, rather than "something went wrong" and a dead end.
  const kind = res.status === 401 ? "expired" : res.status >= 500 ? "server" : "refused";
  throw new SignInFailure(message || res.statusText, kind);
}

/**
 * What this server offers, or a conservative default.
 *
 * EVERY FAILURE ANSWERS "NOTHING BUT THE LOCAL ISSUER", which is the safe direction: a screen that
 * renders a button the server cannot serve is worse than one that renders fewer. It is also the
 * honest reading of a server that will not answer — a backend still starting up has no Google
 * client loaded either.
 *
 * IT IS NOT RETRIED HERE. The sign-in screen already has a retry loop of its own around
 * `localIssuerAvailable`, built for the desktop case where the window opens before the backend; the
 * screen calls this after that resolves, by which point there is definitely something listening.
 */
export async function signInMethods(): Promise<SignInMethods> {
  try {
    const res = await fetch(`${apiBase()}/v1/auth/methods`);
    if (!res.ok) return { google: false, magicLink: false, localIssuer: false };
    const value = (await res.json()) as Partial<SignInMethods>;
    return {
      google: value.google === true,
      magicLink: value.magicLink === true,
      localIssuer: value.localIssuer === true,
    };
  } catch {
    return { google: false, magicLink: false, localIssuer: false };
  }
}

// ---------------------------------------------------------------------------------------------
// The nonce. See the header on why it lives here and why it never touches disk.
// ---------------------------------------------------------------------------------------------

let pendingNonce: string | null = null;

/**
 * A fresh nonce for one sign-in attempt, remembered until it is spent.
 *
 * 256 BITS FROM `crypto.getRandomValues`, never `Math.random`. The obvious sentence, written down
 * because the failure is silent: a predictable nonce is one an interceptor can produce, and nothing
 * about the flow looks different when it happens.
 *
 * A SECOND ATTEMPT REPLACES THE FIRST. Somebody who pressed "Continue with Google", waited, and
 * pressed it again meant the second one — and holding the first would mean the callback from the
 * attempt they actually completed arrives carrying a nonce this app no longer recognises.
 */
function newNonce(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  // base64url, matching the server's `mintSecret` exactly — `looksLikeSecret` refuses anything
  // else, and a padded or `+/`-flavoured encoding would be refused at the start of the flow with
  // a message about a nonce nobody could act on.
  const raw = btoa(String.fromCharCode(...bytes));
  pendingNonce = raw.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  return pendingNonce;
}

/** The nonce this window is waiting on, or null. Read by the exchange; never by a component. */
export function currentNonce(): string | null {
  return pendingNonce;
}

/**
 * Forget the pending nonce.
 *
 * Called after an exchange succeeds or definitively fails, and on sign-out. A nonce kept past its
 * flow is a value sitting in memory that would let a LATER intercepted ticket be spent — which is
 * the exact opposite of what it is for.
 */
export function clearNonce(): void {
  pendingNonce = null;
}

// ---------------------------------------------------------------------------------------------
// The flows.
// ---------------------------------------------------------------------------------------------

/**
 * Start a Google sign-in: ask the server for a URL, open it in the user's own browser.
 *
 * THE SYSTEM BROWSER, NOT THIS WEBVIEW, and it is not a preference. Google's own policy refuses
 * OAuth from an embedded webview — a webview is a browser the host application can read the
 * contents of, which is precisely what an identity flow must not permit — and a packaged app that
 * navigated itself to `accounts.google.com` would have no route back, because the return trip is a
 * web origin trying to load a `tauri://` one. `openExternal` is the hop, behind a host allowlist
 * the page cannot influence.
 *
 * Returns nothing on success; what happens next arrives as a deep link. A promise that resolved
 * when the person finished signing in would be a promise that never settles when they close the
 * tab, which is a real and common outcome.
 */
export async function startGoogleSignIn(): Promise<void> {
  const nonce = newNonce();
  const { authorizeUrl } = await post<{ authorizeUrl: string }>("/v1/auth/oauth/google/start", { nonce });
  const opened = await openExternal(authorizeUrl);
  if (!opened) {
    clearNonce();
    // A browser that would not open is a machine problem rather than a sign-in problem, and the
    // message says so — the alternative is a button that appears to do nothing.
    throw new SignInFailure("could not open your browser — check that one is set as the default", "refused");
  }
}

/** What the server says about a link it accepted. Never whether the address has an account. */
export interface MagicLinkSent {
  /** How long the link lasts, from the server, so the screen and the token cannot disagree. */
  expiresInMinutes: number;
}

/**
 * §3.3 steps 1 and 2. Ask for a sign-in link.
 *
 * IT RESOLVES FOR AN ADDRESS THAT HAS NO ACCOUNT, and that is the point rather than a limitation.
 * The server answers 200 whether or not anybody owns the address, so this client cannot tell — and
 * must not try. A screen that showed "no account with that address" would turn one request into a
 * way for anybody to test whether a given person uses Jaroku.
 *
 * THREE FAILURES ARE STILL FAILURES, and each says something about the REQUEST rather than about a
 * person: a malformed address (400), too many attempts (429), and a mail provider that is down
 * (502). §10 asks for the last one specifically — "Do not silently fail" — because a confirmation
 * screen for a message nothing dispatched is the worst outcome available here.
 */
export async function requestMagicLink(email: string): Promise<MagicLinkSent> {
  const sent = await post<{ expiresInMinutes?: number }>("/v1/auth/magic-link", { email });
  return {
    // Defaulted rather than trusted blindly: a server that answered without the field would
    // otherwise put "expires in undefined minutes" on a screen.
    expiresInMinutes: typeof sent.expiresInMinutes === "number" && sent.expiresInMinutes > 0 ? sent.expiresInMinutes : 15,
  };
}

/**
 * Spend a ticket for a session. §4.4, and the last step of both flows.
 *
 * THE NONCE GOES WITH IT WHEN THERE IS ONE. A Google ticket is bound to the window that started the
 * flow and the server refuses it without a match; a magic-link ticket is deliberately unbound, so
 * that clicking a link on a second device signs that device in — §10 calls this a feature, and it
 * is. Sending a nonce the server is not expecting is harmless, so this always sends whatever it has
 * rather than branching on which flow produced the ticket, which is a fact the client does not have
 * until after the exchange.
 *
 * THE TOKEN IS STORED HERE, immediately, before anything else can fail. §4.4 step 4: OS-native
 * secure storage, never `localStorage` and never a plain file. `storeToken` goes through
 * `sessionVault`, which is the keychain under a host and unchanged in a browser — so a successful
 * exchange survives the app being quit even if the socket that follows it does not open.
 */
export async function exchangeTicket(ticket: string): Promise<ExchangedSession> {
  const nonce = currentNonce();
  const session = await post<ExchangedSession>("/v1/auth/session", nonce ? { ticket, nonce } : { ticket });
  clearNonce();
  storeToken(session.token);
  return session;
}
