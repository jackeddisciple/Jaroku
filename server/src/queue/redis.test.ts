// The Redis connection itself, plus the one thing about it that's pure and needs no server:
// resolving JAROKU_REDIS_URL from an explicit override vs. the environment.
//
// The connectivity half SKIPS, loudly, when there's no Redis — same posture as
// db/postgres.test.ts. `npm run dev` and every other suite work with nothing installed, and a
// test that failed the build on a machine without Docker would make that a lie.
//
//   docker compose up -d redis
//   JAROKU_REDIS_URL=redis://127.0.0.1:6380 npm run test:redis

import { openRedis, pingRedis, redisUrlFromEnv, REDIS_URL_ENV } from "./redis.ts";

let failures = 0;
const check = (ok: boolean, msg: string): void => {
  if (ok) console.log(`  ok   ${msg}`);
  else {
    failures++;
    console.log(`  FAIL ${msg}`);
  }
};

console.log("\nresolving the URL");

check(
  redisUrlFromEnv({ env: {} }) === undefined,
  "no env var, no override -> undefined",
);
check(
  redisUrlFromEnv({ env: { [REDIS_URL_ENV]: "redis://from-env:6379" } }) === "redis://from-env:6379",
  "reads from the environment",
);
check(
  redisUrlFromEnv({ url: "redis://explicit:6379", env: { [REDIS_URL_ENV]: "redis://from-env:6379" } }) ===
    "redis://explicit:6379",
  "an explicit override wins over the environment",
);

try {
  openRedis({ env: {} });
  check(false, "openRedis with no URL configured anywhere throws rather than defaulting");
} catch (err) {
  check(
    (err as Error).message.includes(REDIS_URL_ENV),
    "the refusal names the variable that would fix it",
  );
}

// --- connectivity, if there is a server -------------------------------------------------

const url = redisUrlFromEnv();
if (!url) {
  console.log(
    `\nSKIPPED: no ${REDIS_URL_ENV}. Start one with \`docker compose up -d redis\` and set\n` +
      `  ${REDIS_URL_ENV}=redis://127.0.0.1:6380\n` +
      `to run the connectivity check against Redis.`,
  );
} else {
  const client = openRedis({ url });
  try {
    const ok = await pingRedis(client);
    check(ok, `PING answers PONG at ${url}`);
    if (ok) {
      const key = `jaroku:test:redis:${Date.now()}`;
      await client.set(key, "1", "PX", 5000);
      check((await client.get(key)) === "1", "a value written can be read back");
      await client.del(key);
      check((await client.get(key)) === null, "and deleted");
    }
  } catch (err) {
    console.log(`SKIPPED: ${REDIS_URL_ENV} is set but unreachable — ${(err as Error).message}`);
  } finally {
    client.disconnect();
  }
}

console.log(failures === 0 ? "\nALL CORRECT" : `\n${failures} FAILURES`);
process.exit(failures === 0 ? 0 : 1);
