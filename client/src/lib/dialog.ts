// WHAT MAKES AN OVERLAY A DIALOG, as opposed to a div drawn on top of the application.
//
// The workspace panel had the look and none of the semantics. It dims the application behind it,
// which is a claim — this is the screen now, the rest is unavailable — and to anything that is not
// a pair of eyes it was an ordinary `<div>`. `role="dialog"` on the page: 0. `aria-modal`: 0. Focus
// stayed on the switcher button that opened it. Fifteen consecutive Tab presses walked out of the
// panel and into the greyed-out sidebar behind it — Threads, Agents, Inbox, Activity, Provider
// keys, Search agents, New agent, an agent row, its rename button — with the panel open the whole
// time and nothing marking the boundary between the two. `document.body` was never scroll-locked.
//
// A KEYBOARD USER OPENING WORKSPACE SETTINGS WAS PLACED NOWHERE, was not told a dialog had opened,
// and on the first Tab was silently returned to an application that looks unavailable. The panel
// that owns "delete this workspace permanently" is the one this happened on.
//
// FOUR THINGS, AND THEY ARE NOT SEPARABLE. Announce it, put focus in it, keep focus in it, give
// focus back on the way out. Three of the four with the fourth missing is still a trap somebody
// falls out of, which is why this is one hook rather than four things to remember at each overlay.
//
// CONTAINMENT IS ENFORCED TWICE, deliberately. The `Tab` handler wraps the cycle, which is what
// makes the order feel right; the `focusin` guard is what makes the containment TRUE, because focus
// also moves by click, by programmatic call and by the browser's own address-bar round trip, and a
// keydown handler sees none of those. The guard stands aside for a nested dialog, so an overlay
// opened FROM this one keeps the focus it just took.
//
// ESCAPE IS NOT HERE. Every overlay in this client already closes on Escape and on an outside
// click, and both were verified working; adding a second Escape listener would mean two closers per
// dialog and a nested pair closing both at once.
//
//   npm run test:dialog

import { useEffect, useRef, type RefObject } from "react";

/**
 * Everything a Tab can land on, in document order.
 *
 * `[tabindex="-1"]` is excluded because that is what it means, and the dialog container itself
 * carries one: it is a focus TARGET for the "nothing else to focus" case and never a stop in the
 * cycle.
 */
export const FOCUSABLE_SELECTOR = [
  "a[href]",
  "button:not([disabled])",
  "input:not([disabled])",
  "select:not([disabled])",
  "textarea:not([disabled])",
  '[tabindex]:not([tabindex="-1"])',
].join(",");

/**
 * Where Tab goes next inside a closed cycle.
 *
 * PURE, AND SEPARATE FROM THE DOM, because the wrap is the half that is written wrong. The two
 * natural mistakes — forgetting that Shift+Tab from the first element wraps to the LAST, and
 * letting the modulus produce -1 — both leave a trap that holds in one direction and leaks in the
 * other, which is worse than no trap at all: it passes every check somebody does by hand, because
 * the direction people test is forwards.
 *
 * `current` of -1 means focus is not on any of them — it is on the container, or it has escaped —
 * and both directions then enter at the near end.
 */
export function nextFocusIndex(current: number, count: number, backwards: boolean): number {
  if (count <= 0) return -1;
  if (current < 0) return backwards ? count - 1 : 0;
  return backwards ? (current - 1 + count) % count : (current + 1) % count;
}

/**
 * How many dialogs are currently holding the body's scroll.
 *
 * A COUNT RATHER THAN A BOOLEAN, because overlays nest: a grant dialog opened from the workspace
 * panel and then closed must not hand scrolling back to a page that is still behind an open modal.
 */
let scrollLocks = 0;

function lockScroll(): () => void {
  const body = typeof document === "undefined" ? null : document.body;
  if (!body) return () => {};
  if (scrollLocks === 0) body.dataset.jarokuScroll = body.style.overflow;
  scrollLocks++;
  body.style.overflow = "hidden";
  return () => {
    scrollLocks = Math.max(0, scrollLocks - 1);
    if (scrollLocks === 0) {
      body.style.overflow = body.dataset.jarokuScroll ?? "";
      delete body.dataset.jarokuScroll;
    }
  };
}

/** The props a dialog's own container must carry for it to BE one. */
export interface DialogProps {
  role: "dialog";
  "aria-modal": true;
  "aria-labelledby": string;
  /** So the container is a focus target when it holds nothing focusable of its own. */
  tabIndex: -1;
}

/**
 * Make an overlay a dialog: announced, entered, contained, and given back.
 *
 * `open` drives the whole lifecycle, so a caller that returns null while closed still gets its
 * focus restored — the hook has to be called unconditionally, above any early return, or its own
 * cleanup is what goes missing.
 *
 * `labelId` is the id of the element that NAMES this dialog. A dialog whose accessible name is
 * "dialog" tells a screen-reader user that something opened and nothing about what.
 */
export function useDialog(
  open: boolean,
  labelId: string,
): { ref: RefObject<HTMLDivElement | null>; dialogProps: DialogProps } {
  const ref = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!open) return;
    const container = ref.current;
    if (!container || typeof document === "undefined") return;

    // WHO OPENED IT, so the same control gets the focus back. Without this the keyboard lands at
    // the top of the document on close, which is a worse place than where it started.
    const opener = document.activeElement as HTMLElement | null;

    const focusable = (): HTMLElement[] =>
      Array.from(container.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR))
        .filter((el) => el.offsetParent !== null || el === document.activeElement);

    // INTO THE PANEL, on open. The first focusable thing in it, or the panel itself when it has
    // none — never left on the trigger, which is what "focus is not moved into the panel" was.
    const first = focusable()[0];
    (first ?? container).focus({ preventScroll: true });

    const onKeyDown = (e: KeyboardEvent): void => {
      if (e.key !== "Tab") return;
      const items = focusable();
      if (items.length === 0) {
        e.preventDefault();
        container.focus({ preventScroll: true });
        return;
      }
      const at = items.indexOf(document.activeElement as HTMLElement);
      const next = nextFocusIndex(at, items.length, e.shiftKey);
      // Only intercept at the ends of the cycle. Inside it the browser's own order is the right
      // one, and taking every Tab would break anything with its own arrow/tab handling.
      const wrapping = at < 0 || (e.shiftKey ? at === 0 : at === items.length - 1);
      if (!wrapping) return;
      e.preventDefault();
      items[next]?.focus({ preventScroll: true });
    };

    // AND THE HALF THAT MAKES IT TRUE. A keydown handler never sees a click, a programmatic
    // `.focus()`, or focus returning from the browser's own chrome.
    const onFocusIn = (e: FocusEvent): void => {
      const target = e.target as HTMLElement | null;
      if (!target || container.contains(target)) return;
      // A dialog opened FROM this one is allowed to hold what it just took.
      if (target.closest?.('[role="dialog"]')) return;
      (focusable()[0] ?? container).focus({ preventScroll: true });
    };

    container.addEventListener("keydown", onKeyDown);
    document.addEventListener("focusin", onFocusIn);
    const unlock = lockScroll();

    return () => {
      container.removeEventListener("keydown", onKeyDown);
      document.removeEventListener("focusin", onFocusIn);
      unlock();
      // BACK TO WHOEVER OPENED IT, and only if it is still on the page — a dialog that removed its
      // own trigger (a row it deleted) must not throw on the way out.
      if (opener && document.contains(opener)) opener.focus({ preventScroll: true });
    };
  }, [open]);

  return {
    ref,
    dialogProps: { role: "dialog", "aria-modal": true, "aria-labelledby": labelId, tabIndex: -1 },
  };
}
