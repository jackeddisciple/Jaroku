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
// THE CONFIRMING CONTROL IS NOT THE DEFAULT FOCUS. §8 and §21 both require it, and the dialog
// (Radix's, through `ui/dialog.tsx`, since 2026-10-09) focuses the FIRST focusable element in it — so Cancel is simply written first, which
// is also where a confirmation conventionally draws it. Reading order, focus order and visual order
// are one list, and the rule costs nothing: no `ref`, no effect fighting the hook, and above all no
// `autoFocus` on the one control that must not have it.
//
// §15's "NO SECOND CONFIRMATION DIALOG BESIDE THE EXISTING MCP MODAL" IS NOT THIS. That rule is
// about answering a tool confirmation — a job parked on `waiting` is answered in `McpConfirmModal`
// and nowhere else, because two places one question can be answered would race for one nonce.
// These are destructive-action confirmations, which §21 asks for by name.

import { DESTRUCTIVE } from "../lib/cockpitCopy.ts";
import { type IconComponent } from "../lib/icons/registry.ts";
import { ICON } from "../lib/tokens.ts";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "./ui/dialog.tsx";

export function CockpitDialog({
  open,
  title,
  body,
  confirmLabel,
  confirmIcon: ConfirmMark,
  cancelIcon: CancelMark,
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
  /**
   * A mark on the confirming control, for the one caller that has one.
   *
   * OPTIONAL BECAUSE THIS DIALOG IS SHARED. §6 gives the preflight gate's "Dispatch it" an arrow
   * and its cancel a mark; the three graded destructive confirmations behind the same component —
   * reconnect, kill, stop — are named in §7 as taking none. Passing the marks in from the gate is
   * what keeps a dispatch arrow off the button that kills somebody's agent.
   */
  confirmIcon?: IconComponent;
  cancelIcon?: IconComponent;
  onConfirm: () => void;
  onCancel: () => void;
  destructive?: boolean;
}) {
  return (
    // A SCRIM, WHICH THE DETAIL PANEL DELIBERATELY DOES NOT HAVE. §3D: a panel says "here is more
    // about this" and a modal says "deal with this now" — and these three genuinely do. The scrim
    // is also the dismissal, which is what every other overlay in this client offers — as is Escape,
    // and both cancel. Radix names the dialog by its title and returns focus to whatever opened it.
    <Dialog open={open} onOpenChange={(next) => { if (!next) onCancel(); }}>
      <DialogContent
        // `RADIUS.lg` AND `SURFACE.elevated`, which is what §8 asks of the gate and what the
        // other two inherit by being the same component. `shadow-overlay` is the hairline-plus-
        // shadow pair at the top rung — never the shadow alone, which `tokens.ts` states and §3D
        // restates.
        className="w-full max-w-[400px] rounded-lg border border-edge bg-elevated p-4 shadow-overlay"
      >
        <DialogTitle className="text-label text-ink">{title}</DialogTitle>
        <DialogDescription asChild>
          <div className="mt-2 text-caption leading-[1.55] text-muted">{body}</div>
        </DialogDescription>

        {/* CANCEL FIRST IN THE DOM, WHICH IS ALSO CANCEL FIRST ON SCREEN — and that is the happy
            case rather than a compromise. The dialog focuses the first focusable element, and the
            conventional left-to-right order of a confirmation already puts the dismissal on the
            left, so §21's "the destructive control not focused by default" costs nothing but
            writing the two buttons in the order they are read. No `ref`, no effect fighting the
            hook, no `autoFocus` on the thing that must not have it. */}
        <div className="mt-4 flex items-center justify-end gap-2">
          <button
            type="button"
            onClick={onCancel}
            title={DESTRUCTIVE.cancel}
            aria-label={DESTRUCTIVE.cancel}
            className="inline-flex items-center gap-1.5 rounded-control px-2.5 py-1 text-tiny text-muted transition-colors duration-fast hover:bg-active hover:text-ink focus-visible:outline-none focus-visible:shadow-focusring"
          >
            {/* Icon-only where §6 asks for it, and the word everywhere else. Aborting an
                in-flight operation, which is why it is `cancel-01` and not an `x` — see D2. */}
            {CancelMark ? <CancelMark size={ICON.sm} /> : DESTRUCTIVE.cancel}
          </button>
          <button
            type="button"
            onClick={onConfirm}
            className={`inline-flex items-center gap-1.5 rounded-control border px-2.5 py-1 text-tiny transition-colors duration-fast focus-visible:outline-none focus-visible:shadow-focusring ${
              destructive
                ? "border-err/40 text-err hover:bg-active"
                : "border-hair text-ink hover:bg-active"
            }`}
          >
            {ConfirmMark && <ConfirmMark size={ICON.sm} />}
            {confirmLabel}
          </button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
