// What `jaroku://auth/...` means, and when the app is allowed to act on one.
//
// `deepLink.ts` proves a URL is ours and refuses everything it does not recognise; it stops
// deliberately short of deciding what a recognised one is FOR. This is that decision for the one
// action authentication owns, and it is a separate module for the reason the parser is separate
// from the shell: the rule is the valuable part, the rule is pure, and a rule that can only be
// exercised by launching a desktop application and completing a real OAuth round trip is a rule
// nobody exercises.
//
// TWO THINGS LIVE HERE AND THEY ARE NOT THE SAME THING.
//
//   THE READING. `jaroku://auth/complete?ticket=<ticket>` is the only auth link this application
//   understands. Both the OAuth callback (§3.2 step 5) and the magic-link callback (§3.3 step 7)
//   redirect to exactly it, because by the time either reaches this side they have become the
//   same fact — a single-use, sixty-second ticket that can be exchanged for a session. Nothing
//   downstream needs to know which provider produced one, and a client that branched on it would
//   be a client that can be told which branch to take by whoever sent the link.
//
//   THE GATE. A link can arrive before there is anywhere to put it. The operating system starts
//   this application WITH the URL when it is not running (see deeplink.rs), and on that launch
//   first-run may not be finished — there may be no Python runtime, no checkpoint database and no
//   backend listening. §4.5 is explicit: queue it, complete first-run, then process it on the
//   transition to sign-in. So this module holds at most one pending callback and hands it over
//   when, and only when, something says it is ready to spend it.
//
// AT MOST ONE, AND THE NEWEST WINS. A ticket is worth sixty seconds and is worth nothing twice,
// so a queue of them is a queue of values that are already dead. Somebody who clicked a magic
// link, waited, and clicked a second one meant the second — holding the first and redeeming it
// would show them "that link expired" for a link they abandoned on purpose.

import { parseDeepLink, type DeepLink } from "./deepLink.ts";

/**
 * The path segment that means "a sign-in finished somewhere else and here is the proof".
 *
 * Spelled once, here, and asserted against `server/src/auth/authTickets.ts`'s own constant by
 * `test:desktop-contract` — the redirect is built on the server and read here, across a seam that
 * nothing typechecks, and a rename on one side produces a link that silently does nothing.
 */
export const AUTH_COMPLETE = "complete";

/**
 * A ticket, as it arrived.
 *
 * The RAW value, unvalidated beyond its shape. Whether it is real is the server's question — it
 * is signed, single-use and expiring, and every one of those is checked where the secret is. A
 * client that pre-judged one would either be duplicating that check badly or refusing a good
 * ticket for a reason it cannot possibly know.
 */
export interface AuthCallback {
  ticket: string;
}

/**
 * The widest a ticket may be before this stops looking at it.
 *
 * The server mints 32 bytes as base64url, which is 43 characters. This is not that number: a
 * bound here is a bound on what reaches `fetch` from a URL any program on the machine can open,
 * and pinning it to the exact width would mean a server that widened its tickets by one byte
 * produced links this build refuses. Generous, and still a number.
 */
const TICKET_MAX = 256;

/**
 * Read an auth callback out of a parsed link, or answer `null`.
 *
 * `null` FOR EVERY REFUSAL, and the refusals are the interesting half. §4.5's last row says a
 * malformed deep link is ignored and logged, never error-toasted: a browser or an OS quirk should
 * not arrive as a scary message, and the person who sees it did nothing wrong. So a link that is
 * not `auth`, an `auth` link naming some other path, and an `auth/complete` with no usable ticket
 * all produce the same nothing.
 */
export function readAuthCallback(link: DeepLink | null): AuthCallback | null {
  if (!link || link.action !== "auth") return null;
  // EXACTLY ONE SEGMENT, MATCHED WHOLE. `auth/complete/anything` is not this link — it is a link
  // somebody built, and the only safe reading of a shape this application does not produce is
  // that it was not produced by this application.
  if (link.path.length !== 1 || link.path[0] !== AUTH_COMPLETE) return null;

  const ticket = link.params.ticket;
  if (typeof ticket !== "string") return null;
  // Trimmed before the emptiness check, because a mail client that wrapped the URL can leave
  // whitespace inside the parameter and a ticket with a trailing newline is a ticket the server
  // will refuse for a reason nobody could diagnose from the message it gets back.
  const trimmed = ticket.trim();
  if (trimmed === "" || trimmed.length > TICKET_MAX) return null;
  return { ticket: trimmed };
}

/** The same reading, straight from the URL. What `main.tsx` and the tests both actually call. */
export function readAuthLink(raw: unknown): AuthCallback | null {
  return readAuthCallback(parseDeepLink(raw));
}

// ---------------------------------------------------------------------------------------------
// The gate. See the header: a callback can arrive before there is anywhere to put it.
// ---------------------------------------------------------------------------------------------

/** The one pending callback, or none. See the header on why one rather than a queue. */
let held: AuthCallback | null = null;
/** Who wants it, once there is somebody. Null while the app is not ready to spend a ticket. */
let consumer: ((callback: AuthCallback) => void) | null = null;

/**
 * Offer a callback to whoever is ready for one, or hold it until somebody is.
 *
 * Called from the deep-link subscription, which lives for the whole life of the page.
 */
export function offerAuthCallback(callback: AuthCallback): void {
  if (consumer) {
    consumer(callback);
    return;
  }
  held = callback;
}

/**
 * Say that the app can now act on a sign-in.
 *
 * Returns a function that takes the readiness back — which is not tidiness. Ticket exchange is
 * only meaningful on the sign-in screen: a callback arriving while the main app is up is §4.5's
 * "a different user is signed in" row and needs a prompt rather than a silent swap, and that is a
 * different consumer with a different question. Handing readiness back means only one screen at a
 * time claims the right to spend a ticket.
 *
 * ANYTHING HELD IS DELIVERED IMMEDIATELY, synchronously, before this returns. That is the whole
 * of §4.5's queue row: first-run finishes, the sign-in screen mounts, and the link that started
 * the application is spent on the first frame it could possibly have been spent on.
 */
export function onAuthCallback(handler: (callback: AuthCallback) => void): () => void {
  consumer = handler;
  if (held) {
    const pending = held;
    // CLEARED BEFORE THE HANDLER RUNS, not after. The handler exchanges the ticket and the
    // exchange can fail; a failure that left the callback in the slot would re-deliver a ticket
    // the server has already consumed to the next screen that mounted, which is a "that link
    // expired" somebody would see twice for one click.
    held = null;
    handler(pending);
  }
  return () => {
    if (consumer === handler) consumer = null;
  };
}

/**
 * Forget anything held. Sign-out, and the tests.
 *
 * Sign-out is the real caller. A ticket held for a screen that never mounted is a credential
 * sitting in a module for as long as the window is open, and the moment somebody deliberately
 * ends a session is the moment the last thing that should happen is a stale sign-in completing.
 */
export function clearAuthCallback(): void {
  held = null;
}

/** Whether something is waiting. For the first-run screens, which say so rather than surprising. */
export function authCallbackPending(): boolean {
  return held !== null;
}
