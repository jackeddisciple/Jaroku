// Small display helpers. Copy style from jarokudoc.md §11: short, factual, present tense
// ("Worked for 4m 29s", "Edited 3 files"). Numbers never lie — cost/token math stays exact.

/**
 * How long ago: "just now" / "42s ago" / "9m ago" / "3h ago" / "5d ago" — and then a date.
 *
 * IT USED TO HAVE NO CEILING, so a nine-month-old run rendered as `274d ago`, which is arithmetic
 * the reader has to undo before it means anything. Past a week the calendar date is the useful
 * fact and the elapsed time is not: nobody asks how many days ago something was in March.
 *
 * The year appears only when it is not this one. A date carrying a year every time would be four
 * characters of noise on the ninety-nine percent of rows that are from this year, and its absence
 * is unambiguous — an unqualified `19 Aug` can only mean the most recent one.
 */
const WEEK_S = 7 * 24 * 60 * 60;

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
  if (s < WEEK_S) return `${Math.floor(h / 24)}d ago`;
  const d = new Date(t);
  const sameYear = d.getFullYear() === new Date().getFullYear();
  return d.toLocaleDateString(undefined, {
    day: "numeric",
    month: "short",
    ...(sameYear ? {} : { year: "numeric" }),
  });
}

/**
 * The same idea pointing forwards: "in 8 hours", "in 3 days".
 *
 * A SIBLING RATHER THAN A SIGN INSIDE `relTime`, and the clamp above is why. `relTime` floors its
 * delta at zero deliberately — every one of its ~fifty call sites describes something that has
 * ALREADY happened, and a clock a second ahead of the server would otherwise render a run that just
 * finished as "in 1s". Teaching it to look forwards would remove that protection from all of them
 * to serve the two places that need it.
 *
 * THE TWO PLACES ARE BOTH THIS RELEASE'S. A grant's `expires_at` and an invitation's `expires_at`
 * are the first future instants this client has ever rendered, and they went through `relTime` — so
 * a grant with eight hours left said "expires just now", which is not a smaller answer than the
 * right one, it is a confident lie about the one thing a time-boxed grant exists to communicate.
 *
 * A PAST INSTANT FALLS BACK TO `relTime`, so a caller holding a timestamp that may be either does
 * not have to branch: an expiry that has already passed reads "2h ago" rather than "in 0s".
 */
export function relUntil(iso: string): string {
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return "";
  const s = Math.floor((t - Date.now()) / 1000);
  if (s <= 0) return relTime(iso);
  if (s < 60) return "in under a minute";
  const m = Math.floor(s / 60);
  if (m < 60) return `in ${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `in ${h} hour${h === 1 ? "" : "s"}`;
  const d = Math.floor(h / 24);
  if (d < 30) return `in ${d} day${d === 1 ? "" : "s"}`;
  // Beyond a month the number stops being useful and the DATE starts being: "in 47 days" is
  // something somebody has to convert, and a date is something they can put in a calendar.
  return `on ${new Date(t).toLocaleDateString(undefined, { day: "numeric", month: "short" })}`;
}

/** The exact moment, for the `title` on any element rendering `relTime`. */
export function absTime(iso: string): string {
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return "";
  return new Date(t).toLocaleString();
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
/**
 * Whether `fmtUntil` would say "expired". For the call sites that need to give a dead deadline the
 * error tone — a revoked invitation rendered in the same faint grey as one with a week left, which
 * is the one case where the two states look identical and mean opposite things.
 */
export function isExpired(iso: string): boolean {
  const t = Date.parse(iso);
  return !Number.isNaN(t) && t - Date.now() <= 0;
}

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
