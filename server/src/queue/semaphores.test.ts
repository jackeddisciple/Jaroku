// Named leased semaphores, against both backends - and the pure key-naming logic that needs
// no backend at all.
//
//   docker compose up -d redis
//   JAROKU_REDIS_URL=redis://127.0.0.1:6380 npm run test:semaphores

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

const url = redisUrlFromEnv();
if (!url) {
  console.log(
    `\nSKIPPED: no JAROKU_REDIS_URL. Start one with \`docker compose up -d redis\` and set\n` +
      `  JAROKU_REDIS_URL=redis://127.0.0.1:6380\n` +
      `to run the identical conformance suite against Redis.`,
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
