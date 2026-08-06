// Pre-run cost estimate — what a real-provider eval will roughly cost, before committing.
//
// An eval multiplies cost by examples × providers, and then the judge adds one more call
// per cell. Three examples on two providers is eight paid calls; fifty on three is three
// hundred. Firing that without a number in front of you is the mistake this feature must
// not make easy, so real providers stay locked until this estimate exists.
//
// The estimate is honest about being one:
//
//   * IT IS A RANGE, NOT A POINT. Presenting "$0.4271" implies a precision that a
//     projection from past runs does not have, and being wrong at four decimal places is
//     worse than being approximately right out loud.
//   * IT SAYS WHAT IT'S BASED ON. Calibrated from this agent's real runs on this model is
//     a different quality of guess than a built-in default, and the caller is told which.
//   * AN UNPRICED MODEL ESTIMATES TO null, NOT ZERO. Same rule as everywhere else: unknown
//     and free are different claims.
//   * THE BUDGET CEILING IS THE ACTUAL PROTECTION. The estimate informs the decision; the
//     ceiling enforces it. An estimate that reads low must never be the only thing standing
//     between a user and a large bill.

import type { TraceStore } from "./store.ts";
import type { EvalStore, EvalTarget } from "./evalStore.ts";
import { asInt } from "./db/db.ts";
import type { TenantContext } from "./db/tenant.ts";
import { costFor, isPriced, round8 } from "./pricing.ts";
import { JUDGE_MODEL } from "./judge/score.ts";

/**
 * Fallback per-run token usage when there is no history to calibrate from.
 *
 * Deliberately not tiny: an estimate that undershoots is the dangerous direction, because
 * it's the one that talks someone into a run they'd have declined.
 */
const DEFAULT_INPUT_TOKENS = 4_000;
const DEFAULT_OUTPUT_TOKENS = 600;

/** Spread applied when projecting from a default rather than measured history. */
const DEFAULT_SPREAD = 0.6;
/** Minimum spread even with good history — agent runs are not deterministic. */
const MEASURED_SPREAD = 0.25;

/** Judge output is a small JSON verdict; input is the prompt, which we can measure. */
const JUDGE_OUTPUT_TOKENS = 130;
/** Rough chars-per-token for English prose. Only used for the judge prompt. */
const CHARS_PER_TOKEN = 3.6;

export type Basis = "measured" | "other-model" | "default";

export interface TargetEstimate {
  provider: string;
  model: string;
  runs: number;
  /** null when the model has no pricing entry — unknown, not free. */
  lowUsd: number | null;
  highUsd: number | null;
  /** What the projection is based on, so the caller can weigh it. */
  basis: Basis;
  /** How many past runs informed it. 0 for `default`. */
  sampleSize: number;
  priced: boolean;
}

export interface EvalEstimate {
  examples: number;
  targets: number;
  totalRuns: number;
  perTarget: TargetEstimate[];
  /** Judge overhead: one verdict per cell. Included in the totals below. */
  judgeLowUsd: number;
  judgeHighUsd: number;
  totalLowUsd: number;
  totalHighUsd: number;
  /** True when any selected model has no pricing — the total is a floor, not a range. */
  hasUnpricedTarget: boolean;
  /** Human-readable caveats to show alongside the number. */
  notes: string[];
}

/** Mean input/output tokens per run for this agent on this model, from real history. */
async function measureRuns(
  ctx: TenantContext,
  store: TraceStore,
  agentId: string,
  model: string | null,
): Promise<{ input: number; output: number; runs: number } | null> {
  // Only completed runs: a crashed one is a partial sample and would drag the mean down,
  // which is the dangerous direction for an estimate.
  const raw = await store.database().all<{ run_id: string; tokens: unknown }>(
    `SELECT r.id AS run_id,
            COALESCE(SUM(s.tokens), 0) AS tokens
     FROM runs r
     JOIN steps s ON s.run_id = r.id AND s.type = 'llm_call'
     WHERE r.workspace_id = ? AND r.agent_id = ? AND r.status = 'completed'
       ${model ? "AND r.model = ?" : "AND r.provider != 'fake'"}
     GROUP BY r.id
     ORDER BY MAX(r.started_at) DESC
     LIMIT 20`,
    model ? [ctx.workspaceId, agentId, model] : [ctx.workspaceId, agentId],
  );
  // SUM over an integer column is a bigint in Postgres and arrives as a string.
  const rows = raw.map((r) => ({ run_id: r.run_id, tokens: asInt(r.tokens) }));

  const withTokens = rows.filter((r) => r.tokens > 0);
  if (!withTokens.length) return null;

  const meanTotal = withTokens.reduce((s, r) => s + r.tokens, 0) / withTokens.length;
  // The trace records a combined token count per step, not a split. Assume the same
  // input:output ratio as the default — agent runs are input-heavy (system prompt, tool
  // schemas, accumulated messages), and getting the split slightly wrong moves the estimate
  // far less than getting the total wrong.
  const ratio = DEFAULT_INPUT_TOKENS / (DEFAULT_INPUT_TOKENS + DEFAULT_OUTPUT_TOKENS);
  return {
    input: Math.round(meanTotal * ratio),
    output: Math.round(meanTotal * (1 - ratio)),
    runs: withTokens.length,
  };
}

export async function estimateEval(
  ctx: TenantContext,
  store: TraceStore,
  evalStore: EvalStore,
  opts: { datasetId: string; agentId: string; targets: EvalTarget[]; judgeEnabled: boolean },
): Promise<EvalEstimate> {
  const examples = await evalStore.listExamples(opts.datasetId);
  const notes: string[] = [];
  const perTarget: TargetEstimate[] = [];

  for (const t of opts.targets) {
    const priced = isPriced(t.model);
    const runs = examples.length;

    // Calibrate from this agent's real runs, preferring the same model.
    let basis: Basis = "default";
    let sample = { input: DEFAULT_INPUT_TOKENS, output: DEFAULT_OUTPUT_TOKENS, runs: 0 };
    const sameModel = await measureRuns(ctx, store, opts.agentId, t.model);
    if (sameModel) {
      basis = "measured";
      sample = sameModel;
    } else {
      const anyModel = await measureRuns(ctx, store, opts.agentId, null);
      if (anyModel) {
        // Token counts for the same graph are similar across models, but tokenizers differ
        // — say so rather than presenting it as measured.
        basis = "other-model";
        sample = anyModel;
      }
    }

    const perRun = priced
      ? costFor(t.model, { inputTokens: sample.input, outputTokens: sample.output })
      : null;
    const spread = basis === "default" ? DEFAULT_SPREAD : MEASURED_SPREAD;

    perTarget.push({
      provider: t.provider,
      model: t.model,
      runs,
      lowUsd: perRun === null ? null : round8(perRun * runs * (1 - spread)),
      highUsd: perRun === null ? null : round8(perRun * runs * (1 + spread)),
      basis,
      sampleSize: sample.runs,
      priced,
    });
  }

  // Judge: one verdict per cell. Its input is the prompt, whose size we can actually
  // measure from the examples rather than guess.
  const avgExampleChars = examples.length
    ? examples.reduce((s, e) => s + e.input.length + (e.expected?.length ?? 0), 0) / examples.length
    : 0;
  // Prompt = system + rubric + the example + the agent's answer. The fixed part dominates;
  // ~700 tokens measured against the real judge prompt.
  const judgeInputTokens = Math.round(700 + (avgExampleChars * 2) / CHARS_PER_TOKEN);
  const cells = examples.length * opts.targets.length;
  const perVerdict = opts.judgeEnabled
    ? (costFor(JUDGE_MODEL, { inputTokens: judgeInputTokens, outputTokens: JUDGE_OUTPUT_TOKENS }) ?? 0)
    : 0;
  const judgeLow = round8(perVerdict * cells * 0.7);
  const judgeHigh = round8(perVerdict * cells * 1.5);

  const hasUnpriced = perTarget.some((t) => !t.priced);
  if (hasUnpriced) {
    notes.push(
      `no pricing for ${perTarget.filter((t) => !t.priced).map((t) => t.model).join(", ")} — that part of the cost is unknown, and the total below excludes it`,
    );
  }
  if (perTarget.some((t) => t.basis === "default")) {
    notes.push("no past runs to calibrate from — projected from a built-in default, so the range is wide");
  }
  if (perTarget.some((t) => t.basis === "other-model")) {
    notes.push("calibrated from this agent's runs on a different model — tokenizers differ, so treat it as approximate");
  }
  if (opts.judgeEnabled) notes.push(`includes one judge call per cell (${cells}) on ${JUDGE_MODEL}`);

  return {
    examples: examples.length,
    targets: opts.targets.length,
    totalRuns: examples.length * opts.targets.length,
    perTarget,
    judgeLowUsd: judgeLow,
    judgeHighUsd: judgeHigh,
    totalLowUsd: round8(perTarget.reduce((s, t) => s + (t.lowUsd ?? 0), 0) + judgeLow),
    totalHighUsd: round8(perTarget.reduce((s, t) => s + (t.highUsd ?? 0), 0) + judgeHigh),
    hasUnpricedTarget: hasUnpriced,
    notes,
  };
}
