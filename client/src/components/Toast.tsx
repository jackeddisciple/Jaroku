// The bottom-right toast: a few words about something that just happened, gone in two seconds.
//
// IT MOVES NOTHING. It is fixed-position over the corner, so arriving and leaving never shifts a row
// of the application — which is the whole reason it exists. The connection strip it replaced took
// 28px out of the window's height whenever the socket dropped and gave them back when it returned,
// and every pane in the workspace jumped twice.
//
// The corner does not take clicks either — only a toast with a control in it does — because a corner
// that swallowed the click meant for the composer's send button underneath would be a new way for
// the product to feel broken.

import { useEffect } from "react";
import { useUiStore, type ToastTone } from "../store/uiStore.ts";

/**
 * The corner every toast shares. A toast with a control of its own — the Inbox's undo — renders into
 * it through a portal, so two at once stack one above the other instead of on top of each other.
 */
export const TOAST_STACK_ID = "toast-stack";

const DOT: Record<ToastTone, string | null> = {
  neutral: null,
  ok: "bg-ok",
  err: "bg-err",
};

export function ToastStack() {
  const toast = useUiStore((s) => s.toast);
  const dismiss = useUiStore((s) => s.dismissToast);

  useEffect(() => {
    if (!toast) return;
    // From when it was RAISED, not when it mounted: a toast raised while this component was not on
    // screen — behind the sign-in card, say — has already had its two seconds.
    const left = toast.at + toast.ms - Date.now();
    const t = setTimeout(() => dismiss(toast.id), Math.max(0, left));
    return () => clearTimeout(t);
  }, [toast, dismiss]);

  const shown = toast && toast.at + toast.ms > Date.now() ? toast : null;
  const dot = shown ? DOT[shown.tone] : null;

  return (
    <div id={TOAST_STACK_ID} className="pointer-events-none fixed bottom-4 right-4 z-40 flex flex-col items-end gap-2">
      {shown && (
        <div
          key={shown.id}
          role="status"
          aria-live="polite"
          className="flex max-w-xs animate-slide-in items-center gap-2 rounded-card border border-edge bg-elevated px-3 py-1.5 text-tiny text-ink shadow-overlay motion-reduce:animate-none"
        >
          {dot && <span aria-hidden className={`h-1.5 w-1.5 shrink-0 rounded-full ${dot}`} />}
          <span className="min-w-0">{shown.message}</span>
        </div>
      )}
    </div>
  );
}
