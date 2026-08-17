// §3.3's five glyphs, as geometry — the one place they are drawn.
//
// ONE IMPLEMENTATION FOR TWO SURFACES, and that is §2.1's requirement rather than tidiness: the nav
// badge "reuses the same amber ◆ glyph and colour as the row-level status glyph, so a person who has
// learned the row vocabulary already knows what the nav badge means without learning a second one".
// Two hand-drawn diamonds would be two vocabularies the day one of them was nudged.
//
// THEY ARE DRAWN, NOT TYPED. The obvious way to get ◆ ● ✕ ○ ⊘ is the characters themselves. The
// sidebar already learned why that is wrong: a font character sits on the text baseline at whatever
// weight the row happens to be, and never optically matches the icons two panels over.
//
// FOUR COLOURS, AND NOT ONE MORE. Amber is running-or-attention, red is failure, and dim is "nothing
// outstanding" — which is the absence of a colour rather than a fifth one. Green appears nowhere: a
// thread that finished cleanly is not a success to be congratulated, it is a session with nothing
// waiting in it, and colouring it would make the amber rows compete with something.

import { STATUS } from "../lib/tokens.ts";
import type { ThreadStatus } from "../types.ts";

/** The dim the two quiet glyphs share. Not a fifth colour — the absence of one. */
const DIM = "#52525b";

/**
 * One glyph, at a fixed box.
 *
 * `viewBox` and box size are identical for all five, so a column of rows has its glyphs on one optical
 * axis regardless of which states happen to be in it — which is what makes the shapes scannable without
 * the section headings being read at all.
 */
export function ThreadGlyph({ status }: { status: ThreadStatus }) {
  const common = { width: 12, height: 12, viewBox: "0 0 12 12", "aria-hidden": true } as const;
  // The tooltip goes on a wrapper rather than on the `<svg>`: an SVG element has no `title`
  // attribute, and the `<title>` CHILD that would give it one is not read by a screen reader on an
  // aria-hidden node — so the label belongs on the span, which is the thing hover finds anyway.
  const label: Record<ThreadStatus, string> = {
    needs_you: "needs you",
    running: "running",
    errored: "errored",
    idle: "idle",
    archived: "archived",
  };
  return (
    <span className="inline-flex" title={label[status]} aria-label={label[status]} role="img">
      {glyph(status, common)}
    </span>
  );
}

function glyph(status: ThreadStatus, common: { width: number; height: number; viewBox: string; "aria-hidden": true }) {
  switch (status) {
    case "needs_you":
      // ◆ — a diamond, filled. The only shape here with corners, which is what makes it findable
      // in a column of circles without needing its colour to be read first.
      return (
        <svg {...common}>
          <path d="M6 1.2 10.8 6 6 10.8 1.2 6Z" fill={STATUS.pending} />
        </svg>
      );
    case "running":
      // ● — filled, and pulsing, because something is changing right now. That animation means
      // exactly one thing everywhere in this app, and this is one of them.
      return (
        <svg {...common} className="animate-stream-pulse motion-reduce:animate-none">
          <circle cx="6" cy="6" r="4" fill={STATUS.pending} />
        </svg>
      );
    case "errored":
      // ✕ — the one red thing on the row.
      return (
        <svg {...common}>
          <path
            d="M2.6 2.6 9.4 9.4M9.4 2.6 2.6 9.4"
            stroke={STATUS.error}
            strokeWidth="1.6"
            strokeLinecap="round"
          />
        </svg>
      );
    case "archived":
      // ⊘ — a circle with a line through it. Dim, like idle: an archived thread is not a warning.
      return (
        <svg {...common}>
          <circle cx="6" cy="6" r="4" fill="none" stroke={DIM} strokeWidth="1.3" />
          <path d="M3.2 8.8 8.8 3.2" stroke={DIM} strokeWidth="1.3" strokeLinecap="round" />
        </svg>
      );
    case "idle":
      // ○ — hollow. Nothing outstanding, and nothing to say about it.
      return (
        <svg {...common}>
          <circle cx="6" cy="6" r="3.6" fill="none" stroke={DIM} strokeWidth="1.3" />
        </svg>
      );
  }
}
