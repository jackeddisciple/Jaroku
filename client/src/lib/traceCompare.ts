// A run read against another, and a run's own products — what the trace's Changes, State and
// Artifacts tabs show (the product owner's list, 2026-10-14). Pure functions over the store's steps.
//
//   npm run test:trace-view

import type { RunSummary, Step } from "../types.ts";
import { textFromLlmOutput } from "./agentOutput.ts";
import { isInherited, jsonReply, ownSteps, stepsTime, traceTotals } from "./traceView.ts";

// ── Changes: a branch against the run it branched from ───────────────────────

export interface StepPair {
  /** `type:name#n` — the nth step of that kind and name, the same position in both runs. */
  key: string;
  name: string;
  type: Step["type"];
  parent?: Step;
  own?: Step;
  inputChanged: boolean;
  outputChanged: boolean;
  /** This run's figure less the parent's, when both have one. */
  costDelta: number | null;
  latencyDelta: number | null;
}

const same = (a: unknown, b: unknown): boolean => {
  try {
    return JSON.stringify(a) === JSON.stringify(b);
  } catch {
    return a === b;
  }
};

function keyed(steps: readonly Step[]): Map<string, Step> {
  const seen = new Map<string, number>();
  const out = new Map<string, Step>();
  for (const s of [...steps].sort((a, b) => a.seq - b.seq)) {
    const base = `${s.type}:${s.name}`;
    const n = seen.get(base) ?? 0;
    seen.set(base, n + 1);
    out.set(`${base}#${n}`, s);
  }
  return out;
}

/**
 * Two runs' steps side by side, paired by position: the first `extract_jd` with the first, the
 * second model call with the second. A step only one of them has is still listed, on its side. In
 * the order this run ran them, the parent's extras after.
 */
export function compareRuns(parentSteps: readonly Step[], ownSteps: readonly Step[]): StepPair[] {
  const parent = keyed(parentSteps);
  const own = keyed(ownSteps);
  const keys = [...own.keys(), ...[...parent.keys()].filter((k) => !own.has(k))];
  return keys.map((key) => {
    const p = parent.get(key);
    const o = own.get(key);
    const step = (o ?? p)!;
    const num = (a: number | null | undefined, b: number | null | undefined): number | null =>
      a != null && b != null && Number.isFinite(a) && Number.isFinite(b) ? a - b : null;
    return {
      key,
      name: step.name,
      type: step.type,
      parent: p,
      own: o,
      inputChanged: Boolean(p && o && !same(p.input, o.input)),
      outputChanged: Boolean(p && o && !same(p.output, o.output)),
      costDelta: num(o?.cost, p?.cost),
      latencyDelta: num(o?.latency_ms, p?.latency_ms),
    };
  });
}

/** A run's three figures: its steps' working time, its tokens and its cost — null where unknown. */
export interface RunFigures {
  time: number | null;
  tokens: number | null;
  cost: number | null;
}

/**
 * A branch's figures against its parent's, LIKE FOR LIKE: the branch's own steps against the parent's
 * steps from the same fork on — the stretch the branch ran again. The parent's whole run against the
 * branch's own work compared a run with a part of one, and every branch read as cheaper.
 *
 * TIME IS THE STEPS' WORKING TIME (`stepsTime`), on both sides — not the wall clock. A parent that sat
 * paused or waiting for hours after the fork made a branch read "↓ 2h 23m" faster, a number about the
 * waiting rather than the work (the product owner's call, 2026-10-15).
 *
 * A STRETCH WITH NO MODEL CALLS SPENT NOTHING: its tokens and cost are 0, not unknown, so a branch that
 * stopped calling the model still compares. Unknown stays null — calls made that reported nothing.
 */
/**
 * A whole run's three figures, as the trace's strip compares them with another run's (2026-10-15):
 * the steps' working time, and every token and dollar its steps spent. A run that made no model
 * call spent nothing — 0, not unknown.
 */
export function runFigures(steps: readonly Step[]): RunFigures {
  const t = traceTotals(steps);
  return {
    time: stepsTime(steps),
    tokens: t.tokens ?? (t.llmCalls === 0 ? 0 : null),
    cost: t.cost ?? (t.llmCalls === 0 ? 0 : null),
  };
}

export function branchFigures(
  run: RunSummary,
  steps: readonly Step[],
  parentRun: RunSummary,
  parentSteps: readonly Step[],
): { mine: RunFigures; theirs: RunFigures } | null {
  if (run.parent_run_id == null || run.branch_from_seq == null) return null;
  if (!run.ended_at || !parentRun.ended_at) return null;
  const own = ownSteps(run, steps);
  const stretch = parentSteps.filter((s) => !isInherited(s, run));
  return { mine: runFigures(own), theirs: runFigures(stretch) };
}

// ── State: where the run left its state ─────────────────────────────────────

/**
 * The run's final state, or null when no node recorded one.
 *
 * A NODE'S `state_after` IS ITS UPDATE, NOT THE STATE: `extract` returned `{readings: […]}` and nothing
 * else. Its `state_before` is the whole state it started from. So the last node's state is its
 * `state_before` with its update applied — `messages` appended, as their reducer appends them, every
 * other field replaced.
 */
export function finalState(steps: readonly Step[]): unknown {
  const nodes = [...steps].filter((s) => s.type === "state_update" && (s.state_after != null || s.state_before != null)).sort((a, b) => a.seq - b.seq);
  const last = nodes[nodes.length - 1];
  if (!last) return null;
  const before = last.state_before;
  const update = last.state_after;
  const isMap = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
  if (!isMap(before)) return update ?? before;
  if (!isMap(update)) return before;
  const out: Record<string, unknown> = { ...before };
  for (const [k, v] of Object.entries(update)) {
    const prev = out[k];
    out[k] = k === "messages" && Array.isArray(prev) && Array.isArray(v) ? [...prev, ...v] : v;
  }
  return out;
}

// ── Artifacts: the structured things a run produced ─────────────────────────

export interface Artifact {
  /** Stable across renders: the producing step's id and where in it. */
  key: string;
  /** What it is called: the node that produced it, or the state field it is. */
  title: string;
  /** Where it came from, in words. */
  source: string;
  value: object;
  stepId: string;
}

/**
 * The structured things a run made — a JD read into JSON, a resume read into JSON: every model reply
 * that is a JSON object or array, named for the node it was made in, then every object- or
 * array-valued field of the final state the replies did not already show.
 */
export function runArtifacts(steps: readonly Step[]): Artifact[] {
  const byId = new Map(steps.map((s) => [s.id, s]));
  const out: Artifact[] = [];
  const seen = new Set<string>();
  const remember = (v: unknown): void => {
    try {
      seen.add(JSON.stringify(v));
    } catch {
      /* unserialisable: never deduped, never a problem */
    }
  };
  for (const s of [...steps].sort((a, b) => a.seq - b.seq)) {
    if (s.type !== "llm_call") continue;
    const text = textFromLlmOutput(s.output);
    const json = text ? jsonReply(text) : undefined;
    if (!json) continue;
    const node = s.parent_step_id ? byId.get(s.parent_step_id) : undefined;
    out.push({ key: s.id, title: node?.name ?? s.name, source: `#${s.seq} ${s.name}'s reply`, value: json, stepId: s.id });
    remember(json);
  }
  const state = finalState(steps);
  if (state && typeof state === "object" && !Array.isArray(state)) {
    const last = [...steps].filter((s) => s.type === "state_update").sort((a, b) => a.seq - b.seq).pop();
    for (const [k, v] of Object.entries(state as Record<string, unknown>)) {
      if (k === "messages" || v == null || typeof v !== "object") continue;
      if (Array.isArray(v) && v.length === 0) continue;
      let dup = false;
      try {
        dup = seen.has(JSON.stringify(v));
      } catch {
        dup = false;
      }
      if (dup) continue;
      out.push({ key: `state:${k}`, title: k, source: "a field of the final state", value: v as object, stepId: last?.id ?? "" });
    }
  }
  return out;
}
