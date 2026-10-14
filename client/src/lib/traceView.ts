// The trace, shaped for reading. Pure functions over the store's own `Step`s — never a copy of them.
//
// THE TIMELINE WAS A FLAT LIST IN `seq` ORDER, and the data was never flat. Every model call, tool
// call and routing decision carries `parent_step_id`, pointing at the graph node it ran inside —
// `extract_jd` and the `ChatAnthropic` call it made are a parent and a child, not two neighbours.
// The tree below is that relationship read back out, and it is the only structure here: rows,
// filters, totals and timing are all views of the same steps, so nothing can disagree with the trace.
//
// THREE FACTS ABOUT THE SCHEMA THAT EVERYTHING HERE LEANS ON:
//
//   1. `seq` is assigned when a step STARTS, so a node's seq is below its children's.
//
//   2. A step is EMITTED when it ends — so in a live run a child arrives before its parent. A child
//      whose parent has not landed yet is a root until it does; it never waits off screen.
//
//   3. `started_at` IS STAMPED WHEN THE STEP FINISHES. The interceptor builds the `Step` in `_finish`
//      (runtime/jaroku_interceptor/callback.py) and the field's default is "now". So the moment a
//      step began is `started_at − latency_ms`, and `started_at` itself is when it ended.
//
//   npm run test:trace-view

import type { Run, RunSummary, Step } from "../types.ts";
import { textFromLlmOutput } from "./agentOutput.ts";

// ── What kind of thing a step is ─────────────────────────────────────────────

/** The trace's four kinds, plus a bucket for a type this client has never been told about. */
export type StepCategory = "llm" | "tool" | "state" | "route" | "other";

const CATEGORY_FOR_TYPE: Record<string, StepCategory> = {
  llm_call: "llm",
  tool_call: "tool",
  state_update: "state",
  router: "route",
};

/**
 * A step's kind. UNKNOWN TYPES ARE `other`, NOT A CRASH: rows written before the schema settled
 * carry `type: "tool"`, and a lookup that assumed the four would take the whole panel down on them.
 */
export function stepCategory(step: Pick<Step, "type">): StepCategory {
  return CATEGORY_FOR_TYPE[step.type] ?? "other";
}

/** The words under a step's name. The schema's own word for it lives in the inspector. */
export const CATEGORY_LABEL: Record<StepCategory, string> = {
  llm: "LLM call",
  tool: "Tool call",
  state: "State update",
  route: "Routing",
  other: "Step",
};

/**
 * Which provider a model call went to, for its logo: the chat class's own name first
 * (`ChatAnthropic`, `ChatOpenAI`) — an agent may call more than one — then the run's provider.
 * Null for a step that is not a model call.
 */
export function stepProvider(step: Pick<Step, "type" | "name">, runProvider?: string | null): string | null {
  if (step.type !== "llm_call") return null;
  const name = step.name.toLowerCase();
  if (/anthropic|claude/.test(name)) return "anthropic";
  if (/openai|gpt/.test(name)) return "openai";
  if (/meta|llama|muse/.test(name)) return "meta";
  return runProvider ? runProvider.toLowerCase() : null;
}

// ── What a step said ─────────────────────────────────────────────────────────

/** The tool calls a model call asked for, out of the `[{ content, tool_calls? }]` the tracer records. */
export function llmToolCalls(output: unknown): unknown[] {
  if (!Array.isArray(output)) return [];
  return output.flatMap((g) =>
    typeof g === "object" && g !== null && Array.isArray((g as { tool_calls?: unknown }).tool_calls)
      ? (g as { tool_calls: unknown[] }).tool_calls
      : [],
  );
}

/**
 * A step's output as somebody reading it wants it copied.
 *
 * A MODEL CALL'S IS ITS REPLY — the text the drawer shows, or the tool calls it asked for when it
 * said nothing. It was the captured envelope, `[{"content": "{\"requirement_results\": …}"}]`: a
 * message list with the model's own JSON double-encoded inside it. The envelope is still in the
 * drawer's Raw event, which copies the step exactly as it arrived. Anything else is text as text and
 * the rest as the JSON it is.
 */
export function stepOutputText(step: Pick<Step, "type" | "output">): string {
  if (step.type === "llm_call") {
    const text = textFromLlmOutput(step.output);
    if (text) return text;
    const calls = llmToolCalls(step.output);
    if (calls.length > 0) return JSON.stringify({ tool_calls: calls }, null, 2);
  }
  const v = step.output;
  if (v == null) return "";
  if (typeof v === "string") return v;
  try {
    return JSON.stringify(v, null, 2) ?? "";
  } catch {
    return String(v);
  }
}

/**
 * A model's reply, read as the JSON it is when it is JSON — an object or an array, bare or in a
 * ```json fence, which is how structured-output prompts come back. Undefined for anything else,
 * including JSON that is only a string or a number: those read fine as text.
 */
export function jsonReply(text: string): object | undefined {
  const fenced = /^```(?:json)?\s*\n([\s\S]*?)\n?```$/i.exec(text.trim());
  const body = (fenced ? fenced[1]! : text).trim();
  if (!/^[[{]/.test(body)) return undefined;
  try {
    const v: unknown = JSON.parse(body);
    return typeof v === "object" && v !== null ? v : undefined;
  } catch {
    return undefined;
  }
}

// ── The tree ─────────────────────────────────────────────────────────────────

export interface TraceRow {
  step: Step;
  /** 0 for a root. */
  depth: number;
  /** The parent this row is drawn under — present in the trace, unlike a dangling `parent_step_id`. */
  parentId: string | null;
  /** Direct children, in display order. */
  childIds: string[];
  /** The last of its parent's children, which is where a connector line stops. */
  lastChild: boolean;
  /**
   * For each level from 1 down to this row's own, whether the row's ancestor at that level (or the
   * row itself, last) is a last child — which connector lines carry on past this row.
   */
  lastPath: boolean[];
}

const bySeq = (a: Step, b: Step): number => a.seq - b.seq;

/**
 * Every step once, parents before their children, siblings in `seq` order.
 *
 * DEFENSIVE ABOUT THE PARENT LINK, because it comes off the wire: a parent that is missing makes a
 * root, a step naming itself makes a root, and a cycle cannot strand a step — anything the walk did
 * not reach is appended as a root, so the row count always equals the step count.
 */
export function buildTraceTree(steps: readonly Step[]): TraceRow[] {
  const ordered = [...steps].sort(bySeq);
  const byId = new Map(ordered.map((s) => [s.id, s]));
  const children = new Map<string, Step[]>();
  const roots: Step[] = [];

  for (const s of ordered) {
    const p = s.parent_step_id;
    if (p && p !== s.id && byId.has(p)) {
      const list = children.get(p);
      if (list) list.push(s);
      else children.set(p, [s]);
    } else {
      roots.push(s);
    }
  }

  const rows: TraceRow[] = [];
  const seen = new Set<string>();
  const walk = (s: Step, depth: number, parentId: string | null, lastChild: boolean, path: boolean[]): void => {
    if (seen.has(s.id)) return;
    seen.add(s.id);
    const kids = (children.get(s.id) ?? []).filter((k) => !seen.has(k.id));
    const lastPath = depth === 0 ? [] : [...path, lastChild];
    rows.push({ step: s, depth, parentId, childIds: kids.map((k) => k.id), lastChild, lastPath });
    kids.forEach((k, i) => walk(k, depth + 1, s.id, i === kids.length - 1, lastPath));
  };
  roots.forEach((r, i) => walk(r, 0, null, i === roots.length - 1, []));
  // A cycle is the only way to get here: none of its members was anybody's root.
  for (const s of ordered) if (!seen.has(s.id)) walk(s, 0, null, true, []);
  return rows;
}

/**
 * The steps still waiting for the node they ran inside: their parent chain reaches a
 * `parent_step_id` the trace does not have yet.
 *
 * A STEP IS EMITTED WHEN IT ENDS, so in a live run a model call lands before the node it ran in — and
 * drawn as a root until then, it sat flat at the top level and jumped in under its node a moment
 * later, every row below it shifting. While a run is live these are drawn where their node will land
 * instead (the live tail). In a finished run a missing parent is really missing, and the step is a
 * root, as `buildTraceTree` has it.
 */
export function awaitingNode(steps: readonly Step[]): Set<string> {
  const byId = new Map(steps.map((s) => [s.id, s]));
  const memo = new Map<string, boolean>();
  const waits = (s: Step, seen: Set<string>): boolean => {
    const known = memo.get(s.id);
    if (known !== undefined) return known;
    const p = s.parent_step_id;
    let out = false;
    if (p && p !== s.id && !seen.has(p)) {
      const parent = byId.get(p);
      seen.add(p);
      out = parent ? waits(parent, seen) : true;
    }
    memo.set(s.id, out);
    return out;
  };
  const out = new Set<string>();
  for (const s of steps) if (waits(s, new Set([s.id]))) out.add(s.id);
  return out;
}

// ── What is on screen ────────────────────────────────────────────────────────

export type StepFilter = "all" | "llm" | "tool" | "state" | "route" | "errors";

export interface VisibleRow extends TraceRow {
  /**
   * Shown only so a match keeps its place in the tree — the node a matching model call ran inside.
   * Drawn quieter than a match, and never counted as one.
   */
  context: boolean;
  /** Folded, so its children are not drawn. Always false while a filter or a search is on. */
  collapsed: boolean;
  /**
   * Its steps are drawn right under it — so a line leaves its tile. Not `childIds.length`: a fold, a
   * filter or a search can hide every one of them.
   */
  shownChildren: boolean;
}

/**
 * The lines' view of the rows: `lastChild` and `lastPath` as the SCREEN has them, not the tree.
 *
 * A step whose next sibling a filter hid is the last one drawn under its node, and a line carrying on
 * past it would run into nothing. So both are recomputed over the rows actually shown, with
 * `shownChildren` beside them.
 */
function drawnLinks(rows: VisibleRow[]): VisibleRow[] {
  const lastAt: boolean[] = [];
  return rows.map((row, i) => {
    let j = i + 1;
    while (j < rows.length && rows[j]!.depth > row.depth) j++;
    const next = rows[j];
    const lastChild = !(next && next.depth === row.depth && next.parentId === row.parentId);
    lastAt[row.depth] = lastChild;
    const lastPath = row.depth === 0 ? [] : lastAt.slice(1, row.depth + 1);
    const shownChildren = rows[i + 1]?.parentId === row.step.id;
    return { ...row, lastChild, lastPath, shownChildren };
  });
}

export function matchesFilter(step: Step, filter: StepFilter): boolean {
  if (filter === "all") return true;
  if (filter === "errors") return step.error != null;
  return stepCategory(step) === filter;
}

/** How many steps each filter would show — the counts beside the filter's words. */
export function filterCounts(steps: readonly Step[]): Record<StepFilter, number> {
  const counts: Record<StepFilter, number> = { all: 0, llm: 0, tool: 0, state: 0, route: 0, errors: 0 };
  for (const s of steps) {
    counts.all++;
    const c = stepCategory(s);
    if (c !== "other") counts[c]++;
    if (s.error != null) counts.errors++;
  }
  return counts;
}

/** A payload is searched, but only its first few thousand characters — a keystroke must stay cheap. */
const PAYLOAD_SEARCHED = 4000;
const haystacks = new WeakMap<Step, string>();

function payloadText(v: unknown): string {
  if (v == null) return "";
  if (typeof v === "string") return v.slice(0, PAYLOAD_SEARCHED);
  try {
    return (JSON.stringify(v) ?? "").slice(0, PAYLOAD_SEARCHED);
  } catch {
    return "";
  }
}

/**
 * Everything a search can find a step by, lowercased once per step object. The store replaces a
 * step's object whenever the step changes, so a WeakMap keyed on it can never serve stale text.
 */
export function searchText(step: Step): string {
  const cached = haystacks.get(step);
  if (cached !== undefined) return cached;
  const text = [
    step.name,
    step.id,
    `#${step.seq}`,
    step.type,
    CATEGORY_LABEL[stepCategory(step)],
    step.error ?? "",
    payloadText(step.input),
    payloadText(step.output),
  ].join("\n").toLowerCase();
  haystacks.set(step, text);
  return text;
}

export function matchesQuery(step: Step, query: string): boolean {
  const q = query.trim().toLowerCase();
  return q === "" || searchText(step).includes(q);
}

/** Where in a step a search found its words. */
export type MatchPlace = "name" | "id" | "kind" | "error" | "input" | "output";

/**
 * Where a step matched a search, in the order somebody would look: its name, its id or number, its
 * kind, its error, then what went in and what came out.
 *
 * "PostgreSQL" MATCHED ALL NINE STEPS OF A RUN, because every node's state carries the job
 * description — and nothing said that eight of them matched in their input and one in its name. The
 * row says where (StepRow); this is the same text `searchText` reads, field by field.
 */
export function matchPlaces(step: Step, query: string): MatchPlace[] {
  const q = query.trim().toLowerCase();
  if (q === "" || !matchesQuery(step, q)) return [];
  const has = (text: string): boolean => text.toLowerCase().includes(q);
  const out: MatchPlace[] = [];
  if (has(step.name)) out.push("name");
  if (has(step.id) || has(`#${step.seq}`)) out.push("id");
  if (has(step.type) || has(CATEGORY_LABEL[stepCategory(step)])) out.push("kind");
  if (step.error && has(step.error)) out.push("error");
  if (has(payloadText(step.input))) out.push("input");
  if (has(payloadText(step.output))) out.push("output");
  return out;
}

/**
 * The rows to draw.
 *
 * UNFILTERED, folding applies: a collapsed node hides its descendants and nothing else does.
 *
 * FILTERED OR SEARCHED, folding is set aside and every match is drawn with its ancestors, so a
 * matching model call still appears under the node it ran in. A fold that hid a search's only match
 * would be a search that says "nothing found" about something that is right there.
 */
export function visibleRows(
  tree: readonly TraceRow[],
  opts: { collapsed?: Readonly<Record<string, true>>; filter?: StepFilter; query?: string } = {},
): VisibleRow[] {
  const collapsed = opts.collapsed ?? {};
  const filter = opts.filter ?? "all";
  const query = opts.query ?? "";
  const narrowed = filter !== "all" || query.trim() !== "";

  if (!narrowed) {
    const out: VisibleRow[] = [];
    let hideBelow: number | null = null;
    for (const row of tree) {
      if (hideBelow !== null) {
        if (row.depth > hideBelow) continue;
        hideBelow = null;
      }
      const folded = Boolean(collapsed[row.step.id]) && row.childIds.length > 0;
      out.push({ ...row, context: false, collapsed: folded, shownChildren: false });
      if (folded) hideBelow = row.depth;
    }
    return drawnLinks(out);
  }

  const byId = new Map(tree.map((r) => [r.step.id, r]));
  const matched = new Set<string>();
  const keep = new Set<string>();
  for (const row of tree) {
    if (!matchesFilter(row.step, filter) || !matchesQuery(row.step, query)) continue;
    matched.add(row.step.id);
    let id: string | null = row.step.id;
    while (id && !keep.has(id)) {
      keep.add(id);
      id = byId.get(id)?.parentId ?? null;
    }
  }
  return drawnLinks(
    tree
      .filter((r) => keep.has(r.step.id))
      .map((r) => ({ ...r, context: !matched.has(r.step.id), collapsed: false, shownChildren: false })),
  );
}

/** Every step under a row, at any depth — what a folded node stands for. */
export function descendantSteps(tree: readonly TraceRow[], id: string): Step[] {
  const at = tree.findIndex((r) => r.step.id === id);
  if (at === -1) return [];
  const out: Step[] = [];
  for (let i = at + 1; i < tree.length && tree[i]!.depth > tree[at]!.depth; i++) out.push(tree[i]!.step);
  return out;
}

/** The ids of a step's ancestors, nearest first — what has to be unfolded to show it. */
export function ancestorIds(steps: Readonly<Record<string, Step>>, id: string): string[] {
  const out: string[] = [];
  const seen = new Set([id]);
  let parent = steps[id]?.parent_step_id ?? null;
  while (parent && steps[parent] && !seen.has(parent)) {
    out.push(parent);
    seen.add(parent);
    parent = steps[parent]!.parent_step_id;
  }
  return out;
}

// ── Totals ───────────────────────────────────────────────────────────────────

export interface TraceTotals {
  /** Every token the run's model calls reported, or null when none reported any. */
  tokens: number | null;
  /** What those calls cost, or null when none was priced. */
  cost: number | null;
  /** Model calls in the trace, failed ones included. */
  llmCalls: number;
  /** Model calls that finished but carry no price — a model the pricing table does not know. */
  unpricedCalls: number;
}

/**
 * The run's tokens and cost, by the schema's own accounting.
 *
 * SUMMED OVER EVERY STEP AND NOTHING IS COUNTED TWICE, because only `llm_call` steps carry tokens or
 * cost — a node's figures are not the sum of its children's, they are null. This is the same total
 * the interceptor writes onto `run_end`, computed from the steps so it moves while the run does.
 *
 * NULL IS NOT ZERO. A run whose calls were never priced has an unknown cost, and writing `$0.00`
 * for it would be a claim nobody measured.
 */
export function traceTotals(steps: readonly Step[]): TraceTotals {
  let tokens: number | null = null;
  let cost: number | null = null;
  let llmCalls = 0;
  let unpricedCalls = 0;
  for (const s of steps) {
    if (s.tokens != null) tokens = (tokens ?? 0) + s.tokens;
    if (s.cost != null) cost = (cost ?? 0) + s.cost;
    if (s.type === "llm_call") {
      llmCalls++;
      if (s.cost == null && s.error == null) unpricedCalls++;
    }
  }
  return { tokens, cost, llmCalls, unpricedCalls };
}

// ── A branch's own steps ─────────────────────────────────────────────────────

/**
 * Whether a step was copied into a branch from the run it branched from, rather than run by it.
 *
 * A BRANCH STARTS WITH ITS PARENT'S STEPS UP TO THE FORK, copied verbatim (`copyRunPrefix`) — their
 * timestamps, their tokens, their cost — and `branch_from_seq` is the last of them: the server forks
 * at a whole node boundary and records that boundary's highest seq. Everything after it is the
 * branch's own.
 */
export function isInherited(
  step: Pick<Step, "seq">,
  run: Pick<RunSummary, "parent_run_id" | "branch_from_seq"> | undefined,
): boolean {
  return run?.parent_run_id != null && run.branch_from_seq != null && step.seq <= run.branch_from_seq;
}

/** The steps a run actually ran — a branch's without the prefix it copied from its parent. */
export function ownSteps(
  run: Pick<RunSummary, "parent_run_id" | "branch_from_seq"> | undefined,
  steps: readonly Step[],
): Step[] {
  return steps.filter((s) => !isInherited(s, run));
}

// ── Time ─────────────────────────────────────────────────────────────────────

export interface TimeWindow {
  start: number;
  end: number;
}

/**
 * When a step ran, in epoch milliseconds — or null when its fields cannot say.
 *
 * `started_at` IS THE END. See the header: the interceptor stamps it as the step finishes, so the
 * start is that instant minus the step's own duration.
 */
export function stepWindow(step: Pick<Step, "started_at" | "latency_ms">): TimeWindow | null {
  const end = Date.parse(step.started_at);
  const ms = step.latency_ms;
  if (!Number.isFinite(end) || typeof ms !== "number" || !Number.isFinite(ms) || ms < 0) return null;
  return { start: end - ms, end };
}

/**
 * The span the run's bars are drawn against: from its start (or its first step's, if that is
 * earlier) to its end — or to `now` while it has none.
 *
 * WIDENED TO COVER EVERY STEP, because the run and its steps are stamped by different writers and a
 * step a few milliseconds outside its own run would otherwise draw a bar off the end of the track.
 * Pass a branch its OWN steps (`ownSteps`): the ones it inherited ran in its parent, before it began,
 * and widening to them squeezed the branch's own bars into the last quarter of the track.
 */
export function runWindow(
  run: Pick<Run, "started_at" | "ended_at">,
  steps: readonly Step[],
  now: number,
): TimeWindow | null {
  let start = Date.parse(run.started_at);
  let end = run.ended_at ? Date.parse(run.ended_at) : now;
  if (!Number.isFinite(start) || !Number.isFinite(end)) return null;
  for (const s of steps) {
    const w = stepWindow(s);
    if (!w) continue;
    if (w.start < start) start = w.start;
    if (w.end > end) end = w.end;
  }
  return end > start ? { start, end } : null;
}

/**
 * How long a run has taken, in milliseconds — or null when its times cannot say.
 *
 * ENDED, its end less its start. RUNNING, `now` less its start. PAUSED, up to the last step that
 * finished: a paused run is not doing anything, and counting the wall clock from its start made one
 * reopened from history read "1d 01h" and keep ticking, while the same state reached live froze at
 * the moment the pause landed. Both read the run's own last step now, so they agree.
 */
export function runElapsed(
  run: Pick<Run, "status" | "started_at" | "ended_at">,
  steps: readonly Step[],
  now: number,
): number | null {
  const start = Date.parse(run.started_at);
  if (!Number.isFinite(start)) return null;
  let end = now;
  if (run.ended_at) end = Date.parse(run.ended_at);
  else if (run.status === "paused") {
    end = start;
    for (const s of steps) {
      const w = stepWindow(s);
      if (w && w.end > end) end = w.end;
    }
  }
  return Number.isFinite(end) ? Math.max(0, end - start) : null;
}

/**
 * How long a run's steps themselves took: the top-level steps' durations added up — a node's own
 * time already includes the model calls and tools inside it, so those are never added again.
 *
 * WHAT A RUN'S DURATION IS MADE OF, when somebody asks why it is long. A stopped run read 1m 09s over
 * two steps that took 2.2s together, and nothing said the other minute was the run sitting paused or
 * waiting until it was stopped.
 */
export function stepsTime(steps: readonly Step[]): number {
  let ms = 0;
  for (const row of buildTraceTree(steps)) {
    if (row.depth === 0 && Number.isFinite(row.step.latency_ms) && row.step.latency_ms > 0) ms += row.step.latency_ms;
  }
  return ms;
}

// ── Errors ───────────────────────────────────────────────────────────────────

export interface ErrorParts {
  /** The exception's class, when the message leads with one: `RuntimeError`, `TimezoneNotFound`. */
  type: string | null;
  /** The first line, without the class. */
  message: string;
  /** Every line after the first — a stack, when there is one. */
  detail: string | null;
}

/**
 * Whether a word before a colon is an exception's class rather than the first word of a sentence:
 * CamelCase (`TimezoneNotFound`, `KeyError`) or a class-shaped suffix (`Exception`). An old cancel
 * reason reads `Cancelled: the run was stopped…`, and "Cancelled" is not a class.
 */
const looksLikeClass = (word: string): boolean =>
  /[A-Z].*[A-Z]/.test(word) || /(Error|Exception|Warning|Exit)$/.test(word);

/**
 * A step's error, split the way the interceptor writes it: `f"{type(error).__name__}: {error}"`,
 * sometimes followed by `  at file:line` frames. Anything else is all message.
 */
export function errorParts(error: string): ErrorParts {
  const text = error.replace(/\s+$/, "");
  const nl = text.indexOf("\n");
  const first = nl === -1 ? text : text.slice(0, nl);
  const rest = nl === -1 ? "" : text.slice(nl + 1).replace(/^\s*\n/, "");
  const found = /^([A-Z][\w.]*): (.+)$/.exec(first);
  const m = found && looksLikeClass(found[1]!) ? found : null;
  return {
    type: m ? m[1]! : null,
    message: m ? m[2]! : first,
    detail: rest.trim() ? rest : null,
  };
}
