// The client's auth layer, and the one decision it must not get wrong.
//
// "Disconnected" and "unauthorised" arrive at a browser looking identical — a request fails,
// a socket closes — and treating the second as the first produces the worst behaviour this
// client is capable of: retrying a 401 every second, forever, behind a spinner, while the user
// has no idea they need to sign in. `AuthFailure.retryable` is the whole of that decision, and
// this file is what defends it.
//
//   npm run test:auth

import {
  AuthFailure,
  acceptInvite,
  devSignIn,
  fetchSession,
  fetchTicket,
  localIssuerAvailable,
  socketUrl,
  storeToken,
  storeWorkspace,
  storedToken,
  storedWorkspace,
} from "./auth.ts";

let failures = 0;
const check = (ok: boolean, msg: string): void => {
  if (ok) console.log(`  ok   ${msg}`);
  else {
    failures++;
    console.log(`  FAIL ${msg}`);
  }
};

// A localStorage that behaves like the browser's, since this runs under Node.
const store = new Map<string, string>();
(globalThis as { localStorage?: unknown }).localStorage = {
  getItem: (k: string) => store.get(k) ?? null,
  setItem: (k: string, v: string) => void store.set(k, v),
  removeItem: (k: string) => void store.delete(k),
};

interface Call {
  url: string;
  method: string;
  auth: string | null;
  body: unknown;
}
const calls: Call[] = [];
let reply: { status: number; body: unknown } | Error = { status: 200, body: {} };

globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  calls.push({
    url: String(input),
    method: init?.method ?? "GET",
    auth: (init?.headers as Record<string, string>)?.authorization ?? null,
    body: init?.body ? JSON.parse(String(init.body)) : null,
  });
  if (reply instanceof Error) throw reply;
  return new Response(JSON.stringify(reply.body), {
    status: reply.status,
    headers: { "content-type": "application/json" },
  });
}) as typeof fetch;

const failed = async (p: Promise<unknown>): Promise<AuthFailure> =>
  p.then(() => {
    throw new Error("it did NOT fail");
  }).catch((e) => e as AuthFailure);

console.log("\nretry, or stop");
{
  // The two that must STOP. A token that does not verify, and an account that may not be here.
  reply = { status: 401, body: { error: { message: "token has expired" } } };
  const expired = await failed(fetchSession("t"));
  check(expired.status === 401, "a 401 is reported with its status");
  check(expired.retryable === false, "...and is NOT retryable — the fix is to sign in again");
  check(expired.message === "token has expired", "...with the server's own message, from the error envelope");

  reply = { status: 403, body: { error: { message: "you are not a member of that workspace" } } };
  const forbidden = await failed(fetchTicket("t", "ws"));
  check(forbidden.retryable === false, "a 403 is not retryable either — retrying will not make you a member");

  // The three that must RETRY. None of them is the user's fault, and none is fixed by signing
  // in again — showing a sign-in screen for any of them would be a lie about what went wrong.
  reply = { status: 503, body: { error: { message: "cannot reach the issuer's keys" } } };
  const unavailable = await failed(fetchSession("t"));
  check(
    unavailable.retryable === true,
    "a 503 IS retryable — the token may be perfectly good and the ISSUER is what is down",
  );

  reply = { status: 500, body: { error: { message: "boom" } } };
  check((await failed(fetchSession("t"))).retryable === true, "a 500 is retryable — it is our problem, not theirs");

  reply = { status: 429, body: { error: { message: "slow down" } } };
  check((await failed(fetchSession("t"))).retryable === true, "a 429 is retryable — that is what it means");

  reply = new Error("Failed to fetch");
  const offline = await failed(fetchSession("t"));
  check(offline.retryable === true, "a request that never reached a server is retryable — this is being offline");
  check(offline.status === 0, "...and carries no status, because there was no response");
}

console.log("\nrequests");
{
  calls.length = 0;
  reply = { status: 200, body: { token: "minted" } };
  const token = await devSignIn(" Ada@Example.com ", "Ada");
  check(token === "minted", "dev sign-in returns the token");
  check(storedToken() === "minted", "...and stores it, so a reload does not sign you out");
  check(calls[0]?.url.endsWith("/v1/auth/dev-login") === true, "...from the dev-login route");
  check(calls[0]?.auth === null, "...with no Authorization header, because there is no token yet");

  calls.length = 0;
  reply = { status: 200, body: { user: {}, workspaces: [], defaultWorkspaceId: "w", expiresAt: 1 } };
  await fetchSession("abc");
  check(calls[0]?.auth === "Bearer abc", "the session request carries the bearer token");

  calls.length = 0;
  reply = { status: 200, body: { ticket: "tkt", workspaceId: "w1", role: "owner" } };
  await fetchTicket("abc", "w1");
  check(
    JSON.stringify(calls[0]?.body) === JSON.stringify({ workspaceId: "w1" }),
    "asking for a specific workspace sends it",
  );

  calls.length = 0;
  await fetchTicket("abc", null);
  check(
    JSON.stringify(calls[0]?.body) === "{}",
    "asking for no workspace sends nothing, so the SERVER picks — one rule, in one place",
  );

  calls.length = 0;
  reply = { status: 200, body: { workspace: {}, role: "member", workspaces: [] } };
  await acceptInvite("abc", "ws.secret");
  check(calls[0]?.url.endsWith("/v1/invites/accept") === true, "accepting an invite is an HTTP route");
  check(calls[0]?.auth === "Bearer abc", "...authenticated as the person accepting");
  check((calls[0]?.body as { token: string }).token === "ws.secret", "...carrying the invitation token");

  reply = { status: 404, body: {} };
  check((await localIssuerAvailable()) === false, "a 404 on the JWKS route means no local issuer");
  reply = { status: 200, body: { keys: [] } };
  check((await localIssuerAvailable()) === true, "...and a 200 means there is one");

  // UNREACHABLE IS NOT AN ANSWER, and this is the assertion that says so.
  //
  // The desktop shell opens its window BEFORE starting the backend — deliberately, so a first
  // launch that has to unpack a runtime shows a window with a state in it rather than nothing.
  // The cost is that the very first request can precede the listener. A client that read
  // "connection refused" as "there is no local issuer" rendered the external-provider branch,
  // which has no form on it, and the check runs once at mount — so it stayed there. A packaged
  // app that opened, looked correct, and could not be signed into.
  const before = calls.length;
  let refusals = 2;
  reply = new Error("Failed to fetch");
  const pending = localIssuerAvailable();
  // Let it fail twice, then start answering.
  const settle = setInterval(() => {
    if (--refusals <= 0) {
      reply = { status: 200, body: { keys: [] } };
      clearInterval(settle);
    }
  }, 60);
  check(await pending, "a server that is not listening YET is waited for rather than written off");
  check(calls.length > before + 1, `...having asked more than once (${calls.length - before} attempts)`);
}

console.log("\nstorage");
{
  storeToken("abc");
  check(storedToken() === "abc", "a token round-trips");
  storeToken(null);
  check(storedToken() === null, "...and clearing it removes it rather than storing the string 'null'");

  storeWorkspace("w1");
  check(storedWorkspace() === "w1", "the last workspace is remembered, so a reload lands where it left off");
  storeWorkspace(null);
  check(storedWorkspace() === null, "...and is forgotten on sign-out, so the next account does not inherit it");

  // Private browsing throws on every access. A crash here would take the whole app down at
  // the first paint, before anything could say why.
  const real = globalThis.localStorage;
  (globalThis as { localStorage?: unknown }).localStorage = {
    getItem: () => {
      throw new Error("denied");
    },
    setItem: () => {
      throw new Error("denied");
    },
    removeItem: () => {
      throw new Error("denied");
    },
  };
  let survived = true;
  try {
    storeToken("x");
    check(storedToken() === null, "storage that throws reads as absent rather than crashing");
  } catch {
    survived = false;
  }
  check(survived, "...and writing to it does not throw either — private browsing must not break the app");
  (globalThis as { localStorage?: unknown }).localStorage = real;
}

console.log("\nthe socket URL");
{
  const url = socketUrl("a+b/c=");
  check(url.includes("ticket="), "the ticket goes in the query string — the only place a browser can put one");
  check(!url.includes("a+b/c="), "...percent-encoded, so a ticket cannot break out of the parameter");
  check(url.startsWith("ws"), "...on a ws:// URL");
}

console.log(failures === 0 ? "\nALL CORRECT" : `\n${failures} FAILURES`);
(globalThis as { process?: { exit(code: number): void } }).process?.exit(failures === 0 ? 0 : 1);
