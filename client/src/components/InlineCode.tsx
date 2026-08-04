// Prose that knows which of its words are code.
//
// The panel's one typographic rule is that monospace means "this is literally an identifier". That
// rule held in every structured slot — tool rows, state fields, file paths — and quietly broke
// inside sentences, where `pg_query` rendered as an ordinary word. The same thing looked like two
// different things depending on which slot it happened to be in.
//
// <Prose> is the fix: pass it a string instead of interpolating one, and the identifiers inside it
// come out wearing the same chip the plan card already uses for connector provenance. Same radius,
// same fill, same padding, same 11px mono — because they are the same object, and CHIP is the one
// declaration both of them read.
//
// Vocabulary is the plan's own tool and state names when the caller has them (see lib/inlineCode.ts
// for why a plainly-named field like `messages` is deliberately left alone).

import { chipClass } from "./Chip.tsx";
import { segmentProse } from "../lib/inlineCode.ts";

/**
 * An identifier in a sentence is the same object as an identifier in a row, so the geometry comes
 * from Chip rather than from a class string kept in step by hand. What stays here is the two
 * decisions that are specific to prose:
 *
 * `inline` rather than inline-flex, because an inline-flex box cannot break across a line and a
 * long tool name mid-paragraph has to be able to.
 *
 * 11px against 12px prose: mono's x-height runs large, and matching the nominal size makes the
 * chip look bigger than the sentence around it. `align-middle` (in chipClass) keeps it on the
 * prose baseline instead of riding high the way an inline-block otherwise does.
 *
 * Ink, because an identifier in a sentence IS the thing being named. A chip that labels something
 * else — a connector's provenance, a server's name — stays muted, and reaches for <Chip> directly.
 */
export const CHIP_INK = `${chipClass({ size: "md", tone: "ink", mono: true, inline: true })} bg-active`;

/**
 * A sentence, with its identifiers marked.
 *
 * Renders a fragment rather than a block, so it drops into whatever the caller was already using —
 * a note row, a graph step, a tool summary — without changing that element's layout.
 */
export function Prose({
  text,
  vocabulary,
}: {
  text: string;
  /** The plan's own tool and state names, when the call site has them. */
  vocabulary?: readonly string[];
}) {
  const segments = segmentProse(text, vocabulary);
  return (
    <>
      {segments.map((s, i) =>
        s.code ? (
          <code key={i} className={CHIP_INK}>
            {s.text}
          </code>
        ) : (
          <span key={i}>{s.text}</span>
        ),
      )}
    </>
  );
}
