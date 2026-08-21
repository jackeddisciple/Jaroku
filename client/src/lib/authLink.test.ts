// What a sign-in link is allowed to say, and when the app is allowed to believe it.
//
// Every URL this reads came from outside the application — any program on the machine can open a
// `jaroku://` URL, and so can a web page somebody clicked — so most of this suite is refusals.
// The assertion that matters most is the near-miss: `auth/completed`, `auth/complete/extra` and
// `auth` alone are all shapes this application never produces, and a reader that matched on a
// prefix would hand the ticket exchange somebody else's word.
//
// The second half is the queue, which exists for one case nothing else in this client has: the
// operating system starts the app WITH the URL when it is not running, so the callback arrives
// before first-run has finished and before any screen could act on it. Its load-bearing property
// is that a held callback is delivered SYNCHRONOUSLY the moment a consumer appears, and exactly
// once — a ticket redelivered after a failed exchange is a "that link expired" somebody sees
// twice for one click.
//
//   npm run test:auth-link

import {
  AUTH_COMPLETE,
  authCallbackPending,
  clearAuthCallback,
  offerAuthCallback,
  onAuthCallback,
  readAuthLink,
} from "./authLink.ts";

let failures = 0;
function check(name: string, ok: boolean): void {
  console.log(`  ${ok ? "ok  " : "FAIL"} ${name}`);
  if (!ok) failures++;
}

console.log("\nthe link both providers come back through");
{
  // §3.2 step 5 and §3.3 step 7 redirect to the same URL on purpose: by the time either reaches
  // this side it has become one fact, a single-use ticket, and a client that could tell them
  // apart would be a client somebody could tell which branch to take.
  const google = readAuthLink("jaroku://auth/complete?ticket=abc123");
  check("an OAuth callback yields its ticket", google?.ticket === "abc123");
  const magic = readAuthLink("jaroku://auth/complete?ticket=abc123");
  check("...and a magic-link callback is indistinguishable from it", magic?.ticket === google?.ticket);

  check("the path segment is the one the server redirects to", AUTH_COMPLETE === "complete");
}
{
  // Some mail clients rewrite the URL into the slashless form. `deepLink.ts` already handles it;
  // this asserts the auth reading survives the rewrite, because a magic link that works for most
  // people and fails for one mail client is the hardest kind of report to act on.
  const link = readAuthLink("jaroku:auth/complete?ticket=xyz");
  check("a slashless jaroku:auth/complete parses the same way", link?.ticket === "xyz");
}
{
  const link = readAuthLink("jaroku://auth/complete?ticket=a-b_c&state=ignored");
  check("a base64url ticket survives intact", link?.ticket === "a-b_c");
  check("...and nothing else in the query is read", Object.keys(link ?? {}).join(",") === "ticket");
}
{
  // A mail client that wrapped the URL can leave whitespace inside the parameter. Trimmed here
  // rather than sent, because a ticket with a trailing newline is refused by the server for a
  // reason nobody could diagnose from the message that comes back.
  const link = readAuthLink("jaroku://auth/complete?ticket=%20abc%0A");
  check("surrounding whitespace is trimmed off a ticket", link?.ticket === "abc");
}

console.log("\nwhat is not a sign-in link");
{
  check("a link with no ticket is refused", readAuthLink("jaroku://auth/complete") === null);
  check("...and one whose ticket is empty", readAuthLink("jaroku://auth/complete?ticket=") === null);
  check(
    "...and one whose ticket is only whitespace",
    readAuthLink("jaroku://auth/complete?ticket=%20%20") === null,
  );
  // A bound on what reaches `fetch` from a URL anybody on the machine can open.
  check(
    "an absurdly long ticket is refused on shape, before anything sends it",
    readAuthLink(`jaroku://auth/complete?ticket=${"a".repeat(300)}`) === null,
  );
}
{
  // THE NEAR-MISSES. Each of these is a shape this application never produces, and each would be
  // accepted by a reader that matched on a prefix or on the action alone.
  check("auth with no path is not a callback", readAuthLink("jaroku://auth?ticket=abc") === null);
  check("auth/completed is not auth/complete", readAuthLink("jaroku://auth/completed?ticket=abc") === null);
  check("auth/complete/extra is not auth/complete", readAuthLink("jaroku://auth/complete/extra?ticket=abc") === null);
  check("auth/callback is not the path the server redirects to", readAuthLink("jaroku://auth/callback?ticket=abc") === null);
}
{
  check("a billing link is not a sign-in", readAuthLink("jaroku://billing/success?ticket=abc") === null);
  check("another scheme is not ours", readAuthLink("https://auth.jaroku.dev/magic?ticket=abc") === null);
  check("nonsense is refused rather than parsed halfway", readAuthLink("not a url") === null);
  check("nothing at all is refused", readAuthLink(null) === null);
}

console.log("\nthe queue, which is what §4.5 asks for by name");
{
  clearAuthCallback();
  check("nothing is pending to begin with", !authCallbackPending());

  // The not-running case: the OS starts the app with the URL, first-run is still going, and there
  // is no screen that could spend a ticket. It is held rather than dropped.
  offerAuthCallback({ ticket: "held-1" });
  check("a callback arriving with no consumer is held", authCallbackPending());

  const seen: string[] = [];
  const stop = onAuthCallback((cb) => seen.push(cb.ticket));
  // SYNCHRONOUSLY, before `onAuthCallback` returned. First-run finishes, the sign-in screen
  // mounts, and the link that started the application is spent on the first frame it could be.
  check("...and delivered the moment a consumer appears", seen.join(",") === "held-1");
  check("...leaving nothing pending behind it", !authCallbackPending());

  // Cleared BEFORE the handler ran, so a handler that throws — an exchange that failed — cannot
  // leave a consumed ticket in the slot for the next screen to redeem again.
  const again: string[] = [];
  onAuthCallback((cb) => again.push(cb.ticket));
  check("...and never delivered twice", again.length === 0);
  stop();
}
{
  clearAuthCallback();
  const seen: string[] = [];
  const stop = onAuthCallback((cb) => seen.push(cb.ticket));
  offerAuthCallback({ ticket: "live-1" });
  check("a callback arriving with a consumer goes straight through", seen.join(",") === "live-1");
  check("...and is not also held", !authCallbackPending());

  // Readiness is handed back when the screen that claimed it goes away. Ticket exchange only
  // means something on the sign-in screen; a callback arriving while somebody else is signed in
  // is a different question with a different answer, and it must not be answered by this handler.
  stop();
  offerAuthCallback({ ticket: "after-1" });
  check("once readiness is given back, a callback is held again", authCallbackPending());
  check("...and does not reach the screen that unmounted", seen.join(",") === "live-1");
}
{
  clearAuthCallback();
  // AT MOST ONE, NEWEST WINS. A ticket is worth sixty seconds and worth nothing twice, so a queue
  // of them is a queue of dead values — and somebody who clicked a second magic link meant the
  // second one. Redeeming the first would show them "that link expired" for a link they abandoned.
  offerAuthCallback({ ticket: "old" });
  offerAuthCallback({ ticket: "new" });
  const seen: string[] = [];
  onAuthCallback((cb) => seen.push(cb.ticket));
  check("only the most recent held callback is delivered", seen.join(",") === "new");
}
{
  clearAuthCallback();
  offerAuthCallback({ ticket: "abandoned" });
  // Sign-out is the real caller. A ticket held for a screen that never mounted is a credential
  // sitting in a module for as long as the window is open.
  clearAuthCallback();
  const seen: string[] = [];
  onAuthCallback((cb) => seen.push(cb.ticket));
  check("clearing forgets what was held", seen.length === 0);
}

console.log(failures === 0 ? "\nALL CORRECT" : `\n${failures} FAILURES`);
// Reached through the global rather than as a bare `process`, exactly as the sibling suites do:
// this package has no `@types/node` on purpose, so that a component which reaches for `process`
// fails to compile rather than shipping.
(globalThis as { process?: { exit(code: number): void } }).process?.exit(failures === 0 ? 0 : 1);
