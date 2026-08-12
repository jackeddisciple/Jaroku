// The layer in front of the load balancer, written down where it can be reviewed.
//
// WHY THE EDGE IS A SEPARATE LAYER AT ALL. http/rateLimit.ts refuses a request AFTER a TCP
// handshake, a TLS negotiation, a route lookup and a Redis round trip. That is cheap per request
// and ruinous per hundred thousand: a flood that this process refuses is still a flood this
// process paid for. The edge refuses before any of it, in somebody else's datacentre, on
// somebody else's CPU. It is the only layer that can make a volumetric attack somebody else's
// problem — and the only one that cannot tell a generation from a list of datasets, which is why
// the other two exist.
//
// WHY IT IS IN THIS REPOSITORY. Because an edge configured by clicking is an edge nobody can
// review, diff, or explain six months later — and because these rules and the ones in
// `rateLimit.ts` have to AGREE. The exemptions are the sharp end: `/healthz` and the sandbox
// control plane are deliberately not rate limited here, and if the edge disagrees, a WAF rule
// nobody in this repository can see is what takes every sandbox in a region off the air. The
// test beside this file asserts the two layers name the same exemptions, which is a check no
// dashboard can perform.
//
// WHAT THIS FILE IS NOT. It is not enforcement. Nothing here runs in the request path; it is
// data, rendered to a provider's configuration and applied by the deploy pipeline. If the edge
// is misconfigured or absent, every property this codebase actually promises still holds —
// tenancy, the sandbox boundary, the rate limits, the capability checks. The edge makes an
// attack cheaper to survive; it is never what makes an attack fail.
//
// A NOTE ON BOT SCORES. `cf.bot_management.score` is a vendor's opinion, expressed as a number
// nobody outside that vendor can reproduce, and it is wrong about somebody every day. So it is
// never used to BLOCK: it selects a challenge, which a real person passes and a script does not,
// and which costs a false positive an inconvenience rather than an outage. The one thing here
// that blocks outright is a request for a path that does not exist and never has.

/** What the edge does with a matching request. Ordered from least to most aggressive. */
export type EdgeAction = "log" | "js_challenge" | "managed_challenge" | "block";

/**
 * A condition, as a small tree rather than a provider's string.
 *
 * Structured because there are two renderers and there will be a third: a rule written as
 * Cloudflare's expression language would have to be re-typed for anything else, and the day it
 * is re-typed is the day the two stop meaning the same thing. It is also what lets the test
 * beside this file ask "which paths does this rule cover" without parsing a language.
 */
export type EdgeExpr =
  | { all: EdgeExpr[] }
  | { any: EdgeExpr[] }
  | { not: EdgeExpr }
  | { pathEquals: string }
  | { pathStartsWith: string }
  | { pathMatches: string[] }
  | { method: string[] }
  | { botScoreBelow: number }
  | { userAgentMissing: true }
  | { bodyLargerThan: number };

export interface EdgeRateLimit {
  /** How many requests, in `periodSec`, from one counting key. */
  requests: number;
  periodSec: number;
  /** What the counter is keyed by. The edge has no idea what a workspace is. */
  by: "ip" | "ip+path";
  /** How long a caller stays refused once it trips. */
  mitigationSec: number;
}

export interface EdgeRule {
  /** Stable across renders. Used as the provider's rule id, so editing a rule is not deleting it. */
  id: string;
  /** One sentence a person reading an incident channel can act on. */
  description: string;
  action: EdgeAction;
  expression: EdgeExpr;
  rateLimit?: EdgeRateLimit;
  /**
   * Matched first and short-circuiting, for the rules that exist to say "leave this alone".
   *
   * Order is the whole of an edge configuration's semantics and the usual way to get one wrong.
   * Declaring the skips rather than relying on their position in the array is what stops a rule
   * appended below from quietly covering the control plane.
   */
  skip?: boolean;
}

/**
 * Paths the edge must never rate limit, throttle or challenge.
 *
 * THE SAME TWO `ipRuleFor` EXEMPTS, and the test asserts they stay the same two:
 *
 *   The health checks are asked by a load balancer, from one address, as often as it likes. An
 *   edge that challenges them removes healthy instances from rotation.
 *
 *   `/v1/runs/…` is the control plane a SANDBOX calls home to: its trace push, its pause poll,
 *   its confirmation wait. Every sandbox in a Fly region shares an egress address, so an IP
 *   counter here is a global cap on how many runs may exist — and a JavaScript challenge served
 *   to a Python process is a run that hangs until its wall clock kills it.
 */
export const EDGE_EXEMPT_PREFIXES = ["/healthz", "/readyz", "/v1/runs/"] as const;

/**
 * Paths that have never existed here and never will.
 *
 * Blocking them stops nothing — this server 404s them in microseconds — and that is not what
 * they are for. They are the cheapest possible signal that an address is scanning rather than
 * using, they are the loudest line in an access log, and `.env` and `.git` in particular are
 * what a scanner asks for immediately before it asks for something real.
 */
export const SCANNER_PATHS = [
  "/.env",
  "/.git/config",
  "/wp-login.php",
  "/wp-admin",
  "/phpmyadmin",
  "/.aws/credentials",
  "/config.json",
  "/server-status",
  "/actuator/env",
] as const;

/**
 * The largest body the edge will forward.
 *
 * Deliberately LARGER than `MAX_BINARY_BODY_BYTES`, not equal to it. The edge is a blunt
 * instrument that cannot tell which route a body is for, and a limit equal to the application's
 * would turn every over-large upload into an opaque edge refusal instead of the 413 with a
 * request id that this server produces. What it is for is the body that is absurd rather than
 * merely too big: the 200 MB POST whose only purpose is to make somebody buffer it.
 */
export const EDGE_MAX_BODY_BYTES = 64 * 1024 * 1024;

/**
 * The rules, in order.
 *
 * ONE TABLE, for the reason `plans.ts`, `jobs.ts` and `capabilities.ts` are each one table: the
 * useful question is "what does the edge do", asked of all of them at once.
 */
export const EDGE_RULES: readonly EdgeRule[] = [
  {
    id: "skip-control-plane-and-health",
    description:
      "Never challenge or throttle the sandbox control plane or the health checks — one region's " +
      "sandboxes share an egress address, and a challenged health check pulls a healthy instance.",
    action: "log",
    skip: true,
    expression: { any: EDGE_EXEMPT_PREFIXES.map((p) => ({ pathStartsWith: p })) },
  },
  {
    id: "block-scanner-paths",
    description: "Requests for paths this product has never had. A scanner announcing itself.",
    action: "block",
    expression: { pathMatches: [...SCANNER_PATHS] },
  },
  {
    id: "block-absurd-bodies",
    description:
      "A body far past anything any route accepts. The application's own limit produces a 413 " +
      "with a request id; this is for the one whose only purpose is to be buffered.",
    action: "block",
    expression: { bodyLargerThan: EDGE_MAX_BODY_BYTES },
  },
  {
    id: "challenge-signup-automation",
    description:
      "Sign-up from something that does not look like a browser. A challenge, never a block: a " +
      "bot score is a vendor's opinion and is wrong about somebody every day.",
    action: "managed_challenge",
    expression: {
      all: [{ pathEquals: "/v1/auth/session" }, { method: ["POST"] }, { botScoreBelow: 30 }],
    },
  },
  {
    id: "ratelimit-signup-velocity",
    description:
      "Signup velocity from one address — the first abuse signal the hosted platform has, and " +
      "the cheapest to act on. Ten an hour is a household; fifty is a farm.",
    action: "block",
    expression: { all: [{ pathEquals: "/v1/auth/session" }, { method: ["POST"] }] },
    rateLimit: { requests: 10, periodSec: 3600, by: "ip", mitigationSec: 3600 },
  },
  {
    id: "ratelimit-ws-tickets",
    description:
      "A ticket per socket, and a socket per reconnect. Loose enough that a deploy's reconnect " +
      "storm passes, tight enough that a loop opening sockets does not.",
    action: "block",
    expression: { pathEquals: "/v1/ws-ticket" },
    rateLimit: { requests: 120, periodSec: 60, by: "ip", mitigationSec: 60 },
  },
  {
    id: "ratelimit-oauth-callbacks",
    description:
      "The callback does a token exchange with a third party before it can decide the state is " +
      "invalid, so an invalid one still costs a round trip somebody else has to serve.",
    action: "managed_challenge",
    expression: { pathStartsWith: "/v1/oauth/" },
    rateLimit: { requests: 60, periodSec: 60, by: "ip", mitigationSec: 300 },
  },
  {
    id: "ratelimit-everything-else",
    description:
      "The volumetric floor: whatever this deployment is asked for, at a rate no person produces. " +
      "Deliberately looser than the application's own per-IP bucket, so an ordinary overshoot is " +
      "refused by the layer that can say why.",
    action: "block",
    expression: { not: { any: EDGE_EXEMPT_PREFIXES.map((p) => ({ pathStartsWith: p })) } },
    rateLimit: { requests: 600, periodSec: 60, by: "ip", mitigationSec: 60 },
  },
  {
    id: "log-missing-user-agent",
    description:
      "No User-Agent at all. Recorded, never refused: curl, the test suites and every deployed " +
      "agent calling an API send none, and the fallback debug client is somebody's browser.",
    action: "log",
    expression: { all: [{ userAgentMissing: true }, { not: { pathStartsWith: "/v1/runs/" } }] },
  },
] as const;

// --- rendering --------------------------------------------------------------------------------

/**
 * One expression, in Cloudflare's language.
 *
 * Rendered rather than written, so the tree above stays the only place a rule is stated. Values
 * are escaped on the way in — a path with a quote in it would otherwise end the string and start
 * arbitrary expression syntax, which is injection into a firewall rule.
 */
export function toCloudflare(expr: EdgeExpr): string {
  if ("all" in expr) return `(${expr.all.map(toCloudflare).join(" and ")})`;
  if ("any" in expr) return `(${expr.any.map(toCloudflare).join(" or ")})`;
  if ("not" in expr) return `(not ${toCloudflare(expr.not)})`;
  if ("pathEquals" in expr) return `(http.request.uri.path eq ${q(expr.pathEquals)})`;
  if ("pathStartsWith" in expr) return `(starts_with(http.request.uri.path, ${q(expr.pathStartsWith)}))`;
  if ("pathMatches" in expr) return `(http.request.uri.path in {${expr.pathMatches.map(q).join(" ")}})`;
  if ("method" in expr) return `(http.request.method in {${expr.method.map(q).join(" ")}})`;
  if ("botScoreBelow" in expr) return `(cf.bot_management.score lt ${int(expr.botScoreBelow)})`;
  if ("userAgentMissing" in expr) return `(len(http.user_agent) eq 0)`;
  return `(http.request.body.size gt ${int(expr.bodyLargerThan)})`;
}

/** A quoted literal with nothing in it that could end the quote. */
function q(value: string): string {
  if (/["\\\n\r]/.test(value)) {
    // Refused rather than escaped. Nothing in these rules legitimately contains a quote or a
    // newline, so one appearing means the table was edited into something nobody meant — and a
    // firewall rule is the wrong place to be clever about recovering from that.
    throw new Error(`edge rule value is not safe to render: ${JSON.stringify(value)}`);
  }
  return `"${value}"`;
}

function int(n: number): string {
  if (!Number.isFinite(n) || n < 0 || Math.floor(n) !== n) {
    throw new Error(`edge rule number must be a non-negative integer: ${n}`);
  }
  return String(n);
}

export interface RenderedEdgeConfig {
  /** Bumped when the SHAPE changes, not when a number does. Lets a deploy detect a stale apply. */
  version: number;
  generatedFrom: string;
  exemptPrefixes: string[];
  maxBodyBytes: number;
  rules: {
    id: string;
    description: string;
    action: EdgeAction;
    expression: string;
    skip: boolean;
    rateLimit?: EdgeRateLimit;
  }[];
}

/**
 * The whole configuration, as a provider-shaped document.
 *
 * DETERMINISTIC AND WITHOUT A TIMESTAMP, so the file it produces can be committed and compared.
 * A generated file with a generation time in it changes on every run, which means "is the
 * committed edge configuration the one this code describes" stops being answerable — and that
 * question is the entire reason the configuration is in the repository.
 */
export function renderEdgeConfig(rules: readonly EdgeRule[] = EDGE_RULES): RenderedEdgeConfig {
  return {
    version: 1,
    generatedFrom: "server/src/abuse/edgeRules.ts",
    exemptPrefixes: [...EDGE_EXEMPT_PREFIXES],
    maxBodyBytes: EDGE_MAX_BODY_BYTES,
    rules: rules.map((r) => ({
      id: r.id,
      description: r.description,
      action: r.action,
      expression: toCloudflare(r.expression),
      skip: r.skip === true,
      ...(r.rateLimit ? { rateLimit: r.rateLimit } : {}),
    })),
  };
}

/** The committed file's exact bytes. One newline at the end, two-space indent, stable order. */
export function renderEdgeConfigJson(rules: readonly EdgeRule[] = EDGE_RULES): string {
  return `${JSON.stringify(renderEdgeConfig(rules), null, 2)}\n`;
}
