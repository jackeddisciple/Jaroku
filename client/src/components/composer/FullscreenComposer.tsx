// The expanded composer — §3.2.
//
// Writing a detailed agent brief in a three-line box is miserable, and that is the whole
// justification. What makes this more than a bigger textarea is what it must NOT be:
//
//   IT IS NOT A COPY OF THE COMPOSER'S STATE. §3.2: "it is the same composer state, re-parented,
//   not a copy." Draft text, attachments and every toolbar setting are held above both, so there
//   is nothing to synchronise and no direction for a sync to fail in. A dialog holding its own
//   draft is how a user loses a paragraph by pressing Esc.
//
//   IT DOES NOT UNMOUNT THE THREAD BEHIND IT. The background stays visible at reduced opacity, and
//   the spec says why in four words: "unmounting kills streaming turns". A modal that renders in a
//   portal over a torn-down tree would end whatever run was mid-flight when somebody decided to
//   write a longer message.
//
//   IT KEEPS THE SAME BOTTOM BAR. §12.1e — identical order, identical component. Passed in as a
//   node from the one place that builds it, rather than rebuilt here, because "identical" is not a
//   property two constructions of the same thing can be relied on to keep.
//
// FOCUS IS TRAPPED AND RETURNED (§10). Trapped because a dialog you can Tab out of is a dialog
// that leaves a keyboard user editing a thread they cannot see; returned because the alternative
// is dropping focus on `<body>`, which in this app means the sidebar, three panels from the
// composer they were driving.

import { useEffect, useRef } from "react";

const FOCUSABLE =
  'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

export function FullscreenComposer({
  open,
  onClose,
  onSend,
  title = "Compose",
  children,
}: {
  open: boolean;
  /** Esc, the backdrop, and the collapse trigger all arrive here. */
  onClose: () => void;
  /** Cmd/Ctrl+Enter: §3.2 says it sends AND collapses, in that order. */
  onSend: () => void;
  title?: string;
  children: React.ReactNode;
}) {
  const ref = useRef<HTMLDivElement>(null);
  // Captured on open rather than passed in: the thing to return focus to is whatever had it, which
  // is the collapse trigger in the ordinary case and something else entirely when the dialog was
  // opened by the Cmd+Shift+F chord from inside the textarea.
  const restoreTo = useRef<HTMLElement | null>(null);

  useEffect(() => {
    if (!open) return;
    restoreTo.current = document.activeElement as HTMLElement | null;

    const el = ref.current;
    const raf = requestAnimationFrame(() => {
      // The textarea, not the first button. This dialog exists to be typed in.
      el?.querySelector<HTMLTextAreaElement>("textarea")?.focus();
    });

    const onKey = (e: KeyboardEvent): void => {
      if (e.key === "Escape") {
        // §3.3's Esc order is "close popover → exit fullscreen → clear focus", and the popover half
        // is enforced at the other end: Popover.tsx consumes the event in the capture phase, so an
        // Esc that closed a menu never reaches this listener at all.
        e.preventDefault();
        onClose();
        return;
      }
      if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
        e.preventDefault();
        onSend();
        onClose();
        return;
      }
      if (e.key !== "Tab" || !el) return;
      // The trap. Both edges, because Shift+Tab off the first element is the same escape as Tab off
      // the last one and is the half people forget.
      const items = Array.from(el.querySelectorAll<HTMLElement>(FOCUSABLE))
        .filter((n) => n.offsetParent !== null || n === document.activeElement);
      if (items.length === 0) return;
      const first = items[0]!;
      const last = items[items.length - 1]!;
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first.focus();
      }
    };

    document.addEventListener("keydown", onKey);
    return () => {
      cancelAnimationFrame(raf);
      document.removeEventListener("keydown", onKey);
    };
  }, [open, onClose, onSend]);

  useEffect(() => {
    if (open) return;
    restoreTo.current?.focus();
    restoreTo.current = null;
  }, [open]);

  if (!open) return null;

  return (
    // `fixed`, and deliberately NOT a portal. A portal would mount this outside the pane's tree,
    // which is fine for the overlay and fatal for the promise above it: the thread has to stay
    // mounted, and the cheapest guarantee of that is not moving anything.
    <div className="fixed inset-0 z-40 flex items-center justify-center">
      {/* The thread stays visible through this rather than being replaced by it — §3.2 again. The
          backdrop is a scrim, not a cover. */}
      <div
        className="absolute inset-0 bg-bg/70 backdrop-blur-[1px] transition-opacity duration-base motion-reduce:transition-none"
        onClick={onClose}
        aria-hidden
      />
      <div
        ref={ref}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        className="relative flex w-full max-w-[880px] flex-col overflow-hidden rounded-modal border
          border-edge bg-panel shadow-floating animate-slide-in motion-reduce:animate-none"
        style={{ height: "70vh" }}
      >
        {children}
      </div>
    </div>
  );
}

/**
 * Renders the composer in one of two places without it becoming two composers.
 *
 * This is the mechanical half of §3.2's "the same composer state, re-parented, not a copy". The
 * caller writes the composer ONCE and hands it here; the shell decides whether it lands in the
 * flow at the bottom of the thread or inside the dialog. Every piece of state the composer reads —
 * draft text, attachments, effort, permission mode, the selected model — lives above this in the
 * pane, so there is nothing to copy across and no direction for a copy to fail in.
 *
 * A `key` is deliberately NOT set on the child. React unmounts and remounts the subtree when its
 * position in the tree changes, which costs the textarea's caret position and nothing else, and
 * forcing the remount to be avoided here would mean portalling — which would leave the dialog
 * mounted outside the pane's tree and break the "do not unmount the thread" rule at the other end.
 */
export function ComposerShell({
  fullscreen,
  onClose,
  onSend,
  children,
}: {
  fullscreen: boolean;
  onClose: () => void;
  onSend: () => void;
  children: React.ReactNode;
}) {
  if (!fullscreen) return <>{children}</>;
  return (
    <FullscreenComposer open onClose={onClose} onSend={onSend} title="Compose">
      {children}
    </FullscreenComposer>
  );
}
