// §8.3's toast: "This action requires the [Admin/Owner] role."
//
// IT SHOULD NEVER APPEAR, and that is what it is for. §8.3: "If both gates are correctly
// implemented (affordance absent for wrong role, UpsellCard for wrong tier), neither toast should
// ever appear in normal use. They are safety nets." So this is not part of a flow — it is what
// makes a missed guard visible instead of making a button that silently does nothing.
//
// IT DOES NOT NAME THE CAPABILITY, which §8.3 forbids by name: "Do not name the specific
// capability — the user doesn't know what connector:manage means." The server's own sentence does
// name it, correctly, because the audience for a server log is somebody who can read the source;
// what reaches a person is the thing they can act on, which is a role somebody can grant them.
//
// TIMED, UNLIKE `InviteNotice` BESIDE IT. That one explains a link that would otherwise appear to
// do nothing and stays until it is read; this one explains a click, and a click that produced
// nothing is a thing somebody has already stopped thinking about by the time they cross the room.

import { useEffect } from "react";
import { useUiStore } from "../store/uiStore.ts";
import { ICON } from "../lib/tokens.ts";
import { LockIcon, XIcon } from "./panelIcons.tsx";

/** Long enough to read a sentence, short enough not to sit over the thing it is about. */
const SHOWN_MS = 6000;

export function RoleRefusal() {
  const role = useUiStore((s) => s.refusedRole);
  const clear = useUiStore((s) => s.setRefusedRole);

  useEffect(() => {
    if (!role) return;
    const t = setTimeout(() => clear(null), SHOWN_MS);
    return () => clearTimeout(t);
    // Keyed on the role rather than on a counter, which means a second refusal for the SAME role
    // does not restart the clock. That is the right behaviour for a safety net: two refused
    // clicks in a row are one problem, and a toast that re-armed on every click of a button
    // somebody is jabbing at would stay on screen for as long as they kept jabbing.
  }, [role, clear]);

  if (!role) return null;
  // Capitalised here rather than sent capitalised: the server's value is an identifier, and
  // `roleLabel` in workspaceList.ts does the same for the same reason.
  const named = role.charAt(0).toUpperCase() + role.slice(1);

  return (
    <div className="pointer-events-none fixed inset-x-0 bottom-10 z-40 flex justify-center px-4">
      <div
        role="status"
        className="pointer-events-auto flex max-w-lg items-start gap-2 rounded-card border border-edge bg-panel px-3 py-2 shadow-overlay"
      >
        <span className="mt-0.5 shrink-0 text-muted" aria-hidden><LockIcon size={ICON.xs} /></span>
        <p className="min-w-0 flex-1 text-[12px] leading-[1.5] text-ink">
          This action requires the {named} role.
        </p>
        <button
          onClick={() => clear(null)}
          title="Dismiss"
          aria-label="Dismiss"
          className="shrink-0 rounded-control px-1 py-0.5 text-faint transition-colors hover:bg-active active:bg-chrome hover:text-ink"
        >
          <XIcon size={ICON.xs} />
        </button>
      </div>
    </div>
  );
}
