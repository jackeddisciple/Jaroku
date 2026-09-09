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
 * What counts as an item to move between.
 *
 * ALL THREE VARIANTS, not just `menuitem`. A menu that picks one of several — the agent filter —
 * is `menuitemradio`, and a menu of toggles would be `menuitemcheckbox`; both are items a person
 * arrows through, and a selector that named only the plain one would silently skip a whole menu.
 */
const MENU_ITEM = '[role="menuitem"], [role="menuitemradio"], [role="menuitemcheckbox"]';

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
      const first = root.querySelector<HTMLElement>(MENU_ITEM);
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

  // ── Arrow keys ────────────────────────────────────────────────────────────────────────────────
  // A ROVING FOCUS, NOT A SELECTION MODEL. `role="menu"` tells assistive technology these items are
  // a menu, and a menu is expected to move on Up/Down — Tab alone satisfies "reachable" and not
  // "behaves like what it says it is". There is no `aria-activedescendant` and no virtual cursor:
  // focus itself is the position, which is what makes Enter and Space work with no extra handling.
  //
  // IT WRAPS. Down from the last item goes to the first, because a menu is a ring rather than a
  // list — six items and a dead end at the bottom is the shape people press past by accident.
  //
  // ONLY WHILE OPEN, and only for keys a menu owns. Everything else — Tab, Escape, a character —
  // falls through untouched: Escape is already handled by each menu's own listener, and swallowing
  // Tab here would trap focus in a panel that is not modal.
  useEffect(() => {
    const root = container.current;
    if (!open || !root) return;

    const onKey = (e: KeyboardEvent): void => {
      const keys = ["ArrowDown", "ArrowUp", "Home", "End"];
      if (!keys.includes(e.key)) return;
      const items = [...root.querySelectorAll<HTMLElement>(MENU_ITEM)].filter(
        // A disabled item is skipped rather than focused-and-inert, which is the difference between
        // a menu that feels responsive and one that appears to swallow a keypress.
        (el) => !el.hasAttribute("disabled") && el.getAttribute("aria-disabled") !== "true",
      );
      if (items.length === 0) return;
      // Only when the keyboard is actually IN the menu. Otherwise Up/Down belong to whatever the
      // person is really focused on — a menu left open behind a focused list must not eat its keys.
      const active = document.activeElement;
      if (!(active instanceof HTMLElement) || !root.contains(active)) return;

      e.preventDefault();
      const at = items.indexOf(active);
      const next =
        e.key === "Home" ? 0
        : e.key === "End" ? items.length - 1
        // `at < 0` is focus on the panel rather than an item — the first Down should land on the
        // first item, not the second.
        : e.key === "ArrowDown" ? (at < 0 ? 0 : (at + 1) % items.length)
        : (at <= 0 ? items.length - 1 : at - 1);
      items[next]?.focus({ preventScroll: true });
    };

    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open, container]);
}
