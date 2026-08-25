// §5.4's snooze tray: a strip along the bottom, and the reason snooze is not a slower dismissal.
//
// "Snoozed work stays visible, otherwise snooze silently becomes dismissal." That sentence is the
// whole justification for the strip. A snooze that put something out of sight would be indist-
// inguishable from a dismissal to the person who made it, and §3 is explicit about what that costs:
// without a real snooze people dismiss things they actually care about, and the Inbox starts hiding
// real problems.
//
// COLLAPSED BY DEFAULT AND ONE LINE HIGH, because it is a reassurance rather than a place to work.
// "4 snoozed · next returns in 3h" is enough to know nothing has been lost; the list behind it is
// for the moment somebody wants one of them back early.
//
// IT IS ALSO THE ONE DROP TARGET ON THE BOARD (§4.1). Not because dragging is the good way to snooze
// — the keyboard is — but because a pointer user reaches for it, and having exactly one destination
// is what makes "this is not a lane" legible without a word of explanation.

import { useState } from "react";
import { shortDuration, trayLine } from "../lib/inboxBoard.ts";
import { sendSnoozeInboxItem } from "../lib/socket.ts";
import { ICON, MOTION, SURFACE } from "../lib/tokens.ts";
import { ChevronRightIcon, ClockIcon } from "./panelIcons.tsx";
import { Truncate } from "./Truncate.tsx";
import type { InboxItemView } from "../types.ts";

export function InboxTray({
  snoozed,
  now,
  trayRef,
  armed,
}: {
  snoozed: InboxItemView[];
  now: number;
  /** The drop target's element, for the pointer handler. See `useInboxDrag`. */
  trayRef: (el: HTMLElement | null) => void;
  /**
   * A card is being dragged over this.
   *
   * THE STRIP SAYS SO RATHER THAN THE CARD DOES. What somebody needs to know mid-drag is whether
   * letting go will do anything, and that is a property of the target — a card that changed colour
   * would be telling them about itself.
   */
  armed: boolean;
}) {
  const [open, setOpen] = useState(false);
  const line = trayLine(snoozed, now);

  // NOTHING SNOOZED AND NOTHING BEING DRAGGED: the strip is not there at all. An empty tray is a
  // permanent bar of chrome saying "0 snoozed", which is the noise the empty-sections discipline
  // exists to prevent — and a drop target for a drag nobody has started is a target for nothing.
  if (!line && !armed) return null;

  return (
    <div
      ref={trayRef}
      className="shrink-0 border-t transition-colors motion-reduce:transition-none"
      style={{
        borderColor: armed ? "#3a3a44" : SURFACE.chrome,
        background: armed ? SURFACE.active : "transparent",
        transitionDuration: `${MOTION.fast}ms`,
      }}
    >
      <button
        onClick={() => setOpen((o) => !o)}
        className="flex w-full items-center gap-2 px-5 py-2 text-left text-tiny text-muted transition-colors hover:text-ink"
        // §7's rule for an icon-only control applies to a control whose label is a computed
        // sentence too: the name says what pressing it does, which the sentence does not.
        aria-label={open ? "Collapse the snooze tray" : "Expand the snooze tray"}
        aria-expanded={open}
      >
        <span className="shrink-0 text-faint" aria-hidden>
          <ClockIcon size={ICON.xs} />
        </span>
        {armed ? (
          <span className="text-ink">Let go to snooze until tomorrow</span>
        ) : (
          <span>{line}</span>
        )}
        <span
          className="ml-auto shrink-0 text-faint transition-transform motion-reduce:transition-none"
          style={{ transform: open ? "rotate(90deg)" : undefined, transitionDuration: `${MOTION.fast}ms` }}
          aria-hidden
        >
          <ChevronRightIcon size={ICON.xs} />
        </span>
      </button>

      {open && snoozed.length > 0 && (
        <div className="max-h-[168px] overflow-y-auto border-t border-hair px-5 py-1">
          {snoozed.map((item) => (
            <div key={item.id} className="flex items-center gap-2 py-1">
              <Truncate className="min-w-0 flex-1 text-tiny text-muted" title={item.subject}>
                {item.subject}
              </Truncate>
              <span className="shrink-0 text-tiny tabular-nums text-faint">
                {item.snoozed_until ? shortDuration(Math.max(0, Date.parse(item.snoozed_until) - now)) : ""}
              </span>
              {/* UN-SNOOZE, WHICH §5.4 ASKS FOR PER ITEM. It is a snooze of zero rather than a fourth
                  verb: the server's three durations are the only ones a client may name, and "back
                  now" is the same write with a timestamp already past. That keeps the undo ledger,
                  the capability check and the broadcast on one path. */}
              <button
                onClick={() => sendSnoozeInboxItem(item.id, "hour")}
                title="Bring it back in an hour instead"
                aria-label={`Bring ${item.subject} back in an hour instead`}
                className="shrink-0 rounded-control px-1.5 py-0.5 text-tiny text-faint transition-colors hover:bg-active active:bg-chrome hover:text-ink"
              >
                1h
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
