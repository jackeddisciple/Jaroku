// Judge scoring pipeline — the one deliberate LLM call in the eval path.
//
// Everything else in Jaroku that could have used a model doesn't: the composer routes on
// heuristics, the graph view introspects real code, cost comes from arithmetic. Scoring a
// free-text answer against a rubric genuinely needs a model, so this is where one is spent
// — on claude-haiku-4-5, because the judge runs once per example per provider and its cost
// multiplies exactly as fast as the eval does.
//
// Four rules, each protecting something that would otherwise fail quietly:
//
// 1. A JUDGE FAILURE IS "UNSCORED", NOT A LOW SCORE. If the API errors or returns an
//    unparseable verdict, the example is recorded with score = null. Writing 0 would blame
//    the provider for the judge's problem, and a 0 is indistinguishable from a real one.
//
// 2. THE JUDGE NEVER FAILS THE AGENT RUN. Scoring happens after the run is already terminal
//    and recorded. A broken judge costs you the quality column, not the eval.
//
// 3. JUDGE COST IS EVAL OVERHEAD, TRACKED SEPARATELY. It accumulates on the eval, never on
//    a provider's cost — the judge is the same model for every leg, so charging it to the
//    providers would add a constant to each and make cheap ones look worse than they are.
//    It still counts toward TRUE spend and the budget ceiling, because it is real money.
//
// 4. ONLY SUCCEEDED RUNS ARE JUDGED. A failed run has no answer to grade; sending its
//    partial output to the judge spends money to score a crash.

import type Anthropic from "@anthropic-ai/sdk";
import { anthropicClient } from "../claude.ts";
import { costFor } from "../pricing.ts";
import type { TraceStore } from "../store.ts";
import type { EvalJob, EvalStore, RubricCriterion } from "../evalStore.ts";
import { buildJudgePrompt, parseJudgeVerdict } from "./rubric.ts";
import { extractAgentOutput } from "./output.ts";

/** Budget model by default (doc: the judge is per-example-per-provider; cost multiplies). */
export const JUDGE_MODEL = process.env.JAROKU_JUDGE_MODEL ?? "claude-haiku-4-5";

/** Verdicts are small; this is a ceiling against a runaway, not a target. */
const JUDGE_MAX_TOKENS = 1024;

/** Concurrent judge calls. Network-bound and independent of the run pool's slots. */
const JUDGE_CONCURRENCY = Math.max(1, Number(process.env.JAROKU_JUDGE_CONCURRENCY ?? 4));

/** Total attempts per verdict. Bounded — every retry is another paid call. */
const JUDGE_ATTEMPTS = Math.max(1, Number(process.env.JAROKU_JUDGE_ATTEMPTS ?? 2));

export interface ScoredEvent {
  evalId: string;
  jobId: string;
  score: number | null;
  error?: string | null;
}

export interface JudgeScorerDeps {
  store: TraceStore;
  evalStore: EvalStore;
  onScored: (e: ScoredEvent) => void;
  onScoringFinished: (e: { evalId: string; scored: number; unscored: number }) => void;
}

interface Pending {
  evalId: string;
  queue: EvalJob[];
  running: number;
  scored: number;
  unscored: number;
  /** True once the orchestrator says no more jobs are coming for this eval. */
  sealed: boolean;
}

export class JudgeScorer {
  private pending = new Map<string, Pending>();

  constructor(private deps: JudgeScorerDeps) {}

  /** Whether a judge is reachable at all. Without a key the eval still runs, unscored. */
  static available(): boolean {
    return Boolean(process.env.ANTHROPIC_API_KEY);
  }

  /** Queue a finished job for scoring. Called by the orchestrator as results land. */
  enqueue(evalId: string, job: EvalJob): void {
    // Rule 4: a failed or timed-out run has no answer to grade.
    if (job.status !== "succeeded") return;
    const p = this.slot(evalId);
    p.queue.push(job);
    this.drain(evalId);
  }

  /** No more jobs are coming — report completion once the queue empties. */
  seal(evalId: string): void {
    const p = this.pending.get(evalId);
    if (!p) {
      this.deps.onScoringFinished({ evalId, scored: 0, unscored: 0 });
      return;
    }
    p.sealed = true;
    this.drain(evalId);
  }

  private slot(evalId: string): Pending {
    let p = this.pending.get(evalId);
    if (!p) {
      p = { evalId, queue: [], running: 0, scored: 0, unscored: 0, sealed: false };
      this.pending.set(evalId, p);
    }
    return p;
  }

  private drain(evalId: string): void {
    const p = this.pending.get(evalId);
    if (!p) return;

    while (p.running < JUDGE_CONCURRENCY && p.queue.length) {
      const job = p.queue.shift()!;
      p.running++;
      void this.scoreOne(evalId, job)
        .catch(() => { /* scoreOne never throws; belt and braces */ })
        .finally(() => {
          p.running--;
          this.drain(evalId);
        });
    }

    if (p.sealed && !p.queue.length && p.running === 0) {
      this.pending.delete(evalId);
      this.deps.onScoringFinished({ evalId, scored: p.scored, unscored: p.unscored });
    }
  }

  /** Record an unscored result. Never throws, never blames the provider. */
  private async markUnscored(evalId: string, job: EvalJob, reason: string): Promise<void> {
    await this.deps.evalStore.putScore({ job_id: job.id, score: null, error: reason, judge_model: JUDGE_MODEL });
    const p = this.pending.get(evalId);
    if (p) p.unscored++;
    this.deps.onScored({ evalId, jobId: job.id, score: null, error: reason });
  }

  private async scoreOne(evalId: string, job: EvalJob): Promise<void> {
    const evalRun = await this.deps.evalStore.getEvalRun(evalId);
    if (!evalRun) return;

    // The judge is real spend. If the eval has already hit its ceiling, don't add to it.
    if (evalRun.budget_usd !== null && (await this.deps.evalStore.trueSpend(evalId)) >= evalRun.budget_usd) {
      await this.markUnscored(evalId, job, "not scored — the eval hit its budget ceiling");
      return;
    }
    if (!JudgeScorer.available()) {
      // The free dry-run path still produces a complete eval: every other column is real,
      // and the quality column says plainly why it's blank.
      await this.markUnscored(evalId, job, "not scored — no ANTHROPIC_API_KEY for the judge");
      return;
    }

    const example = await this.deps.evalStore.getExample(job.example_id);
    if (!example) { await this.markUnscored(evalId, job, "the example no longer exists"); return; }
    if (!job.run_id) { await this.markUnscored(evalId, job, "the job has no run to score"); return; }

    const rubric = await this.deps.evalStore.getRubric(evalRun.rubric_id);
    const criteria: RubricCriterion[] = rubric?.criteria ?? [];
    if (!criteria.length) { await this.markUnscored(evalId, job, "the rubric has no criteria"); return; }

    const steps = await this.deps.store.stepsForRun(job.run_id);
    const output = extractAgentOutput(steps);
    const prompt = buildJudgePrompt(
      { input: example.input, expected: example.expected, output: output.text },
      criteria,
    );

    let lastError = "the judge did not return a verdict";
    for (let attempt = 1; attempt <= JUDGE_ATTEMPTS; attempt++) {
      try {
        const res = await anthropicClient().messages.create({
          model: JUDGE_MODEL,
          max_tokens: JUDGE_MAX_TOKENS,
          system: prompt.system,
          messages: [{ role: "user", content: prompt.user }],
          // Structured outputs make the verdict SHAPE enforced rather than requested, which
          // is what lets the parser stay strict without throwing away good verdicts.
          output_config: { format: { type: "json_schema", schema: prompt.schema } },
        } as Anthropic.MessageCreateParamsNonStreaming);

        // Judge spend is recorded BEFORE the verdict is parsed — the call was billed
        // whether or not its answer was usable.
        await this.recordJudgeCost(evalId, res.usage);

        if (res.stop_reason === "refusal") {
          await this.markUnscored(evalId, job, "the judge declined to grade this response");
          return;
        }

        const text = res.content
          .filter((b): b is Anthropic.TextBlock => b.type === "text")
          .map((b) => b.text)
          .join("");
        const parsed = parseJudgeVerdict(text, criteria);
        if ("error" in parsed) {
          lastError = parsed.error;
          continue; // a malformed verdict is worth one more try
        }

        await this.deps.evalStore.putScore({
          job_id: job.id,
          score: parsed.verdict.score,
          per_criterion: parsed.verdict.perCriterion,
          rationale: parsed.verdict.rationale,
          judge_model: JUDGE_MODEL,
        });
        const p = this.pending.get(evalId);
        if (p) p.scored++;
        this.deps.onScored({ evalId, jobId: job.id, score: parsed.verdict.score });
        return;
      } catch (err) {
        lastError = (err as Error).message;
        // The SDK already retries 429/5xx internally; another loop here is for the
        // malformed-verdict case and one transport hiccup, not a retry storm.
        if (attempt === JUDGE_ATTEMPTS) break;
      }
    }

    // Rule 1 + 2: the run stays succeeded; only the quality cell is blank, and it says why.
    await this.markUnscored(evalId, job, `judge failed: ${lastError}`);
  }

  /** Accumulate judge spend on the EVAL, never on a provider (rule 3). */
  private async recordJudgeCost(evalId: string, usage: Anthropic.Usage | null | undefined): Promise<void> {
    if (!usage) return;
    // The Anthropic SDK reports input_tokens EXCLUSIVE of the cached counts, so it maps
    // straight onto the uncached slot of the shared pricing math.
    const cost = costFor(JUDGE_MODEL, {
      inputTokens: usage.input_tokens ?? 0,
      outputTokens: usage.output_tokens ?? 0,
      cacheReadTokens: usage.cache_read_input_tokens ?? 0,
      cacheWriteTokens: usage.cache_creation_input_tokens ?? 0,
    });
    if (cost !== null) await this.deps.evalStore.addJudgeCost(evalId, cost);
  }
}
