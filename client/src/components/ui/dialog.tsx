// The dialog — shadcn/ui's Dialog, copied in and restyled to this app's tokens.
//
// shadcn is source you own rather than a package you import: these are its `components/ui/
// dialog.tsx` (manual install, over `@radix-ui/react-dialog`) with its theme variables swapped for
// ours. Radix brings what the deleted `lib/dialog.ts` did by hand — `role="dialog"` named by its title, focus
// moved in and trapped (both directions), the page behind it locked and hidden from assistive
// technology, focus handed back to whatever opened it — and adds Escape and the press outside as one
// layer in a stack, so a dialog over a panel closes the dialog and not both.
//
// THE DIALOGS MOVE ONE AT A TIME (2026-10-09, after the menus and the composer's popover).
//
// THE SCRIM IS THE DISMISSAL AND THE CENTRING, as every dialog here already drew it: the overlay is a
// full-window flex box that holds the panel, so a press on the scrim closes and the panel sits in
// its middle with the same 24px of air it always had.
//
// `inline` RENDERS IN PLACE INSTEAD OF IN A PORTAL — for a dialog whose tree has to stay mounted
// where it is (the fullscreen composer's thread) or whose markup a suite reads without a browser.

import type { ComponentProps } from "react";
import * as DialogPrimitive from "@radix-ui/react-dialog";
import { LAYER } from "../../lib/tokens.ts";

/** What Option-Tab walks inside a dialog — the same set the old hand-built trap walked. */
const TABBABLE = 'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

export const Dialog = DialogPrimitive.Root;
export const DialogTrigger = DialogPrimitive.Trigger;
export const DialogClose = DialogPrimitive.Close;
export const DialogTitle = DialogPrimitive.Title;
export const DialogDescription = DialogPrimitive.Description;

export function DialogContent({
  className = "",
  overlayClassName = "items-center bg-ink/20 p-6",
  inline = false,
  onEscapeKeyDown,
  onKeyDown,
  children,
  ...props
}: ComponentProps<typeof DialogPrimitive.Content> & {
  /** The scrim's own look — where it holds the panel, its tint, and the air around the panel. */
  overlayClassName?: string;
  inline?: boolean;
}) {
  const body = (
    <DialogPrimitive.Overlay
      className={`fixed inset-0 flex justify-center ${overlayClassName}`}
      style={{ zIndex: LAYER.modal }}
    >
      <DialogPrimitive.Content
        // `aria-modal` SAID OUT LOUD as well as enforced. Radix hides everything else from assistive
        // technology, and the attribute tells a screen reader up front what it is inside.
        aria-modal
        // ESCAPE IS CONSUMED. Radix closes the top layer of its own stack, but the hand-built overlays
        // still listening on the window would hear the same press and close underneath it. (A
        // hand-built `Select` open inside a dialog is not one of Radix's layers, so Escape closes the
        // dialog with it, as it did before; shadcn's Select would be a layer and close first.)
        onEscapeKeyDown={(e) => { e.stopPropagation(); onEscapeKeyDown?.(e); }}
        // OPTION-TAB WRAPS TOO. Radix's trap answers Tab and leaves Option-Tab alone — and Option-Tab
        // is how WebKit (Safari, this app's webview) reaches buttons when full keyboard access is off,
        // so the old trap's wrap held there and Radix's would not. Same wrap, the one key it skips.
        onKeyDown={(e) => {
          onKeyDown?.(e);
          if (e.key !== "Tab" || !e.altKey || e.defaultPrevented) return;
          const items = Array.from(e.currentTarget.querySelectorAll<HTMLElement>(TABBABLE))
            .filter((el) => el.offsetParent !== null);
          if (items.length === 0) return;
          const at = items.indexOf(document.activeElement as HTMLElement);
          const edge = e.shiftKey ? at <= 0 : at === items.length - 1;
          if (!edge) return;
          e.preventDefault();
          items[e.shiftKey ? items.length - 1 : 0]?.focus();
        }}
        className={`focus:outline-none ${className}`}
        {...props}
        // A NAME GIVEN IS THE NAME USED. Radix links a dialog to its title, and `aria-labelledby`
        // outranks `aria-label` — so a dialog that names itself ("Grant access to billing_bot") would
        // be announced by a shorter visible heading instead. Given an explicit label, that wins.
        {...(props["aria-label"] ? { "aria-labelledby": undefined } : {})}
      >
        {children}
      </DialogPrimitive.Content>
    </DialogPrimitive.Overlay>
  );
  return inline ? body : <DialogPrimitive.Portal>{body}</DialogPrimitive.Portal>;
}
