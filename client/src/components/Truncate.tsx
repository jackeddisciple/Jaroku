// Text that runs out of room.
//
// THREE TREATMENTS, CHOSEN BY WHAT THE TEXT IS.
//
//   prose  an ellipsis at the end. A name, a description, a title.
//   path   middle truncation, keeping the filename and its extension whole (lib/truncatePath.ts).
//   both   a gradient at both edges, for centred text, where neither end is "the end".
//
// PROSE USED TO FADE, AND THAT WAS THE MISTAKE. The argument was that a `…` takes a character's
// worth of space at the exact point where space has run out, and that a gradient reads as "this
// continues" — which is true in isolation. What it misses is that a fade is AMBIGUOUS with the
// other thing this app does constantly: dimming. `text-faint`, `opacity-60` on an archived row,
// `disabled:opacity-40`. So a faded tail reads as "this is de-emphasised" as readily as "this
// keeps going", and the sidebar rendered `an agent that take` with no mark at all to say that a
// word had been cut. An ellipsis is unambiguous, and it is unambiguous in one glyph.
//
// The mask survives for `both`, which is the one case an ellipsis genuinely cannot serve: centred
// text overflows at BOTH ends, and `text-overflow` only ever marks one of them.
//
// `title` is unchanged wherever a caller already had one: the full string still belongs on hover.

import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { truncatePath } from "../lib/truncatePath.ts";

/**
 * 28px of fade. Short enough not to dim a whole word on a narrow chip, long enough to read as a
 * gradient rather than as a smudge at 12px type.
 */
const FADE = {
  /** Kept so `fade="right"` call sites still type-check; prose now ends in an ellipsis instead. */
  right: "linear-gradient(to right, #000 calc(100% - 28px), transparent 100%)",
  /**
   * Centred text. `text-align: center` centres the line box, so an over-long string overflows
   * BOTH sides and a right-only mask would fade one end while hard-cutting the other. The graph's
   * node labels are the only place this comes up, and there it is the whole label.
   */
  both:
    "linear-gradient(to right, transparent 0, #000 28px, #000 calc(100% - 28px), transparent 100%)",
} as const;

export function Truncate({
  children,
  title,
  fade = "right",
  variant = "prose",
  className = "",
}: {
  children: React.ReactNode;
  /** The full string, for hover. Callers that already had one keep passing it. */
  title?: string;
  /** Which edges run out. `both` is for centred text — see FADE. */
  fade?: keyof typeof FADE;
  /**
   * `prose` fades at the right edge. `path` truncates from the MIDDLE, keeping the filename and
   * its extension whole — see lib/truncatePath.ts for the four tiers and why a path is not prose.
   *
   * A VARIANT RATHER THAN A SEPARATE COMPONENT, because everything else about the two is identical:
   * the measuring, the resize observer, the `min-w-0` that makes shrinking possible at all, and the
   * `title` carrying the full string on hover. A second component would be a second copy of the
   * measuring, and the copy would be the one that stops matching.
   */
  variant?: "prose" | "path";
  className?: string;
}) {
  const ref = useRef<HTMLSpanElement>(null);
  const [clipped, setClipped] = useState(false);
  /**
   * How many characters fit, for the path variant.
   *
   * MEASURED FROM THE ELEMENT'S OWN TEXT rather than from a font metric: the full string is
   * rendered once, its `scrollWidth` and `clientWidth` are compared, and the ratio gives a
   * character budget. That is exact in the mono face every path in this app is set in, and close
   * enough in the proportional one — and it needs no font loaded, no canvas, and no table of
   * glyph widths that would go stale the day the typeface changes.
   *
   * Zero means "not measured yet", which `truncatePath` reads as "change nothing" — so the first
   * frame renders the full string rather than flashing an ellipsis onto a path that fits.
   */
  const [budget, setBudget] = useState(0);

  const measure = (el: HTMLSpanElement, text: string): void => {
    // Only `both` needs to know whether it is clipped — prose marks itself with an ellipsis and a
    // path marks itself by being cut in the middle, so neither has anything to switch on.
    if (fade === "both") setClipped(el.scrollWidth > el.clientWidth + 1);
    if (variant !== "path" || !text) return;
    // Against the FULL string, which is why `title` is the source rather than the rendered child:
    // measuring an already-truncated element would shrink the budget on every pass until nothing
    // was left of the name.
    const perChar = el.scrollWidth / Math.max(1, el.textContent?.length ?? 1);
    setBudget(perChar > 0 ? Math.floor(el.clientWidth / perChar) : 0);
  };

  // Every render, because the text can change without the box changing size — a run row whose
  // agent id gets longer is the same width and a different overflow.
  useLayoutEffect(() => {
    const el = ref.current;
    if (el) measure(el, typeof children === "string" ? children : (title ?? ""));
  });

  // And on resize, because the box can change without the text changing — which is most of the
  // time in a three-column layout the user can drag.
  useEffect(() => {
    const el = ref.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(() => {
      measure(el, typeof children === "string" ? children : (title ?? ""));
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, [children, title, variant]);

  // The path variant needs a STRING to cut. A caller passing elements gets the prose behaviour,
  // which is the right fallback: fading a composed row is wrong-looking, and silently rendering
  // `[object Object]` through a truncator would be worse.
  const source = typeof children === "string" ? children : null;
  const body =
    variant === "path" && source ? truncatePath(source, budget) : children;

  return (
    <span
      ref={ref}
      // The full path on hover, always, for the variant whose whole job is to remove some of it.
      // §A.3 is explicit that the tooltip carries the disambiguating context a tier-3 truncation
      // gave up.
      title={title ?? (variant === "path" && source ? source : undefined)}
      // `min-w-0` is what lets this shrink at all inside a flex row; without it the element is
      // sized by its content and never overflows, so nothing ever fades.
      // `text-ellipsis` for prose, and nothing for a path — the two treatments are alternatives,
      // not layers: a middle-truncated string already ends at a character somebody chose, and
      // marking that end again would claim a second cut that is not there.
      className={`block min-w-0 overflow-hidden whitespace-nowrap ${
        variant === "path" || fade === "both" ? "" : "text-ellipsis"
      } ${className}`}
      style={clipped && fade === "both" ? { maskImage: FADE.both, WebkitMaskImage: FADE.both } : undefined}
    >
      {body}
    </span>
  );
}
