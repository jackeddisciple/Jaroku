// What gets metered, named — same reasoning as queue/jobs.ts naming what the queue moves
// before anything moved it. A closed set in one module, so "which kind is this" is a decision
// somebody makes while looking at every other kind, rather than a string typed at a call site.
//
// THE SPLIT THAT MATTERS IS NOT llm-vs-not. It is WHOSE MODEL CALL IT WAS:
//
//   `llm.provider` — the agent's own calls, made inside a run, priced from its trace steps.
//   Under BYOK this is the user's own key and their own bill; we meter it because they want
//   the dashboard, and we do not charge for it.
//
//   `llm.judge` — the eval judge. Metered separately and never folded into a provider's agent
//   cost, exactly as `eval_runs.judge_cost_usd` already keeps it separate: a comparison that
//   charged the judge's opinion to the provider being judged would make an expensive judge
//   look like an expensive model.
//
//   `llm.generation` / `llm.plan` / `llm.edit` / `llm.explain` — the platform thinking on a
//   workspace's behalf. These are Anthropic-only and, under BYOK, are the calls the platform
//   genuinely pays for unless the workspace opts its own key in.
//
//   `sandbox.seconds` / `storage.bytes` — infrastructure. What is billable under BYOK, where
//   token spend is not. Kept as separate kinds from day one rather than added later, because
//   "meter everything, bill some of it" is a distinction that cannot be retrofitted onto rows
//   that never recorded which was which.

import type { BillingRepository } from "../db/repositories/billing.ts";
import type { TenantContext } from "../db/tenant.ts";
import type { Step } from "../types.ts";

/** Every kind of thing a `usage_events` row can describe. */
export const USAGE_KINDS = [
  "llm.provider",
  "llm.judge",
  "llm.generation",
  "llm.plan",
  "llm.edit",
  "llm.explain",
  "sandbox.seconds",
  "storage.bytes",
] as const;

export type UsageKind = (typeof USAGE_KINDS)[number];

export function isUsageKind(v: unknown): v is UsageKind {
  return typeof v === "string" && (USAGE_KINDS as readonly string[]).includes(v);
}

/** The kinds that are model calls. The dashboard's token columns mean nothing for the rest. */
export const LLM_KINDS: readonly UsageKind[] = USAGE_KINDS.filter((k) => k.startsWith("llm."));

/**
 * A deterministic name for one metered event.
 *
 * The same idea as `buildIdempotencyKey` in queue/jobs.ts, and needed for a stricter reason.
 * Trace ingestion is at-least-once by design — a worker that dies between writing steps and
 * acknowledging its batch will redeliver them — and Session 4 made that safe for the trace by
 * upserting on the step's own id. Billing has no such id to lean on, because a usage row is
 * DERIVED from a step rather than sent as one. So the derivation has to name itself, from the
 * parts that identify the thing being metered and nothing else.
 *
 * `parts` must therefore never include anything that varies between two deliveries of the same
 * event — no timestamp, no attempt counter that is not itself part of what was billed, no uuid
 * minted at the call site. A key that varies is not an idempotency key; it is a second charge.
 */
export function usageKey(kind: UsageKind, ...parts: string[]): string {
  return [kind, ...parts].join(":");
}

// --- metering ------------------------------------------------------------------------------

/**
 * Turns the things that happen into the rows that get billed.
 *
 * ONE OBJECT rather than a function per kind, because every kind needs the same two things: a
 * repository to write through, and a way to answer "which provider and model was that". The
 * second is the reason this holds state at all — see `runModels`.
 *
 * NOTHING HERE DECIDES ANYTHING. It records. Whether a workspace may start the next run is
 * billing/balances.ts's question, asked against these rows; keeping the two apart is what lets
 * metering be unconditional and enforcement be conditional, which is exactly the split BYOK
 * needs (meter everything, bill some of it).
 */
export class UsageMeter {
  /**
   * runId -> the provider and model that run is executing on.
   *
   * A step does not carry them. The frozen schema puts provider and model on the RUN, which is
   * correct — they do not change between steps — and means a step-derived usage row has to look
   * them up. Reading the run row per step would be a query per step on the ingest chain, which
   * is the one place in this process that must not become chatty; caching what `run_start`
   * already delivered costs nothing.
   *
   * A miss is not an error: a resumed segment arrives with no fresh `run_start`, and after a
   * restart there is nothing cached at all. `meterStep` falls back to the run row and then
   * remembers it, so the miss costs one query per run rather than one per step.
   */
  private runModels = new Map<string, { provider: string; model: string }>();

  constructor(
    private billing: BillingRepository,
    /** How a cache miss is answered. Injected rather than imported so this file does not
     *  depend on the trace store, and so a test can hand it a map. */
    private lookupRun: (ctx: TenantContext, runId: string) => Promise<{ provider: string; model: string } | null>,
  ) {}

  /** Remember what a run is executing on. Called from the `run_start` the ingest chain sees. */
  noteRun(runId: string, provider: string, model: string): void {
    this.runModels.set(runId, { provider, model });
  }

  /** Forget a finished run. The cache is a cache, not a record. */
  forgetRun(runId: string): void {
    this.runModels.delete(runId);
  }

  /**
   * Meter one trace step, if it is one that cost money. Returns whether a row was written.
   *
   * COST COMES FROM THE STEP, NEVER FROM `runs.cost`. That is the oldest rule in the cost model
   * and it is load-bearing here for a reason it was not on the dashboard: `runs.cost` is written
   * by `run_end`, and a run that crashes mid-graph never emits one — so a bill assembled from
   * run rows would omit every run that failed, which is precisely the population a retry storm
   * produces. The step is where the call happened and the step is what gets billed.
   *
   * A step with neither tokens nor cost is not metered at all. A `tool_call` or a
   * `state_update` did not talk to a provider, and writing a zero-cost row for one would fill
   * the table with events that mean nothing and make "how many model calls did this run make"
   * unanswerable.
   *
   * A step with tokens and NO cost IS metered, with a null cost and `cost_known = false`. That
   * is the whole "unknown is not zero" rule reaching the ledger: the alternative is dropping the
   * row, which would make an unpriced model look like a model that made no calls, and the
   * workspace's total would be a confident undercount rather than a flagged one.
   */
  async meterStep(ctx: TenantContext, step: Step): Promise<boolean> {
    if (step.type !== "llm_call") return false;
    if (step.tokens === null && step.cost === null) return false;

    const target = await this.modelFor(ctx, step.run_id);
    return this.billing.record(ctx, {
      kind: "llm.provider",
      // The STEP's id, which the tracer minted and which survives redelivery — the same id
      // `insertStep`'s ON CONFLICT DO NOTHING already relies on. Anything derived from the
      // moment of ingestion instead (a timestamp, a fresh uuid) would bill a redelivered batch
      // a second time, and at-least-once delivery guarantees there will be one.
      //
      // Worth stating what this does NOT cover: a branch copies a run's steps under FRESH ids,
      // and none of those copies is metered — because none of them goes through this path.
      // Money is metered where a call HAPPENS, not where a row exists.
      idempotencyKey: usageKey("llm.provider", step.id),
      runId: step.run_id,
      provider: target?.provider ?? null,
      model: target?.model ?? null,
      totalTokens: step.tokens,
      costUsd: step.cost,
      occurredAt: step.started_at,
    });
  }

  private async modelFor(
    ctx: TenantContext,
    runId: string,
  ): Promise<{ provider: string; model: string } | null> {
    const cached = this.runModels.get(runId);
    if (cached) return cached;
    const looked = await this.lookupRun(ctx, runId);
    if (looked) this.runModels.set(runId, looked);
    return looked;
  }
}
