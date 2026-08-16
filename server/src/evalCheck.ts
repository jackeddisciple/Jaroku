// A quality check on a pull request, which a build check cannot be.
//
// §B.1's premise in one line: a PR gets a build check for free from any CI system, and it gets a
// QUALITY check from nowhere else, because nowhere else has a dataset, a judge and a cost model
// already sitting behind the agent whose code the PR is changing. Git can tell a person what text
// changed; only this can tell them whether the agent still works, what it will cost, and how fast
// it answers.
//
// WHAT THIS FILE IS. The arithmetic and the words. It turns an eval aggregate into three numbers,
// compares them against a baseline that may not exist, and renders the summary GitHub shows. It
// makes no network call and touches no database — which is what makes the interesting cases below
// assertable, and every one of them is about the baseline being absent.
//
// THE NULL-NOT-ZERO RULE IS THE WHOLE OF THE CARE HERE, and §B.1.1 states it: with no baseline, the
// check still runs and posts absolute numbers with a plain note — "no baseline yet; this run
// establishes one" — rather than fabricating a delta against nothing. That is the same discipline
// the cost accounting has held since v0.1.9 and the same one §A.5 draws between an absent count and
// a zero. A `+0%` beside a first-ever check is a claim that nothing changed, made about a comparison
// that did not happen.
//
// AND IT APPLIES ONE LEVEL DOWN AS WELL. A metric can be absent even when the baseline is present:
// an eval run on the dry-run provider is unpriced, so its cost is null and its cost DELTA is null
// too, beside a pass-rate delta that is perfectly real. Three metrics, three independent answers.

/** One run's three numbers. Any of them may be absent, and absence is never zero. */
export interface CheckMetrics {
  /** 0..1 over SCORED runs. Null when the judge scored nothing — "unscored", not "scored zero". */
  passRate: number | null;
  /** Mean USD per succeeded run. Null when the model has no pricing entry, or on a dry run. */
  costPerRunUsd: number | null;
  /** p50 over succeeded runs. Null when nothing succeeded — there is no median of nothing. */
  latencyP50Ms: number | null;
}

/** The same three, as differences. Each is null exactly when either side of it is. */
export interface CheckDeltas {
  passRate: number | null;
  cost: number | null;
  latency: number | null;
}

export interface CheckComparison {
  metrics: CheckMetrics;
  deltas: CheckDeltas;
  /**
   * Whether a baseline existed at all.
   *
   * DISTINCT FROM "every delta happened to be null", which is why it is its own field. A first-ever
   * check and a check against a baseline that was itself unscored produce the same three nulls and
   * want completely different sentences: one says "this run establishes one" and the other says the
   * comparison could not be made. Deriving the first from the second would print the wrong one.
   */
  hasBaseline: boolean;
}

/**
 * One difference, or null.
 *
 * NULL IF EITHER SIDE IS NULL, which is the arithmetic §B.1.1's rule reduces to. Treating an absent
 * baseline as 0 turns "we have never measured this" into "it was zero and now it is 96%", which is
 * a stronger claim than anything in this system is entitled to make.
 */
function delta(now: number | null, before: number | null): number | null {
  if (now === null || before === null) return null;
  return now - before;
}

/** Compare a run's metrics against a baseline that may not exist. */
export function compareToBaseline(
  metrics: CheckMetrics,
  baseline: CheckMetrics | null,
): CheckComparison {
  if (!baseline) {
    return {
      metrics,
      deltas: { passRate: null, cost: null, latency: null },
      hasBaseline: false,
    };
  }
  return {
    metrics,
    deltas: {
      passRate: delta(metrics.passRate, baseline.passRate),
      cost: delta(metrics.costPerRunUsd, baseline.costPerRunUsd),
      latency: delta(metrics.latencyP50Ms, baseline.latencyP50Ms),
    },
    hasBaseline: true,
  };
}

/**
 * What the check reports as its conclusion.
 *
 * A CHECK PASSES UNLESS THE AGENT GOT WORSE, and "worse" is deliberately narrow: the pass rate went
 * DOWN. Cost and latency are reported and never gate, and that is a decision worth stating rather
 * than leaving implicit — an agent that got 4% better for 10% more money is a trade a person makes,
 * not one a check makes for them. Failing a PR over a cost increase would put a threshold in this
 * file that nobody could justify and everybody would learn to override.
 *
 * NO BASELINE MEANS `neutral`, NEVER `success`. GitHub renders a neutral check as a grey circle
 * rather than a green tick, which is exactly right for "this ran and there was nothing to compare
 * it to" — and §3.9's own rule, one feature over, is that rendering an absent verdict as a passing
 * one is how a gate becomes decoration.
 *
 * AN UNSCORED RUN IS ALSO `neutral`. The eval produced no pass rate, so there is no quality claim to
 * make; reporting success would be reporting that a measurement nobody took came out well.
 */
export function conclusionFor(comparison: CheckComparison): "success" | "failure" | "neutral" {
  if (comparison.metrics.passRate === null) return "neutral";
  if (!comparison.hasBaseline) return "neutral";
  if (comparison.deltas.passRate !== null && comparison.deltas.passRate < 0) return "failure";
  return "success";
}

const pct = (v: number): string => `${Math.round(v * 100)}%`;

/**
 * A signed number, with its sign always shown.
 *
 * `+0` IS A REAL AND DIFFERENT ANSWER from an omitted delta, and both appear: a run that scored
 * identically to its baseline genuinely did not move, and rendering that as nothing would make it
 * indistinguishable from a run with no baseline at all. So the sign is always printed for a delta
 * that exists, and a delta that does not exist prints nothing whatsoever.
 */
function signed(v: number, render: (n: number) => string): string {
  return v >= 0 ? `+${render(v)}` : `−${render(-v)}`;
}

const usd = (v: number): string => `$${v.toFixed(4)}`;
const ms = (v: number): string => `${Math.round(v)}ms`;

/**
 * §B.1.1's summary, as GitHub renders it under the check name.
 *
 * THREE LINES AND A NOTE, and the note only when there is nothing to compare against. The shape is
 * the spec's own mock — `pass-rate 92% → 96% (+4)`, `cost / run $0.0031 → $0.0028 (−10%)` — and the
 * arrow form is what makes it readable at a glance: a person scanning a PR wants the direction
 * before the magnitude.
 *
 * COST AND LATENCY DELTAS ARE RENDERED AS PERCENTAGES and the pass rate as POINTS, which is the
 * mock's own choice and is the honest one. A pass rate is already a proportion, so "+4%" of 92% is
 * ambiguous — 96%, or 95.7%? Points are unambiguous. Cost has no natural unit to be a point of, so
 * a proportion is the only comparable form.
 *
 * A METRIC THAT IS NULL SIMPLY DOES NOT APPEAR. A line reading `cost / run —` is a line that has to
 * be explained; a missing line is one somebody does not ask about, and the note below covers the
 * only case where the absence is the point.
 */
export function summaryFor(
  comparison: CheckComparison,
  baseline: CheckMetrics | null,
  opts: { datasetName?: string; providerMode?: "dry_run" | "paid" } = {},
): string {
  const lines: string[] = [];
  const { metrics, deltas } = comparison;

  if (metrics.passRate !== null) {
    const before = baseline?.passRate;
    const arrow = typeof before === "number" ? `${pct(before)} → ${pct(metrics.passRate)}` : pct(metrics.passRate);
    // Points, not a percentage of a percentage — see above.
    const d = deltas.passRate === null ? "" : ` (${signed(deltas.passRate * 100, (n) => String(Math.round(n)))})`;
    lines.push(`pass-rate    ${arrow}${d}`);
  }

  if (metrics.costPerRunUsd !== null) {
    const before = baseline?.costPerRunUsd;
    const arrow = typeof before === "number" ? `${usd(before)} → ${usd(metrics.costPerRunUsd)}` : usd(metrics.costPerRunUsd);
    // A proportion, and only when the baseline was non-zero: a percentage change from zero is
    // undefined, and rendering it as infinity or as 100% would both be inventions.
    const d =
      deltas.cost !== null && typeof before === "number" && before !== 0
        ? ` (${signed((deltas.cost / before) * 100, (n) => `${Math.round(n)}%`)})`
        : "";
    lines.push(`cost / run   ${arrow}${d}`);
  }

  if (metrics.latencyP50Ms !== null) {
    const before = baseline?.latencyP50Ms;
    const arrow = typeof before === "number" ? `${ms(before)} → ${ms(metrics.latencyP50Ms)}` : ms(metrics.latencyP50Ms);
    const d =
      deltas.latency !== null && typeof before === "number" && before !== 0
        ? ` (${signed((deltas.latency / before) * 100, (n) => `${Math.round(n)}%`)})`
        : "";
    lines.push(`p50 latency  ${arrow}${d}`);
  }

  if (lines.length === 0) {
    // Every metric absent. Not the same as "no baseline": this eval produced nothing measurable,
    // and saying so is more useful than an empty block under a neutral check.
    lines.push("this run produced no scored results — nothing to report against.");
  } else if (!comparison.hasBaseline) {
    // §B.1.1's exact sentence. It is the difference between a check that looks broken and one that
    // is telling somebody it is the first of its kind.
    lines.push("");
    lines.push("no baseline yet; this run establishes one");
  }

  if (opts.providerMode === "dry_run") {
    // §B.1.3's boundary, said on the check itself rather than only in the settings. Somebody reading
    // a pass rate needs to know it came from the fake provider, because it proves every tool imports
    // and executes and proves nothing about what a real model would answer.
    lines.push("");
    lines.push("ran on the free dry-run provider — this proves the tools import and execute, not what a real model answers");
  }

  return lines.join("\n");
}

/** The check's title, as it appears in GitHub's checks list. */
export function titleFor(datasetName: string | null): string {
  return datasetName ? `Jaroku eval · ${datasetName}` : "Jaroku eval";
}
