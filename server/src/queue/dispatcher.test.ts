// The fair dispatcher's conformance suite, against both backends.
//
// InMemoryQueueBackend runs always — nothing installed needed, same posture every suite in
// this codebase holds to. RedisQueueBackend runs the IDENTICAL scenarios when a real Redis is
// reachable, and SKIPS loudly rather than silently passing when there isn't one.
//
//   docker compose up -d redis
//   JAROKU_REDIS_URL=redis://127.0.0.1:6380 npm run test:dispatcher

import { InMemoryQueueBackend } from "./inMemoryBackend.ts";
import { RedisQueueBackend } from "./redisBackend.ts";
import { openRedis, pingRedis, redisUrlFromEnv } from "./redis.ts";
import { runQueueConformance } from "./conformance.ts";

let failures = 0;

console.log("\nInMemoryQueueBackend");
failures += (await runQueueConformance("in-memory", new InMemoryQueueBackend())).failures;

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
      failures += (await runQueueConformance("redis", new RedisQueueBackend(client))).failures;
    } finally {
      client.disconnect();
    }
  }
}

console.log(failures === 0 ? "\nALL CORRECT" : `\n${failures} FAILURES`);
process.exit(failures === 0 ? 0 : 1);
