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

import { segmentProse } from "../lib/inlineCode.ts";

/**
 * The chip. One declaration, so an identifier in a sentence and an identifier in a row can never
 * drift apart.
 *
 * 11px against 12px prose: mono's x-height runs large, and matching the nominal size makes the chip
 * look bigger than the sentence around it. `align-middle` keeps it on the prose baseline instead of
 * riding high the way an inline-block otherwise does.
 */
export const CHIP =
  "rounded bg-active px-1.5 py-[1px] font-mono text-[11px] align-middle [overflow-wrap:anywhere]";

/**
 * Colour is left out of CHIP and chosen per use, because the two uses mean different things: an
 * identifier is the thing being named and takes ink, while a connector chip is a label *about* a
 * tool and stays muted. Everything else about them — geometry, fill, type — is shared.
 */
export const CHIP_INK = `${CHIP} text-ink`;

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
