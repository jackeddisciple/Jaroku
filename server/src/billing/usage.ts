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

import { randomUUID } from "node:crypto";
import type { BillingRepository } from "../db/repositories/billing.ts";
import type { TenantContext } from "../db/tenant.ts";
import { costFor, round8 } from "../pricing.ts";
import type { Step } from "../types.ts";
import { BYTES_PER_GIB, HOURS_PER_MONTH, infraRates, type InfraRates } from "./rates.ts";

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
  /**
   * A thing that was COUNTED against a tier's quota, rather than a thing that cost money.
   *
   * THE ODD ONE OUT ON THIS LIST, and it is here rather than in a table of its own because what it
   * needs is exactly what this table already provides: a globally unique key, an INSERT that either
   * wins or collides, and a row somebody can look at afterwards. `workspace_usage_periods` holds a
   * running total and cannot answer "was THIS run counted"; a second marker table would be this
   * one with the money columns unused.
   *
   * IT COSTS ZERO AND KNOWS IT. `cost_usd: 0` with `cost_known: true` is not the "unknown is not
   * zero" rule being broken — an unpriced call is a call whose price we could not look up, and this
   * is not a call at all. `quantity` carries how many the row counted, so an eval batch of a
   * hundred cases is one row saying a hundred rather than a hundred rows.
   *
   * IT MUST STAY OUT OF EVERY SPEND FIGURE, which it does by costing nothing: `spendSince` sums
   * `cost_usd`, and zero adds nothing to a total or to a share. `test:metering` asserts that.
   */
  "period.marker",
] as const;

export type UsageKind = (typeof USAGE_KINDS)[number];

/**
 * Whose money paid for a metered call.
 *
 * Beside the kinds rather than in the schema, for the reason the kinds are: `kind` says what was
 * bought and this says who bought it, and under BYOK those are different questions about the
 * same row. An `llm.provider` call on a workspace's own key is their bill; the identical call on
 * ours is ours. See migration 024.
 */
export const PAYERS = ["platform", "workspace"] as const;
export type Payer = (typeof PAYERS)[number];

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
  private runModels = new Map<string, { provider: string; model: string; payer: Payer }>();

  constructor(
    private billing: BillingRepository,
    /** How a cache miss is answered. Injected rather than imported so this file does not
     *  depend on the trace store, and so a test can hand it a map. */
    private lookupRun: (ctx: TenantContext, runId: string) => Promise<{ provider: string; model: string } | null>,
  ) {}

  /**
   * Remember what a run is executing on, and whose key is paying for it.
   *
   * `payer` cannot be recovered later: whether a run used its workspace's own key depends on
   * what was configured AT THE TIME, and a workspace that connects a key tomorrow would
   * retroactively change what today's rows mean. So it is recorded when the run starts, by the
   * one caller that knows — the thing that built the run's environment.
   */
  noteRun(runId: string, provider: string, model: string, payer: Payer = "platform"): void {
    this.runModels.set(runId, { provider, model, payer });
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
      // Defaults to the platform when nothing recorded a payer — a cache miss, a resumed
      // segment after a restart. Over-attributing to the platform makes the platform-key
      // ceiling tighter than it needs to be, which is the direction to be wrong in: the failure
      // is a workspace being throttled, not the platform paying for something it did not agree
      // to.
      payer: target?.payer ?? "platform",
      totalTokens: step.tokens,
      costUsd: step.cost,
      occurredAt: step.started_at,
    });
  }

  /**
   * Meter a model call the PLATFORM made on a workspace's behalf.
   *
   * Generation, the plan gate, the fix loop, explain and the judge. These are not run steps and
   * never will be: they happen on the request path, produce no trace, and are Anthropic-only
   * regardless of which provider the workspace's agents run on. Under BYOK they are the calls
   * the platform genuinely pays for, which is why they get kinds of their own rather than being
   * folded into `llm.provider` — "meter everything, bill some of it" needs the rows to say
   * which is which.
   *
   * THE COST IS COMPUTED HERE RATHER THAN TAKEN FROM THE CALLER. Every one of these call sites
   * already has a `UsageSummary`, whose `cost_usd` coalesces an unpriced model to 0 — which is
   * fine for the "this generation cost $0.004" line in the UI, where the model is a constant
   * this repo prices, and is not fine for a ledger row. `costFor` returns null for a model with
   * no pricing entry, and null is what gets written. The day somebody points
   * JAROKU_JUDGE_MODEL or JAROKU_EXPLAIN_MODEL at something unpriced, the bill says "unknown"
   * instead of "free".
   *
   * ON THE IDEMPOTENCY KEY BEING OPTIONAL. It exists to make a REDELIVERABLE event safe, and
   * these calls are not redeliverable: they happen once, synchronously, on a request nobody
   * replays. So a fresh uuid is the honest key. The alternative — deriving one from, say, the
   * agent and the prompt — would silently un-bill the second of two genuine generations of the
   * same brief, which is a real thing a user does. Callers that DO have a redelivery story (the
   * judge, whose attempts are bounded and numbered) pass their own.
   */
  async meterModelCall(
    ctx: TenantContext,
    kind: Exclude<UsageKind, "llm.provider" | "sandbox.seconds" | "storage.bytes">,
    call: {
      model: string;
      inputTokens: number;
      outputTokens: number;
      /** The Anthropic SDK reports `input_tokens` EXCLUSIVE of these, so they are priced apart. */
      cacheReadTokens?: number;
      cacheWriteTokens?: number;
      idempotencyKey?: string;
      runId?: string | null;
      /** `workspace` when the call went out on the workspace's own key. Defaults to us. */
      payer?: Payer;
      /**
       * The conversation that caused the call — the column migration 044 added for exactly this.
       *
       * IT WAS MISSING FROM THIS SHAPE AND THE CALLER WAS PASSING IT ANYWAY. `meterPlatformCall`
       * declares `threadId` in its own signature and hands its argument straight to this method;
       * structural typing accepts an object with an extra property when it arrives as a variable
       * rather than as a literal, so the field was dropped here in silence. Every plan, generation,
       * edit and explanation therefore wrote `thread_id = NULL`, and `spendByThread`'s second query
       * — the one whose whole job is the platform's own thinking, which carries no run to
       * attribute through — matched nothing. The per-thread cost column has been showing agents'
       * runs only since it shipped, which is a figure that is confidently short rather than wrong,
       * and is the failure mode that file's own header warns about.
       *
       * Null for a call that belongs to no conversation, which is the judge: an eval is a batch of
       * runs and its verdicts attribute through those.
       */
      threadId?: string | null;
    },
  ): Promise<boolean> {
    const cost = costFor(call.model, {
      inputTokens: call.inputTokens,
      outputTokens: call.outputTokens,
      cacheReadTokens: call.cacheReadTokens ?? 0,
      cacheWriteTokens: call.cacheWriteTokens ?? 0,
    });
    return this.billing.record(ctx, {
      kind,
      idempotencyKey: call.idempotencyKey ?? usageKey(kind, randomUUID()),
      runId: call.runId ?? null,
      threadId: call.threadId ?? null,
      // Every platform-side call is Anthropic's: planning, generation, the fix loop, explain and
      // the judge are all Anthropic-only (see providers.ts's `powers_jaroku`). Recorded rather
      // than left null so a future second provider is a change to this line and not a schema
      // question.
      provider: "anthropic",
      payer: call.payer ?? "platform",
      model: call.model,
      inputTokens: call.inputTokens,
      outputTokens: call.outputTokens,
      cachedInputTokens: (call.cacheReadTokens ?? 0) + (call.cacheWriteTokens ?? 0),
      costUsd: cost,
    });
  }

  /**
   * Meter the wall clock one run's sandbox occupied.
   *
   * WALL CLOCK, NOT CPU. A micro-VM is reserved for the whole time it exists, so a run that
   * spends four minutes waiting on a provider costs the same to host as one that spends four
   * minutes computing — and billing CPU would charge an agent that does the right thing (I/O,
   * waiting, one model call) less than one that spins, which is backwards from what the
   * platform actually pays for.
   *
   * KEYED BY THE RUN ID ALONE. A run has exactly one sandbox lifetime: it is started once, it
   * exits once, and a resumed run is a NEW subprocess under the same id — which is the one case
   * this key deliberately swallows. A pause/resume cycle is metered as its first segment only,
   * and that undercharges. It is the right direction to be wrong in while the alternative is a
   * key derived from a timestamp, which would double-charge a redelivered exit; a segment
   * counter is what fixes it properly, and it is not in this session.
   *
   * A run that never started is not metered at all: `spawnError` means no sandbox existed, and
   * a zero-second row would be an event that did not happen.
   */
  async meterSandboxSeconds(
    ctx: TenantContext,
    run: { runId: string; elapsedMs: number; rates?: InfraRates },
  ): Promise<boolean> {
    if (!Number.isFinite(run.elapsedMs) || run.elapsedMs <= 0) return false;
    const seconds = round8(run.elapsedMs / 1000);
    const rates = run.rates ?? infraRates();
    return this.billing.record(ctx, {
      kind: "sandbox.seconds",
      idempotencyKey: usageKey("sandbox.seconds", run.runId),
      runId: run.runId,
      quantity: seconds,
      unit: "second",
      // Always ours. A micro-VM is hosting the platform pays a provider for, whoever's key the
      // agent inside it was using — which is exactly why sandbox seconds are what BYOK still
      // bills for.
      payer: "platform",
      // A deployment with no rate set does not charge for sandbox time, and says so as a
      // priced zero rather than as an unknown — see billing/rates.ts. Rounded through the same
      // helper every other USD figure in this codebase goes through, so a sum of sandbox rows
      // and a sum of token rows cannot disagree at the eighth decimal.
      costUsd: round8(seconds * rates.sandboxUsdPerSecond),
    });
  }

  /**
   * Meter the bytes a workspace held over one sampling interval.
   *
   * STORAGE IS A RATE, NOT AN EVENT, and this is the honest way to fit one into an event log:
   * sample what is held, and record the cost of holding it for the interval since the last
   * sample. Metering bytes at the moment they are WRITTEN — the tempting alternative, since a
   * version publish is an event — would charge a workspace once for a file it keeps forever and
   * nothing for keeping it, which is the opposite of what an object store bills.
   *
   * THE KEY IS THE WORKSPACE AND THE INTERVAL, and that is not decoration. Every gateway
   * replica runs this sampler, so at the top of an hour N replicas each try to record the same
   * interval for the same workspace. The unique index is what makes exactly one of them the
   * charge and the rest no-ops — the same arbitration the trace ingest relies on, doing real
   * work rather than defending against a hypothetical.
   */
  async meterStorage(
    ctx: TenantContext,
    sample: { bytes: number; intervalStart: string; intervalHours: number; rates?: InfraRates },
  ): Promise<boolean> {
    if (!Number.isFinite(sample.bytes) || sample.bytes <= 0) return false;
    if (!Number.isFinite(sample.intervalHours) || sample.intervalHours <= 0) return false;
    const rates = sample.rates ?? infraRates();
    const gibHours = (sample.bytes / BYTES_PER_GIB) * sample.intervalHours;
    return this.billing.record(ctx, {
      kind: "storage.bytes",
      idempotencyKey: usageKey("storage.bytes", ctx.workspaceId, sample.intervalStart),
      quantity: sample.bytes,
      unit: "byte",
      payer: "platform", // storage is ours to pay for, same as sandbox time

      costUsd: round8((gibHours / HOURS_PER_MONTH) * rates.storageUsdPerGibMonth),
      occurredAt: sample.intervalStart,
    });
  }

  private async modelFor(
    ctx: TenantContext,
    runId: string,
  ): Promise<{ provider: string; model: string; payer: Payer } | null> {
    const cached = this.runModels.get(runId);
    if (cached) return cached;
    const looked = await this.lookupRun(ctx, runId);
    if (!looked) return null;
    // The run row carries the provider and the model and cannot carry the payer — whose key was
    // used is not a property of the trace. A miss therefore attributes to the platform, which is
    // the tighter of the two answers: see meterStep's own note.
    const filled = { ...looked, payer: "platform" as Payer };
    this.runModels.set(runId, filled);
    return filled;
  }
}
