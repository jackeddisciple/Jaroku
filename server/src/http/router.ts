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

import type { IncomingMessage, ServerResponse } from "node:http";
import { newRequestId } from "../db/tenant.ts";

/** Query parameters whose values must never reach a log line. */
const REDACTED_PARAMS = new Set(["ticket", "token", "key", "access_token", "code"]);

/** The largest body any route here accepts. A token is ~1 KB; a workspace id is 36 bytes. */
export const MAX_BODY_BYTES = 64 * 1024;

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
}

/** What a handler returns. `body` is serialised as JSON; `undefined` means 204. */
export interface HttpResponse {
  status?: number;
  body?: unknown;
  headers?: Record<string, string>;
}

export type Handler = (req: HttpRequest) => Promise<HttpResponse> | HttpResponse;

interface Route {
  method: string;
  /** Exact path. No parameters: nothing in this session's surface needs one. */
  path: string;
  handler: Handler;
}

export interface RouterOptions {
  /** One line per request. Defaults to console.log; the tests pass a collector. */
  log?: (line: string) => void;
  /** Requests to answer without a log line. `/healthz` at 1 Hz is not information. */
  quiet?: (path: string) => boolean;
}

export class Router {
  private routes: Route[] = [];
  private log: (line: string) => void;
  private quiet: (path: string) => boolean;

  constructor(opts: RouterOptions = {}) {
    this.log = opts.log ?? ((line) => console.log(line));
    this.quiet = opts.quiet ?? ((path) => path === "/healthz");
  }

  get(path: string, handler: Handler): this {
    return this.add("GET", path, handler);
  }

  post(path: string, handler: Handler): this {
    return this.add("POST", path, handler);
  }

  private add(method: string, path: string, handler: Handler): this {
    this.routes.push({ method, path, handler });
    return this;
  }

  /** Does any route claim this path, under any method? Drives 404 vs 405. */
  private claims(path: string): boolean {
    return this.routes.some((r) => r.path === path);
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
    const route = this.routes.find((r) => r.path === path && r.method === method);
    if (!route) {
      if (!this.claims(path)) return false;
      // The path exists under another verb. 405 rather than 404, because "you used the wrong
      // method" and "there is nothing here" send a client looking in different places.
      this.respond(res, newRequestId(), 405, {
        error: { code: "method_not_allowed", message: `${method} is not allowed on ${path}` },
      });
      return true;
    }

    const requestId = newRequestId();
    const started = Date.now();
    const req = this.request(raw, url, path, method, requestId);
    let status = 500;
    try {
      const out = await route.handler(req);
      status = out.status ?? (out.body === undefined ? 204 : 200);
      this.respond(res, requestId, status, out.body, out.headers);
    } catch (err) {
      const e = err as Partial<HttpError>;
      status = typeof e?.status === "number" ? e.status : 500;
      const code = typeof e?.code === "string" ? e.code : "internal_error";
      // A 500's message is deliberately not the exception's. Everything below 500 was thrown
      // deliberately by a handler in this codebase and says something a user can act on;
      // anything else is a bug, and its text describes the inside of the server.
      const message = status < 500 ? String((err as Error).message) : "the server failed to handle that";
      if (status >= 500) console.error(`[http] ${requestId} ${method} ${path}:`, err);
      this.respond(res, requestId, status, { error: { code, message } });
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
    };
  }
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
