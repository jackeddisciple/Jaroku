// The HTTP surface.
//
// Until now this server answered exactly two things: `GET /` for the fallback debug client,
// and a WebSocket upgrade. Everything else in the product went down the socket. That was the
// right shape for a localhost tool with no authentication, and it is the wrong one the moment
// there is any — a browser cannot set an `Authorization` header on a WebSocket, so the
// credential exchange HAS to happen over HTTP before the socket exists.
//
// So: a router, and deliberately a small one. No framework, for the reason the migration
// runner has none and the test suites are plain tsx scripts — this does about ninety lines of
// work, and a dependency here would be a dependency in the path every request takes.
//
// FOUR PROPERTIES, and each is the answer to something that bites later:
//
//   A REQUEST ID ON EVERY REQUEST. `TenantContext.requestId` already exists and already
//   correlates a log line, an audit row and a trace. This is where it is minted for anything
//   arriving over HTTP, and it goes back out on the response so a user reporting a failure can
//   name the request that produced it.
//
//   ONE ERROR SHAPE. A handler throws `HttpError` and gets `{ error: { code, message,
//   requestId } }` with the right status. A handler throwing anything else gets a 500 whose
//   body says nothing about what went wrong, because an exception message on a public endpoint
//   is a description of the inside of the server.
//
//   A BODY LIMIT ON EVERYTHING. Not per-route opt-in. An unbounded read is a memory exhaustion
//   away from being an outage, and the endpoints here take a token and a workspace id — there
//   is no legitimate 10 MB request in this file.
//
//   NOTHING SENSITIVE IN A LOG LINE. The ws-ticket rides in a query string, because that is
//   the only place a browser can put anything on a WebSocket URL. It is single-use and lives
//   thirty seconds, but a value that grants a session must not sit in an access log for a year
//   anyway, so the logger redacts it by name.
//
//   AND CORS, FROM THE SAME ALLOWLIST THE SOCKET USES. The client is served by Vite on :5173
//   and this server answers on :4317, so every request the browser makes here is cross-origin —
//   `/v1/auth/dev-login`, `/v1/auth/session`, `/v1/ws-ticket`, all of them. Without a
//   `Access-Control-Allow-Origin` the browser blocks the RESPONSE, `fetch` rejects with a bare
//   "Failed to fetch", and the client cannot sign in at all. That is not a hypothetical: it is
//   what the app did until this was added, and no test suite saw it because the suites run
//   under `tsx`, where there is no browser to enforce a same-origin policy.
//
//   The allowlist is `auth/origin.ts`'s, unchanged and not a second copy. Two lists of
//   permitted origins would drift, and the day they do the answer to "may this origin talk to
//   us" depends on which transport asked.
//
//   Note that CORS and the socket's Origin check protect against opposite things and neither
//   replaces the other. CORS asks the BROWSER not to reveal a response to script from another
//   origin; the socket's check is the server refusing the connection outright, because — as
//   auth/origin.ts says at length — WebSockets are not covered by CORS at all.

import type { IncomingMessage, ServerResponse } from "node:http";
import { newRequestId } from "../db/tenant.ts";

/** Query parameters whose values must never reach a log line. */
const REDACTED_PARAMS = new Set(["ticket", "token", "key", "access_token", "code"]);

/**
 * What the router needs to know about origins. Structurally `auth/origin.ts`'s `OriginPolicy`,
 * declared as its own shape so the HTTP layer does not import the auth layer for one predicate.
 */
export interface CorsPolicy {
  allows(origin: string | undefined): boolean;
}

/** The request headers a browser is allowed to send here. `authorization` is the whole point. */
const ALLOWED_REQUEST_HEADERS = "authorization, content-type";

/**
 * How long a browser may cache a preflight. Ten minutes: long enough that a session/ticket
 * exchange is not three round trips instead of two, short enough that changing the allowlist
 * takes effect within a coffee break.
 */
const PREFLIGHT_MAX_AGE_S = 600;

/** The largest JSON body any route here accepts. A token is ~1 KB; a workspace id is 36 bytes. */
export const MAX_BODY_BYTES = 64 * 1024;

/**
 * The largest binary body, which is a different question with a different answer.
 *
 * The object route accepts a presigned PUT, and what it accepts is an agent's file — capped at
 * 200 KB by projectFs for the same reasons — or an eval export. Sharing the JSON cap would make
 * a 300 KB export unwritable; sharing an unbounded read would make one request an outage. So it
 * is its own number, larger and still a number.
 */
export const MAX_BINARY_BODY_BYTES = 16 * 1024 * 1024;

/**
 * A failure with a status and a code the client can branch on.
 *
 * `code` is the machine-readable half and is what the client's socket layer uses to tell
 * "retry" from "stop and show sign-in" — the distinction commit 12 depends on. `message` is
 * for a person, and is safe to render: everything thrown as an HttpError is a message this
 * codebase wrote, never a driver's or a third party's.
 */
export class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "HttpError";
  }
}

export const badRequest = (m: string): HttpError => new HttpError(400, "bad_request", m);
export const unauthorized = (m: string): HttpError => new HttpError(401, "unauthorized", m);
export const forbidden = (m: string): HttpError => new HttpError(403, "forbidden", m);
export const notFound = (m: string): HttpError => new HttpError(404, "not_found", m);
export const tooLarge = (m: string): HttpError => new HttpError(413, "payload_too_large", m);

/** What a handler is given. Everything it needs about the request, and nothing more. */
export interface HttpRequest {
  readonly requestId: string;
  readonly method: string;
  /** Path only — never the query string, which is what the redaction rule is about. */
  readonly path: string;
  readonly url: URL;
  readonly raw: IncomingMessage;
  /** The client's address, for audit rows. Best-effort: behind a proxy this is the proxy. */
  readonly ip: string | null;
  header(name: string): string | undefined;
  /** The JSON body, size-capped. `{}` when there is no body — absent is not an error here. */
  json<T = Record<string, unknown>>(): Promise<T>;
  /** The body as bytes, capped separately. For the one route whose payload is not JSON. */
  buffer(): Promise<Buffer>;
}

/**
 * What a handler returns.
 *
 * `body` is serialised as JSON, EXCEPT when it is a Buffer, which is written through untouched
 * with whatever `headers` says its content type is. That exception exists for exactly one route
 * — the object route serves an agent's file — and it is an exception rather than a second
 * response type because everything else about answering a request is identical, down to the
 * request id header and the CORS decision.
 *
 * `undefined` means 204.
 */
export interface HttpResponse {
  status?: number;
  body?: unknown;
  headers?: Record<string, string>;
}

export type Handler = (req: HttpRequest) => Promise<HttpResponse> | HttpResponse;

interface Route {
  method: string;
  /**
   * The path, matched exactly — or, when `prefix` is set, as a leading string.
   *
   * Session 2's routes were all exact, and the comment here said nothing needed a parameter.
   * Session 3 does: an object is addressed BY ITS KEY, and a key is not a fixed string. It
   * arrives percent-encoded as one segment (see storage/presign.ts, which encodes the slashes
   * deliberately so nothing between here and the handler can resolve a `..` inside it), so a
   * prefix match plus one decode is the whole of the routing it needs — and no path-pattern
   * language has to be invented for one route.
   */
  path: string;
  prefix?: boolean;
  handler: Handler;
}

export interface RouterOptions {
  /** One line per request. Defaults to console.log; the tests pass a collector. */
  log?: (line: string) => void;
  /** Requests to answer without a log line. `/healthz` at 1 Hz is not information. */
  quiet?: (path: string) => boolean;
  /**
   * Which origins may read a response. Absent means no CORS headers at all, which is right for
   * a same-origin caller and for every non-browser client — `curl` and the test suites do not
   * consult them.
   */
  cors?: CorsPolicy;
}

export class Router {
  private routes: Route[] = [];
  private log: (line: string) => void;
  private quiet: (path: string) => boolean;
  private cors?: CorsPolicy;

  constructor(opts: RouterOptions = {}) {
    this.log = opts.log ?? ((line) => console.log(line));
    this.quiet = opts.quiet ?? ((path) => path === "/healthz");
    this.cors = opts.cors;
  }

  get(path: string, handler: Handler): this {
    return this.add("GET", path, handler);
  }

  post(path: string, handler: Handler): this {
    return this.add("POST", path, handler);
  }

  put(path: string, handler: Handler): this {
    return this.add("PUT", path, handler);
  }

  /** Everything under `prefix`, for a route whose tail is data rather than a path. */
  prefixRoute(method: "GET" | "PUT", prefix: string, handler: Handler): this {
    this.routes.push({ method, path: prefix, prefix: true, handler });
    return this;
  }

  private add(method: string, path: string, handler: Handler): this {
    this.routes.push({ method, path, handler });
    return this;
  }

  private matches(route: Route, path: string): boolean {
    return route.prefix ? path.startsWith(route.path) : route.path === path;
  }

  /** Does any route claim this path, under any method? Drives 404 vs 405. */
  private claims(path: string): boolean {
    return this.routes.some((r) => this.matches(r, path));
  }

  /** The verbs a path actually answers, for the preflight. Never a guessed wildcard. */
  private methodsFor(path: string): string[] {
    return [...new Set(this.routes.filter((r) => this.matches(r, path)).map((r) => r.method))];
  }

  /**
   * The CORS headers for one request, or none.
   *
   * ECHOED, never `*`. The allowlist is a list of specific origins, and answering `*` would
   * grant every one of them plus everything else — a wildcard is not an abbreviation for the
   * list, it is the absence of one. `vary: origin` because the answer differs per origin and a
   * cache that missed that would serve one origin's permission to another.
   *
   * NO `access-control-allow-credentials`. This server authenticates with a bearer token in a
   * header, never a cookie, so nothing needs it — and it is the header that would make the
   * origin allowlist load-bearing against CSRF rather than merely tidy.
   */
  private corsHeaders(origin: string | undefined): Record<string, string> {
    if (!this.cors || !origin) return {};
    if (!this.cors.allows(origin)) return { vary: "origin" };
    return {
      "access-control-allow-origin": origin,
      // So a client can report the id of the request that failed, which is the entire reason
      // it is on the response.
      "access-control-expose-headers": "x-request-id",
      vary: "origin",
    };
  }

  /**
   * Answer a request, or report that no route matched so the caller can fall through.
   *
   * Returning false rather than 404ing here is what lets the static debug client keep its
   * `GET /` without the router having to know what a debug client is.
   */
  async handle(raw: IncomingMessage, res: ServerResponse): Promise<boolean> {
    const url = new URL(raw.url ?? "/", `http://${raw.headers.host ?? "localhost"}`);
    const path = url.pathname;
    const method = (raw.method ?? "GET").toUpperCase();
    const origin = header(raw, "origin");

    // Preflight, before route lookup: a browser sends OPTIONS with no credential and no body,
    // and it is asking about a route rather than invoking one. Answered only for paths this
    // router actually claims, so an OPTIONS to nowhere still falls through to the 404 and a
    // preflight cannot be used to enumerate what does not exist.
    if (method === "OPTIONS" && this.claims(path)) {
      const allowed = this.cors?.allows(origin) ?? false;
      const requestId = newRequestId();
      // Without the allow headers the browser fails the preflight and never sends the real
      // request — which is the refusal. A 204 either way keeps the two cases indistinguishable
      // to a non-browser prober.
      this.respond(res, requestId, 204, undefined, {
        ...(allowed && origin
          ? {
              "access-control-allow-methods": this.methodsFor(path).join(", "),
              "access-control-allow-headers": ALLOWED_REQUEST_HEADERS,
              "access-control-max-age": String(PREFLIGHT_MAX_AGE_S),
            }
          : {}),
        ...this.corsHeaders(origin),
      });
      return true;
    }

    // Exact routes are searched before prefix ones, so a prefix can never shadow a specific
    // path that happens to sit underneath it.
    const route =
      this.routes.find((r) => !r.prefix && r.path === path && r.method === method) ??
      this.routes.find((r) => r.prefix && this.matches(r, path) && r.method === method);
    if (!route) {
      if (!this.claims(path)) return false;
      // The path exists under another verb. 405 rather than 404, because "you used the wrong
      // method" and "there is nothing here" send a client looking in different places.
      this.respond(res, newRequestId(), 405, {
        error: { code: "method_not_allowed", message: `${method} is not allowed on ${path}` },
      }, this.corsHeaders(origin));
      return true;
    }

    const requestId = newRequestId();
    const started = Date.now();
    const req = this.request(raw, url, path, method, requestId);
    // On every answer below, including the failures. A 401 a browser cannot READ is a client
    // that shows "could not reach the server" for "your token expired" — which is exactly the
    // retry-versus-stop distinction lib/socket.ts is built around, defeated at the last step.
    const cors = this.corsHeaders(origin);
    let status = 500;
    try {
      const out = await route.handler(req);
      status = out.status ?? (out.body === undefined ? 204 : 200);
      this.respond(res, requestId, status, out.body, { ...cors, ...out.headers });
    } catch (err) {
      const e = err as Partial<HttpError>;
      status = typeof e?.status === "number" ? e.status : 500;
      const code = typeof e?.code === "string" ? e.code : "internal_error";
      // A 500's message is deliberately not the exception's. Everything below 500 was thrown
      // deliberately by a handler in this codebase and says something a user can act on;
      // anything else is a bug, and its text describes the inside of the server.
      const message = status < 500 ? String((err as Error).message) : "the server failed to handle that";
      if (status >= 500) console.error(`[http] ${requestId} ${method} ${path}:`, err);
      this.respond(res, requestId, status, { error: { code, message } }, cors);
    }
    if (!this.quiet(path)) {
      this.log(`[http] ${requestId} ${method} ${this.redact(url)} ${status} ${Date.now() - started}ms`);
    }
    return true;
  }

  /** The path plus its query, with anything that grants access replaced by its name. */
  private redact(url: URL): string {
    if (!url.search) return url.pathname;
    const params = new URLSearchParams(url.search);
    for (const key of params.keys()) {
      if (REDACTED_PARAMS.has(key.toLowerCase())) params.set(key, "[redacted]");
    }
    return `${url.pathname}?${params.toString()}`;
  }

  private respond(
    res: ServerResponse,
    requestId: string,
    status: number,
    body: unknown,
    headers: Record<string, string> = {},
  ): void {
    if (res.writableEnded) return;
    // On the response as well as in the log, so a user reporting a failure can name the exact
    // request and somebody can find its line.
    const base: Record<string, string> = { "x-request-id": requestId, ...headers };
    if (body === undefined) {
      res.writeHead(status, base).end();
      return;
    }
    // A Buffer is the payload, not a thing to describe as one. See HttpResponse.
    if (Buffer.isBuffer(body)) {
      res
        .writeHead(status, {
          "content-type": "application/octet-stream",
          ...base,
          "content-length": String(body.length),
        })
        .end(body);
      return;
    }
    const payload =
      body !== null && typeof body === "object" && "error" in (body as object)
        ? { error: { ...(body as { error: object }).error, requestId } }
        : body;
    const text = JSON.stringify(payload);
    res.writeHead(status, { ...base, "content-type": "application/json; charset=utf-8" }).end(text);
  }

  private request(
    raw: IncomingMessage,
    url: URL,
    path: string,
    method: string,
    requestId: string,
  ): HttpRequest {
    let parsed: Promise<unknown> | null = null;
    let bytes: Promise<Buffer> | null = null;
    return {
      requestId,
      method,
      path,
      url,
      raw,
      ip: raw.socket?.remoteAddress ?? null,
      header: (name) => {
        const v = raw.headers[name.toLowerCase()];
        return Array.isArray(v) ? v[0] : v;
      },
      json: <T,>(): Promise<T> => {
        parsed ??= readJson(raw);
        return parsed as Promise<T>;
      },
      buffer: (): Promise<Buffer> => {
        bytes ??= readBytes(raw);
        return bytes;
      },
    };
  }
}

/** One request header, flattened. Node gives an array for headers that may repeat. */
function header(raw: IncomingMessage, name: string): string | undefined {
  const v = raw.headers[name];
  return Array.isArray(v) ? v[0] : v;
}

/** Read a body as bytes, against the binary cap. Same header-then-reality rule as readJson. */
async function readBytes(raw: IncomingMessage): Promise<Buffer> {
  const declared = Number(raw.headers["content-length"] ?? 0);
  if (Number.isFinite(declared) && declared > MAX_BINARY_BODY_BYTES) {
    throw tooLarge(`request body over ${MAX_BINARY_BODY_BYTES} bytes`);
  }
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of raw) {
    const buf = chunk as Buffer;
    size += buf.length;
    if (size > MAX_BINARY_BODY_BYTES) throw tooLarge(`request body over ${MAX_BINARY_BODY_BYTES} bytes`);
    chunks.push(buf);
  }
  return Buffer.concat(chunks);
}

/**
 * Read a JSON body, capped.
 *
 * The cap is enforced against what actually arrives, not against `Content-Length` — a header
 * is a claim, and a chunked request has none at all. Checking the header first is still worth
 * doing because it refuses an obvious abuse before a byte is read.
 */
async function readJson<T>(raw: IncomingMessage): Promise<T> {
  const declared = Number(raw.headers["content-length"] ?? 0);
  if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) {
    throw tooLarge(`request body over ${MAX_BODY_BYTES} bytes`);
  }
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of raw) {
    const buf = chunk as Buffer;
    size += buf.length;
    if (size > MAX_BODY_BYTES) throw tooLarge(`request body over ${MAX_BODY_BYTES} bytes`);
    chunks.push(buf);
  }
  if (size === 0) return {} as T;
  const text = Buffer.concat(chunks).toString("utf8");
  try {
    const value = JSON.parse(text) as unknown;
    if (value === null || typeof value !== "object" || Array.isArray(value)) {
      throw badRequest("expected a JSON object");
    }
    return value as T;
  } catch (err) {
    if (err instanceof HttpError) throw err;
    throw badRequest("body is not valid JSON");
  }
}
