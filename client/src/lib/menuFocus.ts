// Where the keyboard goes when a menu opens, and where it comes back to when one closes.
//
// THE BUG THIS EXISTS FOR IS INVISIBLE WITH A MOUSE, which is why all three sidebar menus had it.
// Each one renders as `{open && <div role="menu">…}` placed BEFORE its trigger in the markup —
// which is correct for the account menu, whose panel opens upward and therefore belongs above the
// button visually. But the tab order is the DOM order, not the visual one: a person who opens the
// menu from the keyboard and presses Tab moves to whatever follows the TRIGGER, stepping straight
// over every item they just opened. The items were reachable only by Shift+Tab, backwards, which
// nobody does on purpose.
//
// AND CLOSING WAS THE OTHER HALF. Escape unmounted the panel while focus was inside it, so focus
// fell to `<body>` — the next Tab restarts from the top of the document, and a screen reader
// announces nothing at all. Both are the same omission: a menu is a place, and something has to say
// where you are when it opens and where you return to when it shuts.
//
// A HOOK RATHER THAN A `<Menu>` COMPONENT, deliberately. The three menus differ in what they
// contain, where they anchor and how wide they are; what they share is exactly this behaviour, and
// wrapping them in a component to unify it would have meant a props object describing all three
// layouts. This is the part that was actually duplicated — which was zero times, because none of
// them had it.

import { useEffect, useRef } from "react";

/**
 * Move focus into a menu when it opens, and back to its trigger when it closes.
 *
 * `container` must wrap BOTH the menu and its trigger — which the three call sites already do,
 * because that is the element their click-away listener measures against.
 *
 * THE TRIGGER IS FOUND BY `aria-haspopup`, not passed in as a second ref. Every one of these menus
 * already marks its trigger that way for assistive technology; reusing that is one source of truth
 * rather than a ref that can silently drift onto the wrong element.
 *
 * FOCUS IS RESTORED ONLY IF IT IS STILL INSIDE THE MENU. Closing by clicking somewhere else should
 * leave focus where the person put it — yanking it back to the trigger would fight them. It is only
 * when the thing they were focused on is being unmounted that focus has nowhere to go and this has
 * to answer for it.
 */
export function useMenuFocus(open: boolean, container: React.RefObject<HTMLElement | null>): void {
  const wasOpen = useRef(false);

  useEffect(() => {
    const root = container.current;
    if (!root) return;

    if (open && !wasOpen.current) {
      // Opening. The first item, because a menu opened from the keyboard should land on something
      // actionable rather than on the panel itself.
      const first = root.querySelector<HTMLElement>('[role="menuitem"]');
      // `preventScroll` because these panels are inside a scrolling column, and focusing an item
      // near its bottom edge would otherwise jump the whole sidebar.
      first?.focus({ preventScroll: true });
    } else if (!open && wasOpen.current) {
      // Closing. Only rescue focus if it is about to be destroyed with the panel — see above.
      const active = document.activeElement;
      if (active instanceof HTMLElement && root.contains(active)) {
        root.querySelector<HTMLElement>('[aria-haspopup="menu"]')?.focus({ preventScroll: true });
      }
    }
    wasOpen.current = open;
  }, [open, container]);
}
