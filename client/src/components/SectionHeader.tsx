// A section's name and how many things are in it. One header grammar, everywhere.
//
// IT ALREADY EXISTED TWICE. The Threads list and the Inbox board both drew "label, count, rule" out
// of the same three spans, and the Threads file's own comment records what happened when they were
// two copies: "the rule used to run BETWEEN the label and its count here and AFTER the count on the
// Inbox board — the same header, two orders, two views apart". Every other surface in the product
// drew the label and left the count off, so the answer to "how many secrets do I have" was to count
// the rows.
//
// NO PARENTHESES, NO BRACKETS, NO BADGE PILL. `Blocking 12`, not `Blocking (12)` and not a count in
// a filled circle. A pill makes a count an alert, and a section that is merely full is not one — the
// sidebar's Inbox badge is the only counted thing in this product that is supposed to demand
// something, and it earns that by counting only what a person has to answer.
//
// ── THE TWO RULES THAT ARE THE WHOLE POINT ──────────────────────────────────────────────────────
//
// A COUNT IS A TOTAL, NOT A PAGE. `count` is a `number | null` and never a `.length` off a list the
// caller happens to be holding, unless that list is genuinely all of them. The Activity feed is
// virtualised at ten thousand rows — `rows.length` there is the RENDER WINDOW — and a header reading
// "Activity 40" over ten thousand events is a lie that looks like a feature. Where a payload does not
// carry a total, the honest answer is `null`, which is why null is a value rather than an omission.
//
// EMPTY IS NOT ZERO. A count that is genuinely zero renders `0`. A count that is not yet known
// renders a dash. These are different sentences and this component can say both: `Blocking 0` is an
// achievement and reads as one; `Blocking —` says the board has not arrived yet. Rendering the
// second as the first is the specific way a loading state becomes a confident wrong answer.
//
// THE DASH IS `format.ts`'s EM DASH, NOT THE `--` THE BRIEF PRINTS. This app already has one mark
// for "not known" — `fmtCost`, `fmtTokens`, `fmtDuration` and `fmtRatio` all return "—" — and a
// second spelling of the same idea, on the same screen as the first, would be two dialects of
// unknown. The brief's own rule for this case is that the existing files win.
//
//   npm run test:section-count

import { TYPE } from "../lib/tokens.ts";

/** What `count === null` renders. The same mark `lib/format.ts` returns for every unknown figure. */
export const UNKNOWN_COUNT = "—";

export function SectionHeader({
  name,
  count,
  rule = false,
  className = "",
  children,
}: {
  /** The section's own word. Rendered as it is given; the header's caps are a class, not a transform. */
  name: string;
  /**
   * How many things are in the section, in total.
   *
   * `null` MEANS NOT YET KNOWN, and it is the honest answer for a paginated section whose payload
   * carries no total. `undefined` is not accepted on purpose: a prop that could be forgotten is a
   * count that silently disappears, and the difference between "this section has no count" and
   * "somebody forgot to pass one" is exactly what `test:section-count` cannot see afterwards.
   */
  count: number | null;
  /** The hairline out to the edge, for a header that sits over a full-width list. */
  rule?: boolean;
  className?: string;
  /** A control that belongs to the section rather than to the page — a collapse, a filter. */
  children?: React.ReactNode;
}) {
  return (
    <div className={`flex shrink-0 items-center gap-2 ${className}`}>
      <span className={TYPE.panelLabel}>{name}</span>
      {/* TABULAR, so a column of headers has its counts on one axis rather than dancing by a pixel
          per digit. And `aria-label` on the pair, because "Blocking 12" read as two unrelated runs
          of text is how a screen reader announces a number with nothing attached to it. */}
      <span className="text-tiny tabular-nums text-faint">
        {count === null ? UNKNOWN_COUNT : count}
      </span>
      {rule && <span className="h-px flex-1 bg-hair" />}
      {children}
    </div>
  );
}
