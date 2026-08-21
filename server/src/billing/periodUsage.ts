// Counting the things a tier bounds, at the moment they actually happen.
//
// WHERE A RUN IS COUNTED IS THE WHOLE DECISION, and the specification names all three candidates
// because two of them are wrong:
//
//   ON REQUEST RECEIPT — wrong, because a request that gets refused was not a run. Counting there
//   means a workspace at its limit spends its next month's allowance on 402s, which is a quota that
//   punishes you for hitting a quota.
//
//   ON COMPLETION — wrong, and worse. A run that was killed, crashed or cancelled still spent the
//   model calls it had already made; counting only what finished means the expensive failure modes
//   are free, which is exactly backwards from what the number is protecting.
//
//   WHERE `status` FIRST BECOMES `running` — right, and it is where the money starts.
//
// "FIRST" IS DOING REAL WORK IN THAT SENTENCE. A run reaches `running` more than once: pause and
// resume is the ordinary case, and a restart that re-dispatches is another. Counting each arrival
// would mean pausing to think costs a run, so this counts a run ONCE, keyed by its id, and the
// mechanism is the same one the ledger uses — an idempotency key and a unique constraint, not a
// flag somebody has to remember to check.
//
// AND EVAL RUNS ARE COUNTED PER CASE, NOT PER BATCH. A batch over a hundred dataset cases is a
// hundred runs of the agent and a hundred model calls; billing it as one would make the eval engine
// the cheapest way to use the product, which it is not.
//
// NOTHING HERE THROWS INTO ITS CALLER. Every increment is fired and caught, because it sits on the
// trace ingest chain: a counter that could not be written is a figure that is slightly low for a
// month, and a run that dies because its counter could not be written is a run somebody lost.
// `UsageMeter.meterStep`'s call site makes the same trade, and says so.

import type { TenantContext } from "../db/tenant.ts";
import type { BillingRepository } from "../db/repositories/billing.ts";
import { billingPeriod } from "./gate.ts";
import type { UsageMetric } from "./entitlementGate.ts";

/**
 * The counters, incremented once per thing.
 *
 * Takes a repository rather than a `Db`, so this file imports no driver — `test:db-boundary` is
 * what makes that a rule rather than a habit.
 */
export class PeriodUsage {
  /**
   * Run ids already counted this process.
   *
   * A CACHE IN FRONT OF THE REAL GUARD, not the guard itself. The database is what makes counting
   * idempotent — see `countRun` — and this exists only so that a resume, which is the common case,
   * does not cost a round trip to learn something this process already knows. It is deliberately
   * unbounded in nothing but the lifetime of a process: a set of uuids for the runs one server
   * started is small, and it is emptied by the restart that would otherwise make it stale.
   */
  private counted = new Set<string>();

  constructor(private billing: BillingRepository, private now: () => Date = () => new Date()) {}

  /**
   * Count a run, at the moment it starts, and only the first time.
   *
   * THE DATABASE ARBITRATES, not the set above. Two replicas can watch the same run start — a
   * redelivered `run_start`, a restart re-reading its queue — and a check-then-write loses one of
   * them silently, which on a quota counter means a workspace quietly getting more than it paid
   * for. So the write is an INSERT that either creates the marker row or collides with it, and the
   * counter moves only when the insert won.
   *
   * THE MARKER IS A USAGE EVENT WITH NO COST, which is a deliberate reuse rather than a new table.
   * `usage_events.idempotency_key` is already globally unique and already the mechanism by which a
   * redelivered trace batch cannot bill twice; a run that has started is exactly the same kind of
   * fact, recorded the same way, and it makes "was this run counted" a question with an answer in
   * the ledger rather than in a cache.
   */
  async countRun(ctx: TenantContext, runId: string): Promise<void> {
    if (this.counted.has(runId)) return;
    await this.count(ctx, "runs", `period.run:${runId}`, 1, { runId });
    this.counted.add(runId);
  }

  /**
   * Count eval work, per dataset CASE.
   *
   * Keyed by the eval run's id and the number of cases, so a redelivered dispatch of the same batch
   * collides rather than doubling. A batch that grows between deliveries would be a different key,
   * which is the honest reading: it is a different amount of work.
   */
  async countEvalCases(ctx: TenantContext, evalRunId: string, cases: number): Promise<void> {
    if (cases <= 0) return;
    await this.count(ctx, "eval_runs", `period.eval:${evalRunId}:${cases}`, cases, {});
  }

  /** What this workspace has used this period, as a map. Absent metrics are absent, not zero. */
  async forCurrentPeriod(ctx: TenantContext): Promise<Record<string, number>> {
    return this.billing.usageForPeriod(ctx, billingPeriod(this.now()).start);
  }

  /**
   * The one write, with the two halves in the order that makes a crash between them harmless.
   *
   * THE MARKER FIRST, THEN THE COUNTER. A crash after the marker leaves a run counted once and
   * recorded as counted, which is right. A crash between them in the other order would leave the
   * counter moved and no record that it had been, so the next delivery would move it again — the
   * one ordering that can double-count. The same "evidence before the conclusion drawn from it"
   * rule `applySubscription` states at length for the same reason.
   */
  private async count(
    ctx: TenantContext,
    metric: UsageMetric,
    idempotencyKey: string,
    by: number,
    extra: { runId?: string },
  ): Promise<void> {
    const period = billingPeriod(this.now());
    // `cost_usd: null` with `cost_known: true` would be a lie — this row is not an unpriced call,
    // it is not a call at all. Zero and known is what it is: a thing that happened, costing nothing
    // of its own, whose whole purpose is the unique key.
    const claimed = await this.billing.record(ctx, {
      kind: "period.marker",
      idempotencyKey,
      runId: extra.runId ?? null,
      costUsd: 0,
      quantity: by,
      unit: metric,
      payer: "platform",
    });
    if (!claimed) return;
    await this.billing.incrementUsage(ctx, {
      metric,
      periodStart: period.start,
      periodEnd: period.end,
      by,
    });
  }
}
