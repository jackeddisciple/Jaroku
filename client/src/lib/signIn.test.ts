// The client's half of signing in, and mostly the one value it keeps.
//
// THE NONCE IS WHAT THIS SUITE IS ABOUT. Everything else here is a `fetch` with a body, and the
// interesting properties are all about a 32-byte value that must be unguessable, must survive a
// browser hop and an operating system waking the window back up, must go back to the server at
// exactly the right moment, and must never touch disk.
//
// WHY "NEVER TOUCHES DISK" IS ASSERTED RATHER THAN ASSUMED. `jaroku://` is a URL scheme and any
// program on the machine can register one, so the nonce is what makes an intercepted deep link
// useless — whoever grabbed it cannot produce a value that only ever existed in this process's
// memory. Writing it to `localStorage`, or to the keychain, would hand it to exactly the class of
// program the binding defends against. So the suite installs a `localStorage` that records every
// write and asserts the nonce is never among them — the same shape `test:session-vault` uses for
// the token, against the mirror-image mistake.
//
//   npm run test:auth-sign-in

import {
  SignInFailure,
  clearNonce,
  currentNonce,
  exchangeTicket,
  signInMethods,
  startGoogleSignIn,
} from "./signIn.ts";

let failures = 0;
function check(name: string, ok: boolean): void {
  console.log(`  ${ok ? "ok  " : "FAIL"} ${name}`);
  if (!ok) failures++;
}

// --- the environment these modules expect --------------------------------------------------------

/** Every key anything wrote, and what it wrote. Nothing is ever read back from a real store. */
const written = new Map<string, string>();
const g = globalThis as Record<string, unknown>;
g.localStorage = {
  getItem: (k: string) => written.get(k) ?? null,
  setItem: (k: string, v: string) => void written.set(k, v),
  removeItem: (k: string) => void written.delete(k),
};
// No `__TAURI__`, so `openExternal` takes its browser branch and `sessionVault` takes its
// `localStorage` one — which is what makes this suite runnable under `tsx` at all.
let opened: string[] = [];
g.window = { open: (url: string) => void opened.push(url) };

/** What the next `fetch` answers with, and what it was asked. */
let responder: (url: string, init?: { body?: string }) => { status: number; body: unknown } = () => ({
  status: 200,
  body: {},
});
const asked: { url: string; body: unknown }[] = [];
g.fetch = async (url: string, init?: { body?: string }): Promise<unknown> => {
  const body = init?.body ? (JSON.parse(init.body) as unknown) : null;
  asked.push({ url: String(url), body });
  const answer = responder(String(url), init);
  return {
    ok: answer.status >= 200 && answer.status < 300,
    status: answer.status,
    statusText: "",
    json: async () => answer.body,
    text: async () => JSON.stringify(answer.body),
  };
};

const reset = (): void => {
  asked.length = 0;
  opened = [];
  written.clear();
  clearNonce();
};

// --- what the server says it offers --------------------------------------------------------------

console.log("\nwhich controls the screen is allowed to render");
{
  reset();
  responder = () => ({ status: 200, body: { google: true, magicLink: true, localIssuer: false } });
  const offered = await signInMethods();
  check("a configured server offers both real paths", offered.google && offered.magicLink);
  check("...and says the dev sign-in is not one of them", !offered.localIssuer);
}
{
  reset();
  // A HALF-CONFIGURED SERVER ANSWERS FALSE, which is the whole reason this route exists: a
  // "Continue with Google" that 404s is worse than no Google at all, and the client cannot know
  // without asking.
  responder = () => ({ status: 200, body: { google: false, magicLink: true, localIssuer: true } });
  const offered = await signInMethods();
  check("a server with no Google client offers no Google button", !offered.google);
  check("...while email still works, because neither is a second-class citizen", offered.magicLink);
}
{
  reset();
  // EVERY FAILURE ANSWERS "NOTHING", which is the safe direction: a screen rendering a button the
  // server cannot serve is worse than one rendering fewer. It is also the honest reading of a
  // backend still starting up, which has no Google client loaded either.
  responder = () => ({ status: 500, body: {} });
  const broken = await signInMethods();
  check("a server that errors offers nothing", !broken.google && !broken.magicLink && !broken.localIssuer);

  responder = () => {
    throw new Error("connection refused");
  };
  const absent = await signInMethods();
  check("...and so does one that is not there at all", !absent.google && !absent.magicLink);
}
{
  reset();
  // A truthy value is not `true`. The server sends booleans; anything else is a shell or a proxy
  // that has rewritten the body, and believing it would render a button against a route that may
  // not exist.
  responder = () => ({ status: 200, body: { google: "yes", magicLink: 1, localIssuer: {} } });
  const offered = await signInMethods();
  check("a truthy non-boolean is not read as true", !offered.google && !offered.magicLink && !offered.localIssuer);
}

// --- the nonce ------------------------------------------------------------------------------------

console.log("\nthe value that binds a sign-in to this window");
{
  reset();
  check("nothing is pending before a flow starts", currentNonce() === null);

  responder = () => ({ status: 200, body: { authorizeUrl: "https://accounts.google.com/o/oauth2/v2/auth?x=1" } });
  await startGoogleSignIn();

  const nonce = currentNonce();
  check("starting a flow mints one", typeof nonce === "string" && nonce.length > 0);
  check("...of 32 bytes, base64url", /^[A-Za-z0-9_-]{43}$/.test(nonce ?? ""));
  // The server's `looksLikeSecret` refuses anything else, and a padded or `+/`-flavoured encoding
  // would be refused at the START of the flow with a message about a nonce nobody could act on.
  check("...with no padding, matching the server's own encoding", !(nonce ?? "").includes("="));

  const sent = asked.find((a) => a.url.includes("/oauth/google/start"));
  check("...and it is what the server was told", (sent?.body as { nonce?: string })?.nonce === nonce);
}
{
  reset();
  responder = () => ({ status: 200, body: { authorizeUrl: "https://accounts.google.com/o/oauth2/v2/auth" } });
  await startGoogleSignIn();
  const first = currentNonce();
  await startGoogleSignIn();
  const second = currentNonce();
  check("two flows never share a nonce", first !== second);
  // Somebody who pressed the button, waited, and pressed it again meant the SECOND one. Holding the
  // first would mean the callback from the attempt they actually completed arrives carrying a nonce
  // this window no longer recognises.
  check("...and the newest is the one being waited on", currentNonce() === second);
}
{
  reset();
  responder = () => ({ status: 200, body: { authorizeUrl: "https://accounts.google.com/o/oauth2/v2/auth" } });
  await startGoogleSignIn();
  const nonce = currentNonce()!;
  // THE ASSERTION THIS SUITE EXISTS FOR. See the header: a nonce on disk is a nonce handed to the
  // class of program the binding defends against.
  const stored = [...written.values()].join("|");
  check("the nonce is NEVER written to browser storage", !stored.includes(nonce));
  check("...and nothing at all was written by starting a flow", written.size === 0);
}
{
  reset();
  responder = () => ({ status: 200, body: { authorizeUrl: "https://accounts.google.com/o/oauth2/v2/auth?a=b" } });
  await startGoogleSignIn();
  // §3.2 step 2: the SYSTEM BROWSER, never this webview. In a browser build that is `window.open`;
  // under a host it is a Rust command behind an allowlist. Either way the app does not navigate.
  check("the authorization URL is opened outside this window", opened.length === 1);
  check("...and it is the one the server returned", opened[0] === "https://accounts.google.com/o/oauth2/v2/auth?a=b");
}
{
  reset();
  // A browser that would not open is a machine problem, and the nonce is forgotten rather than
  // left waiting for a callback that cannot arrive.
  g.window = {
    open: () => {
      throw new Error("no browser");
    },
  };
  responder = () => ({ status: 200, body: { authorizeUrl: "https://accounts.google.com/o/oauth2/v2/auth" } });
  let refused: unknown = null;
  try {
    await startGoogleSignIn();
  } catch (err) {
    refused = err;
  }
  check("a browser that will not open is a failure, not a silent no-op", refused instanceof SignInFailure);
  check("...and the pending nonce is dropped rather than left waiting", currentNonce() === null);
  g.window = { open: (url: string) => void opened.push(url) };
}

// --- the exchange ---------------------------------------------------------------------------------

console.log("\nspending a ticket");
{
  reset();
  responder = (url) =>
    url.includes("/oauth/google/start")
      ? { status: 200, body: { authorizeUrl: "https://accounts.google.com/o/oauth2/v2/auth" } }
      : {
          status: 200,
          body: {
            token: "a-real-token",
            expiresAt: 9999999999,
            provider: "google",
            user: { id: "u1", email: "ada@example.com", displayName: "Ada", onboarded: false, isAdmin: false, adminMode: false },
            workspaces: [],
            defaultWorkspaceId: "w1",
          },
        };
  await startGoogleSignIn();
  const nonce = currentNonce();
  const session = await exchangeTicket("ticket-1");

  check("the exchange yields a session", session.user.email === "ada@example.com");
  const sent = asked.find((a) => a.url.endsWith("/v1/auth/session"));
  check("...and the ticket went with it", (sent?.body as { ticket?: string })?.ticket === "ticket-1");
  // §3.2's app-instance binding, spent. The server refuses a Google ticket without a match.
  check("...along with the nonce this window was waiting on", (sent?.body as { nonce?: string })?.nonce === nonce);
  check("the nonce is forgotten once it is spent", currentNonce() === null);
  // §4.4 step 4. `storeToken` goes through the vault, which is the keychain under a host and
  // `localStorage` in a browser — so a successful exchange survives a quit even if the socket that
  // follows it does not open.
  check("the token is stored before anything else can fail", written.get("jaroku.token") === "a-real-token");
}
{
  reset();
  // A magic-link ticket may be spent on a device that never started a flow — §10 calls the
  // cross-device click a feature. The exchange sends whatever it has, which is nothing, and the
  // server requires nothing for that flow.
  responder = () => ({
    status: 200,
    body: {
      token: "t",
      expiresAt: 1,
      provider: "magic_link",
      user: { id: "u", email: "x@y.co", displayName: null, onboarded: true, isAdmin: false, adminMode: false },
      workspaces: [],
      defaultWorkspaceId: "w",
    },
  });
  await exchangeTicket("from-another-device");
  const sent = asked.find((a) => a.url.endsWith("/v1/auth/session"));
  check("a ticket with no pending flow is sent without a nonce", !("nonce" in ((sent?.body as object) ?? {})));
  check("...and still yields a session, which is the cross-device path working", written.has("jaroku.token"));
}
{
  reset();
  // §4.5's first three rows: expired, already used, and forged all produce the same 401 and the
  // same sentence. Telling them apart on this side is what the screen must NOT do.
  responder = () => ({ status: 401, body: { error: { message: "that sign-in link expired or was already used" } } });
  let caught: unknown = null;
  try {
    await exchangeTicket("spent");
  } catch (err) {
    caught = err;
  }
  check("a refused ticket throws", caught instanceof SignInFailure);
  check("...classified as expired, which is the one the screen has a way back from", (caught as SignInFailure).kind === "expired");
  check("...and no token was stored", !written.has("jaroku.token"));
}
{
  reset();
  responder = () => ({ status: 500, body: { error: { message: "the server failed to handle that" } } });
  let caught: unknown = null;
  try {
    await exchangeTicket("x");
  } catch (err) {
    caught = err;
  }
  // A 500 is OURS and may pass; a 401 is the user's and will not. The screen retries one and offers
  // a way back from the other, which is the same distinction `AuthFailure.retryable` draws.
  check("a server error is not an expired ticket", (caught as SignInFailure).kind === "server");

  responder = () => {
    throw new Error("offline");
  };
  try {
    await exchangeTicket("x");
  } catch (err) {
    caught = err;
  }
  check("...and neither is an unreachable server", (caught as SignInFailure).kind === "network");
}

console.log(failures === 0 ? "\nALL CORRECT" : `\n${failures} FAILURES`);
(globalThis as { process?: { exit(code: number): void } }).process?.exit(failures === 0 ? 0 : 1);
