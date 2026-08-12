// The buckets, on both implementations, against the same suite.
//
// A CONFORMANCE SUITE RATHER THAN TWO TESTS, exactly as storage/conformance.ts and
// queue/conformance.ts are: there are two implementations of one promise, and the property that
// matters is that they cannot be told apart. The Redis half runs the SHIPPED LUA — through
// fixtures/redis/mockRedis.ts's real Lua VM when no Redis is reachable, and against a real one
// when JAROKU_REDIS_URL is set — so what is exercised is the script that runs in production
// rather than a JavaScript paraphrase of it.
//
// TIME IS INJECTED, NEVER SLEPT. A refill test that waits sixty seconds is a test nobody runs.
// Both implementations take a clock for exactly this reason, and the fake one is the same fake
// for both, which is what makes "they agree" mean something.
//
//   npm run test:rate-limit
//   JAROKU_REDIS_URL=redis://127.0.0.1:6380 npm run test:rate-limit

import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { MockRedis } from "../../fixtures/redis/mockRedis.ts";
import { openRedis, pingRedis, redisUrlFromEnv } from "../queue/redis.ts";
import { Router, tooMany } from "./router.ts";
import {
  MemoryRateLimiter,
  RATE_RULES,
  RedisRateLimiter,
  clientAddress,
  ipRuleFor,
  rateRefusal,
  retryAfterSeconds,
  type RateAction,
  type RateLimiter,
} from "./rateLimit.ts";

let failures = 0;
const check = (ok: boolean, msg: string): void => {
  if (ok) console.log(`  ok   ${msg}`);
  else {
    failures++;
    console.log(`  FAIL ${msg}`);
  }
};

// --- the table --------------------------------------------------------------------------------

console.log("\nthe rules");
{
  const actions = Object.keys(RATE_RULES) as RateAction[];
  check(actions.length > 0, `${actions.length} actions have a bucket`);
  check(
    actions.every((a) => RATE_RULES[a].capacity >= 1 && RATE_RULES[a].perMinute > 0),
    "every rule admits at least one request and refills at all — a capacity of zero refuses forever",
  );
  check(
    actions.every((a) => RATE_RULES[a].scope === "ip" || RATE_RULES[a].scope === "workspace"),
    "every rule says what it is keyed by",
  );
  check(
    RATE_RULES["http.request"].capacity > RATE_RULES["agent.generate"].capacity,
    "the blanket per-IP ceiling is looser than the per-workspace one on a model call",
  );
  check(
    RATE_RULES["auth.signup"].perMinute < 1,
    "signup is per hour rather than per minute — signup velocity is the abuse signal, not the UX",
  );
}

console.log("\nwhich rule a path falls under");
{
  check(ipRuleFor("/healthz") === null, "a load balancer's health check is not rate limited");
  check(ipRuleFor("/readyz") === null, "...nor readiness");
  check(
    ipRuleFor("/v1/runs/abc/control") === null,
    "the sandbox control plane is exempt — every sandbox in a region shares one egress address",
  );
  check(ipRuleFor("/v1/ws-ticket") === "auth.ticket", "a ticket has its own bucket");
  check(ipRuleFor("/v1/auth/session") === "auth.session", "so does sign-in");
  check(ipRuleFor("/v1/oauth/google/callback") === "oauth.callback", "so does a provider's redirect back");
  check(ipRuleFor("/v1/objects/ws%2Fx") === "http.request", "everything else falls under the blanket rule");
}

console.log("\nthe address a bucket is keyed by");
{
  const noProxy = {} as NodeJS.ProcessEnv;
  const proxied = { JAROKU_TRUST_PROXY: "1" } as NodeJS.ProcessEnv;
  check(
    clientAddress({ forwardedFor: "1.2.3.4" }, "10.0.0.9", noProxy) === "10.0.0.9",
    "X-Forwarded-For is IGNORED by default — it is client-supplied, and a fresh value is a fresh bucket",
  );
  check(
    clientAddress({ forwardedFor: "1.2.3.4, 10.0.0.1" }, "10.0.0.9", proxied) === "1.2.3.4",
    "...and honoured, leftmost first, when the deployment says it is behind a proxy",
  );
  check(
    clientAddress({ realIp: "5.6.7.8" }, "10.0.0.9", proxied) === "5.6.7.8",
    "...falling back to X-Real-IP when there is no forwarded chain",
  );
  check(
    clientAddress({}, "::ffff:127.0.0.1", noProxy) === clientAddress({}, "127.0.0.1", noProxy),
    "one address has many spellings, and they share one bucket",
  );
  check(clientAddress({}, null, noProxy) === "unknown", "an address we do not have still keys something");
}

// --- the conformance suite both limiters run ---------------------------------------------------

/** A clock the suite moves by hand. Both implementations take one. */
function fakeClock(start = 1_700_000_000_000): { now: () => number; advance: (ms: number) => void } {
  let t = start;
  return { now: () => t, advance: (ms) => void (t += ms) };
}

async function suite(label: string, build: (now: () => number) => RateLimiter): Promise<void> {
  console.log(`\n${label}`);
  const clock = fakeClock();
  const limiter = build(clock.now);
  const rule = RATE_RULES["agent.generate"];

  console.log("  · a burst, then a refusal");
  {
    const results = [];
    for (let i = 0; i < rule.capacity; i++) results.push(await limiter.take("agent.generate", "ws-a"));
    check(results.every((r) => r.ok), `the first ${rule.capacity} are admitted — capacity is a burst, not a rate`);
    check(results.at(-1)!.remaining === 0, "...and the last one leaves the bucket empty");

    const refused = await limiter.take("agent.generate", "ws-a");
    check(!refused.ok, "the next is refused");
    check(refused.retryAfterMs > 0, "...with a wait");
    check(refused.remaining === 0, "...and nothing left");
    check(refused.limit === rule.capacity, "...and the ceiling it hit");
  }

  console.log("  · the wait is the truth");
  {
    const refused = await limiter.take("agent.generate", "ws-a");
    check(!refused.ok, "still refused");
    // A hair short of the stated wait: the answer must still be no, or `Retry-After` was
    // optimistic — which is exactly the lie that turns a rate limit into a retry storm.
    clock.advance(Math.max(1, refused.retryAfterMs - 50));
    check(!(await limiter.take("agent.generate", "ws-a")).ok, "just before the stated wait, still refused");
    clock.advance(200);
    check((await limiter.take("agent.generate", "ws-a")).ok, "just after it, admitted");
  }

  console.log("  · refill is continuous, and capped");
  {
    clock.advance(60 * 60_000); // an hour of doing nothing
    const after = await limiter.take("agent.generate", "ws-a");
    check(after.ok, "an idle bucket is full again");
    check(
      after.remaining === rule.capacity - 1,
      `...and no fuller than full (${after.remaining} of ${rule.capacity - 1}) — an hour does not buy a hundred`,
    );
  }

  console.log("  · buckets do not share");
  {
    const clock2 = fakeClock();
    const fresh = build(clock2.now);
    for (let i = 0; i < rule.capacity; i++) await fresh.take("agent.generate", "ws-a");
    check(!(await fresh.take("agent.generate", "ws-a")).ok, "ws-a is out");
    check((await fresh.take("agent.generate", "ws-b")).ok, "...and ws-b is untouched — one bucket per subject");
    check((await fresh.take("agent.plan", "ws-a")).ok, "...and so is ws-a's plan bucket — one bucket per action");
    await fresh.close();
  }

  console.log("  · concurrency");
  {
    const clock3 = fakeClock();
    const fresh = build(clock3.now);
    // Twenty callers at once against a bucket of five. Exactly five may win, or "capacity" is a
    // suggestion — this is the property the Lua script exists for.
    const all = await Promise.all(
      Array.from({ length: 20 }, () => fresh.take("agent.generate", "ws-race")),
    );
    const admitted = all.filter((r) => r.ok).length;
    check(admitted === rule.capacity, `twenty simultaneous asks admit exactly ${rule.capacity} (${admitted})`);
    await fresh.close();
  }

  await limiter.close();
}

await suite("MemoryRateLimiter", (now) => new MemoryRateLimiter(now));

// The shipped Lua, in a real Lua VM, with no Redis installed.
await suite("RedisRateLimiter (mock Redis, real Lua)", (now) => new RedisRateLimiter(new MockRedis() as never, now));

if (redisUrlFromEnv()) {
  const probe = openRedis();
  if (await pingRedis(probe)) {
    // A real server, with a namespace of its own so a developer's queue keys are untouched.
    //
    // ONE CLIENT PER LIMITER, and the shared one that used to be here is why. `suite` builds
    // three limiters — the main one and a fresh one for each of the last two sections — and a
    // RedisRateLimiter QUITS ITS CLIENT in `close()`. That is correct and is what production
    // gives it: `openRateLimiter()` calls `openRedis()` itself, so the limiter owns the
    // connection it closes. Handing all three the same client meant the first `close()` shut
    // the socket underneath the other two, and the next `take()` wrote to it.
    //
    // The failure was not an assertion. Every check in the real-Redis pass printed `ok`, and
    // then ioredis raised `write EPIPE` from an error event with no handler on it, which ends
    // the process — so a green suite exited 1 and the log's last useful line was a passing
    // check. Only reachable with a real Redis, so it never happened on a machine without one.
    await suite("RedisRateLimiter (real Redis)", (now) => new RedisRateLimiter(openRedis(), now));
  } else {
    console.log("\nSKIPPED: JAROKU_REDIS_URL is set but nothing answered");
  }
  await probe.quit().catch(() => {});
} else {
  console.log("\n(no JAROKU_REDIS_URL — the real-Redis pass was skipped; the mock ran the same Lua)");
}

// --- what a refused HTTP request looks like ----------------------------------------------------

console.log("\non the wire");
{
  const clock = fakeClock();
  const limiter = new MemoryRateLimiter(clock.now);
  const router = new Router({
    log: () => {},
    quiet: () => true,
    beforeHandle: async (req) => {
      const action = ipRuleFor(req.path);
      if (!action) return;
      const decision = await limiter.take(action, clientAddress({}, req.ip, {}));
      if (decision.ok) return;
      throw tooMany(rateRefusal(decision), retryAfterSeconds(decision), {
        "x-ratelimit-limit": String(decision.limit),
      });
    },
  });
  router.get("/healthz", () => ({ body: { ok: true } }));
  router.post("/v1/auth/session", () => ({ body: { ok: true } }));

  const http = createServer((req, res) => {
    void router.handle(req, res).then((handled) => {
      if (!handled) res.writeHead(404).end("no");
    });
  });
  await new Promise<void>((resolve) => http.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${(http.address() as AddressInfo).port}`;

  const statuses: number[] = [];
  let last: Response | undefined;
  for (let i = 0; i < RATE_RULES["auth.session"].capacity + 1; i++) {
    last = await fetch(`${base}/v1/auth/session`, { method: "POST" });
    statuses.push(last.status);
  }
  check(statuses.slice(0, -1).every((s) => s === 200), "sign-in works until the bucket is empty");
  check(last!.status === 429, "and then it is a 429");
  check(Number(last!.headers.get("retry-after")) >= 1, "...carrying an honest Retry-After in whole seconds");
  check(last!.headers.get("x-ratelimit-limit") === String(RATE_RULES["auth.session"].capacity), "...and the ceiling");
  const body = (await last!.json()) as { error?: { code?: string; message?: string } };
  check(body.error?.code === "rate_limited", "...with a code a client can branch on");
  check(
    !/\d+ per minute|capacity/i.test(body.error?.message ?? ""),
    "...and a message that does not recite the thresholds to whoever is probing them",
  );

  // The exempt path, after the bucket that would have covered it is long empty.
  for (let i = 0; i < 50; i++) await fetch(`${base}/healthz`);
  check((await fetch(`${base}/healthz`)).status === 200, "a health check is never refused, however often it is asked");

  http.close();
  await limiter.close();
}

console.log(failures === 0 ? "\nALL CORRECT" : `\n${failures} FAILURES`);
process.exit(failures === 0 ? 0 : 1);
