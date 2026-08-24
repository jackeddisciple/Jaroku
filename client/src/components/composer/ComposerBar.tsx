// Band 3 — the composer's control bar, and the only interactive band of the three.
//
// §3.1 is unusually specific about this row and every clause of it is here: a single row at all
// widths, a fixed left-to-right order, a flex spacer between the input group and the execution
// group, 44px tall, 8px gaps within a group, a top hairline, and never a second row. `layoutBar`
// in lib/composerBar.ts holds the part of that which is a rule rather than a style, so the rules
// are checked by a suite instead of by resizing a window.
//
// IT MEASURES ITSELF, NOT THE WINDOW. The breakpoints are about the box the controls have to fit
// in, and in a three-panel app that box is nothing like the viewport: a 1400px window with both
// side panels open leaves this bar around 600px, so a window-width media query would render the
// full-width layout into a space too narrow to hold it. A `ResizeObserver` on the bar's own
// element is the only measurement that answers the actual question.
//
// THE SAME COMPONENT RENDERS IN FULLSCREEN. §3.2 and §12.1e: "identical order, identical
// component". Not a second bar that looks like this one — the same instance of the same element,
// re-parented by the fullscreen dialog. A user must not have to collapse the editor to change
// effort or attach a file, and a copy would drift on the first change either half received alone.

import { useEffect, useRef, useState } from "react";
import {
  densityFor, layoutBar, overflowSlot, showsLabel, type ControlId, type Density,
} from "../../lib/composerBar.ts";
import { GLYPH, HIT_TARGET } from "../icons.ts";
import { Popover } from "./Popover.tsx";

/** What the bar needs from a control: how to draw it, in the bar and in the overflow menu. */
export interface ControlSpec {
  /** In the bar. `density` decides whether a text label renders — see §3.1's responsive collapse. */
  bar: (density: Density) => React.ReactNode;
  /**
   * In the `⋯` menu, when this control has collapsed into it.
   *
   * A separate renderer rather than the same node reparented, because a control in a menu is a
   * different shape from a control in a bar: the shield is a glyph with a word beside it in the
   * row and a full-width menu item with its current value on the right inside the popover. A
   * control that has none is simply never collapsible.
   */
  menu?: () => React.ReactNode;
}

export function ComposerBar({
  controls,
  className = "",
}: {
  /** Only the controls that EXIST right now. An absent key is a control that is not rendered, and
   *  §12.1c is the promise that its absence moves nothing else. */
  controls: Partial<Record<ControlId, ControlSpec>>;
  className?: string;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const overflowRef = useRef<HTMLButtonElement>(null);
  const [width, setWidth] = useState<number | null>(null);
  const [menuOpen, setMenuOpen] = useState(false);

  useEffect(() => {
    const el = ref.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver((entries) => {
      const w = entries[0]?.contentRect.width;
      if (typeof w === "number") setWidth(w);
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // NULL UNTIL MEASURED, AND `full` UNTIL THEN. The first paint happens before the observer has
  // fired, and starting at `overflow` would put three controls behind a `⋯` for one frame on every
  // mount — a visible flicker on the most-looked-at row in the product.
  const density: Density = width === null ? "full" : densityFor(width);
  const present = Object.keys(controls) as ControlId[];
  const layout = layoutBar(present, density);
  const slot = overflowSlot(layout);

  // The overflow menu closes when the bar widens past the breakpoint, because the trigger it is
  // anchored to has just stopped existing — a popover left open against a removed trigger floats
  // over the composer with nothing to return focus to.
  useEffect(() => {
    if (layout.overflow.length === 0) setMenuOpen(false);
  }, [layout.overflow.length]);

  const left = layout.left.map((id) => (
    <span key={id} className="contents">{controls[id]?.bar(density)}</span>
  ));

  if (slot >= 0) {
    left.splice(slot, 0, (
      <div key="__overflow" className="relative shrink-0">
        <button
          ref={overflowRef}
          type="button"
          onClick={() => setMenuOpen((v) => !v)}
          aria-label="More composer controls"
          aria-expanded={menuOpen}
          aria-haspopup="menu"
          title="Effort, permissions and connectors"
          className="inline-flex items-center justify-center rounded-control text-muted transition-colors
            duration-fast hover:bg-active hover:text-ink focus-visible:outline-none focus-visible:shadow-focusring"
          style={{ minWidth: HIT_TARGET, minHeight: HIT_TARGET, fontSize: GLYPH.toolbar }}
        >
          <span aria-hidden className="leading-none">⋯</span>
        </button>
        <Popover
          open={menuOpen}
          onClose={() => setMenuOpen(false)}
          triggerRef={overflowRef}
          label="More composer controls"
          width={260}
        >
          {layout.overflow.map((id) => (
            <div key={id} onClick={() => setMenuOpen(false)}>{controls[id]?.menu?.()}</div>
          ))}
        </Popover>
      </div>
    ));
  }

  return (
    <div
      ref={ref}
      // `flex` with a spacer, and NEVER `justify-between` — see lib/composerBar.ts's header for
      // the whole argument. `flex-nowrap` is the "bar never wraps" clause spelled in CSS: without
      // it, a control the overflow rule did not catch would silently start a second row.
      className={`flex flex-nowrap items-center gap-2 border-t border-hair pt-2 ${className}`}
      style={{ minHeight: 44 }}
    >
      {left}
      {/* The spacer. One element, absorbing the whole difference, so both groups stay packed
          against their own edge as controls come and go. */}
      <div className="min-w-2 flex-1" aria-hidden />
      {layout.right.map((id) => (
        <span key={id} className="contents">{controls[id]?.bar(density)}</span>
      ))}
    </div>
  );
}

/** Re-exported so a control can ask whether it should draw its word without importing the rules. */
export { showsLabel };
