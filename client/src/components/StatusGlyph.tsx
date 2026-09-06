// The seven phases, as geometry. One circle, seven variations, and nothing else in the product
// draws a status mark after this.
//
// THEY ARE SIBLINGS, NOT SEVEN UNRELATED MARKS, and that is the whole reason the ramp is readable
// at a glance down a column. Every one of them is the same circle at the same radius on the same
// 24-unit grid the rest of the app's marks are drawn on — Lucide's own `r=10`, which is thirteen
// pixels across at the 16px size a dense row uses — so a list of forty rows has its glyphs on one
// optical axis whatever states happen to be in it. A mark drawn on its own grid would sit a
// different weight from the icons two panels over, which is the failure the icon-system release
// spent a whole generator preventing.
//
// EVERY PAIR SURVIVES GREYSCALE, which is the claim `test:status-glyph` exists to prove and the
// reason none of these seven is "a dot in a different colour":
//
//   pending   dashed ring          exists, has not begun
//   ready     hollow ring          begun, nothing happening now
//   active    faint ring + arc     work is happening right now
//   waiting   ring + centre dot    halted, needs a human
//   done      filled + check       finished, succeeded
//   failed    ring + cross         finished, did not succeed
//   halted    filled + bar         stopped deliberately, not a failure
//
// THE TWO FILLED MARKS KNOCK THEIR SYMBOL OUT rather than drawing it on top, and that is a
// deliberate piece of geometry rather than a flourish. A check stroked over a filled disc in the
// same colour is invisible, and a check stroked in a surface colour would be wrong on every surface
// but the one it was picked for — this app draws glyphs on the canvas, on a card, on a sidebar row
// and inside a popover, four different greys. An even-odd fill leaves the symbol transparent, so it
// shows whatever is actually behind it, on every one of them, with no id, no mask and no `useId`
// collision in a list of forty.
//
// THE ACTIVE ARC DOES NOT SPIN. Forty running rows with forty spinners is a seizure risk and a
// paint-cost problem, so the motion is `stream-pulse` — this app's own idiom for "in flight", the
// one `ThreadGlyph` and `StatusDot` already use — and it drops entirely under `prefers-reduced-
// motion`. Tailwind's own `animate-pulse` is a different curve and is the one somebody reaches for
// without knowing this app has its own.
//
//   npm run test:status-glyph
//   npm run test:status-amber

import { PHASE_COLOUR, PHASE_WORD, type Phase } from "../lib/statusPhase.ts";
import { ICON } from "../lib/tokens.ts";
import { svg } from "./panelIcons.tsx";

/**
 * The base circle's centreline radius, on the shared 24-unit grid.
 *
 * `10` IS LUCIDE'S OWN, which is what makes a phase ring the same size as every circular mark
 * already in the app — the loader, the cancel, the plus-in-a-circle. Twenty units across at a 16px
 * render is thirteen pixels, which is the size §2.1 asks for.
 */
const R = 10;

/** The filled variants' radius: the ring's centreline plus half its stroke, so both read the same
 * size. A filled disc at `R` alone is visibly smaller than a ring stroked around `R`, and the two
 * sitting in one column is exactly the kind of one-pixel difference nobody can name and everybody
 * sees. */
const R_FILLED = R + ICON.strokeWidth / 2;

/** The disc, as a path, so an even-odd fill can subtract a symbol from it. */
const DISC = `M12 ${12 - R_FILLED}a${R_FILLED} ${R_FILLED} 0 1 0 0 ${R_FILLED * 2}a${R_FILLED} ${R_FILLED} 0 1 0 0-${R_FILLED * 2}Z`;

/**
 * The check, as a closed outline rather than as a stroked polyline.
 *
 * A stroke cannot be subtracted from a fill, so the tick is spelled out as the seven-point polygon
 * a 2.4-unit stroke with mitred joins would have produced. The numbers are the offsets of that
 * stroke's two sides; they are written out because deriving them at render time would be arithmetic
 * in a hot list to reproduce a constant.
 */
const CHECK = "M6.35 13.05L10.4 17.1L17.65 9.85L15.95 8.15L10.4 13.7L8.05 11.35Z";

/** The bar, same idea. Horizontal, because `halted` is the sibling of `cancelled`'s dash and a
 * vertical pair would read as a pause button — which is a CONTROL, and this is a state. */
const BAR = "M6.6 10.85H17.4V13.15H6.6Z";

/**
 * The two registers §2.3 gives this mark, and there is no third.
 *
 * A LADDER OF ITS OWN, off `ICON` where it can be, for the same reason `BRAND` is one: this glyph
 * appears in exactly two places — a dense row and a card — and the card step is 20, which is not on
 * the icon ladder because the icon ladder tops out at a standalone control. Naming the two is what
 * stops a call site writing `size={20}` beside another writing `size={18}` because it looked right
 * on the card it was being written against.
 */
export const GLYPH_SIZE = {
  /** In a list. The whole value of the mark is scanning one column down forty of them. */
  row: ICON.md,
  /** On a card, where the row's 16 reads as an afterthought beside a title. */
  card: 20,
} as const;

export function StatusGlyph({
  phase,
  size = ICON.md,
  title,
  className = "",
}: {
  phase: Phase;
  /** 16 in dense rows, 20 on cards. §2.3. */
  size?: number;
  /**
   * A better sentence than the phase's own word, for a surface that has one — "unreachable" rather
   * than "failed" on an MCP card, where the difference needs a sentence and not a shape.
   */
  title?: string;
  className?: string;
}) {
  const word = title ?? PHASE_WORD[phase];
  // THE LABEL GOES ON THE WRAPPER, NOT ON THE SVG. An SVG element has no `title` attribute, and the
  // `<title>` CHILD that would give it one is not read on an aria-hidden node — the same reasoning
  // `ThreadGlyph` records. The span is what hover finds anyway.
  return (
    <span
      title={word}
      aria-label={word}
      role="img"
      className={`inline-flex shrink-0 items-center ${className}`}
      style={{ color: PHASE_COLOUR[phase] }}
    >
      {draw(phase, size)}
    </span>
  );
}

function draw(phase: Phase, size: number) {
  switch (phase) {
    case "pending":
      // A DASHED RING MEANS "NOT BEGUN" IN EVERY TAB or the vocabulary is worthless. The dash
      // period divides the circumference twelve ways, so the gaps land evenly rather than leaving
      // one long dash where the path closes.
      return svg({ size }, <circle cx="12" cy="12" r={R} strokeDasharray="2.618 2.618" />);
    case "ready":
      return svg({ size }, <circle cx="12" cy="12" r={R} />);
    case "active":
      // THE RING RECEDES AND THE ARC DOES NOT, which is what makes this readable with the colour
      // stripped. Opacity is a greyscale difference as much as a colour one, so the quarter reads
      // as the dark part of a progress ring rather than as "the amber one".
      return svg(
        { size },
        <>
          <circle cx="12" cy="12" r={R} opacity="0.3" />
          <path
            d={`M12 ${12 - R}A${R} ${R} 0 0 1 22 12`}
            className="animate-stream-pulse motion-reduce:animate-none"
          />
        </>,
      );
    case "waiting":
      return svg(
        { size },
        <>
          <circle cx="12" cy="12" r={R} />
          <circle cx="12" cy="12" r="2.6" fill="currentColor" />
        </>,
      );
    case "done":
      return svg(
        { size },
        <path fill="currentColor" stroke="none" fillRule="evenodd" d={`${DISC}${CHECK}`} />,
      );
    case "failed":
      return svg(
        { size },
        <>
          <circle cx="12" cy="12" r={R} />
          <path d="M8.5 8.5 15.5 15.5M15.5 8.5 8.5 15.5" />
        </>,
      );
    case "halted":
      return svg(
        { size },
        <path fill="currentColor" stroke="none" fillRule="evenodd" d={`${DISC}${BAR}`} />,
      );
  }
}
