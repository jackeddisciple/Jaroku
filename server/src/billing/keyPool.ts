// N keys per provider, handed out in turn, and what happens when a provider says no.
//
// WHY A POOL AND NOT A KEY. One key is one rate limit, and a rate limit is per ACCOUNT rather than
// per workspace — so on the platform-paid path, every workspace in the deployment shares whatever
// the single key allows. That is fine at one workspace and is the first thing to break at fifty,
// in the least useful way: not a clear "we are at capacity" but a scatter of 429s that look, from
// inside a run, exactly like the provider having a bad afternoon.
//
// ROUND ROBIN, AND NOTHING CLEVERER. A load balancer that tried to track each key's remaining
// budget would need a signal providers do not reliably give, and would be a second system to be
// wrong. Turn-taking spreads load evenly, which is the whole of what is needed until there is
// evidence otherwise — the specification says so in as many words, and it is right.
//
// EXHAUSTION IS A 429 AND NEVER A QUEUE. The tempting alternative is to hold the request until a
// key frees up, which turns a capacity problem into a latency problem and hides it: the graphs stay
// green, the runs get slower, and nobody learns there is not enough capacity until somebody
// complains about speed. A refusal with a retry-after is a worse minute for one user and the only
// version in which the operator finds out.
//
// COOLDOWN RATHER THAN REMOVAL. A key that returns 429 is not broken — it is busy, and it will be
// fine shortly. So it is set aside for a while and comes back on its own; a pool that removed keys
// would drain to empty over a busy hour and never refill without a restart.
//
// WHAT THIS FILE DOES NOT DECIDE is whether a workspace may use the platform's key at all. That is
// `PlatformKeyGate`'s three gates — the kill switch, the plan, and the per-workspace ceiling — and
// they are asked first. This answers only "which key, if any, is free right now".

import { PROVIDER_ENV_KEY, type ProviderId } from "../providers.ts";

/**
 * How long a key that reported a rate limit is set aside for, when the provider does not say.
 *
 * Sixty seconds because that is the window most providers quote, and because the cost of being
 * wrong is asymmetric: too short and the next request rediscovers the limit, which is one wasted
 * call; too long and capacity sits idle, which is every user on the deployment waiting.
 */
export const DEFAULT_COOLDOWN_MS = 60_000;

/** The most a provider's own `retry-after` may set aside a key for. */
const MAX_COOLDOWN_MS = 15 * 60_000;

export interface PoolKey {
  /** The provider this key authenticates against. */
  provider: ProviderId;
  /** Which key of the provider's set this is — 1-based, for a log line nobody has to decode. */
  index: number;
  value: string;
}

export type PoolLease =
  | { ok: true; key: PoolKey }
  | { ok: false; reason: "unconfigured" | "exhausted"; retryAfterS: number };

/**
 * Where a provider's keys are read from.
 *
 * `ANTHROPIC_API_KEY` is the first, and `ANTHROPIC_API_KEY_2`, `_3` … are the rest. NUMBERED FROM
 * THE EXISTING NAME rather than a new `JAROKU_POOL_*` scheme, so a deployment that has one key
 * configured already has a pool of one and nothing to change — and adding capacity is adding a
 * variable rather than migrating a convention. The scan stops at the first gap, so a missing `_3`
 * hides a present `_4` loudly instead of silently doubling capacity nobody meant to add.
 */
export function poolKeysFor(
  provider: ProviderId,
  env: NodeJS.ProcessEnv = process.env,
): string[] {
  const base = PROVIDER_ENV_KEY[provider];
  const out: string[] = [];
  const first = (env[base] ?? "").trim();
  if (!first) return out;
  out.push(first);
  for (let n = 2; ; n++) {
    const next = (env[`${base}_${n}`] ?? "").trim();
    if (!next) break;
    out.push(next);
  }
  return out;
}

/**
 * The platform's keys, one provider at a time.
 *
 * IN MEMORY AND PER PROCESS, deliberately. The cursor and the cooldowns are hints about capacity
 * rather than facts about the world: two replicas each turn-taking through the same five keys still
 * spread load across all five, and a cooldown one replica learned is a cooldown the other will
 * learn from its own 429 a moment later. Coordinating them would mean a shared store on the path
 * every inference call takes, to save at most one refused request per replica per minute.
 */
export class ProviderKeyPool {
  private cursor = new Map<ProviderId, number>();
  /** `provider:index` → the moment it may be used again. */
  private cooling = new Map<string, number>();

  constructor(
    private env: NodeJS.ProcessEnv = process.env,
    private now: () => number = Date.now,
  ) {}

  /** How many keys this deployment holds for a provider. Zero is the ordinary local case. */
  size(provider: ProviderId): number {
    return poolKeysFor(provider, this.env).length;
  }

  /**
   * Take the next usable key, or say why there is none.
   *
   * STARTS FROM THE CURSOR AND WALKS THE WHOLE RING, so a key in cooldown is skipped rather than
   * blocking the ones behind it — and the cursor advances whether or not a key was taken, which is
   * what makes the sharing even rather than favouring whatever sits at position one.
   */
  lease(provider: ProviderId): PoolLease {
    const keys = poolKeysFor(provider, this.env);
    if (keys.length === 0) return { ok: false, reason: "unconfigured", retryAfterS: 0 };

    const start = this.cursor.get(provider) ?? 0;
    for (let step = 0; step < keys.length; step++) {
      const index = (start + step) % keys.length;
      this.cursor.set(provider, (index + 1) % keys.length);
      if (this.availableAt(provider, index) <= this.now()) {
        return { ok: true, key: { provider, index: index + 1, value: keys[index]! } };
      }
    }

    // EVERY KEY IS COOLING. The retry-after is the SOONEST one comes back, not the longest — the
    // caller is being told when to try again, and the answer is the moment capacity exists.
    const soonest = Math.min(
      ...keys.map((_, i) => this.availableAt(provider, i)),
    );
    return {
      ok: false,
      reason: "exhausted",
      retryAfterS: Math.max(1, Math.ceil((soonest - this.now()) / 1000)),
    };
  }

  /**
   * A provider told us this key is rate limited. Set it aside.
   *
   * `retryAfterS` IS THE PROVIDER'S OWN NUMBER WHEN THEY GIVE ONE, and a default when they do not —
   * the same rule `http/rateLimit.ts` follows about computing a retry-after from the refill rather
   * than guessing. Clamped, because a header is a value from outside this system: a provider having
   * a bad day could otherwise set aside the whole pool for an afternoon.
   */
  rateLimited(key: PoolKey, retryAfterS?: number): void {
    const ms = retryAfterS !== undefined && Number.isFinite(retryAfterS) && retryAfterS > 0
      ? Math.min(retryAfterS * 1000, MAX_COOLDOWN_MS)
      : DEFAULT_COOLDOWN_MS;
    this.cooling.set(`${key.provider}:${key.index - 1}`, this.now() + ms);
  }

  /** Whether any key for this provider could be used right now. For a readiness answer, not a gate. */
  hasCapacity(provider: ProviderId): boolean {
    return this.lease(provider).ok;
  }

  private availableAt(provider: ProviderId, index: number): number {
    return this.cooling.get(`${provider}:${index}`) ?? 0;
  }
}

/**
 * What a caller says to somebody whose run could not get a key.
 *
 * NAMES THE SITUATION AND WHAT WOULD CLEAR IT, which is the rule every refusal in this codebase is
 * written under. "High demand" is the honest description of an exhausted pool — it is not the
 * workspace's fault, it is not their quota, and nothing they change fixes it except waiting. And it
 * is deliberately distinguishable from "connect a key", which is what an unconfigured pool means
 * and which the person CAN act on.
 */
export function poolRefusal(lease: Extract<PoolLease, { ok: false }>): string {
  if (lease.reason === "unconfigured") {
    return "this deployment has no provider key to lend — connect your own in the Secrets tab";
  }
  return `high demand right now — every provider key is rate limited. Try again in ${lease.retryAfterS}s.`;
}
