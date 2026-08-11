// The hosted QueueBackend. Same semantics as InMemoryQueueBackend, made safe across however
// many worker processes are pointed at the same Redis by doing the admit sequence — rotate,
// check capacity, pop, reserve — as one Lua script. Redis runs a script to completion before
// looking at another command from anyone, which is what makes it one atomic step instead of
// four commands two workers could interleave between.
//
// Key layout, all under a job class:
//
//   q:{class}:list:{workspaceId}   LIST   one workspace's pending jobs, FIFO
//   q:{class}:ring                 LIST   rotation order of workspaces with pending work
//   q:{class}:reserved:index       ZSET   leaseId -> expiresAtMs, for every outstanding admit
//   q:{class}:reserved:job:{lease} STRING the admitted job's JSON, so reapExpired can recover
//                                         it — kept alive past its own lease TTL as a safety
//                                         net (ARGV silentTtl below) so a slightly-late reap
//                                         sweep still finds the job rather than nothing
//
// The reserved STRING's own Redis expiry is NOT the signal that a lease has lapsed — the ZSET
// score is. Tying "the job is recoverable" to the same clock as "the lease is still valid"
// would mean an unswept lease loses its job the instant it expires, which defeats the entire
// point of reserving it in the first place.

import type { Redis } from "ioredis";
import type { JobClass, QueueJob } from "./jobs.ts";
import type { AdmitOptions, QueueBackend } from "./backend.ts";

/** How much longer than its own lease a reserved job's JSON survives, so a reaper that runs
 *  a little late still finds something to recover. Generous on purpose — the cost of keeping
 *  a small string around too long is nothing next to the cost of losing a job. */
const SAFETY_NET_MULTIPLIER = 20;

const ADMIT_SCRIPT = `
local now = tonumber(ARGV[1])
local ttl = tonumber(ARGV[2])
local leaseId = ARGV[3]
local maxInFlight = tonumber(ARGV[4])
local listPrefix = ARGV[5]
local reservedPrefix = ARGV[6]
local safetyTtl = tonumber(ARGV[7])

if maxInFlight >= 0 then
  -- Exclusive of now, matching InMemoryQueueBackend's expiresAtMs > now. ZCOUNT's own min is
  -- inclusive, so a lease expiring on this exact millisecond counted as in flight here while
  -- CLAIM_EXPIRED_SCRIPT (score > now) already considered it reapable — one millisecond in which
  -- a lease was simultaneously holding capacity and available to be claimed.
  local inFlight = redis.call('ZCOUNT', KEYS[2], '(' .. now, '+inf')
  if inFlight >= maxInFlight then
    return false
  end
end

local ringLen = redis.call('LLEN', KEYS[1])
local attempts = 0
while attempts < ringLen do
  attempts = attempts + 1
  -- HEAD TO TAIL, not tail to head. enqueue RPUSHes a newly-pending workspace onto the TAIL, so
  -- rotating with RPOPLPUSH served the most RECENTLY pending workspace first — the ring ran
  -- backwards. Round-robin survived that (everyone still gets a turn per cycle) but two things
  -- did not: a workspace that has been waiting longest lost its place to one that just arrived,
  -- and ringOrder() answered "who is served next, and after that" in exactly reverse order,
  -- which is the opposite of what InMemoryQueueBackend answers for the same queue. One
  -- interface, two implementations, two different answers.
  local candidate = redis.call('LPOP', KEYS[1])
  if not candidate then
    return false
  end
  redis.call('RPUSH', KEYS[1], candidate)
  local listKey = listPrefix .. candidate
  local job = redis.call('LPOP', listKey)
  if job then
    if redis.call('LLEN', listKey) == 0 then
      -- The rotation just put it at the tail, so remove from the tail (LREM's negative count).
      redis.call('LREM', KEYS[1], -1, candidate)
    end
    local reservedKey = reservedPrefix .. leaseId
    redis.call('SET', reservedKey, job, 'PX', safetyTtl)
    redis.call('ZADD', KEYS[2], now + ttl, leaseId)
    return {candidate, job}
  else
    redis.call('LREM', KEYS[1], -1, candidate)
    ringLen = redis.call('LLEN', KEYS[1])
  end
end
return false
`;

const ENQUEUE_SCRIPT = `
local len = redis.call('RPUSH', KEYS[1], ARGV[2])
if len == 1 then
  redis.call('RPUSH', KEYS[2], ARGV[1])
end
return len
`;

const ACK_SCRIPT = `
redis.call('ZREM', KEYS[1], ARGV[1])
redis.call('DEL', KEYS[2])
return 1
`;

const CLAIM_EXPIRED_SCRIPT = `
local score = redis.call('ZSCORE', KEYS[1], ARGV[1])
if not score then return false end
if tonumber(score) > tonumber(ARGV[2]) then return false end
local job = redis.call('GET', KEYS[2])
redis.call('ZREM', KEYS[1], ARGV[1])
redis.call('DEL', KEYS[2])
if job then return job else return false end
`;

// A named semaphore is one sorted set: member = leaseId, score = expiresAtMs. Count is
// ZCOUNT((now, +inf) rather than ZCARD, so an expired-but-unreleased holder stops counting
// against the cap immediately rather than waiting for something to clean it up — the same
// "capacity check never deletes" rule inFlightCount follows for the ring's own reserved
// index, for the same reason: only an explicit release should ever remove a member.
const SEMAPHORE_ACQUIRE_SCRIPT = `
local key = KEYS[1]
local now = tonumber(ARGV[1])
local ttl = tonumber(ARGV[2])
local leaseId = ARGV[3]
local max = tonumber(ARGV[4])

local live = redis.call('ZCOUNT', key, '(' .. now, '+inf')
if live >= max then
  return false
end
redis.call('ZADD', key, now + ttl, leaseId)
-- Trim anything already expired so an idle semaphore's zset doesn't grow forever. Strictly
-- less than now, never touching a still-live member regardless of what TTL it was granted.
redis.call('ZREMRANGEBYSCORE', key, '-inf', '(' .. now)
return true
`;

const SEMAPHORE_RELEASE_SCRIPT = `
redis.call('ZREM', KEYS[1], ARGV[1])
return 1
`;

// Removes each ARGV item (the exact serialized job, matched by value — LREM's own contract)
// from the list, then drops the workspace from the ring if that emptied it. ARGV[1] is the
// workspace id, ARGV[2..] the items; the caller already knows exactly which serialized jobs
// to remove because it read them via LRANGE and filtered by idempotencyKey itself — this
// script's only job is doing the removal atomically against whatever else the ring is doing.
const PURGE_PENDING_SCRIPT = `
local removed = 0
for i = 2, #ARGV do
  removed = removed + redis.call('LREM', KEYS[1], 1, ARGV[i])
end
if redis.call('LLEN', KEYS[1]) == 0 then
  redis.call('LREM', KEYS[2], 1, ARGV[1])
end
return removed
`;

interface QueueRedis extends Redis {
  jarokuAdmit(
    ring: string,
    index: string,
    now: string,
    ttl: string,
    leaseId: string,
    maxInFlight: string,
    listPrefix: string,
    reservedPrefix: string,
    safetyTtl: string,
  ): Promise<[string, string] | null>;
  jarokuEnqueue(list: string, ring: string, workspaceId: string, jobJson: string): Promise<number>;
  jarokuAck(index: string, reservedKey: string, leaseId: string): Promise<number>;
  jarokuClaimExpired(index: string, reservedKey: string, leaseId: string, now: string): Promise<string | null>;
  jarokuSemAcquire(semKey: string, now: string, ttl: string, leaseId: string, max: string): Promise<1 | null>;
  jarokuSemRelease(semKey: string, leaseId: string): Promise<number>;
  jarokuPurgePending(list: string, ring: string, workspaceId: string, ...items: string[]): Promise<number>;
}

function keys(jobClass: JobClass) {
  const base = `q:${jobClass}`;
  return {
    ring: `${base}:ring`,
    index: `${base}:reserved:index`,
    listPrefix: `${base}:list:`,
    reservedPrefix: `${base}:reserved:job:`,
    list: (workspaceId: string) => `${base}:list:${workspaceId}`,
    reserved: (leaseId: string) => `${base}:reserved:job:${leaseId}`,
  };
}

/** Semaphore keys are not job-class-ring keys — they live under their own namespace so a
 *  workspace's `run.eval` reservation can never collide with anything the ring uses. */
function semaphoreRedisKey(key: string): string {
  return `sem:${key}`;
}

export class RedisQueueBackend implements QueueBackend {
  private client: QueueRedis;

  constructor(client: Redis) {
    this.client = client as QueueRedis;
    if (typeof this.client.jarokuAdmit !== "function") {
      this.client.defineCommand("jarokuAdmit", { numberOfKeys: 2, lua: ADMIT_SCRIPT });
      this.client.defineCommand("jarokuEnqueue", { numberOfKeys: 2, lua: ENQUEUE_SCRIPT });
      this.client.defineCommand("jarokuAck", { numberOfKeys: 2, lua: ACK_SCRIPT });
      this.client.defineCommand("jarokuClaimExpired", { numberOfKeys: 2, lua: CLAIM_EXPIRED_SCRIPT });
      this.client.defineCommand("jarokuSemAcquire", { numberOfKeys: 1, lua: SEMAPHORE_ACQUIRE_SCRIPT });
      this.client.defineCommand("jarokuSemRelease", { numberOfKeys: 1, lua: SEMAPHORE_RELEASE_SCRIPT });
      this.client.defineCommand("jarokuPurgePending", { numberOfKeys: 2, lua: PURGE_PENDING_SCRIPT });
    }
  }

  async enqueue(job: QueueJob): Promise<void> {
    const k = keys(job.class);
    await this.client.jarokuEnqueue(k.list(job.workspaceId), k.ring, job.workspaceId, JSON.stringify(job));
  }

  async tryAdmit(jobClass: JobClass, opts: AdmitOptions): Promise<QueueJob | null> {
    const k = keys(jobClass);
    const now = Date.now();
    const max = opts.maxGlobalInFlight ?? -1;
    const safetyTtl = Math.max(opts.leaseTtlMs * SAFETY_NET_MULTIPLIER, opts.leaseTtlMs + 60_000);
    const reply = await this.client.jarokuAdmit(
      k.ring,
      k.index,
      String(now),
      String(opts.leaseTtlMs),
      opts.leaseId,
      String(max),
      k.listPrefix,
      k.reservedPrefix,
      String(safetyTtl),
    );
    if (!reply) return null;
    const [, jobJson] = reply;
    return JSON.parse(jobJson) as QueueJob;
  }

  async ack(jobClass: JobClass, leaseId: string): Promise<void> {
    const k = keys(jobClass);
    await this.client.jarokuAck(k.index, k.reserved(leaseId), leaseId);
  }

  async reapExpired(jobClass: JobClass): Promise<QueueJob[]> {
    const k = keys(jobClass);
    const now = Date.now();
    const expiredLeaseIds = await this.client.zrangebyscore(k.index, "-inf", now);
    const reclaimed: QueueJob[] = [];
    for (const leaseId of expiredLeaseIds) {
      const jobJson = await this.client.jarokuClaimExpired(k.index, k.reserved(leaseId), leaseId, String(now));
      if (!jobJson) continue; // another reaper already claimed it, or it was acked in between
      const job = JSON.parse(jobJson) as QueueJob;
      reclaimed.push(job);
      await this.enqueue(job);
    }
    return reclaimed;
  }

  async pendingCount(jobClass: JobClass, workspaceId: string): Promise<number> {
    return this.client.llen(keys(jobClass).list(workspaceId));
  }

  async ringOrder(jobClass: JobClass): Promise<string[]> {
    return this.client.lrange(keys(jobClass).ring, 0, -1);
  }

  async inFlightCount(jobClass: JobClass): Promise<number> {
    // `(now`, not `now` — see ADMIT_SCRIPT's own note on why the boundary is exclusive.
    return this.client.zcount(keys(jobClass).index, `(${Date.now()}`, "+inf");
  }

  async acquireSemaphore(key: string, max: number, leaseId: string, ttlMs: number): Promise<boolean> {
    const now = Date.now();
    const reply = await this.client.jarokuSemAcquire(semaphoreRedisKey(key), String(now), String(ttlMs), leaseId, String(max));
    return reply === 1;
  }

  async releaseSemaphore(key: string, leaseId: string): Promise<void> {
    await this.client.jarokuSemRelease(semaphoreRedisKey(key), leaseId);
  }

  async semaphoreCount(key: string): Promise<number> {
    return this.client.zcount(semaphoreRedisKey(key), `(${Date.now()}`, "+inf");
  }

  async purgePending(jobClass: JobClass, workspaceId: string, idempotencyKeys: Set<string>): Promise<number> {
    const k = keys(jobClass);
    const raw = await this.client.lrange(k.list(workspaceId), 0, -1);
    const toRemove = raw.filter((j) => idempotencyKeys.has((JSON.parse(j) as QueueJob).idempotencyKey));
    if (!toRemove.length) return 0;
    return this.client.jarokuPurgePending(k.list(workspaceId), k.ring, workspaceId, ...toRemove);
  }
}
