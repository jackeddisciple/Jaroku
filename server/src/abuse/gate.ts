// Where an observation becomes a consequence, and where a consequence is asked about.
//
// TWO METHODS, AND THEY ARE ON DIFFERENT PATHS ON PURPOSE.
//
//   `evaluate` runs AFTER a signal was recorded, off the request path, and may write. It is the
//   only thing that applies or lifts an automatic rung.
//
//   `check` runs BEFORE work is dispatched, on the request path, and never writes. It is cached
//   for a few seconds, because it is asked on every run, generation and eval start and a
//   suspension that takes five seconds to take effect is indistinguishable from one that takes
//   none — while a database round trip per dispatch is not.
//
// THE CACHE IS SHORT AND INVALIDATED ON WRITE, which is the same posture the membership cache
// takes and for the same reason: the window where a stale answer is wrong is the window where
// somebody's enforcement has just changed, and the cost of being wrong for five seconds in that
// window is one more run — bounded, recoverable, and much cheaper than making every dispatch
// wait on a query.

import type { AbuseRepository } from "../db/repositories/abuse.ts";
import type { EnforcementRepository } from "../db/repositories/enforcement.ts";
import type { TenantContext } from "../db/tenant.ts";
import {
  NO_ENFORCEMENT,
  decide,
  refusesWork,
  rungFor,
  type EnforcementState,
} from "./enforcement.ts";

export interface AbuseGateDeps {
  signals: AbuseRepository;
  enforcement: EnforcementRepository;
  /**
   * Tell the workspace what changed.
   *
   * A rung applied without anybody being told is a workspace whose runs simply stop working,
   * which produces a support ticket that starts with "is it broken". Optional so the gate is
   * testable without a relay.
   */
  notify?: (ctx: TenantContext, event: { level: string; message: string; applied: boolean }) => void;
  log?: (line: string) => void;
  now?: () => number;
}

/** How long a `check` answer is reused. See the header on why this is small rather than zero. */
const CACHE_TTL_MS = 5_000;

export class AbuseGate {
  private cache = new Map<string, { state: EnforcementState; at: number }>();
  private log: (line: string) => void;
  private now: () => number;

  constructor(private deps: AbuseGateDeps) {
    this.log = deps.log ?? ((line) => console.log(line));
    this.now = deps.now ?? Date.now;
  }

  /**
   * What is in force for this workspace, cached.
   *
   * FAILS OPEN, and this one is worth being explicit about. If the enforcement table cannot be
   * read, this returns `none` — a workspace keeps working. The alternative, failing closed,
   * means a database blip suspends every customer at once, which is a self-inflicted outage
   * dressed as a safety measure. Enforcement bounds consumption; it is not a security boundary,
   * and nothing that IS one behaves this way.
   */
  async check(ctx: TenantContext): Promise<EnforcementState> {
    const hit = this.cache.get(ctx.workspaceId);
    if (hit && this.now() - hit.at < CACHE_TTL_MS) return hit.state;
    try {
      const state = await this.deps.enforcement.current(ctx);
      this.cache.set(ctx.workspaceId, { state, at: this.now() });
      return state;
    } catch (err) {
      this.log(`[abuse] could not read enforcement for ${ctx.workspaceId}: ${(err as Error)?.message ?? err}`);
      return NO_ENFORCEMENT;
    }
  }

  /** Whether this workspace may START something that consumes. Never about what is running. */
  async mayStartWork(ctx: TenantContext): Promise<{ ok: true } | { ok: false; state: EnforcementState }> {
    const state = await this.check(ctx);
    // A LAPSED automatic rung refuses nothing. The row is still unlifted — `evaluate` is what
    // tidies it away — and treating it as in force would mean a soft limit outlived its expiry
    // for as long as it took the next signal to arrive.
    if (state.expiresAt && !state.byHuman && Date.parse(state.expiresAt) <= this.now()) return { ok: true };
    return refusesWork(state.level) ? { ok: false, state } : { ok: true };
  }

  /**
   * Re-decide this workspace's rung from its current score.
   *
   * Called after a signal is recorded, and cheap enough to call more often than that. It writes
   * only when something CHANGES — see `decide`, which returns `none` for the overwhelmingly
   * common case of a score that has not crossed anything.
   */
  async evaluate(ctx: TenantContext): Promise<EnforcementState> {
    const current = await this.deps.enforcement.current(ctx);
    const score = await this.deps.signals.score(ctx, this.now());
    const verdict = decide(current, score, this.now());
    if (verdict.action === "none") return current;

    this.cache.delete(ctx.workspaceId);

    if (verdict.action === "lift") {
      await this.deps.enforcement.lift(ctx, verdict.reason, null);
      this.log(`[abuse] ${ctx.workspaceId} enforcement lifted — ${verdict.reason}`);
      this.deps.notify?.(ctx, {
        level: "none",
        message: "the temporary limit on this workspace has been lifted",
        applied: false,
      });
      return NO_ENFORCEMENT;
    }

    const rung = rungFor(verdict.level);
    const recent = await this.deps.signals.recent(ctx, 20);
    const applied = await this.deps.enforcement.apply(ctx, {
      level: verdict.level,
      reason: verdict.reason,
      // THE EVIDENCE, COPIED. Signals decay and are swept at thirty days, so a row that pointed
      // at them would by the time of an appeal point at nothing. Kinds and counts only — a
      // signal's detail can name a run, and an enforcement record is not a place to accumulate
      // a second copy of somebody's trace.
      evidence: {
        score,
        counts: recent.reduce<Record<string, number>>((acc, s) => {
          acc[s.kind] = (acc[s.kind] ?? 0) + 1;
          return acc;
        }, {}),
      },
      appliedBy: null,
      expiresAt: rung?.expiresAfterMs ? new Date(this.now() + rung.expiresAfterMs).toISOString() : null,
    });
    this.log(`[abuse] ${ctx.workspaceId} → ${verdict.level} (score ${Math.round(score)})`);
    this.deps.notify?.(ctx, {
      level: verdict.level,
      message: rung?.explain ?? "this workspace has been limited",
      applied: true,
    });
    return {
      level: applied.level,
      reason: applied.reason,
      appliedAt: applied.applied_at,
      expiresAt: applied.expires_at,
      byHuman: false,
    };
  }

  /** Forget a cached answer, for when something outside this module changed one. */
  invalidate(workspaceId: string): void {
    this.cache.delete(workspaceId);
  }
}
