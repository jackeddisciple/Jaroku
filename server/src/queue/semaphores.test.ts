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
