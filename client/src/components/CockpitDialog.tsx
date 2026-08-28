// The Cockpit's one dialog, serving the three decisions that deserve one.
//
// §21 GRADES THE CONFIRMATIONS AND THE GRADING IS THE POINT: "Three controls in this tab do
// irreversible or disruptive things, and giving all three the same confirmation teaches people to
// click through all three."
//
//   STOP is inline, a single press, no dialog. It is scoped to one item and the item is on screen.
//   RECONNECT is a dialog, because the agent goes briefly offline and other people's jobs are
//   affected — and it carries Part 2's sentence verbatim.
//   KILL is a dialog naming the agent, because everything running on it dies.
//
// AND §8's PRE-FLIGHT GATE is the same shape for a different reason: it is "the one place in this
// tab a modal is right, because it is asking for a decision that spends money and touches the
// world". §8 also says "Everything else about it is the app's existing dialog. Do not write a
// bespoke one" — which is what this file is, one dialog rather than three.
//
// THE CONFIRMING CONTROL IS NOT THE DEFAULT FOCUS. §8 and §21 both require it, and `useDialog`
// focuses the FIRST focusable element in the container — so Cancel is simply written first, which
// is also where a confirmation conventionally draws it. Reading order, focus order and visual order
// are one list, and the rule costs nothing: no `ref`, no effect fighting the hook, and above all no
// `autoFocus` on the one control that must not have it.
//
// §15's "NO SECOND CONFIRMATION DIALOG BESIDE THE EXISTING MCP MODAL" IS NOT THIS. That rule is
// about answering a tool confirmation — a job parked on `waiting` is answered in `McpConfirmModal`
// and nowhere else, because two places one question can be answered would race for one nonce.
// These are destructive-action confirmations, which §21 asks for by name.

import { useEffect, useId } from "react";

import { DESTRUCTIVE } from "../lib/cockpitCopy.ts";
import { useDialog } from "../lib/dialog.ts";
import { LAYER } from "../lib/tokens.ts";

export function CockpitDialog({
  open,
  title,
  body,
  confirmLabel,
  onConfirm,
  onCancel,
  /**
   * Whether confirming destroys something, which changes only the control's tone.
   *
   * TONE AND NOT SHAPE. A destructive confirm is `text-err` on a hairline rather than a filled red
   * block: §10's rose-is-scarce rule holds here too, and a dialog whose primary control is a red
   * rectangle reads as an alarm about the dialog rather than about the act. The words carry the
   * weight — "Kill it", "Dispatch it" — which is §16's rule that a control says what it will do.
   */
  destructive = false,
}: {
  open: boolean;
  title: string;
  body: React.ReactNode;
  confirmLabel: string;
  onConfirm: () => void;
  onCancel: () => void;
  destructive?: boolean;
}) {
  const labelId = useId();
  const { ref, dialogProps } = useDialog(open, labelId);
  // The hook must run unconditionally — its own cleanup is what restores focus — so the early
  // return is below it rather than above. `dialog.ts` says so in as many words.

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent): void => {
      // ESCAPE CANCELS, and it is here rather than in `useDialog` because that hook deliberately
      // does not own Escape: every overlay in this client already closes on it, and a second
      // listener in the hook would mean two closers per dialog and a nested pair closing both.
      if (e.key === "Escape") { e.stopPropagation(); onCancel(); }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onCancel]);

  if (!open) return null;

  return (
    // A SCRIM, WHICH THE DETAIL PANEL DELIBERATELY DOES NOT HAVE. §3D: a panel says "here is more
    // about this" and a modal says "deal with this now" — and these three genuinely do. The scrim
    // is also the dismissal, which is what every other overlay in this client offers.
    <div
      className="fixed inset-0 flex items-center justify-center bg-ink/20 p-6"
      style={{ zIndex: LAYER.modal }}
      onMouseDown={(e) => { if (e.target === e.currentTarget) onCancel(); }}
    >
      <div
        ref={ref}
        {...dialogProps}
        aria-labelledby={labelId}
        // `RADIUS.modal` AND `SURFACE.elevated`, which is what §8 asks of the gate and what the
        // other two inherit by being the same component. `shadow-overlay` is the hairline-plus-
        // shadow pair at the top rung — never the shadow alone, which `tokens.ts` states and §3D
        // restates.
        className="w-full max-w-[400px] rounded-modal border border-edge bg-elevated p-4 shadow-overlay"
      >
        <h2 id={labelId} className="text-label text-ink">{title}</h2>
        <div className="mt-2 text-caption leading-[1.55] text-muted">{body}</div>

        {/* CANCEL FIRST IN THE DOM, WHICH IS ALSO CANCEL FIRST ON SCREEN — and that is the happy
            case rather than a compromise. `useDialog` focuses the first focusable element, and the
            conventional left-to-right order of a confirmation already puts the dismissal on the
            left, so §21's "the destructive control not focused by default" costs nothing but
            writing the two buttons in the order they are read. No `ref`, no effect fighting the
            hook, no `autoFocus` on the thing that must not have it. */}
        <div className="mt-4 flex items-center justify-end gap-2">
          <button
            type="button"
            onClick={onCancel}
            className="rounded-control px-2.5 py-1 text-tiny text-muted transition-colors duration-fast hover:bg-active hover:text-ink focus-visible:outline-none focus-visible:shadow-focusring"
          >
            {DESTRUCTIVE.cancel}
          </button>
          <button
            type="button"
            onClick={onConfirm}
            className={`rounded-control border px-2.5 py-1 text-tiny transition-colors duration-fast focus-visible:outline-none focus-visible:shadow-focusring ${
              destructive
                ? "border-err/40 text-err hover:bg-active"
                : "border-hair text-ink hover:bg-active"
            }`}
          >
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
