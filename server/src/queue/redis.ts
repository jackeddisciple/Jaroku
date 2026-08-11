// Session 5 of the hosted migration: the Redis connection every queue module in this
// directory shares.
//
// Nothing before this session needed Redis at all — one process owned the pool, the eval
// pump and every WebSocket in one address space, so "who else is running work" was a
// question answerable from local memory. A worker process changes that: it has no sockets,
// the gateway has no pool slots of its own to hand an eval job, and neither can see the
// other's memory. Redis is the one thing both sides open a connection to.
//
// Same rule as JAROKU_PG_URL and JAROKU_OBJECT_STORE: local development needs NOTHING
// installed and NOTHING running. Redis is infrastructure for the queue and the fair
// dispatcher, not for `npm run dev`, and every module that opens one gates it behind
// JAROKU_REDIS_URL being set at all — see queue/dispatcher.ts and worker.ts, neither of
// which this commit wires up yet.

import Redis, { type RedisOptions } from "ioredis";

/** Where Jaroku's own Redis lives. Unset means "the queue is not configured" — callers
 *  decide what that means for them, this module only opens what it's told to. */
export const REDIS_URL_ENV = "JAROKU_REDIS_URL";

export interface OpenRedisOptions {
  /** Overrides JAROKU_REDIS_URL. Tests pass this rather than mutating the environment. */
  url?: string;
  /** Overrides process.env. */
  env?: NodeJS.ProcessEnv;
}

export function redisUrlFromEnv(opts: OpenRedisOptions = {}): string | undefined {
  const env = opts.env ?? process.env;
  return opts.url ?? env[REDIS_URL_ENV];
}

/**
 * One Redis connection, lazily connecting so constructing a client never blocks and never
 * throws — a queue module can hold this from boot and only pay for a live socket once
 * something actually calls it, exactly the posture `claude.ts` takes with its lazy
 * Anthropic client.
 *
 * `maxRetriesPerRequest: null` and a bounded reconnect backoff over ioredis's own retry loop:
 * the default gives up on a slow reconnect by rejecting in-flight commands, which turns a
 * two-second Redis restart into a wave of dispatcher errors instead of a wave of latency.
 */
export function openRedis(opts: OpenRedisOptions = {}): Redis {
  const url = redisUrlFromEnv(opts);
  if (!url) {
    throw new Error(
      `${REDIS_URL_ENV} is not set. \`docker compose up -d redis\` starts one locally, then set\n` +
        `  ${REDIS_URL_ENV}=redis://127.0.0.1:6380`,
    );
  }
  const options: RedisOptions = {
    lazyConnect: true,
    maxRetriesPerRequest: null,
    retryStrategy: (attempt: number) => Math.min(1000 * attempt, 10_000),
  };
  return new Redis(url, options);
}

/** True once `PING` answers. Used by health checks and by tests deciding whether to skip. */
export async function pingRedis(client: Redis): Promise<boolean> {
  try {
    if (client.status === "wait" || client.status === "end") await client.connect();
    const reply = await client.ping();
    return reply === "PONG";
  } catch {
    return false;
  }
}
