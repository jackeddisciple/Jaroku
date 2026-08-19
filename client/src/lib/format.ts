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

/**
 * Duration in ms → "820ms" / "2.4s" / "1m 05s".
 *
 * ONE UNIT-SPACING CONVENTION: none. It had three inside one function — a space before `ms`, no
 * space before `s`, and a zero-padded second half — so `820 ms` and `2.4s` appeared in the same
 * trace column, one with a gap and one without, and neither was wrong on its own.
 */
export function fmtDuration(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)}ms`;
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

/**
 * A count, shortened past a thousand: "999" / "11.6k" / "1.2M".
 *
 * THE ONE PLACE THE THRESHOLD AND THE SUFFIXES ARE DECIDED. There were two implementations of
 * this idea — this one and `activityMetrics.tokens` — so the same quantity read as `11,646 tok`
 * in the Usage panel and `11.6K` in the Activity hero, one screen apart. One decimal is kept so
 * `1.2M` and `1.9M` are different numbers on screen, and nobody reads the last three digits of
 * 4,182,993 tokens anyway.
 */
export function shortCount(value: number): string {
  const abs = Math.abs(value);
  if (abs >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`;
  if (abs >= 1_000) return `${(value / 1_000).toFixed(1)}k`;
  return String(Math.round(value));
}

/**
 * A token count, with the unit where the unit goes: after the number, once.
 *
 * TWO FORMS, THE SAME SPLIT COST AND PERCENT USE. `exact` is for an itemised row somebody is
 * reading as a figure — a usage line, a per-step total — where the digits are the point. `short`
 * is for a summary somebody is reading as a size. Which one a surface wants is a property of the
 * surface, not of the number.
 */
export function fmtTokens(
  tokens: number | null | undefined,
  form: "exact" | "short" = "exact",
): string {
  if (tokens == null) return "—";
  return `${form === "short" ? shortCount(tokens) : tokens.toLocaleString()} tok`;
}

/** Latency in ms, or an em dash when there isn't one. Null is "no measurement", not 0. */
export function fmtLatency(ms: number | null | undefined): string {
  if (ms == null) return "—";
  return fmtDuration(ms);
}

/**
 * 0..1 → "67%" for a share, "47.2%" for progress.
 *
 * TWO PRECISIONS, BECAUSE THEY ANSWER DIFFERENT QUESTIONS. A share of a total is read as a
 * proportion and a decimal on it is noise. A progress readout is watched while it moves, and a
 * figure that only advances in whole steps reads as coarse and, on a long drain, as stuck — next
 * to four-decimal costs on the same strip.
 */
export function fmtPercent(
  ratio: number | null | undefined,
  precision: "share" | "progress" = "progress",
): string {
  if (ratio == null) return "—";
  const pct = ratio * 100;
  return precision === "share" ? `${Math.round(pct)}%` : `${pct.toFixed(1)}%`;
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
