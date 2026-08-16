// Two traces, side by side, per step — §B.2.3.
//
// NOT A NEW RENDERER AND NOT NEW ANALYSIS. v0.0.1's state-diff view already compares a before and
// an after WITHIN one step; the eval comparison dashboard already renders one input across N
// providers. This is the first applied ACROSS two traces instead of within one, narrowed to the
// second's N=2 — and the whole file is the alignment problem, because once two step lists are
// aligned the rendering is a table somebody has already built twice.
//
// THE ALIGNMENT IS THE HARD PART, AND SEQUENCE NUMBERS ARE NOT IT. Two runs of the same input
// against two refs produce step 1 = step 1 and then, the moment one of them retries a tool, every
// later pair is offset by one and the diff reports six differences where there is one. That is the
// exact case §B.2.3's own mock shows: main has `#3 state_update` where the published version has
// `#3 tool_call get_weather(retry)` and `#4 state_update`, and the honest reading is "one step
// added", not "steps 3 and 4 both changed".
//
// SO IT IS A LONGEST-COMMON-SUBSEQUENCE OVER STEP IDENTITY, which is the same shape a text diff
// uses and for the same reason: it is the algorithm that produces the smallest honest edit script
// rather than the one that lines up positions. What counts as "the same step" is `(type, name)` —
// see `identityOf`, which is where the interesting judgement lives.
//
// WHAT IT COMPARES ONCE ALIGNED: output, cost and latency, which are §B.2.3's three. Cost and
// latency are compared as NUMBERS THAT MAY BE NULL, because a run on the dry-run provider is
// unpriced and an unpriced step is not a free one — the same null-not-zero rule that governs every
// other number in this product.

import type { Step } from "./types.ts";

/**
 * What makes two steps "the same step" for alignment.
 *
 * `(type, name)` AND NOT THE OUTPUT. Two runs of the same graph call the same tool with different
 * arguments and get different answers — that is the DIFFERENCE the diff exists to show, and folding
 * it into identity would align nothing and report every step as added-and-removed.
 *
 * AND NOT THE SEQUENCE NUMBER, for the reason the header gives: a retry inserted anywhere shifts
 * every number after it, and a diff keyed on position reports a shift as a rewrite.
 *
 * A REPEATED (type, name) IS STILL AMBIGUOUS — three `tool_call get_weather` steps in a row can be
 * aligned three ways — and the LCS below resolves that the way a text diff resolves three identical
 * lines: by preferring the alignment that leaves the fewest unmatched steps, which is the one a
 * person reading it would draw.
 *
 * SEPARATED BY A NUL, which is `scan.ts`'s own choice for a composite key and for the same reason:
 * a step's `name` is a tool name a model chose, and any printable separator is a character that
 * could appear inside one. `llm_call` + `a b` and `llm_call a` + `b` are two different steps that a
 * space would collapse into one.
 */
export function identityOf(step: Pick<Step, "type" | "name">): string {
  return `${step.type}\u0000${step.name}`;
}

export type StepChange =
  /** Present on both sides, identical in output, cost and latency. */
  | "same"
  /** Present on both sides, differing in at least one of the three. */
  | "changed"
  /** Only on the right — a step this ref added. */
  | "added"
  /** Only on the left — a step this ref no longer takes. */
  | "removed";

/** One row of the comparison. Either side may be null, which is what added and removed mean. */
export interface TraceDiffRow {
  change: StepChange;
  left: Step | null;
  right: Step | null;
  /**
   * Which of the three moved, for a `changed` row. Empty for every other change.
   *
   * A LIST RATHER THAN A BOOLEAN, because "the output is identical and it cost twice as much" and
   * "it returned something else for the same money" are different findings, and a row that only
   * said "changed" would make somebody open both sides to learn which.
   */
  differing: ("output" | "cost" | "latency")[];
}

export interface TraceDiff {
  rows: TraceDiffRow[];
  /** Totals for the footer. Null on either side when that side had nothing priced — never 0. */
  leftCostUsd: number | null;
  rightCostUsd: number | null;
  leftLatencyMs: number;
  rightLatencyMs: number;
}

/** Deep-ish equality for a step's output. JSON, because that is what the column holds. */
function sameOutput(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  try {
    return JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
  } catch {
    // A payload that will not serialise cannot be compared, and reporting it as identical would
    // hide a real difference. Reporting it as different is the safe direction: it costs somebody a
    // look at a row that may turn out to be the same, rather than hiding one that is not.
    return false;
  }
}

/**
 * Whether two aligned steps differ, and in what.
 *
 * COST IS COMPARED WITH NULL AS ITS OWN VALUE. `null` is "nothing priced this" and `0` is "this
 * genuinely cost nothing" — v0.1.9's rule — so a step that went from priced to unpriced HAS changed,
 * and treating null as zero would report a run that stopped being metered as a run that got free.
 *
 * LATENCY IS COMPARED EXACTLY AND NOT WITH A TOLERANCE, deliberately. A tolerance would need a
 * number nobody can justify — is 5ms noise? 50? — and would silently hide the one case §B.2.3 is
 * for, which is somebody looking at two refs to find out which is slower. The RENDERER can decide a
 * 3ms difference is not worth colouring; the diff's job is to report what the numbers were.
 */
function compare(left: Step, right: Step): ("output" | "cost" | "latency")[] {
  const differing: ("output" | "cost" | "latency")[] = [];
  if (!sameOutput(left.output, right.output)) differing.push("output");
  if ((left.cost ?? null) !== (right.cost ?? null)) differing.push("cost");
  if (left.latency_ms !== right.latency_ms) differing.push("latency");
  return differing;
}

/**
 * The longest common subsequence of two step lists, by identity.
 *
 * A PLAIN O(n·m) TABLE, because a trace is tens of steps and a smarter algorithm would be a
 * dependency and a page of code to save microseconds on a list that fits on a screen. The same
 * judgement `githubApi.ts` makes about not taking Octokit, one layer in.
 */
function lcs(left: readonly Step[], right: readonly Step[]): number[][] {
  const table: number[][] = Array.from({ length: left.length + 1 }, () =>
    new Array<number>(right.length + 1).fill(0),
  );
  for (let i = left.length - 1; i >= 0; i--) {
    for (let j = right.length - 1; j >= 0; j--) {
      table[i]![j] =
        identityOf(left[i]!) === identityOf(right[j]!)
          ? table[i + 1]![j + 1]! + 1
          : Math.max(table[i + 1]![j]!, table[i]![j + 1]!);
    }
  }
  return table;
}

/**
 * Align two traces and say what moved.
 *
 * BOTH SIDES ARE TAKEN IN SEQUENCE ORDER and are not re-sorted here. A trace's `seq` is the order
 * the run actually took, which is the only order a comparison of two runs means anything in — and
 * sorting by anything else would produce a diff of two things that never happened.
 *
 * REMOVED BEFORE ADDED ON A REPLACEMENT. Where a step on the left has no partner and a step on the
 * right has no partner at the same point, the walk emits the removal first — so a replaced step
 * reads top-to-bottom as "this went, that came", which is the order every diff renderer in this app
 * already draws a `-` above a `+`.
 */
export function diffTraces(left: readonly Step[], right: readonly Step[]): TraceDiff {
  const table = lcs(left, right);
  const rows: TraceDiffRow[] = [];
  let i = 0;
  let j = 0;

  while (i < left.length && j < right.length) {
    if (identityOf(left[i]!) === identityOf(right[j]!)) {
      const differing = compare(left[i]!, right[j]!);
      rows.push({
        change: differing.length === 0 ? "same" : "changed",
        left: left[i]!,
        right: right[j]!,
        differing,
      });
      i++;
      j++;
    } else if (table[i + 1]![j]! >= table[i]![j + 1]!) {
      rows.push({ change: "removed", left: left[i]!, right: null, differing: [] });
      i++;
    } else {
      rows.push({ change: "added", left: null, right: right[j]!, differing: [] });
      j++;
    }
  }
  for (; i < left.length; i++) rows.push({ change: "removed", left: left[i]!, right: null, differing: [] });
  for (; j < right.length; j++) rows.push({ change: "added", left: null, right: right[j]!, differing: [] });

  return {
    rows,
    leftCostUsd: totalCost(left),
    rightCostUsd: totalCost(right),
    leftLatencyMs: left.reduce((n, s) => n + s.latency_ms, 0),
    rightLatencyMs: right.reduce((n, s) => n + s.latency_ms, 0),
  };
}

/**
 * A trace's cost, or null.
 *
 * NULL WHENEVER ANY STEP WAS UNPRICED, not a partial sum. The eval dashboard's `costIncomplete`
 * flag makes exactly this distinction and for exactly this reason: a footer reading `$0.0012` when
 * two of five steps could not be priced is an exact-looking number that is wrong, and a comparison
 * of two such numbers is a comparison of two floors.
 *
 * A trace with no steps at all costs 0, which is a real answer: nothing ran, and nothing is what it
 * cost.
 */
function totalCost(steps: readonly Step[]): number | null {
  let total = 0;
  for (const step of steps) {
    // Only steps that CAN cost money are asked. A `state_update` has no cost by construction, and
    // treating its null as "unpriced" would make every trace unpriceable.
    if (step.type !== "llm_call" && step.type !== "tool_call") continue;
    if (step.cost === null || step.cost === undefined) return null;
    total += step.cost;
  }
  return total;
}
