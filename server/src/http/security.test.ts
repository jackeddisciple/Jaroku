// What a browser is told about every response, and what happens to a request that never ends.
//
// Run against a real socket for the same reason http/router.test.ts is: a header set is a claim
// about what arrives at a client, and asserting it on an object the code just built is asserting
// that the code did what it says rather than that the wire carries it.
//
// THE ONE THING THIS SUITE CANNOT ASSERT is that a browser obeys any of it. A CSP is an
// instruction, not an enforcement, and a policy that is wrong in a way no header test can see —
// too loose, or naming a directive this browser does not know — still passes here. What this
// defends is the property that is actually ours: that the headers are present on EVERY answer,
// including the failures, the preflights and the fallthroughs, since a missing policy on the
// 500 path is exactly the one nobody notices.
//
//   npm run test:security-headers

import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { HttpError, Router } from "./router.ts";
import {
  API_SECURITY_HEADERS,
  DEFAULT_HANDLER_TIMEOUT_MS,
  DOCUMENT_SECURITY_HEADERS,
  HSTS_PRELOAD_ENV,
  HSTS_SUBDOMAINS_ENV,
  TLS_ENV,
  documentSecurityHeaders,
  securityHeaders,
} from "./security.ts";

let failures = 0;
const check = (ok: boolean, msg: string): void => {
  if (ok) console.log(`  ok   ${msg}`);
  else {
    failures++;
    console.log(`  FAIL ${msg}`);
  }
};

// --- the header set, as data ------------------------------------------------------------------

console.log("\nthe header set");
{
  const plain = securityHeaders({});
  check(!("strict-transport-security" in plain), "HSTS is absent unless the deployment says it is HTTPS");
  check(
    plain["content-security-policy"] === "default-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'",
    "the API policy permits nothing at all",
  );
  check(plain["x-content-type-options"] === "nosniff", "a declared content type is not a suggestion");
  check(plain["referrer-policy"] === "no-referrer", "a URL carrying a ws-ticket is never sent onward as a referrer");
  check(plain["x-frame-options"] === "DENY", "...and the old framing header rides along for browsers that only know it");

  const tls = securityHeaders({ [TLS_ENV]: "1" });
  check(tls["strict-transport-security"] === "max-age=63072000", "JAROKU_PUBLIC_TLS turns HSTS on");
  check(
    !tls["strict-transport-security"]!.includes("includeSubDomains"),
    "...without claiming anything about hostnames this process cannot see",
  );
  const wide = securityHeaders({ [TLS_ENV]: "1", [HSTS_SUBDOMAINS_ENV]: "1", [HSTS_PRELOAD_ENV]: "1" });
  check(
    wide["strict-transport-security"] === "max-age=63072000; includeSubDomains; preload",
    "...and both wider promises are separate, explicit opt-ins",
  );
  check(
    securityHeaders({ [HSTS_SUBDOMAINS_ENV]: "1" })["strict-transport-security"] === undefined,
    "subdomains alone does not imply TLS — the switch that matters is the one that says HTTPS",
  );

  const doc = documentSecurityHeaders({ [TLS_ENV]: "1" });
  check(doc["content-security-policy"]!.includes("'unsafe-inline'"), "the document policy admits the inline client");
  check(doc["content-security-policy"]!.startsWith("default-src 'none'"), "...on top of a base that admits nothing");
  check(doc["content-security-policy"]!.includes("connect-src 'self'"), "...and lets it reach only this origin's socket");
  check(
    !doc["content-security-policy"]!.includes("script-src 'self' https:"),
    "...and never a remote script source",
  );
  check(doc["strict-transport-security"] === "max-age=63072000", "one TLS decision, not two");

  // Frozen, so nothing can weaken the policy by assigning to the shared object at runtime.
  const before = API_SECURITY_HEADERS["content-security-policy"];
  try {
    (API_SECURITY_HEADERS as Record<string, string>)["content-security-policy"] = "default-src *";
  } catch {
    /* strict mode throws; sloppy mode ignores. Either is fine — the assertion is the value. */
  }
  check(API_SECURITY_HEADERS["content-security-policy"] === before, "the shared header set cannot be rewritten in place");
  check(Object.isFrozen(DOCUMENT_SECURITY_HEADERS), "...nor the document one");
}

// --- on the wire ------------------------------------------------------------------------------

const router = new Router({
  log: () => {},
  quiet: () => true,
  cors: { allows: (o) => o === undefined || o === "http://localhost:5173" },
  securityHeaders: securityHeaders({ [TLS_ENV]: "1" }),
  // Short, so the deadline assertions below take a moment rather than a quarter of a minute.
  defaultTimeoutMs: 150,
});
router.get("/ok", () => ({ body: { ok: true } }));
router.get("/refused", () => {
  throw new HttpError(402, "payment_required", "a message meant for a person");
});
router.get("/boom", () => {
  throw new Error("a secret about the inside of the server");
});
router.get("/bytes", () => ({ body: Buffer.from("not json"), headers: { "content-type": "text/plain" } }));
router.get("/forever", () => new Promise<never>(() => {}));
router.get("/patient", () => new Promise((resolve) => setTimeout(() => resolve({ body: { ok: true } }), 300)), {
  timeoutMs: 2_000,
});

// The router, then the static fallthrough — the same two-step wsRelay.serveHttp performs, and
// mirrored here because the fallthrough is a real response surface with its own policy: a path
// the router does not claim is answered by whoever is behind it, and "behind it" is where the
// debug client lives.
const http = createServer((req, res) => {
  void router.handle(req, res).then((handled) => {
    if (!handled) res.writeHead(404, documentSecurityHeaders({ [TLS_ENV]: "1" })).end("fell through");
  });
});
await new Promise<void>((resolve) => http.listen(0, "127.0.0.1", resolve));
const base = `http://127.0.0.1:${(http.address() as AddressInfo).port}`;

const call = async (
  method: string,
  path: string,
  headers: Record<string, string> = {},
): Promise<Response> => fetch(`${base}${path}`, { method, headers });

const carriesPolicy = (res: Response): boolean =>
  res.headers.get("content-security-policy") === API_SECURITY_HEADERS["content-security-policy"] &&
  res.headers.get("x-content-type-options") === "nosniff" &&
  res.headers.get("referrer-policy") === "no-referrer" &&
  res.headers.get("x-frame-options") === "DENY" &&
  res.headers.get("strict-transport-security") === "max-age=63072000";

console.log("\nevery answer, including the ones nobody looks at");
{
  check(carriesPolicy(await call("GET", "/ok")), "a 200 carries the policy");
  check(carriesPolicy(await call("GET", "/refused")), "a deliberate 402 carries it");
  check(carriesPolicy(await call("GET", "/boom")), "an unexpected 500 carries it — the response nobody remembers");
  const fell = await call("GET", "/nope");
  check(
    fell.headers.get("content-security-policy") === DOCUMENT_SECURITY_HEADERS["content-security-policy"] &&
      fell.headers.get("x-content-type-options") === "nosniff",
    "a path the router does not claim falls through to a response that still carries a policy",
  );
  check(carriesPolicy(await call("POST", "/ok")), "a 405 carries it");
  check(
    carriesPolicy(await call("OPTIONS", "/ok", { origin: "http://localhost:5173" })),
    "a CORS preflight carries it",
  );

  const bytes = await call("GET", "/bytes");
  check(bytes.headers.get("content-type") === "text/plain", "a route's own content-type survives the policy set");
  check(carriesPolicy(bytes), "...and the policy is on it anyway");

  const cors = await call("GET", "/ok", { origin: "http://localhost:5173" });
  check(
    cors.headers.get("access-control-allow-origin") === "http://localhost:5173" && carriesPolicy(cors),
    "CORS and the policy set coexist — they answer different questions",
  );
}

console.log("\ndeadlines");
{
  const started = Date.now();
  const res = await call("GET", "/forever");
  const elapsed = Date.now() - started;
  check(res.status === 504, "a handler that never answers is answered without it");
  const body = (await res.json()) as { error?: { code?: string } };
  check(body.error?.code === "handler_timeout", "...with a code a client can branch on");
  check(elapsed < 2_000, `...promptly (${elapsed}ms)`);
  check(carriesPolicy(res), "...and the timeout answer carries the policy too");

  const patient = await call("GET", "/patient");
  check(patient.status === 200, "a route that states its own longer deadline is not cut off at the default");

  check(DEFAULT_HANDLER_TIMEOUT_MS >= 10_000, "the shipped default is generous enough for a real query");
  check(DEFAULT_HANDLER_TIMEOUT_MS <= 60_000, "...and short enough that a wedged one does not hold a socket forever");
}

console.log("\nread timeouts");
{
  // The slowloris case, end to end: a request that declares a body and then does not send it.
  // Node's own `requestTimeout` is what closes this, and the assertion is that the socket does
  // not simply sit there — a connection an attacker holds for free is the whole attack.
  //
  // THE HANDLER READS THE BODY, and that detail is the test. Node hands a request to the
  // listener as soon as the HEADERS are in, so a handler that ignores the body answers 200 to a
  // request that was never finished and the connection sails on — which is what this suite
  // asserted, wrongly, until the harness was made to read like the router does.
  //
  // The interval is here for the same reason it is in wsRelay: without it Node sweeps every
  // thirty seconds and these numbers mean nothing.
  const server = createServer(
    { headersTimeout: 1_000, requestTimeout: 1_500, connectionsCheckingInterval: 200 },
    async (req, res) => {
      try {
        for await (const _ of req) {
          /* drain, exactly as readJson does */
        }
      } catch {
        /* the connection was reaped mid-body, which is the point */
      }
      if (!res.writableEnded) res.writeHead(200).end("ok");
    },
  );
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;

  const { Socket } = await import("node:net");
  const socket = new Socket();
  let answer = "";
  // THE SOCKET HAS TO BE READ FROM. A paused stream never processes the peer's FIN, so a
  // connection the server hung up on ten seconds ago still looks open from here — which made an
  // earlier version of this test fail against a server that was behaving correctly.
  socket.on("data", (chunk: Buffer) => {
    answer += chunk.toString();
  });
  const closed = new Promise<string>((resolve) => {
    socket.on("close", () => resolve("closed"));
    socket.on("error", () => resolve("closed"));
    setTimeout(() => resolve("still open"), 8_000);
  });
  socket.connect(port, "127.0.0.1", () => {
    socket.write("POST /slow HTTP/1.1\r\nHost: x\r\nContent-Length: 100\r\n\r\n");
    socket.write("a"); // ...and then nothing, forever.
  });
  check((await closed) === "closed", "a half-sent request is hung up on rather than held");
  check(answer.startsWith("HTTP/1.1 408"), `...with a 408 rather than a silent drop (${answer.split("\r\n")[0]})`);
  socket.destroy();
  server.close();
}

http.close();
console.log(failures === 0 ? "\nALL CORRECT" : `\n${failures} FAILURES`);
process.exit(failures === 0 ? 0 : 1);
