// §3's five-second toast, which is what buys the absence of confirmation dialogs.
//
// "Every destructive action shows a 5-second toast with undo. NO CONFIRMATION DIALOGS — undo is
// strictly better and does not interrupt a triage flow." A confirmation is a gate somebody clears
// before the thing happens, and a board meant to be cleared in one pass cannot afford one per card.
// Undo is the same safety with the cost moved to the rare case: it is paid only by the person who
// got it wrong.
//
// WHICH MEANS THIS HAS TO BE HONEST ABOUT WHAT IT CAN STILL TAKE BACK. The token is single-use and
// the server holds it for a minute; the toast lives five seconds. So the strip disappears on its own
// and pressing undo after it has gone is not possible rather than silently doing nothing — the one
// failure a safety net must not have.
//
// A FLOATING CARD IN THE CORNER, NOT A BAR IN THE FLOW. It was a bar above the tray, on the argument
// that a floating card covers the bottom of the board — but a bar that arrived with every dismissal
// pushed the board up and dropped it back five seconds later, under the eyes of somebody triaging it.
// It renders into the corner every toast shares (`ToastStack`), and it is still mounted by the Inbox
// alone, because ⌘Z is the Inbox's chord and the hint beside the button would be a lie anywhere else.

import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { sendUndoInboxAction } from "../lib/socket.ts";
import { TOAST_STACK_ID } from "./Toast.tsx";
import { useInboxStore } from "../store/inboxStore.ts";
import { keyHint } from "../lib/modKey.ts";
import { Icon } from "../lib/icons/registry.ts";
import { ICON } from "../lib/tokens.ts";

/** §3's window. Five seconds, which is the number the specification gives. */
export const TOAST_MS = 5000;

/** What the strip says happened. Past tense, because it already has. */
const VERB: Record<string, string> = {
  resolve: "Resolved",
  dismiss: "Dismissed",
  snooze: "Snoozed",
};

export function InboxUndoToast() {
  const undo = useInboxStore((s) => s.undo);
  const setUndo = useInboxStore((s) => s.setUndo);
  const [visible, setVisible] = useState(false);
  // Looked up once mounted rather than during render: the stack is the application's, and the Inbox
  // can render before the shell has committed it.
  const [stack, setStack] = useState<HTMLElement | null>(null);
  useEffect(() => setStack(document.getElementById(TOAST_STACK_ID)), []);

  /**
   * The five seconds, as one timer per toast.
   *
   * KEYED ON THE TOKEN rather than on the object, so a second action inside the window restarts the
   * clock instead of inheriting the remainder of the first one's. Dismissing two things in a row is
   * two decisions and the second toast is the one still true — the same one-slot rule the store
   * keeps, and the reason there is no queue here.
   */
  useEffect(() => {
    if (!undo) {
      setVisible(false);
      return;
    }
    setVisible(true);
    const timer = setTimeout(() => {
      setVisible(false);
      // CLEARED FROM THE STORE, NOT ONLY HIDDEN. ⌘Z reads the same field, and a token that was
      // invisible but still live would make the chord work for a minute after the offer expired —
      // which is a safety net that behaves differently depending on whether you can see it.
      setUndo(null);
    }, TOAST_MS);
    return () => clearTimeout(timer);
  }, [undo?.token, setUndo]);

  if (!undo || !visible || !stack) return null;

  const verb = VERB[undo.action] ?? "Done";
  return createPortal(
    <div
      key={undo.token}
      className="pointer-events-auto flex animate-slide-in items-center gap-2 rounded-card border border-edge bg-elevated py-1 pl-3 pr-1.5 text-tiny text-muted shadow-overlay motion-reduce:animate-none"
      role="status"
      // POLITE, not assertive: this reports something the person just did, and interrupting a screen
      // reader mid-sentence to say so would be the audio equivalent of a modal.
      aria-live="polite"
    >
      <span className="text-ink">{verb}</span>
      {undo.changed > 1 && <span className="text-faint">{undo.changed} items</span>}
      <button
        onClick={() => sendUndoInboxAction(undo.token)}
        className="ml-auto inline-flex items-center gap-1 rounded-control px-2 py-0.5 text-tiny text-muted transition-colors hover:bg-active active:bg-chrome hover:text-ink"
      >
        <Icon.inbox.undo size={ICON.badge} />
        Undo
      </button>
      <span className="shrink-0 text-tiny text-faint">{keyHint("⌘Z")}</span>
    </div>,
    stack,
  );
}
