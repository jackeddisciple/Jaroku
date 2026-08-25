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
  /**
   * Unit or noun. Shown as the figure's tooltip, and on screen only when `keepLabel` says the
   * figure is ambiguous without it.
   */
  label?: string;
  /** Render `label` beside the value. For a count whose unit cannot be inferred from its glyph. */
  keepLabel?: boolean;
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
    // `gap-x-3` rather than `gap-x-3.5`: fourteen pixels is off the four-pixel grid and appeared
    // nowhere else in the client.
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-tiny">
      {leading}
      {stats.map((s, i) => (
        <span
          key={i}
          // THE LABEL IS THE TOOLTIP NOW. A glyph plus a value plus a word, four times over, is a
          // set of labelled form fields; a glyph plus a value is a chip row you read at a glance —
          // and the glyph is already the label, which is the whole reason each figure has one.
          // `output tokens` and `cached` were the words that went; `files` stays, because a bare
          // `3` beside a document mark could be three of anything.
          title={s.title ?? s.label}
          className={`inline-flex items-center gap-1.5 ${s.dim ? "text-faint" : "text-muted"}`}
        >
          <span className="shrink-0 flex items-center opacity-70" aria-hidden>
            {s.icon}
          </span>
          <span className="tabular-nums">{s.value}</span>
          {s.label && s.keepLabel && <span>{s.label}</span>}
        </span>
      ))}
    </div>
  );
}

/** The icon size stats use. Exported so callers do not re-pick it per call site. */
export const STAT_ICON = ICON.xs;
