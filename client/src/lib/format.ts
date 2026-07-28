// Small display helpers. Copy style from jarokudoc.md §11: short, factual, present tense
// ("Worked for 4m 29s", "Edited 3 files"). Numbers never lie — cost/token math stays exact.

import type { StepType } from "../types.ts";

export function relTime(iso: string): string {
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return "";
  const s = Math.max(0, Math.floor((Date.now() - t) / 1000));
  if (s < 5) return "just now";
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

/** Duration in ms → "820 ms" / "2.4s" / "1m 05s". */
export function fmtDuration(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)} ms`;
  const s = ms / 1000;
  if (s < 60) return `${s.toFixed(1)}s`;
  const m = Math.floor(s / 60);
  return `${m}m ${String(Math.floor(s % 60)).padStart(2, "0")}s`;
}

export function fmtCost(cost: number | null | undefined): string {
  if (cost == null) return "—";
  if (cost === 0) return "$0";
  return `$${cost < 0.01 ? cost.toFixed(5) : cost.toFixed(4)}`;
}

export function fmtTokens(tokens: number | null | undefined): string {
  if (tokens == null) return "—";
  return `${tokens.toLocaleString()} tok`;
}

/** Latency in ms, or an em dash when there isn't one. Null is "no measurement", not 0. */
export function fmtLatency(ms: number | null | undefined): string {
  if (ms == null) return "—";
  return fmtDuration(ms);
}

/** 0..1 → "67%". */
export function fmtPercent(ratio: number | null | undefined): string {
  if (ratio == null) return "—";
  return `${Math.round(ratio * 100)}%`;
}

export function jsonPretty(v: unknown): string {
  if (v == null) return "";
  if (typeof v === "string") return v;
  try {
    return JSON.stringify(v, null, 2);
  } catch {
    return String(v);
  }
}

// Type → muted badge classes. Color hints at kind; it is intentionally low-saturation so the
// timeline reads as content, not a rainbow (doc §4.2 restraint). Status colors are separate.
const BADGE: Record<StepType, string> = {
  llm_call: "bg-[#182130] text-[#7fa9db]",
  tool_call: "bg-[#16221a] text-[#79c48f]",
  state_update: "bg-[#241f18] text-[#c99a52]",
  router: "bg-[#221826] text-[#a98cc4]",
};

export function typeBadge(type: StepType): string {
  return BADGE[type];
}
