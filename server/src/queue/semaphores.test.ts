// Named leased semaphores, against both backends - and the pure key-naming logic that needs
// no backend at all.
//
//   docker compose up -d redis
//   JAROKU_REDIS_URL=redis://127.0.0.1:6380 npm run test:semaphores

import type { Redis } from "ioredis";
import { MockRedis } from "../../fixtures/redis/mockRedis.ts";
import { InMemoryQueueBackend } from "./inMemoryBackend.ts";
import { RedisQueueBackend } from "./redisBackend.ts";
import { openRedis, pingRedis, redisUrlFromEnv } from "./redis.ts";
import { runSemaphoreConformance } from "./conformance.ts";
import { providerLimit, semaphoreKey, workspaceSemaphore, providerSemaphore } from "./semaphores.ts";

let failures = 0;
const check = (ok: boolean, msg: string): void => {
  if (ok) console.log(`  ok   ${msg}`);
  else {
    failures++;
    console.log(`  FAIL ${msg}`);
  }
};

console.log("\nkey naming");

check(semaphoreKey("run.eval", { kind: "global" }) === "run.eval:global", "global key names the class alone");
check(
  semaphoreKey("run.eval", { kind: "workspace", workspaceId: "ws-1" }) === "run.eval:ws:ws-1",
  "workspace key names the class and the workspace",
);
check(
  semaphoreKey("run.eval", { kind: "provider", provider: "anthropic" }) === "run.eval:provider:anthropic",
  "provider key names the class and the provider",
);
check(
  semaphoreKey("judge", { kind: "workspace", workspaceId: "ws-1" }) !==
    semaphoreKey("run.eval", { kind: "workspace", workspaceId: "ws-1" }),
  "the same workspace under a different class is a different key",
);

console.log("\nprovider limits");

check(providerLimit("fake") === 16, "the fake provider defaults generously - it's free and local");
check(providerLimit("anthropic") === 2, "a real provider defaults conservatively");
{
  process.env.JAROKU_LIMIT_ANTHROPIC = "9";
  check(providerLimit("anthropic") === 9, "an env override is read, case-insensitively on the provider name");
  delete process.env.JAROKU_LIMIT_ANTHROPIC;
}

console.log("\nthe Semaphore convenience wrapper");

{
  const backend = new InMemoryQueueBackend();
  const sem = workspaceSemaphore(backend, "run.eval", "ws-1", 1);
  const l1 = "lease-1";
  check(await sem.acquire(l1, 60_000), "workspaceSemaphore acquires through the backend");
  check((await sem.count()) === 1, "and its count matches");
  await sem.release(l1);
  check((await sem.count()) === 0, "and releases through it too");

  const provSem = providerSemaphore(backend, "run.eval", "anthropic");
  check(provSem.max === providerLimit("anthropic"), "providerSemaphore defaults its max from providerLimit");
}

console.log("\nInMemoryQueueBackend");
failures += (await runSemaphoreConformance("in-memory", new InMemoryQueueBackend())).failures;

// The semaphore scripts are Lua too, and they carry the per-workspace and per-provider caps —
// the descendants of slot 0 and JAROKU_LIMIT_<PROVIDER>. fixtures/redis/mockRedis.ts runs the
// real ones, so this no longer waits on a broker being installed. See dispatcher.test.ts.
console.log("\nwhat the in-memory backend is still holding after the traffic stops");
{
  // A gateway on the in-memory backend runs for as long as the process does. Redis's own acquire
  // script trims expired members on every call and drops a zset once it is empty; this had no
  // equivalent, so every workspace that ever queued a job and every lease that ever expired
  // without an explicit release stayed in memory for the process's whole uptime. At a hosted
  // deployment's workspace count that is a leak, not a rounding error.
  const backend = new InMemoryQueueBackend();
  const start = backend.retainedEntries();

  for (let i = 0; i < 2_000; i++) {
    const ws = `ws-churn-${i}`;
    await backend.enqueue({
      id: `job-${i}`, class: "run.eval", workspaceId: ws,
      idempotencyKey: `run.eval:job-${i}`, enqueuedAt: new Date().toISOString(), attempt: 1, payload: {},
    });
    const leaseId = `lease-${i}`;
    await backend.tryAdmit("run.eval", { leaseId, leaseTtlMs: 60_000, maxGlobalInFlight: null });
    await backend.ack("run.eval", leaseId);
    // An expired holder nobody releases — a worker that died mid-job, which is the case leases
    // exist for and therefore the case that accumulates. All against ONE key, because that is
    // the axis with no ceiling: a key is per workspace and per provider and so bounded by how
    // many of those exist, but lease ids are minted per admission, forever.
    await backend.acquireSemaphore("run.eval:provider:fake", 4, `sem-${i}`, -1);
  }

  const after = backend.retainedEntries();
  check(
    after.lists - start.lists === 0,
    `two thousand drained workspaces leave no list behind (${after.lists - start.lists} retained)`,
  );
  check(
    after.leases - start.leases === 0,
    `and no acked lease behind (${after.leases - start.leases} retained)`,
  );
  check(
    (await backend.semaphoreCount("run.eval:provider:fake")) === 0,
    "and two thousand expired holders leave the cap free rather than looking saturated",
  );
  // The count above would read 0 either way, since an expired holder never counted against the
  // cap. What proves the trim is what is RETAINED: one key acquired two thousand times left two
  // thousand dead entries in its map, one per lease id, none of which anything would ever remove.
  check(
    after.semaphoreHolders - start.semaphoreHolders <= 1,
    `expired holders are trimmed rather than accumulating (${after.semaphoreHolders - start.semaphoreHolders} retained)`,
  );

  // ...without breaking the thing the retention was protecting: a LIVE holder still counts.
  await backend.acquireSemaphore("run.eval:provider:anthropic", 2, "live-1", 60_000);
  await backend.acquireSemaphore("run.eval:provider:anthropic", 2, "live-2", 60_000);
  check(
    !(await backend.acquireSemaphore("run.eval:provider:anthropic", 2, "live-3", 60_000)),
    "and a cap held by live leases still refuses a third",
  );
}

console.log("\nRedisQueueBackend, on the in-process Lua fixture");
failures += (
  await runSemaphoreConformance("redis-lua", new RedisQueueBackend(new MockRedis() as unknown as Redis))
).failures;

const url = redisUrlFromEnv();
if (!url) {
  console.log(
    `\nNOTE: no JAROKU_REDIS_URL, so the run above used the in-process Lua fixture rather than a\n` +
      `real broker. \`docker compose up -d redis\` and JAROKU_REDIS_URL=redis://127.0.0.1:6380 runs\n` +
      `the identical scenarios against the real thing.`,
  );
} else {
  const client = openRedis({ url });
  if (!(await pingRedis(client))) {
    console.log(`\nSKIPPED: JAROKU_REDIS_URL is set but unreachable at ${url}`);
    client.disconnect();
  } else {
    console.log("\nRedisQueueBackend");
    try {
      failures += (await runSemaphoreConformance("redis", new RedisQueueBackend(client))).failures;
    } finally {
      client.disconnect();
    }
  }
}

console.log(failures === 0 ? "\nALL CORRECT" : `\n${failures} FAILURES`);
process.exit(failures === 0 ? 0 : 1);
