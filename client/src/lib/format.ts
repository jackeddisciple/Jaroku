// Small display helpers. Copy style from jarokudoc.md §11: short, factual, present tense
// ("Worked for 4m 29s", "Edited 3 files"). Numbers never lie — cost/token math stays exact.

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

/**
 * A deadline, forwards: "in 6d" / "in 3h" / "in 12m" / "expired".
 *
 * NOT `relTime` WITH A SIGN FLIP. `relTime` clamps a future timestamp to zero and renders "just
 * now", which is the worst available answer for an expiry — an invitation good for another week
 * would read as one that had only this moment been issued. Everything this formats is a thing that
 * stops working at a stated time (an invitation, a presigned download, a token), and the useful
 * fact is how long is left, including that the answer is "none".
 */
export function fmtUntil(iso: string): string {
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return "";
  const s = Math.floor((t - Date.now()) / 1000);
  if (s <= 0) return "expired";
  if (s < 60) return `in ${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `in ${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `in ${h}h`;
  return `in ${Math.floor(h / 24)}d`;
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

// The step-type colours moved to lib/tokens.ts as STEP_TYPE. They are a category accent set, which
// is what that file is for, and as a pair of Tailwind class names they could only ever be handed
// to a `className` — the chip that renders them takes values.
