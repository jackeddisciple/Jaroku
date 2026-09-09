// A menu that hangs off a row inside a scrolling list, and the clip that swallowed it.
//
// THE BUG. `AgentRowMenu` is the only menu in the application that lives inside a scroller — every
// other one sits in chrome that never scrolls. Its panel was `position: absolute` inside the list,
// which is correct until the list gets an `overflow`: an ancestor with `overflow` other than
// `visible` CLIPS its absolutely-positioned descendants, and no amount of `z-index` climbs out of a
// clip. `z-index` orders what is painted; `overflow` decides what exists to paint.
//
// It surfaced the moment the Pinned shelf got a height cap, because a cap needs a scroller: with
// one or two agents pinned the shelf is about fifty pixels tall, so a two-hundred-pixel menu opened
// from it was cut off almost entirely and read as hiding behind Recents. The same clip was already
// latent on the bottom rows of Recents, where it took a full list to notice.
//
// SO THE PANEL LEAVES THE SIDEBAR. Rendered through a portal into `document.body`, it has no
// scrolling ancestor to be clipped by, and this positions it against its trigger by hand — which is
// the price of the portal, since leaving the list also means leaving the coordinate space.
//
// `position: fixed` WITHOUT A PORTAL WOULD NOT HAVE DONE IT. Fixed elements normally escape
// ancestor clipping, but `.sidebar-material` carries a `backdrop-filter`, and a filter makes its
// element the containing block for fixed descendants — so the panel would have been anchored and
// clipped inside the very column it was trying to escape. The portal is the version that does not
// depend on which properties the sidebar happens to be painted with today.

import { useLayoutEffect } from "react";

/** Distance from the trigger, and the closest the panel may come to the window's edge. */
const GAP = 4;
const EDGE = 8;

/**
 * Keep a portalled panel pinned to its trigger, flipping up when it would fall off the bottom.
 *
 * WRITTEN STRAIGHT TO THE NODE RATHER THAN HELD IN STATE. Position is not information anything
 * renders FROM — it is a consequence of where the trigger ended up — and putting it in state would
 * re-render the whole menu on every scroll event that moves it. This is one style write per frame.
 *
 * A LAYOUT EFFECT, because it runs before paint: the panel is rendered off-screen and placed in the
 * same frame it mounts, so there is no flash at the wrong position. It also has to be after mount
 * rather than during render, since deciding whether to flip means measuring the panel's height, and
 * a panel that has not been laid out has none.
 *
 * IT FOLLOWS RATHER THAN CLOSES ON SCROLL. Closing is the easier answer and the wrong one here: two
 * of this menu's items open a form inside the panel — a rename field, and the field that asks for
 * an agent's slug before deleting it — so a scroll that dismissed the panel would throw away what
 * somebody had typed.
 */
export function useAnchoredMenu(
  open: boolean,
  trigger: React.RefObject<HTMLElement | null>,
  panel: React.RefObject<HTMLElement | null>,
): void {
  useLayoutEffect(() => {
    if (!open) return;

    const place = (): void => {
      const t = trigger.current;
      const p = panel.current;
      if (!t || !p) return;
      const r = t.getBoundingClientRect();
      const h = p.offsetHeight;
      const w = p.offsetWidth;

      // Below by default. Above only if there is genuinely room there — a panel taller than the
      // window fits nowhere, and flipping it up would move the clipped edge from the bottom to the
      // top, where the items are.
      const below = r.bottom + GAP;
      const above = r.top - GAP - h;
      const top = below + h > window.innerHeight - EDGE && above >= EDGE ? above : below;

      // Right edges aligned, which is where an overflow control's menu belongs — then pulled back
      // inside the window, because the sidebar is narrow enough that the panel is wider than the
      // room to its left when the window is small.
      const left = Math.min(
        Math.max(EDGE, r.right - w),
        Math.max(EDGE, window.innerWidth - w - EDGE),
      );

      p.style.top = `${Math.max(EDGE, top)}px`;
      p.style.left = `${left}px`;
    };

    place();
    // CAPTURE, because the scroll that moves this panel happens on the list INSIDE the sidebar and
    // scroll events do not bubble to the document from an element. Capture is how one listener sees
    // every scroller at once rather than this hook having to be told which one it is riding on.
    document.addEventListener("scroll", place, true);
    window.addEventListener("resize", place);
    return () => {
      document.removeEventListener("scroll", place, true);
      window.removeEventListener("resize", place);
    };
  }, [open, trigger, panel]);
}
