// The fair dispatcher's conformance suite, against every backend.
//
// THREE RUNS, NOT ONE-AND-A-SKIP. InMemoryQueueBackend always. RedisQueueBackend against
// fixtures/redis/mockRedis.ts always — which executes redisBackend.ts's real Lua source in a real
// Lua VM, so the atomic admit, the leases and the purge are genuinely exercised on a machine with
// no Redis installed. And RedisQueueBackend against a REAL Redis when JAROKU_REDIS_URL points at
// one, which is still the authority and still what a hosted deployment runs.
//
// Before the fixture existed this file printed "SKIPPED" for everything but the in-memory backend,
// which meant the hosted backend's Lua — the load-bearing half of Session 5 — had no coverage at
// all on any machine without Docker.
//
//   docker compose up -d redis
//   JAROKU_REDIS_URL=redis://127.0.0.1:6380 npm run test:dispatcher

import type { Redis } from "ioredis";
import { MockRedis } from "../../fixtures/redis/mockRedis.ts";
import { InMemoryQueueBackend } from "./inMemoryBackend.ts";
import { RedisQueueBackend } from "./redisBackend.ts";
import { openRedis, pingRedis, redisUrlFromEnv } from "./redis.ts";
import { runQueueConformance } from "./conformance.ts";

let failures = 0;

console.log("\nInMemoryQueueBackend");
failures += (await runQueueConformance("in-memory", new InMemoryQueueBackend())).failures;

console.log("\nRedisQueueBackend, on the in-process Lua fixture");
failures += (
  await runQueueConformance("redis-lua", new RedisQueueBackend(new MockRedis() as unknown as Redis))
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
      failures += (await runQueueConformance("redis", new RedisQueueBackend(client))).failures;
    } finally {
      client.disconnect();
    }
  }
}

console.log(failures === 0 ? "\nALL CORRECT" : `\n${failures} FAILURES`);
process.exit(failures === 0 ? 0 : 1);
