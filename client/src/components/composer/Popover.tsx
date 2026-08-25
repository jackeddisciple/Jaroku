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
// editor they had not finished with.

import { useEffect, useId, useRef } from "react";

/** A menu row's own arrow-key membership. Anything focusable inside a `role="menu"` counts. */
const FOCUSABLE = 'button:not([disabled]), [href], input, select, textarea, [tabindex]:not([tabindex="-1"])';

export function Popover({
  open,
  onClose,
  /** Where focus goes when the popover closes. §10: back to the trigger, never to the document. */
  triggerRef,
  label,
  align = "left",
  width,
  children,
}: {
  open: boolean;
  onClose: () => void;
  triggerRef: React.RefObject<HTMLElement | null>;
  /** Names the menu for a screen reader — "Reasoning effort", "Attach context". */
  label: string;
  align?: "left" | "right";
  width?: number;
  children: React.ReactNode;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const id = useId();

  useEffect(() => {
    if (!open) return;
    const el = ref.current;
    if (!el) return;

    // Focus the first row on open, so the keyboard path starts inside the menu rather than one Tab
    // away from it. `requestAnimationFrame` because the element is mounted but not yet laid out on
    // the tick the effect runs.
    const raf = requestAnimationFrame(() => {
      el.querySelector<HTMLElement>(FOCUSABLE)?.focus();
    });

    const rows = (): HTMLElement[] => Array.from(el.querySelectorAll<HTMLElement>(FOCUSABLE));

    const onKey = (e: KeyboardEvent): void => {
      if (e.key === "Escape") {
        // CONSUMED HERE. See the header: without this the same Esc also collapses the fullscreen
        // composer this popover may be sitting inside.
        e.stopPropagation();
        e.preventDefault();
        onClose();
        return;
      }
      if (e.key !== "ArrowDown" && e.key !== "ArrowUp" && e.key !== "Home" && e.key !== "End") return;
      const items = rows();
      if (items.length === 0) return;
      // A control INSIDE a row — a text field in the file picker — keeps its own arrow keys. Only
      // navigate when focus is on a row itself.
      const active = document.activeElement as HTMLElement | null;
      if (active instanceof HTMLInputElement || active instanceof HTMLTextAreaElement) return;
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

    const onDown = (e: MouseEvent): void => {
      const target = e.target as Node;
      // The trigger is excluded deliberately: it toggles, and closing here as well would make a
      // second click on it close-then-reopen, which reads as the menu not responding.
      if (el.contains(target) || triggerRef.current?.contains(target)) return;
      onClose();
    };

    document.addEventListener("keydown", onKey, true);
    document.addEventListener("mousedown", onDown);
    return () => {
      cancelAnimationFrame(raf);
      document.removeEventListener("keydown", onKey, true);
      document.removeEventListener("mousedown", onDown);
    };
  }, [open, onClose, triggerRef]);

  // Focus back to the trigger on close. In its own effect rather than in `onClose`, because the
  // popover also closes by way of a selection, an outside click and an Esc — three call sites that
  // would each have to remember.
  const wasOpen = useRef(false);
  useEffect(() => {
    if (wasOpen.current && !open) triggerRef.current?.focus();
    wasOpen.current = open;
  }, [open, triggerRef]);

  if (!open) return null;

  return (
    <div
      ref={ref}
      id={id}
      role="menu"
      aria-label={label}
      className={`absolute bottom-full z-30 mb-1.5 animate-slide-in rounded-card border border-edge
        bg-elevated p-1 shadow-floating motion-reduce:animate-none
        ${align === "right" ? "right-0" : "left-0"}`}
      style={{ minWidth: width ?? 240 }}
    >
      {children}
    </div>
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
