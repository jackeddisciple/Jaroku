// Stat row — the "what did that cost" line, as a set of figures rather than a sentence.
//
// Generation reported itself as prose: "Generated 6 files · 1,912 output tokens · $0.0125 + $0.0027
// plan = $0.0151 · cache hit". Everything in it is a number, but they were separated by middots and
// wrapped in words, so reading the cost meant parsing the sentence to find it. Numbers are what the
// eye is best at spotting and worst at finding inside prose.
//
// Each figure gets an icon, so the label is carried by a glyph the eye can jump to, and the value
// sits in tabular monospace so successive generations line up rather than shifting under each other.
// Built as its own component because the trace panel reports the same three quantities and should
// eventually say them the same way (doc §4.7 — the details that make you faster).

import { ICON } from "../lib/tokens.ts";

export type Stat = {
  icon: React.ReactNode;
  /** The figure. Monospace and tabular — this is the thing being compared. */
  value: string;
  /** Unit or noun, in prose. Optional: "$0.0151" needs no noun, "6 files" does. */
  label?: string;
  /** Hover explanation, for figures whose meaning is not obvious from the glyph. */
  title?: string;
  /** Secondary stats recede — a cache hit is worth reporting, not worth leading with. */
  dim?: boolean;
};

/**
 * A row of figures. `leading` is the sentence-opener that says what happened ("Generated",
 * "Edited") — kept because "6 files" alone does not say whether they were written or rewritten.
 */
export function StatRow({ leading, stats }: { leading?: React.ReactNode; stats: Stat[] }) {
  return (
    <div className="flex flex-wrap items-center gap-x-3.5 gap-y-1 text-[11px]">
      {leading}
      {stats.map((s, i) => (
        <span
          key={i}
          title={s.title}
          className={`inline-flex items-center gap-1.5 ${s.dim ? "text-faint" : "text-muted"}`}
        >
          <span className="shrink-0 flex items-center opacity-70" aria-hidden>
            {s.icon}
          </span>
          <span className="font-mono tabular-nums">{s.value}</span>
          {s.label && <span>{s.label}</span>}
        </span>
      ))}
    </div>
  );
}

/** The icon size stats use. Exported so callers do not re-pick it per call site. */
export const STAT_ICON = ICON.xs;
