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
  className = "",
}: {
  children: React.ReactNode;
  /** The full string, for hover. Callers that already had one keep passing it. */
  title?: string;
  /** Which edges run out. `both` is for centred text — see FADE. */
  fade?: keyof typeof FADE;
  className?: string;
}) {
  const ref = useRef<HTMLSpanElement>(null);
  const [clipped, setClipped] = useState(false);

  // Every render, because the text can change without the box changing size — a run row whose
  // agent id gets longer is the same width and a different overflow.
  useLayoutEffect(() => {
    const el = ref.current;
    if (el) setClipped(el.scrollWidth > el.clientWidth + 1);
  });

  // And on resize, because the box can change without the text changing — which is most of the
  // time in a three-column layout the user can drag.
  useEffect(() => {
    const el = ref.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(() => {
      setClipped(el.scrollWidth > el.clientWidth + 1);
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  return (
    <span
      ref={ref}
      title={title}
      // `min-w-0` is what lets this shrink at all inside a flex row; without it the element is
      // sized by its content and never overflows, so nothing ever fades.
      className={`block min-w-0 overflow-hidden whitespace-nowrap ${className}`}
      style={clipped ? { maskImage: FADE[fade], WebkitMaskImage: FADE[fade] } : undefined}
    >
      {children}
    </span>
  );
}
