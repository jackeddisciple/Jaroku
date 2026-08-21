// Telling the payment provider what was used, in batches, because per-call reporting loses data.
//
// THE SPECIFICATION IS BLUNT ABOUT THIS AND IT IS RIGHT: Stripe rate-limits usage records, and a
// system that reported one per inference call would hit those limits under exactly the load that
// makes the reporting matter — and a usage record that was rate-limited is revenue that silently
// never happened. So: every five minutes, or every hundred calls, whichever comes first.
//
// THE TWO TRIGGERS ARE NOT REDUNDANT. The timer bounds LATENCY, so a quiet workspace's overage
// still reaches the invoice the same day it happened. The count bounds SIZE, so a busy one does not
// accumulate five minutes of a fan-out into a single enormous report. Either alone leaves the other
// case unbounded.
//
// ONLY OVERAGE IS REPORTED. Included credit is not a metered charge — it is what the subscription
// price already bought — so the report starts only once accumulated cost has passed the plan's
// included figure. Reporting from the first dollar would invoice everybody twice for the first $15.
//
// WHAT THE CLIENT SEES IS NOT WHAT STRIPE SEES, AND THAT IS FINE. The workspace's own usage figure
// comes from `workspace_usage_periods` and moves on every call; Stripe's copy lags by at most a
// batch. They agree at the end of the period, which is when an invoice is produced, and the
// alternative — making them agree continuously — is the per-call reporting this file exists to
// avoid.
//
// A FLUSH THAT FAILS KEEPS ITS ROWS. The pending amounts are returned to the buffer rather than
// dropped, so a provider outage delays a report instead of losing one. The duplicate risk that
// creates is handled the way every other write to a provider is: an idempotency key derived from
// what is being reported, so a retry of the same batch is the same batch.

import type { TenantContext } from "../db/tenant.ts";
import type { StripeConfig } from "./stripe.ts";

/** Every five minutes. The latency bound — see the header on why there are two. */
export const FLUSH_INTERVAL_MS = 5 * 60_000;

/** Or every hundred calls. The size bound. */
export const FLUSH_AT_CALLS = 100;

interface Pending {
  workspaceId: string;
  /** The subscription item a usage record is posted against. Nothing can be reported without it. */
  subscriptionItemId: string;
  /** Accumulated overage since the last successful report, in whatever unit the price meters. */
  quantity: number;
  calls: number;
  /** The period this belongs to, so a rollover cannot fold two months into one report. */
  periodStart: string;
}

export interface ReporterDeps {
  config: () => StripeConfig;
  /**
   * Which subscription item this workspace's overage is billed against, or null when none is.
   *
   * NULL IS THE ORDINARY CASE and not an error: a workspace on Free, a workspace within its
   * included credit, and a deployment with no metered price configured all answer null, and all
   * three mean "nothing to report" rather than "something went wrong".
   */
  subscriptionItemFor: (ctx: TenantContext) => Promise<string | null>;
  log?: (line: string) => void;
  now?: () => number;
}

export class UsageReporter {
  /** Keyed by workspace, because a report is per subscription item and there is one per workspace. */
  private pending = new Map<string, Pending>();
  private timer: ReturnType<typeof setInterval> | null = null;
  private log: (line: string) => void;

  constructor(private deps: ReporterDeps) {
    this.log = deps.log ?? ((line) => console.log(line));
  }

  /**
   * Start the interval that bounds how long a figure can sit unreported.
   *
   * UNREF'D, like every other scheduled thing in this codebase: a timer that keeps a process alive
   * is a process that will not shut down cleanly, and a deployment restarting during a release
   * should not wait five minutes to do it.
   */
  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => void this.flushAll(), FLUSH_INTERVAL_MS);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /**
   * Add overage to what will be reported.
   *
   * `overageUsd` IS ALREADY THE PART PAST THE INCLUDED CREDIT — the caller subtracts, because the
   * caller is the one that knows what the plan included and what has been spent this period. A
   * reporter that worked that out itself would be a second place that has to know what a plan means.
   */
  async record(
    ctx: TenantContext,
    overageUsd: number,
    periodStart: string,
  ): Promise<void> {
    if (!(overageUsd > 0)) return;
    const itemId = await this.deps.subscriptionItemFor(ctx);
    // Nothing to report against. Not an error — a workspace inside its credit is the common case.
    if (!itemId) return;

    const existing = this.pending.get(ctx.workspaceId);
    // A PERIOD BOUNDARY EMPTIES THE BUFFER BY REPORTING IT. Folding August's overage into July's
    // record would put the charge on the wrong invoice, which is the one kind of billing error
    // nobody can reconcile afterwards.
    if (existing && existing.periodStart !== periodStart) {
      await this.flush(ctx.workspaceId);
    }

    const next = this.pending.get(ctx.workspaceId) ?? {
      workspaceId: ctx.workspaceId,
      subscriptionItemId: itemId,
      quantity: 0,
      calls: 0,
      periodStart,
    };
    next.quantity += overageUsd;
    next.calls += 1;
    this.pending.set(ctx.workspaceId, next);

    if (next.calls >= FLUSH_AT_CALLS) await this.flush(ctx.workspaceId);
  }

  /** How much is waiting to be reported for a workspace. For a suite and for a health answer. */
  pendingFor(workspaceId: string): { quantity: number; calls: number } | null {
    const p = this.pending.get(workspaceId);
    return p ? { quantity: p.quantity, calls: p.calls } : null;
  }

  async flushAll(): Promise<void> {
    for (const workspaceId of [...this.pending.keys()]) await this.flush(workspaceId);
  }

  /**
   * Report one workspace's accumulated overage.
   *
   * TAKEN OUT OF THE BUFFER FIRST, so a call arriving during the request accumulates against a
   * fresh row rather than being reported and then reported again. Put BACK on failure, which is
   * what makes an outage a delay rather than a loss.
   */
  async flush(workspaceId: string): Promise<void> {
    const batch = this.pending.get(workspaceId);
    if (!batch || batch.quantity <= 0) return;
    this.pending.delete(workspaceId);

    const cfg = this.deps.config();
    if (!cfg.secretKey) {
      // No payments configured, which is the local path and not an error state. Dropped rather than
      // held: holding would grow a buffer forever on a deployment that will never report anything.
      return;
    }

    try {
      await postUsageRecord(cfg, batch);
      this.log(
        `[billing] reported ${batch.quantity.toFixed(4)} of overage for ${workspaceId} ` +
        `(${batch.calls} call(s))`,
      );
    } catch (err) {
      // BACK IN THE BUFFER, merged with anything that arrived while the request was in flight. The
      // next flush carries both, and the idempotency key changes with the amount — which is correct
      // rather than a hole: it is a different report, of a larger number, and Stripe adds usage
      // records rather than replacing them, so a partially-succeeded batch is the case the key
      // protects against and a genuinely larger batch is the case it must not.
      const arrived = this.pending.get(workspaceId);
      if (arrived) {
        arrived.quantity += batch.quantity;
        arrived.calls += batch.calls;
      } else {
        this.pending.set(workspaceId, batch);
      }
      this.log(`[billing] could not report usage for ${workspaceId}: ${(err as Error)?.message ?? err}`);
    }
  }
}

/**
 * The API call, form-encoded, by hand.
 *
 * NO SDK, for the reason `stripe.ts` has none: this is one POST, and a dependency in the path a
 * payment takes is a supply chain in the path a payment takes.
 *
 * `action=increment` RATHER THAN `set`, which is the difference between reporting what has happened
 * SINCE the last report and reporting a running total. This buffer holds a delta, so `set` would
 * overwrite the period's total with the last five minutes of it.
 */
async function postUsageRecord(cfg: StripeConfig, batch: Pending): Promise<void> {
  const body = new URLSearchParams();
  // Stripe meters in whole units. Rounded UP, so a fraction of a cent is never free — and rounded
  // here rather than at accumulation, so a hundred small calls round once rather than a hundred
  // times, which is the difference between a rounding error and a systematic one.
  body.set("quantity", String(Math.max(1, Math.ceil(batch.quantity * 100))));
  body.set("action", "increment");
  body.set("timestamp", String(Math.floor(Date.now() / 1000)));

  const res = await fetch(
    `${cfg.apiBase ?? "https://api.stripe.com"}/v1/subscription_items/${encodeURIComponent(batch.subscriptionItemId)}/usage_records`,
    {
      method: "POST",
      headers: {
        authorization: `Bearer ${cfg.secretKey}`,
        "content-type": "application/x-www-form-urlencoded",
        // The batch's own contents, so a retry of the SAME report is the same report and a genuinely
        // larger one is not.
        "idempotency-key": `usage:${batch.workspaceId}:${batch.periodStart}:${batch.quantity.toFixed(6)}`,
      },
      body: body.toString(),
      signal: AbortSignal.timeout(15_000),
    },
  );
  if (!res.ok) {
    // The status and not the body — Stripe echoes parameters back, and this string reaches a log.
    throw new Error(`Stripe answered ${res.status} ${res.statusText} reporting usage`);
  }
}
