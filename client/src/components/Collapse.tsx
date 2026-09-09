// A section that opens and closes at a speed the eye can follow.
//
// EVERY DISCLOSURE IN THE SIDEBAR WAS A MOUNT. `{open && <div>…}` puts the content on screen in one
// frame and takes it away in one frame, which is not a fast animation — it is no animation, and it
// is what makes a column feel like it is jumping rather than moving. Three of them did this: the
// Pinned shelf, Recents, and the run list under an agent row.
//
// WHY `grid-template-rows` AND NOT `height`. The content of all three is content-sized — a list of
// however many rows there are — and `height: auto` is not a transitionable value, which is the
// whole reason this pattern exists. A grid with ONE row can be told to take `1fr` of a track that
// is sized by its content and `0fr` of it, and both ends of that are real numbers the browser can
// interpolate. The child needs `min-height: 0` and `overflow: hidden` or it refuses to be squeezed
// below its content height and the animation plays with nothing visibly happening.
//
// `max-height` IS THE USUAL ALTERNATIVE AND IT IS WORSE. It needs a magic number bigger than the
// content ever gets; guess low and long lists are clipped, guess high and the transition spends
// most of its duration animating empty space, which reads as a lag on open and a snap on close.
//
// IT ALSO COMPOSES WITH FLEX, which Recents needs. That section is `flex-1` — it holds the slack
// that keeps the account row at the foot of the column — so its scroller has to fill a height it is
// GIVEN rather than one it asks for. A `flex-1 min-h-0` grid still resolves `1fr` against the space
// flex handed it, so the same component serves the two content-sized sections and the flexible one.

import type { ReactNode } from "react";

export function Collapse({
  open,
  className = "",
  children,
}: {
  open: boolean;
  /** Layout for the OUTER box — `flex-1 min-h-0` where the section is the flexible one. */
  className?: string;
  children: ReactNode;
}) {
  return (
    <div
      // `grid-rows-[0fr]` COLLAPSES THE TRACK, NOT THE BOX. When this is the flexible section the
      // outer element keeps the height flex gave it and the row inside goes to nothing, which is
      // correct: Recents closed should still hold the column's slack, or the account row would
      // climb up the sidebar every time somebody folded a list away.
      className={`grid transition-[grid-template-rows] duration-collapse ease-smooth motion-reduce:transition-none ${
        open ? "grid-rows-[1fr]" : "grid-rows-[0fr]"
      } ${className}`}
    >
      {/* BOTH OF THESE ARE LOAD-BEARING. `overflow-hidden` is what makes the squeeze visible;
          `min-h-0` is what allows it at all, since a grid item's automatic minimum size is its
          content and would otherwise refuse every value below it. */}
      <div className="min-h-0 overflow-hidden">{children}</div>
    </div>
  );
}
