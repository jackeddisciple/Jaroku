// Drag, with one destination and no library.
//
// §4.1: "Drag has exactly one destination: the snooze tray. Cross-column drag is disabled. If a user
// starts dragging toward another column, dim the columns so it reads instantly as not-a-lane." And,
// in as many words: "DO NOT ADD A DRAG-AND-DROP LIBRARY FOR THIS. One drag target does not justify
// the dependency. A pointer-event handler is enough."
//
// This is that handler, and it is about a hundred lines because the hard part of drag-and-drop is
// everything a library gives you for the general case — reordering, sortable lists, collision
// detection between many targets, keyboard equivalents, virtual scrolling. None of that applies to
// one target that does not reorder anything.
//
// THE THREE THINGS IT ACTUALLY HAS TO GET RIGHT:
//
//   A DRAG MUST NOT SWALLOW A CLICK. Cards expand on click and their controls are buttons; a handler
//   that treated every pointerdown as a drag would make the board unusable with a mouse. So nothing
//   happens until the pointer has moved past a threshold, and a release before that is left alone
//   for the ordinary click handler to see.
//
//   POINTER CAPTURE, NOT DOCUMENT LISTENERS. `setPointerCapture` keeps the move and up events coming
//   to the same element even when the pointer leaves it — which it always does, because the tray is
//   at the bottom of the screen and the card is not. Document listeners would work and would also
//   need tearing down on unmount, on re-render, and on the card resolving out from under the drag.
//
//   IT ENDS WHEREVER THE POINTER IS, INCLUDING NOWHERE. A drag released over the board is a drag
//   somebody changed their mind about, and it does nothing at all — no snap-back animation, because
//   nothing moved: the card never left its column.
//
// THE KEYBOARD IS NOT A FALLBACK FOR THIS, it is the primary path. §5.5's `S` then 1/2/3 snoozes
// without a mouse, and it is a better interaction than dragging is. The drag exists because a
// pointer user reaches for it, not because it is how the feature is meant to be used.

import { useCallback, useRef, useState } from "react";

/** How far a pointer has to move before this is a drag rather than a click. */
export const DRAG_THRESHOLD_PX = 6;

export interface InboxDragState {
  /** The item being dragged, or null. Anything reading this to dim the board reads only this. */
  itemId: string | null;
  /** Where the pointer is, so the card can follow it. */
  x: number;
  y: number;
  /** True while the pointer is over the tray, so it can say it will take the drop. */
  overTray: boolean;
}

const IDLE: InboxDragState = { itemId: null, x: 0, y: 0, overTray: false };

export interface InboxDragHandlers {
  state: InboxDragState;
  /** Put on each card. Returns the props rather than taking a ref, so a card stays a plain div. */
  cardProps: (itemId: string) => {
    onPointerDown: (e: React.PointerEvent<HTMLElement>) => void;
    onPointerMove: (e: React.PointerEvent<HTMLElement>) => void;
    onPointerUp: (e: React.PointerEvent<HTMLElement>) => void;
    onPointerCancel: (e: React.PointerEvent<HTMLElement>) => void;
  };
  /** Put on the tray, so the hook can tell when the pointer is over it. */
  trayRef: (el: HTMLElement | null) => void;
}

export function useInboxDrag(onDropInTray: (itemId: string) => void): InboxDragHandlers {
  const [state, setState] = useState<InboxDragState>(IDLE);
  const tray = useRef<HTMLElement | null>(null);
  /**
   * Where the pointer went down, and whether the threshold has been passed.
   *
   * A REF RATHER THAN STATE, because it changes on every pointermove and none of those changes is
   * something to re-render for — the render only cares once a drag has actually started.
   */
  const origin = useRef<{ id: string; x: number; y: number; dragging: boolean } | null>(null);

  const overTray = (x: number, y: number): boolean => {
    const el = tray.current;
    if (!el) return false;
    const r = el.getBoundingClientRect();
    return x >= r.left && x <= r.right && y >= r.top && y <= r.bottom;
  };

  const trayRef = useCallback((el: HTMLElement | null) => {
    tray.current = el;
  }, []);

  const cardProps = useCallback(
    (itemId: string) => ({
      onPointerDown: (e: React.PointerEvent<HTMLElement>) => {
        // LEFT BUTTON, AND NOT ON A CONTROL. A drag started from the dismiss button would be a drag
        // that also dismissed, and a right-click is a context menu somebody asked for.
        if (e.button !== 0) return;
        if ((e.target as HTMLElement).closest("button,input,a")) return;
        origin.current = { id: itemId, x: e.clientX, y: e.clientY, dragging: false };
      },
      onPointerMove: (e: React.PointerEvent<HTMLElement>) => {
        const start = origin.current;
        if (!start || start.id !== itemId) return;
        const moved = Math.hypot(e.clientX - start.x, e.clientY - start.y);
        if (!start.dragging) {
          if (moved < DRAG_THRESHOLD_PX) return;
          start.dragging = true;
          // From here the pointer belongs to this element wherever it goes — including over the
          // tray, which is not a descendant of it.
          e.currentTarget.setPointerCapture(e.pointerId);
        }
        setState({
          itemId,
          x: e.clientX,
          y: e.clientY,
          overTray: overTray(e.clientX, e.clientY),
        });
      },
      onPointerUp: (e: React.PointerEvent<HTMLElement>) => {
        const start = origin.current;
        origin.current = null;
        // NOT A DRAG: leave the event entirely alone so the card's own click handler sees it and
        // expands. This is the branch that keeps the board usable with a mouse.
        if (!start || !start.dragging) return;
        if (e.currentTarget.hasPointerCapture(e.pointerId)) e.currentTarget.releasePointerCapture(e.pointerId);
        const dropped = overTray(e.clientX, e.clientY);
        setState(IDLE);
        // A DRAG RELEASED OVER THE BOARD DOES NOTHING AT ALL, and there is no snap-back to animate
        // because nothing moved — the card never left its column. Cross-column drag is not disabled
        // by refusing a drop somewhere; it is disabled by there being nowhere else to drop.
        if (dropped) onDropInTray(start.id);
        // The click that would otherwise follow a drag is suppressed by the pointer capture, which
        // is one more thing not to have to remember.
      },
      onPointerCancel: (e: React.PointerEvent<HTMLElement>) => {
        origin.current = null;
        if (e.currentTarget.hasPointerCapture(e.pointerId)) e.currentTarget.releasePointerCapture(e.pointerId);
        setState(IDLE);
      },
    }),
    [onDropInTray],
  );

  return { state, cardProps, trayRef };
}
