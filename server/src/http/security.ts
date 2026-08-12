// The headers every response carries, and the deadline every request runs under.
//
// Session 8's first commit, and it is deliberately the smallest one: nothing here decides who
// may do what. CORS and the body limits already landed in Session 2 and are re-audited below
// rather than rewritten — what is genuinely new is a set of response headers instructing a
// BROWSER what it may do with what we sent it, and a clock on every handler.
//
// WHY A JSON API NEEDS A CONTENT SECURITY POLICY AT ALL. The usual answer is that it does not:
// there is no markup in a `{"error":{…}}` body for an injected script to live in. The reason to
// send one anyway is that `Content-Type` is a claim a browser is willing to second-guess. A
// route that echoes a user-supplied string, served without `nosniff`, fetched directly by a
// victim's browser as a top-level navigation, is a stored-XSS surface on OUR origin — and this
// origin is where the bearer token lives, in `localStorage`, one same-origin script away. So:
// `nosniff` so the type is not a suggestion, and a policy that permits nothing so that a
// document served from here has no script, no frame and no form to submit to anyone.
//
// TWO POLICIES, BECAUSE THERE ARE TWO KINDS OF RESPONSE. Everything through the router is data,
// and gets the policy that permits nothing. `debug-client.html` is a document with an inline
// `<style>` and an inline `<script>` that opens the socket, and the policy that permits nothing
// would leave a blank page — so it gets its own, which is still `default-src 'none'` with
// exactly two allowances plus the socket it exists to open. A single policy loose enough for
// both would be the loose one applied to the API, which is the surface that matters.
//
// HSTS IS CONDITIONAL, and the condition is not `NODE_ENV`. Sent over plaintext it is ignored,
// which is harmless; sent by a deployment somebody reaches at `http://localhost:4317` behind a
// TLS-terminating proxy it is honoured, and a browser then refuses plain HTTP to `localhost`
// for two years — for every other project on that machine's port 80 too. So it rides on
// `JAROKU_PUBLIC_TLS=1`, an explicit statement that this deployment is only ever reached over
// HTTPS, and `includeSubDomains`/`preload` are separate opt-ins because both are promises about
// hostnames this process cannot see.
//
// THE DEADLINE IS PER ROUTE AND HAS A DEFAULT, rather than being a global number. Two routes in
// this server are long-polls by design — the control plane's `GET …/control` waits up to 25
// seconds for a pause that may never come, and `POST …/mcp-confirm` waits up to 120 for a human
// — and a global timeout short enough to be useful would kill exactly those. See
// sandbox/controlPlaneRoutes.ts, which asks for its own numbers.

/** Every response the router writes carries these. See the header on why an API has a CSP. */
export const API_SECURITY_HEADERS: Readonly<Record<string, string>> = Object.freeze({
  // The whole of the API's policy: this document may load nothing, be framed by nobody, submit
  // to nowhere, and cannot have its base rewritten. `frame-ancestors` is the modern
  // `X-Frame-Options`; the older header is sent too, below, for the browsers that only know it.
  "content-security-policy":
    "default-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'",
  // The type we declared is the type it is. Without this a browser may sniff a JSON body as
  // HTML and run what is in it, which is how an echoed string becomes script on our origin.
  "x-content-type-options": "nosniff",
  // A URL here can carry a ws-ticket in its query string. `no-referrer` is what keeps that out
  // of somebody else's access log the moment a response links anywhere.
  "referrer-policy": "no-referrer",
  // Nothing here needs a camera, a microphone, a location or a payment handler, and a policy
  // that names them is what stops an injected frame asking on our behalf.
  "permissions-policy": "camera=(), microphone=(), geolocation=(), payment=(), usb=(), interest-cohort=()",
  "x-frame-options": "DENY",
  // A cross-origin page may not hold a handle to a window of ours, and may not read a response
  // of ours even when it is allowed to make the request.
  "cross-origin-opener-policy": "same-origin",
  "cross-origin-resource-policy": "same-origin",
});

/**
 * The document policy, for `debug-client.html` and for nothing else.
 *
 * `'unsafe-inline'` twice, and it is honest to name it that: the fallback client is one file
 * with its style and its script inside it, deliberately, so that a server with no build step can
 * still show a trace. What the policy still forbids is everything that turns an injection into
 * an exfiltration — no external script, no external style, no frame, no form, and a `connect-src`
 * of `'self'` so the socket it opens is ours and a `fetch` to anywhere else is refused.
 */
export const DOCUMENT_SECURITY_HEADERS: Readonly<Record<string, string>> = Object.freeze({
  "content-security-policy":
    "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; " +
    "connect-src 'self'; img-src 'self' data:; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
  "x-content-type-options": "nosniff",
  "referrer-policy": "no-referrer",
  "permissions-policy": API_SECURITY_HEADERS["permissions-policy"]!,
  "x-frame-options": "DENY",
  "cross-origin-opener-policy": "same-origin",
  "cross-origin-resource-policy": "same-origin",
});

export const TLS_ENV = "JAROKU_PUBLIC_TLS";
export const HSTS_SUBDOMAINS_ENV = "JAROKU_HSTS_INCLUDE_SUBDOMAINS";
export const HSTS_PRELOAD_ENV = "JAROKU_HSTS_PRELOAD";

/** Two years, the value a preload list requires and the one every guide converges on. */
const HSTS_MAX_AGE_S = 63_072_000;

/**
 * The headers for one deployment: the constants above, plus HSTS when it has said it is HTTPS.
 *
 * Built from an environment rather than read from one at each response, because these do not
 * change while a process runs and a header set assembled per request is a header set assembled
 * six thousand times a second.
 */
export function securityHeaders(env: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const headers: Record<string, string> = { ...API_SECURITY_HEADERS };
  if (!isOn(env[TLS_ENV])) return headers;
  const directives = [`max-age=${HSTS_MAX_AGE_S}`];
  // A promise about every hostname under this one, including the ones somebody has not built
  // yet. Separate opt-in because getting it wrong takes two years to expire.
  if (isOn(env[HSTS_SUBDOMAINS_ENV])) directives.push("includeSubDomains");
  // And a promise to a browser vendor's baked-in list, which is not undone by removing the
  // header. Separate again, and for a sharper version of the same reason.
  if (isOn(env[HSTS_PRELOAD_ENV])) directives.push("preload");
  headers["strict-transport-security"] = directives.join("; ");
  return headers;
}

/** The document set, with whatever HSTS the API set resolved to — one TLS decision, not two. */
export function documentSecurityHeaders(env: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const hsts = securityHeaders(env)["strict-transport-security"];
  return { ...DOCUMENT_SECURITY_HEADERS, ...(hsts ? { "strict-transport-security": hsts } : {}) };
}

function isOn(v: string | undefined): boolean {
  return v === "1" || v === "true" || v === "yes";
}

// --- deadlines --------------------------------------------------------------------------------

/**
 * How long an ordinary handler may take before the request is answered without it.
 *
 * Fifteen seconds, which is far longer than anything here should need and short enough that a
 * wedged dependency does not accumulate sockets until the process runs out of them. The point is
 * not to make slow requests fast: it is that a request which will never finish must not occupy a
 * connection forever, because six thousand of those is the outage.
 */
export const DEFAULT_HANDLER_TIMEOUT_MS = 15_000;

/**
 * How long the HTTP server waits for a client to finish sending its request.
 *
 * The slowloris number, and it is a different question from the one above: that bounds OUR work,
 * this bounds somebody else's dribble. Node's own defaults are 60s of headers and 300s of body,
 * which is an invitation — a few hundred sockets each sending one byte a minute costs an
 * attacker nothing and costs us the connection table.
 */
export const REQUEST_READ_TIMEOUT_MS = 20_000;
export const HEADERS_READ_TIMEOUT_MS = 10_000;
/**
 * How long an idle keep-alive connection is held open.
 *
 * Longer than a browser needs between the session call and the ws-ticket that follows it, and
 * shorter than a load balancer's own idle timeout — a connection the balancer thinks is alive
 * and this process has closed is the classic source of sporadic 502s, and the way to avoid it is
 * to be the side that hangs up.
 */
export const KEEP_ALIVE_TIMEOUT_MS = 65_000;
/**
 * How often Node looks for connections that have run past those two numbers.
 *
 * THE ONE THAT MAKES THE OTHER TWO REAL, and it is easy to miss because it has nothing to do
 * with either name. Node does not arm a timer per socket: it sweeps, and the sweep's default
 * interval is thirty seconds — so a `requestTimeout` of twenty is enforced somewhere between
 * twenty and fifty, and one of two seconds is not enforced at all in any way a test can observe.
 * Five seconds is a sweep cheap enough to run on an idle server and fine enough that the numbers
 * above mean roughly what they say.
 */
export const CONNECTIONS_CHECK_INTERVAL_MS = 5_000;
