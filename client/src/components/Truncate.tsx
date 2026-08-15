// Text that runs out of room, ending by fading rather than by stopping.
//
// Twenty-two places in the client clip a name, a path or a description to one line, and every one
// of them used Tailwind's `truncate`, which is `text-overflow: ellipsis`. Two problems with that
// in this app specifically.
//
// The ellipsis is a character, so it takes a character's worth of space at the exact point where
// space has run out, and it sits in the type. In a column of agent names or file paths you get a
// ragged edge of `…` marks that read as content — three dots are a real thing to see, and there
// is nothing to see. A gradient reads as "this continues", which is what is actually true.
//
// And the cut is hard. `agents/support_bot/tools/order_lo…` gives you no sense of whether one
// character was lost or forty; the fade says the string kept going without pretending to measure
// how far.
//
// The fade is applied ONLY when the text actually overflows. Masking the last 28px of every
// string would dim the end of every short label in the app, which is a worse artefact than the
// ellipsis was — so the element measures itself and wears the mask only when it is clipped.
//
// `title` is unchanged wherever a caller already had one: the full string still belongs on hover,
// and a fade is a hint that there is more, not a way of showing it.

import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { truncatePath } from "../lib/truncatePath.ts";

/**
 * 28px of fade. Short enough not to dim a whole word on a narrow chip, long enough to read as a
 * gradient rather than as a smudge at 12px type.
 */
const FADE = {
  /** The usual case: text starts at the left edge and runs out on the right. */
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
    setClipped(el.scrollWidth > el.clientWidth + 1);
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
      className={`block min-w-0 overflow-hidden whitespace-nowrap ${className}`}
      // NO MASK ON A PATH. The two treatments are alternatives, not layers: a middle-truncated
      // string already ends at a character somebody chose, and fading that end would dim the
      // extension the truncation went out of its way to keep.
      style={clipped && variant !== "path" ? { maskImage: FADE[fade], WebkitMaskImage: FADE[fade] } : undefined}
    >
      {body}
    </span>
  );
}
