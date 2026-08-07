// The HTTP layer, exercised against a real socket.
//
// A router is the kind of module that looks obviously correct and is wrong at the edges, and
// every edge here is one somebody reaches from outside: an oversized body, a body that is not
// JSON, a path that exists under another verb, a handler that throws something that is not an
// HttpError. So this listens on a real ephemeral port and makes real requests rather than
// handing fake objects to `handle()` — the parts most worth testing are the parts that only
// exist once there is a socket.
//
//   npm run test:http

import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { HttpError, MAX_BODY_BYTES, Router, badRequest, unauthorized } from "./router.ts";
import { healthz, readyz } from "./health.ts";

let failures = 0;
const check = (ok: boolean, msg: string): void => {
  if (ok) console.log(`  ok   ${msg}`);
  else {
    failures++;
    console.log(`  FAIL ${msg}`);
  }
};

const logged: string[] = [];
const router = new Router({ log: (line) => logged.push(line), quiet: () => false });

router.get("/healthz", healthz());
router.get("/readyz", readyz({ dialect: "sqlite", probe: async () => 1 }));
router.get("/slow", readyz({ dialect: "postgres", probe: () => new Promise(() => {}) }));
router.get("/boom", () => {
  throw new Error("a secret about the inside of the server");
});
router.get("/refused", () => {
  throw new HttpError(402, "payment_required", "a message meant for a person");
});
router.post("/echo", async (req) => ({ body: { got: await req.json() } }));
router.post("/strict", async (req) => {
  const body = await req.json<{ name?: unknown }>();
  if (typeof body.name !== "string") throw badRequest("name must be a string");
  return { body: { name: body.name } };
});
router.post("/empty", () => ({}));

const http = createServer((req, res) => {
  void router.handle(req, res).then((handled) => {
    if (!handled) res.writeHead(404).end("fell through");
  });
});
await new Promise<void>((resolve) => http.listen(0, "127.0.0.1", resolve));
const port = (http.address() as AddressInfo).port;
const base = `http://127.0.0.1:${port}`;

async function call(
  method: string,
  path: string,
  body?: string | Record<string, unknown>,
  headers: Record<string, string> = {},
): Promise<{ status: number; json: any; text: string; requestId: string | null; res: Response }> {
  const res = await fetch(`${base}${path}`, {
    method,
    body: body === undefined ? undefined : typeof body === "string" ? body : JSON.stringify(body),
    headers: body === undefined ? headers : { "content-type": "application/json", ...headers },
  });
  const text = await res.text();
  let json: any = null;
  try {
    json = JSON.parse(text);
  } catch {
    /* not JSON — some assertions want exactly that */
  }
  return { status: res.status, json, text, requestId: res.headers.get("x-request-id"), res };
}

console.log("\nrouting");
{
  const ok = await call("GET", "/healthz");
  check(ok.status === 200 && ok.json?.ok === true, "GET /healthz answers 200 without touching anything");
  check(ok.requestId !== null && ok.requestId!.length > 0, "...with a request id on the response");

  const ready = await call("GET", "/readyz");
  check(ready.status === 200 && ready.json?.db === "sqlite", "GET /readyz probes the database and names the driver");

  const slow = await call("GET", "/slow");
  check(slow.status === 503, "a probe that never answers is 503, not a hang");
  check(
    typeof slow.json?.error?.message === "string" && slow.json.error.message.includes("postgres"),
    "...and the message names the driver that did not answer",
  );

  const missing = await call("GET", "/nothing-here");
  check(missing.status === 404 && missing.text === "fell through", "an unclaimed path falls through to the caller");

  const wrongVerb = await call("POST", "/healthz", {});
  check(wrongVerb.status === 405, "a claimed path under the wrong verb is 405, not 404");
  check(wrongVerb.json?.error?.code === "method_not_allowed", "...with a code the client can branch on");
}

console.log("\nthe error envelope");
{
  const refused = await call("GET", "/refused");
  check(refused.status === 402, "an HttpError keeps its status");
  check(refused.json?.error?.code === "payment_required", "...and its code");
  check(refused.json?.error?.message === "a message meant for a person", "...and its message reaches the client");
  check(typeof refused.json?.error?.requestId === "string", "...and the envelope carries the request id");

  const boom = await call("GET", "/boom");
  check(boom.status === 500, "an unexpected throw is a 500");
  check(
    !boom.text.includes("a secret about the inside of the server"),
    "...whose body does NOT contain the exception message",
  );
  check(boom.json?.error?.code === "internal_error", "...and is still a well-formed envelope");
}

console.log("\nbodies");
{
  const echo = await call("POST", "/echo", { a: 1 });
  check(echo.status === 200 && echo.json?.got?.a === 1, "a JSON body arrives parsed");

  const none = await call("POST", "/echo");
  check(none.status === 200 && JSON.stringify(none.json?.got) === "{}", "an absent body is {} rather than an error");

  const notJson = await call("POST", "/echo", "{not json");
  check(notJson.status === 400 && notJson.json?.error?.code === "bad_request", "a body that is not JSON is a 400");

  const array = await call("POST", "/echo", "[1,2,3]");
  check(array.status === 400, "a JSON array is refused — every route here expects an object");

  const strict = await call("POST", "/strict", { name: 7 });
  check(strict.status === 400 && strict.json?.error?.message === "name must be a string", "a handler's own 400 reaches the client verbatim");

  const empty = await call("POST", "/empty", {});
  check(empty.status === 204 && empty.text === "", "a handler returning no body answers 204");

  // Declared oversize: refused on the header, before a byte of it is read.
  const declared = await fetch(`${base}/echo`, {
    method: "POST",
    headers: { "content-type": "application/json", "content-length": String(MAX_BODY_BYTES + 1) },
    body: "x".repeat(MAX_BODY_BYTES + 1),
  });
  check(declared.status === 413, "a body over the cap is 413");

  // Undeclared oversize: chunked, so there is no Content-Length to check. The cap has to hold
  // against what actually arrives, which is the case a header check alone would miss.
  const chunked = await fetch(`${base}/echo`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    duplex: "half",
    body: new ReadableStream({
      start(controller) {
        const chunk = new TextEncoder().encode("x".repeat(8192));
        for (let i = 0; i < (MAX_BODY_BYTES / 8192) + 2; i++) controller.enqueue(chunk);
        controller.close();
      },
    }),
  } as RequestInit).catch(() => ({ status: 413 }) as Response);
  check(chunked.status === 413, "...including a chunked one, which declares no length at all");
}

console.log("\nlogging");
{
  logged.length = 0;
  await call("GET", "/healthz?ticket=super-secret&page=2");
  const line = logged.at(-1) ?? "";
  check(!line.includes("super-secret"), "a ticket in the query string never reaches a log line");
  check(line.includes("ticket=%5Bredacted%5D") || line.includes("ticket=[redacted]"), "...it is redacted by name");
  check(line.includes("page=2"), "...while everything else is kept, so the line stays useful");

  logged.length = 0;
  const quiet = new Router({ log: (l) => logged.push(l) });
  quiet.get("/healthz", healthz());
  const server2 = createServer((req, res) => void quiet.handle(req, res));
  await new Promise<void>((r) => server2.listen(0, "127.0.0.1", r));
  await fetch(`http://127.0.0.1:${(server2.address() as AddressInfo).port}/healthz`);
  check(logged.length === 0, "the default logger stays quiet about /healthz — a probe at 1 Hz is not information");
  await new Promise<void>((r) => server2.close(() => r()));
}

console.log("\nCORS");
{
  // The client is served by Vite on another port, so every request a browser makes to this
  // server is cross-origin. Without these headers the browser blocks the RESPONSE and `fetch`
  // rejects with a bare "Failed to fetch" — which is what the app did until this existed, and
  // which no suite here could see, because `tsx` has no same-origin policy to enforce.
  //
  // So this asserts the headers rather than the behaviour, and says plainly that a passing run
  // is not the same as having opened the app in a browser.
  const allowed = "http://localhost:5173";
  const corsRouter = new Router({
    log: () => {},
    quiet: () => true,
    cors: { allows: (o) => o === undefined || o === allowed },
  });
  corsRouter.get("/healthz", healthz());
  corsRouter.post("/v1/thing", () => ({ body: { ok: true } }));
  corsRouter.post("/v1/refuses", () => {
    throw unauthorized("nope");
  });
  const corsHttp = createServer((req, res) => {
    void corsRouter.handle(req, res).then((handled) => {
      if (!handled) res.writeHead(404).end("no");
    });
  });
  await new Promise<void>((r) => corsHttp.listen(0, "127.0.0.1", r));
  const corsBase = `http://127.0.0.1:${(corsHttp.address() as AddressInfo).port}`;
  const hit = (method: string, path: string, headers: Record<string, string> = {}): Promise<Response> =>
    fetch(`${corsBase}${path}`, { method, headers });

  const good = await hit("GET", "/healthz", { origin: allowed });
  check(good.headers.get("access-control-allow-origin") === allowed, "an allowed origin is told so, by name");
  check(good.headers.get("vary") === "origin", "...with vary: origin, so no cache serves one origin's answer to another");
  check(
    good.headers.get("access-control-allow-origin") !== "*",
    "...and never with a wildcard, which is the absence of an allowlist rather than a shorthand for one",
  );
  check(
    (good.headers.get("access-control-expose-headers") ?? "").includes("x-request-id"),
    "...and the request id is readable, which is the whole reason it is on the response",
  );
  check(
    good.headers.get("access-control-allow-credentials") === null,
    "no allow-credentials: this server authenticates with a bearer header, never a cookie",
  );

  const hostile = await hit("GET", "/healthz", { origin: "https://evil.example" });
  check(
    hostile.headers.get("access-control-allow-origin") === null,
    "an origin that is not on the list is given no permission at all",
  );

  const preflight = await hit("OPTIONS", "/v1/thing", {
    origin: allowed,
    "access-control-request-method": "POST",
  });
  check(preflight.status === 204, `a preflight is answered (${preflight.status})`);
  check(preflight.headers.get("access-control-allow-methods") === "POST", "...naming the verbs the path actually answers");
  check(
    (preflight.headers.get("access-control-allow-headers") ?? "").includes("authorization"),
    "...and permitting the Authorization header, without which nothing here can be called",
  );
  check(Number(preflight.headers.get("access-control-max-age")) > 0, "...and cacheable, so it is not a round trip per request");

  const hostilePreflight = await hit("OPTIONS", "/v1/thing", {
    origin: "https://evil.example",
    "access-control-request-method": "POST",
  });
  check(
    hostilePreflight.headers.get("access-control-allow-methods") === null,
    "a preflight from an origin not on the list is refused the permission it asked for",
  );

  // The one that is easy to miss, and the one that breaks the client's most important
  // decision: a 401 the browser cannot READ becomes "could not reach the server", so the
  // socket layer retries forever instead of showing the sign-in screen.
  const refused = await hit("POST", "/v1/refuses", { origin: allowed });
  check(refused.status === 401, "a handler's refusal still refuses");
  check(
    refused.headers.get("access-control-allow-origin") === allowed,
    "...and a FAILING response carries the headers too, or the client cannot tell 401 from offline",
  );

  const nothingHere = await hit("OPTIONS", "/v1/not-a-route", { origin: allowed });
  check(nothingHere.status === 404, "a preflight for a path that does not exist still 404s rather than answering");

  await new Promise<void>((r) => corsHttp.close(() => r()));
}

await new Promise<void>((r) => http.close(() => r()));

console.log(failures === 0 ? "\nALL CORRECT" : `\n${failures} FAILURES`);
process.exit(failures === 0 ? 0 : 1);
