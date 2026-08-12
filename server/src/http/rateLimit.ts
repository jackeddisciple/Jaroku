// How often one address, and one workspace, may ask for something expensive.
//
// THREE LAYERS, AND THIS FILE IS THE SECOND AND THIRD. The edge — a WAF in front of the load
// balancer — is the first, and it is the only one that can refuse a flood without paying for a
// TCP handshake and a TLS negotiation per request; it lands in the next commit as configuration
// rather than code, because it does not run here. What runs here is the pair the edge cannot
// express: PER IP, because the edge does not know which of our routes is cheap, and PER
// WORKSPACE PER ACTION, because the edge has never heard of a workspace and cannot tell a
// generation from a list of datasets.
//
// WHY BOTH, RATHER THAN THE STRICTER ONE. They protect different people. The per-IP bucket
// protects the SERVER from somebody with no account; the per-workspace bucket protects EVERY
// OTHER TENANT from one that is signed in and enthusiastic — and a workspace's members are on
// many addresses, so an IP limit tight enough to bound a workspace would refuse a team of five.
// A single limit cannot be both.
//
// A TOKEN BUCKET, NOT A FIXED WINDOW. A fixed window has a seam: sixty requests at 11:59:59 and
// sixty more at 12:00:00 is a hundred and twenty in a second, and the counter says both minutes
// were fine. A bucket refills continuously, so a burst is bounded by `capacity` and a sustained
// rate by `perMinute`, and the two are separate numbers because they are separate questions —
// opening the app makes a handful of requests at once and then almost none.
//
// THE `Retry-After` IS COMPUTED, NOT GUESSED. It is the time until the bucket holds one token
// again, which is a number this file actually knows. A constant would be a lie in whichever
// direction it happened to be wrong, and the wrong direction that matters is "too short":
// telling a client to come back in one second when it must wait thirty is how a rate limit
// becomes a retry storm that keeps itself refused.
//
// TWO IMPLEMENTATIONS, ALWAYS — the standing rule of this migration. `MemoryRateLimiter` needs
// nothing installed and is what `npm run dev` uses. `RedisRateLimiter` is one bucket per key
// across every replica, which is the only version that means anything when there are six of
// them: an in-memory limit of sixty across six gateways is a limit of three hundred and sixty.
// The refill is a Lua script for the reason every other atomic step in this codebase is one —
// read, refill, spend and write have to be one operation, or two replicas both see the last
// token and both spend it.

import type Redis from "ioredis";
import { openRedis, redisUrlFromEnv } from "../queue/redis.ts";

/**
 * Everything with a bucket of its own.
 *
 * Named after what a user did rather than after the route or the command that carries it —
 * `agent.generate` is one action whether it arrives as a socket command or, one day, as an HTTP
 * POST. Adding one here without adding a rule below is a type error, which is the point.
 */
export type RateAction =
  // --- per IP: everything an unauthenticated stranger can reach -----------------------------
  | "http.request"
  | "auth.session"
  | "auth.ticket"
  | "auth.signup"
  | "oauth.callback"
  // --- per workspace: the expensive half of the product --------------------------------------
  | "agent.generate"
  | "agent.plan"
  | "agent.edit"
  | "agent.explain"
  | "run.start"
  | "eval.start"
  | "mcp.discover"
  | "member.invite"
  | "connector.connect"
  | "billing.checkout";

export interface RateRule {
  /** The most that may happen at once, from an empty-handed start. Bounds a BURST. */
  capacity: number;
  /** How fast the bucket refills. Bounds a SUSTAINED rate. */
  perMinute: number;
  /** What the key is built from. `ip` for a stranger, `workspace` for a tenant. */
  scope: "ip" | "workspace";
}

/**
 * The numbers, in one table, for the reason `plans.ts` and `jobs.ts` are each one table: a limit
 * defined next to the code that enforces it is a limit nobody can review as a set.
 *
 * They are deliberately generous. A rate limit is not the abuse response — commits 4 and 5 are —
 * and every number here is chosen so that a person using the product energetically never sees
 * one. What they bound is the shape of automation: a script, a loop, a farm.
 */
export const RATE_RULES: Record<RateAction, RateRule> = {
  // The blanket per-IP ceiling on everything the router answers. High, because a browser opening
  // the app makes a session call, a ticket call and an object fetch per agent file, and a team
  // behind one office NAT is one address.
  "http.request": { capacity: 240, perMinute: 240, scope: "ip" },
  // Sign-in itself, which is where a credential-stuffing attempt lands.
  "auth.session": { capacity: 20, perMinute: 20, scope: "ip" },
  // A ticket per socket, and a socket per reconnect. Reconnects come in storms after a deploy,
  // so the burst is what matters here and the sustained rate barely does.
  "auth.ticket": { capacity: 60, perMinute: 60, scope: "ip" },
  // SIGNUP VELOCITY FROM ONE ADDRESS, which is the first signal in the abuse section of the
  // spec and the cheapest one to act on. Five in an hour is a family; fifty is a farm.
  "auth.signup": { capacity: 5, perMinute: 5 / 60, scope: "ip" },
  // A third party redirecting a browser back to us. Bounded because the callback does real work
  // — a token exchange with somebody else's server — before it can decide the state is invalid.
  "oauth.callback": { capacity: 30, perMinute: 30, scope: "ip" },

  // Generation is the single most expensive thing a workspace can ask for: a model call that
  // writes a project. Five at once, five a minute.
  "agent.generate": { capacity: 5, perMinute: 5, scope: "workspace" },
  "agent.plan": { capacity: 10, perMinute: 20, scope: "workspace" },
  "agent.edit": { capacity: 10, perMinute: 20, scope: "workspace" },
  "agent.explain": { capacity: 10, perMinute: 30, scope: "workspace" },
  // A run is already bounded by the interactive reservation and by the budget gate. This is the
  // cheap outer wall: it stops a loop pressing Run from writing a run row per iteration.
  "run.start": { capacity: 20, perMinute: 60, scope: "workspace" },
  // An eval is a fan-out — one press is up to five hundred jobs — so the press itself is rare.
  "eval.start": { capacity: 5, perMinute: 10, scope: "workspace" },
  // A round trip to a third party nobody here controls. The discovery queue already collapses
  // duplicates; this bounds how fast distinct ones can be asked for.
  "mcp.discover": { capacity: 10, perMinute: 20, scope: "workspace" },
  // Invitations are email nobody asked for, sent from our address. Twenty an hour.
  "member.invite": { capacity: 20, perMinute: 20 / 60, scope: "workspace" },
  // Starting an OAuth flow costs a state row and a redirect; finishing one costs a token
  // exchange. Ten an hour is more reconnecting than anybody does.
  "connector.connect": { capacity: 10, perMinute: 10 / 60, scope: "workspace" },
  // A checkout session is a row in somebody else's system that we cannot delete.
  "billing.checkout": { capacity: 10, perMinute: 10 / 60, scope: "workspace" },
};

export interface RateDecision {
  ok: boolean;
  /** How long until one token exists. 0 when the request was admitted. */
  retryAfterMs: number;
  /** Tokens left after this request, floored. For the `X-RateLimit-Remaining` header. */
  remaining: number;
  /** The rule's capacity, so a client is told what it is up against rather than only that it is. */
  limit: number;
}

export interface RateLimiter {
  readonly kind: "memory" | "redis";
  /**
   * Spend one token of `action` for `subject`, or report how long until there is one.
   *
   * `subject` is an IP or a workspace id — whichever the rule's scope names — and the caller
   * supplies it rather than this module deriving it, because the caller is the only thing that
   * knows which of the two it is holding.
   */
  take(action: RateAction, subject: string, cost?: number): Promise<RateDecision>;
  close(): Promise<void>;
}

/** `Retry-After` is expressed in whole seconds, and never zero — 0 reads as "immediately". */
export function retryAfterSeconds(decision: RateDecision): number {
  return Math.max(1, Math.ceil(decision.retryAfterMs / 1000));
}

/**
 * A refusal a person can act on.
 *
 * Names the action and the wait, and deliberately does not name the limit's exact numbers: a
 * refusal that recites its own thresholds is a refusal that tells somebody probing them exactly
 * how to stay underneath.
 */
export function rateRefusal(decision: RateDecision): string {
  const s = retryAfterSeconds(decision);
  const when = s >= 120 ? `${Math.ceil(s / 60)} minutes` : `${s} second${s === 1 ? "" : "s"}`;
  return `that is happening too often — try again in about ${when}`;
}

/** How long an untouched bucket is kept before it is forgotten and starts full again. */
const idleTtlMs = (rule: RateRule): number =>
  // The time it takes to refill from empty, plus a minute. Shorter than that and a bucket
  // expires while it is still holding a debt, which hands back the burst it just spent.
  Math.ceil((rule.capacity / Math.max(rule.perMinute, 0.0001)) * 60_000) + 60_000;

/** The key one bucket lives under. `rl:` so it cannot collide with the queue's namespace. */
export const rateKey = (action: RateAction, subject: string): string => `rl:${action}:${subject}`;

// --- the local implementation ------------------------------------------------------------------

interface Bucket {
  tokens: number;
  updatedAt: number;
}

/**
 * One process's buckets, in a Map.
 *
 * Correct for `npm run dev` and honest about what it is not: with N gateway replicas this
 * enforces N times the limit, which is why the hosted path uses Redis. Atomic for the same
 * reason InMemoryQueueBackend is — one JavaScript turn, no `await` in the critical section.
 */
export class MemoryRateLimiter implements RateLimiter {
  readonly kind = "memory";
  private buckets = new Map<string, Bucket>();
  private sweepAfter = 0;

  constructor(private now: () => number = Date.now) {}

  async take(action: RateAction, subject: string, cost = 1): Promise<RateDecision> {
    const rule = RATE_RULES[action];
    const key = rateKey(action, subject);
    const now = this.now();
    this.sweep(now);

    const bucket = this.buckets.get(key) ?? { tokens: rule.capacity, updatedAt: now };
    const perMs = rule.perMinute / 60_000;
    const tokens = Math.min(rule.capacity, bucket.tokens + Math.max(0, now - bucket.updatedAt) * perMs);
    if (tokens >= cost) {
      this.buckets.set(key, { tokens: tokens - cost, updatedAt: now });
      return { ok: true, retryAfterMs: 0, remaining: Math.floor(tokens - cost), limit: rule.capacity };
    }
    this.buckets.set(key, { tokens, updatedAt: now });
    return {
      ok: false,
      retryAfterMs: Math.ceil((cost - tokens) / perMs),
      remaining: 0,
      limit: rule.capacity,
    };
  }

  /**
   * Drop buckets nobody has touched for long enough to be full again.
   *
   * Opportunistic rather than on a timer, exactly as `DbTicketStore.issue` sweeps: a limiter
   * that holds a process open with an interval is a limiter that makes `npm run dev` refuse to
   * exit. A bucket that is full holds no information — it is indistinguishable from one that
   * never existed — so forgetting it is free.
   */
  private sweep(now: number): void {
    if (now < this.sweepAfter) return;
    this.sweepAfter = now + 60_000;
    for (const [key, bucket] of this.buckets) {
      const action = key.slice(3, key.indexOf(":", 3)) as RateAction;
      const rule = RATE_RULES[action];
      if (!rule) {
        this.buckets.delete(key);
        continue;
      }
      if (now - bucket.updatedAt > idleTtlMs(rule)) this.buckets.delete(key);
    }
  }

  async close(): Promise<void> {
    this.buckets.clear();
  }
}

// --- the hosted one ------------------------------------------------------------------------------

/**
 * Read, refill, spend and write, in one step nothing can interleave with.
 *
 * The whole bucket is ONE STRING — `<tokens>:<updatedAt>` — rather than a hash, because the
 * cost of a second field is a second command and the value is never read by anything but this
 * script. `PX` on every write is what makes a limiter that has seen a million addresses stop
 * being a million keys a week later.
 *
 * Returns integers only. Redis converts a Lua float to an integer by truncation on the way out,
 * so a fractional token count has to be scaled deliberately rather than discovered.
 */
const TAKE_SCRIPT = `
local raw = redis.call('GET', KEYS[1])
local capacity = tonumber(ARGV[1])
local perMs = tonumber(ARGV[2])
local now = tonumber(ARGV[3])
local cost = tonumber(ARGV[4])
local ttl = tonumber(ARGV[5])

local tokens = capacity
if raw then
  local sep = string.find(raw, ':', 1, true)
  if sep then
    tokens = tonumber(string.sub(raw, 1, sep - 1)) or capacity
    local ts = tonumber(string.sub(raw, sep + 1)) or now
    local elapsed = now - ts
    if elapsed > 0 then
      tokens = math.min(capacity, tokens + elapsed * perMs)
    end
  end
end

local allowed = 0
local retry = 0
if tokens >= cost then
  allowed = 1
  tokens = tokens - cost
else
  retry = math.ceil((cost - tokens) / perMs)
end

redis.call('SET', KEYS[1], tostring(tokens) .. ':' .. tostring(now), 'PX', ttl)
return { allowed, math.floor(tokens * 1000), retry }
`;

interface RateRedis extends Redis {
  jarokuRateTake(
    key: string,
    capacity: string,
    perMs: string,
    now: string,
    cost: string,
    ttl: string,
  ): Promise<[number, number, number]>;
}

export class RedisRateLimiter implements RateLimiter {
  readonly kind = "redis";
  private client: RateRedis;

  constructor(
    client: Redis,
    /** Injected so a suite can move time without sleeping. Production passes nothing. */
    private now: () => number = Date.now,
  ) {
    this.client = client as RateRedis;
    if (typeof this.client.jarokuRateTake !== "function") {
      this.client.defineCommand("jarokuRateTake", { numberOfKeys: 1, lua: TAKE_SCRIPT });
    }
  }

  async take(action: RateAction, subject: string, cost = 1): Promise<RateDecision> {
    const rule = RATE_RULES[action];
    const perMs = rule.perMinute / 60_000;
    const [allowed, milliTokens, retry] = await this.client.jarokuRateTake(
      rateKey(action, subject),
      String(rule.capacity),
      String(perMs),
      String(this.now()),
      String(cost),
      String(idleTtlMs(rule)),
    );
    return {
      ok: allowed === 1,
      retryAfterMs: allowed === 1 ? 0 : Math.max(1, retry),
      remaining: Math.floor(milliTokens / 1000),
      limit: rule.capacity,
    };
  }

  async close(): Promise<void> {
    await this.client.quit().catch(() => {});
  }
}

/**
 * The limiter this deployment gets: Redis when there is one, a Map when there is not.
 *
 * The same shape as `defaultQueueBackend` and for the same reason — one place decides, and
 * nothing downstream can tell which it got.
 */
export function openRateLimiter(opts: { url?: string; env?: NodeJS.ProcessEnv } = {}): RateLimiter {
  const url = redisUrlFromEnv(opts);
  return url ? new RedisRateLimiter(openRedis({ url })) : new MemoryRateLimiter();
}

// --- what the HTTP layer does with one ------------------------------------------------------

/**
 * Which per-IP rule a request path falls under, or null for a path that is not IP-limited.
 *
 * TWO PATHS ARE DELIBERATELY EXEMPT, and both would be actively harmed by a per-address bucket:
 *
 *   `/healthz` and `/readyz` are asked by a load balancer, from one address, as often as it
 *   likes. A rate-limited health check is an instance removed from rotation for being healthy.
 *
 *   `/v1/runs/…` is the control plane a SANDBOX calls home to. Every sandbox in a Fly region
 *   shares an egress address, so an IP bucket there would be a global cap on how many runs may
 *   exist — and those requests already carry a run-scoped token and are already bounded by the
 *   backpressure caps, which limit the thing that actually costs (bytes and lines), not the
 *   number of times a runner asks whether it should pause.
 */
export function ipRuleFor(path: string): RateAction | null {
  if (path === "/healthz" || path === "/readyz") return null;
  if (path.startsWith("/v1/runs/")) return null;
  if (path === "/v1/auth/session" || path === "/v1/auth/dev-login") return "auth.session";
  if (path === "/v1/ws-ticket") return "auth.ticket";
  if (path.startsWith("/v1/oauth/")) return "oauth.callback";
  return "http.request";
}

/**
 * The address a bucket is keyed by, from what a proxy said and what the socket says.
 *
 * `X-Forwarded-For` IS TRUSTED ONLY WHEN THIS DEPLOYMENT SAYS IT IS BEHIND A PROXY. Trusting it
 * unconditionally would make the per-IP limit worthless — the header is client-supplied, and a
 * fresh value per request is a fresh bucket per request. Trusting it never would make it
 * worthless the other way once there IS a proxy: every request would arrive from the balancer's
 * one address and six thousand users would share a bucket. So it is a switch, and the value
 * taken is the LEFTMOST entry, which is the client as the nearest trusted proxy saw it.
 */
export const TRUST_PROXY_ENV = "JAROKU_TRUST_PROXY";

export function clientAddress(
  headers: { forwardedFor?: string; realIp?: string },
  socketAddress: string | null,
  env: NodeJS.ProcessEnv = process.env,
): string {
  const trusted = env[TRUST_PROXY_ENV] === "1" || env[TRUST_PROXY_ENV] === "true";
  if (trusted) {
    const first = (headers.forwardedFor ?? "").split(",")[0]?.trim();
    if (first) return normaliseAddress(first);
    if (headers.realIp?.trim()) return normaliseAddress(headers.realIp.trim());
  }
  return normaliseAddress(socketAddress ?? "unknown");
}

/**
 * One address, spelled one way.
 *
 * `::ffff:127.0.0.1` and `127.0.0.1` are the same host, and a limiter that keyed them separately
 * would hand out two buckets to one caller — the same "one address has many spellings" problem
 * the sandbox's block list had, in a place where it costs a limit rather than a boundary.
 */
function normaliseAddress(raw: string): string {
  let value = raw.trim().toLowerCase();
  if (value.startsWith("[") && value.includes("]")) value = value.slice(1, value.indexOf("]"));
  if (value.startsWith("::ffff:")) value = value.slice("::ffff:".length);
  return value || "unknown";
}
