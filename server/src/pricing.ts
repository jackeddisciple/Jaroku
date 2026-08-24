// Model pricing — the Node reader of the shared `runtime/pricing.json` table.
//
// The Python interceptor has its own reader (runtime/jaroku_interceptor/pricing.py) over
// the SAME file. That is the point: a per-step cost computed inside a run and a pre-run
// estimate computed here are the same arithmetic over the same numbers, so the eval
// dashboard and the "this will cost about $X" gate can never disagree.
//
// Three rules, identical to the Python side:
//   1. An unpriced model costs UNKNOWN (null), never $0. Doc §8 — "wrong cost numbers
//      destroy trust instantly"; a silent zero next to a real number is the worst case,
//      because it reads as "this provider is free" rather than "we don't know".
//   2. Matching is exact-then-longest-prefix, never unordered substring.
//   3. Cached input is priced as cached input (Anthropic: ~0.1x read, ~1.25x write).
//      Charging cache reads at the full input rate overstates cost by up to 10x.
//
// Loading is best-effort: a missing or malformed table means "every model is unpriced",
// which is honest, rather than a guess.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
/** runtime/pricing.json — the single source of truth, shared with the Python runtime. */
export const PRICING_PATH = join(resolve(__dirname, "..", ".."), "runtime", "pricing.json");

const PER_MILLION = 1_000_000;
// USD carried to 8 decimals ($0.00000001) — orders of magnitude below any real step cost,
// so per-step rounding cannot accumulate into a visible aggregate error.
const USD_DP = 8;

/** One model's rates. `input`/`output` are USD per MILLION tokens. */
export interface Price {
  id: string;
  provider: string;
  input: number;
  output: number;
  cache_read_mult: number;
  cache_write_mult: number;
  free: boolean;
}

export interface TokenBreakdown {
  /** UNCACHED input only — cache reads/writes are passed separately and priced apart. */
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
}

function load(): Price[] {
  try {
    const raw = JSON.parse(readFileSync(PRICING_PATH, "utf8")) as {
      models?: Record<string, unknown>[];
    };
    const out: Price[] = [];
    for (const m of raw.models ?? []) {
      const id = typeof m.id === "string" ? m.id : null;
      const input = Number(m.input);
      const output = Number(m.output);
      // One bad row must not void the whole table.
      if (!id || !Number.isFinite(input) || !Number.isFinite(output)) continue;
      out.push({
        id,
        provider: typeof m.provider === "string" ? m.provider : "",
        input,
        output,
        cache_read_mult: Number.isFinite(Number(m.cache_read_mult)) ? Number(m.cache_read_mult) : 0,
        cache_write_mult: Number.isFinite(Number(m.cache_write_mult)) ? Number(m.cache_write_mult) : 1,
        free: m.free === true,
      });
    }
    return out;
  } catch {
    return []; // no table -> every model is unpriced. Never fatal.
  }
}

const TABLE: Price[] = load();

/** Every priced model, for UI that needs to show what is and isn't comparable. */
export function allPrices(): readonly Price[] {
  return TABLE;
}

/** The most specific entry for `model`: exact match, else longest matching prefix. */
export function priceFor(model: string): Price | null {
  if (!model) return null;
  const exact = TABLE.find((p) => p.id === model);
  if (exact) return exact;
  let best: Price | null = null;
  for (const p of TABLE) {
    if (model.startsWith(p.id) && (best === null || p.id.length > best.id.length)) best = p;
  }
  return best;
}

/** Whether a cost can be computed at all for this model. */
export function isPriced(model: string): boolean {
  return priceFor(model) !== null;
}

/** USD for one model call, or `null` when the model has no pricing entry. */
export function costFor(model: string, t: TokenBreakdown): number | null {
  const price = priceFor(model);
  if (!price) return null;
  const usd =
    (t.inputTokens * price.input +
      (t.cacheReadTokens ?? 0) * price.input * price.cache_read_mult +
      (t.cacheWriteTokens ?? 0) * price.input * price.cache_write_mult +
      t.outputTokens * price.output) /
    PER_MILLION;
  return round8(usd);
}

/** Round to the module's USD precision. Exported so aggregation rounds identically. */
export function round8(usd: number): number {
  return Number(usd.toFixed(USD_DP));
}

// ── Capability ──────────────────────────────────────────────────────────────
// What a model can DO, as opposed to what it costs. Same file, same reader, and that is a
// decision rather than convenience: the composer spec requires the reasoning budgets to live
// "in the same shared pricing/capability file as model metadata", and the reason is the reason
// the prices are here — a table that lives in TypeScript is a table the Python runtime cannot
// read, and two tables about the same models drift the first time one of them is edited.
//
// Loading is best-effort in exactly the same way. A missing `reasoning` key means "this model
// has no reasoning control", which is the safe direction: the composer hides the effort chip
// rather than sending a thinking budget to a provider that would reject it.

/** How a provider spells "think harder", or null when it does not. */
export type ReasoningKind = "thinking" | "effort";

export interface Capability {
  id: string;
  /** Null when the model exposes no reasoning control at all — §6.2 omits the chip. */
  reasoning: ReasoningKind | null;
  /** The ceiling every thinking budget is validated against before dispatch. */
  maxOutputTokens: number;
  /** For the attachment budget check. Null when nothing has recorded one. */
  contextWindow: number | null;
}

/** Jaroku's four levels, in tokens, for `thinking`-shaped providers. */
export type ReasoningBudgets = Record<string, number>;

function loadCapabilities(): { caps: Capability[]; budgets: ReasoningBudgets } {
  try {
    const raw = JSON.parse(readFileSync(PRICING_PATH, "utf8")) as {
      models?: Record<string, unknown>[];
      reasoning?: { budgets?: Record<string, unknown> };
    };
    const caps: Capability[] = [];
    for (const m of raw.models ?? []) {
      const id = typeof m.id === "string" ? m.id : null;
      if (!id) continue;
      const kind = m.reasoning;
      caps.push({
        id,
        reasoning: kind === "thinking" || kind === "effort" ? kind : null,
        // A model with no recorded ceiling gets a conservative one rather than Infinity. An
        // unbounded default would let a budget through unvalidated, which is the one thing this
        // number exists to prevent.
        maxOutputTokens: Number.isFinite(Number(m.max_output_tokens)) ? Number(m.max_output_tokens) : 4096,
        contextWindow: Number.isFinite(Number(m.context_window)) ? Number(m.context_window) : null,
      });
    }
    const budgets: ReasoningBudgets = {};
    for (const [k, v] of Object.entries(raw.reasoning?.budgets ?? {})) {
      if (Number.isFinite(Number(v))) budgets[k] = Number(v);
    }
    return { caps, budgets };
  } catch {
    return { caps: [], budgets: {} };
  }
}

const CAPS = loadCapabilities();

/**
 * The capability record for a model, matched exactly-then-longest-prefix — the SAME rule
 * `priceFor` uses, and deliberately so. A model id that prices as `claude-sonnet-5` and reasons
 * as something else would be two answers about one model.
 */
export function capabilityFor(model: string): Capability | null {
  if (!model) return null;
  const exact = CAPS.caps.find((c) => c.id === model);
  if (exact) return exact;
  let best: Capability | null = null;
  for (const c of CAPS.caps) {
    if (model.startsWith(c.id) && (best === null || c.id.length > best.id.length)) best = c;
  }
  return best;
}

/** The shared budget table. Empty when the file is missing, which reads as "no thinking". */
export function reasoningBudgets(): ReasoningBudgets {
  return CAPS.budgets;
}

/** How much context this model has, for the attachment budget check. Null when unrecorded. */
export function contextWindowFor(model: string): number | null {
  return capabilityFor(model)?.contextWindow ?? null;
}
