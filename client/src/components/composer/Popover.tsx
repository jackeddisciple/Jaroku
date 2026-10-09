// The popover every composer control opens.
//
// Five controls in the bar open one — ⊕, effort, shield, connectors, and the `⋯` overflow — and
// §10 asks the same four things of each: `role="menu"`, arrow-key navigation, `Esc` to close, and
// focus returned to the trigger. Four implementations of that is four chances to forget the last
// one, and returning focus is the one everybody forgets: a menu that closes and drops focus onto
// `<body>` sends a keyboard user back to the top of the document, which in this app means the
// sidebar, three panels away from the composer they were driving.
//
// IT OPENS UPWARD, ALWAYS. The composer is pinned to the bottom of its column, so a menu opening
// downward is a menu off the screen. This is the same decision the model selector and the old
// GitHub attach menu each made separately; here it is made once.
//
// ESC IS ORDERED, AND THAT ORDER IS §3.3'S: "close popover → exit fullscreen → clear focus". Which
// means this component must stop the event from travelling once it has consumed it — otherwise
// pressing Esc inside a popover in the fullscreen composer closes both, and the user loses an
// editor they had not finished with. (Radix's Escape, stopped in `onEscapeKeyDown` below.)

import type { RefObject } from "react";
import { Popover as Root, PopoverAnchor, PopoverContent } from "../ui/popover.tsx";

/** A menu row's own arrow-key membership. Anything focusable inside a `role="menu"` counts. */
const FOCUSABLE = 'button:not([disabled]), [href], input, select, textarea, [tabindex]:not([tabindex="-1"])';

/**
 * A RADIX POPOVER UNDERNEATH (ui/popover.tsx, 2026-10-09), behind the API the eleven call sites
 * already use. What Radix took over: placement against the trigger (and a flip downward when there
 * is no room above, which the always-upward panel could not do), the press outside, Escape, and
 * focus moved in on open. What stays here is what a popover does not know it is: a `role="menu"`
 * whose rows the arrow keys walk.
 */
export function Popover({
  open,
  onClose,
  /** Where focus goes when the popover closes. §10: back to the trigger, never to the document. */
  triggerRef,
  label,
  align = "left",
  width,
  bare = false,
  children,
}: {
  open: boolean;
  onClose: () => void;
  triggerRef: React.RefObject<HTMLElement | null>;
  /** Names the menu for a screen reader — "Reasoning effort", "Attach context". */
  label: string;
  align?: "left" | "right";
  width?: number;
  /**
   * No surface of its own — no panel, border, padding or shadow, and no slide of its own — for a
   * row of marks that float by themselves: the tray's connector logos on their blobs. Everything
   * that makes it a menu (role, arrow keys, Esc, focus returned) is unchanged.
   */
  bare?: boolean;
  children: React.ReactNode;
}) {
  /** The arrow keys: rows a ring, and a field or a slider keeping its own. */
  const onKeyDown = (e: React.KeyboardEvent<HTMLDivElement>): void => {
    if (e.key !== "ArrowDown" && e.key !== "ArrowUp" && e.key !== "Home" && e.key !== "End") return;
    const items = Array.from(e.currentTarget.querySelectorAll<HTMLElement>(FOCUSABLE));
    if (items.length === 0) return;
    // A control INSIDE a row — a text field in the file picker — keeps its own arrow keys. Only
    // navigate when focus is on a row itself.
    const active = document.activeElement as HTMLElement | null;
    if (active instanceof HTMLInputElement || active instanceof HTMLTextAreaElement) return;
    // AND A SLIDER OWNS ITS ARROWS, Home and End included: they move its value, not the focus. Taken
    // here, End jumped focus to the last row while the slider still moved, and every key after it
    // landed on something else. The effort slider is the one inside a popover today.
    if (active?.getAttribute("role") === "slider") return;
    e.preventDefault();
    const at = active ? items.indexOf(active) : -1;
    const next =
      e.key === "Home" ? 0
      : e.key === "End" ? items.length - 1
      // Wrapping, because a menu of four items should not require knowing which end you are at.
      : e.key === "ArrowDown" ? (at + 1) % items.length
      : (at - 1 + items.length) % items.length;
    items[next]?.focus();
  };

  const onTrigger = (target: EventTarget | null): boolean =>
    target instanceof Node && Boolean(triggerRef.current?.contains(target));

  return (
    <Root open={open} onOpenChange={(next) => { if (!next) onClose(); }}>
      {/* ANCHORED TO THE CALL SITE'S OWN BUTTON. Each control renders its trigger itself and hands
          this a ref, so the anchor is that element rather than a wrapper Radix would own. */}
      <PopoverAnchor virtualRef={triggerRef as RefObject<HTMLElement>} />
      <PopoverContent
        // IN PLACE, NOT IN A PORTAL — see ui/popover.tsx: the fullscreen composer's Tab trap walks
        // its own subtree, and a popover inside it has to be in it.
        inline
        role="menu"
        aria-label={label}
        // IT OPENS UPWARD. The composer is pinned to the bottom of its column, so a menu opening
        // downward is a menu off the screen — and Radix flips it only when there is no room above.
        side="top"
        align={align === "right" ? "end" : "start"}
        onKeyDown={onKeyDown}
        // ESC IS ORDERED, AND THAT ORDER IS §3.3'S: "close popover → exit fullscreen → clear focus".
        // Radix hears it on the document in the capture phase; stopping it there means the
        // fullscreen composer's own listener never sees the Esc that closed a menu.
        onEscapeKeyDown={(e) => e.stopPropagation()}
        // THE TRIGGER IS NOT "OUTSIDE". It toggles, and closing here as well would make a second
        // click on it close-then-reopen, which reads as the menu not responding.
        onInteractOutside={(e) => { if (onTrigger(e.target)) e.preventDefault(); }}
        // Focus back to the trigger on close, whichever way it closed — §10: never to the document.
        onCloseAutoFocus={(e) => { e.preventDefault(); triggerRef.current?.focus(); }}
        className={bare ? "" : "animate-slide-in rounded-card border border-edge bg-elevated p-1 shadow-floating motion-reduce:animate-none"}
        // `min-content` IS THE WIDTH THE PANEL ALWAYS HAD. Hung `absolute` off a 32px control, it
        // shrank to its narrowest — the minimum below, or its longest word — and its footnotes wrapped.
        // Placed against the window it would grow to its widest instead: the permission popover's
        // one-line footnote drew it 686px across.
        style={{ minWidth: width ?? 240, width: "min-content" }}
      >
        {children}
      </PopoverContent>
    </Root>
  );
}

/**
 * One row in a popover.
 *
 * `selected` draws the ✓ that every segmented popover in the spec shows against its current value,
 * and carries `aria-checked` so the tick is not the only way to know — §10's rule that no state is
 * conveyed by appearance alone.
 */
export function PopoverRow({
  label,
  detail,
  selected = false,
  disabled = false,
  onSelect,
  icon,
  trailing,
}: {
  label: React.ReactNode;
  detail?: React.ReactNode;
  selected?: boolean;
  disabled?: boolean;
  onSelect: () => void;
  icon?: React.ReactNode;
  trailing?: React.ReactNode;
}) {
  return (
    <button
      type="button"
      role="menuitemradio"
      aria-checked={selected}
      disabled={disabled}
      onClick={onSelect}
      className="flex w-full items-center gap-2 rounded-control px-2 py-1.5 text-left transition-colors
        duration-fast hover:bg-active/50 focus-visible:bg-active/50 focus-visible:outline-none
        disabled:cursor-not-allowed disabled:opacity-40"
    >
      {icon && <span className="shrink-0 text-muted">{icon}</span>}
      <span className="min-w-0 flex-1">
        <span className="block text-caption text-ink">{label}</span>
        {detail && <span className="block text-tiny text-faint">{detail}</span>}
      </span>
      {/* A FIXED SLOT, occupied or not. Rendering the tick only when selected makes every row
          jump ~14px the moment you change the value — the same reason the connector chips in
          BuildPane reserve theirs. */}
      <span className="inline-flex w-3 shrink-0 justify-center text-tiny text-accent" aria-hidden>
        {selected ? "✓" : ""}
      </span>
      {trailing}
    </button>
  );
}

/** A hairline between groups of rows, and the footnote blocks the spec's popovers end with. */
export function PopoverNote({ children }: { children: React.ReactNode }) {
  return (
    <div className="mt-1 border-t border-hair px-2 pb-1 pt-1.5 text-tiny leading-relaxed text-faint">
      {children}
    </div>
  );
}
