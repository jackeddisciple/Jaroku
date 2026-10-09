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

import { Dialog, DialogContent, DialogTitle } from "../ui/dialog.tsx";

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
  return (
    // A RADIX DIALOG (ui/dialog.tsx, 2026-10-09), which now does the trap and the return the header
    // promises: Tab cannot leave it, and focus goes back to whatever had it when it opened — the
    // collapse trigger usually, the textarea when the Cmd+Shift+F chord opened it.
    //
    // §3.3's Esc ORDER, "close popover → exit fullscreen", is Radix's layering: a composer popover
    // open inside this is the top layer, so the first Esc closes it and only the next reaches here.
    <Dialog open={open} onOpenChange={(next) => { if (!next) onClose(); }}>
      <DialogContent
        // `fixed`, and deliberately NOT a portal. A portal would mount this outside the pane's tree,
        // which is fine for the overlay and fatal for the promise above it: the thread has to stay
        // mounted, and the cheapest guarantee of that is not moving anything.
        inline
        aria-describedby={undefined}
        // The thread stays visible through this rather than being replaced by it — §3.2 again. The
        // backdrop is a scrim, not a cover, and pressing it closes.
        overlayClassName="items-center bg-ink/25 backdrop-blur-[1px]"
        // The textarea, not the first button. This dialog exists to be typed in.
        onOpenAutoFocus={(e) => {
          e.preventDefault();
          (e.currentTarget as HTMLElement | null)?.querySelector<HTMLTextAreaElement>("textarea")?.focus();
        }}
        onKeyDown={(e) => {
          if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
            e.preventDefault();
            onSend();
            onClose();
          }
        }}
        className="relative flex w-full max-w-[880px] flex-col overflow-hidden rounded-lg border
          border-edge bg-elevated shadow-floating animate-slide-in motion-reduce:animate-none"
        style={{ height: "70vh" }}
      >
        <DialogTitle className="sr-only">{title}</DialogTitle>
        {children}
      </DialogContent>
    </Dialog>
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
  // IN THE FLOW IT IS LIFTED TO E2, the level the dialog's own surface gives it below, so the
  // composer sits at one height wherever it renders — the product owner's call on 2026-09-10, and
  // named in surfaceSystem.test.ts as a decision rather than slipped past the rule. On a wrapper
  // rather than the card, because the standalone card's `shadow-glow` is a shadow too and an
  // element wears only one: on the card itself, one of the two would silently win.
  // THE WRAPPER TAKES THE CARD'S RADIUS, `xl`, or the shadow's corners would not follow the card's,
  // and it is `relative` so it always paints over the tray BuildPane stands up behind it.
  if (!fullscreen) return <div className="relative rounded-xl shadow-floating">{children}</div>;
  return (
    <FullscreenComposer open onClose={onClose} onSend={onSend} title="Compose">
      {children}
    </FullscreenComposer>
  );
}
