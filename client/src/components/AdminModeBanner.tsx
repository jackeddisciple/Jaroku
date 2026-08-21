// The banner that exists to prevent forgetting.
//
// IT IS NOT DISMISSIBLE, and that is the whole design rather than an oversight. Admin mode removes
// every limit this product has; the failure it guards against is not somebody abusing it but
// somebody leaving it on — recording a demo, taking a screenshot, debugging a customer's report and
// concluding the limits work fine. A banner somebody can close is a banner that is closed.
//
// RED AND NEVER SUBTLE. The specification says so in as many words, and the reason is the
// screenshot case: if an image goes out with admin mode on, this is the thing that makes it obvious
// before it is published rather than after. A tasteful grey strip would be edited out of somebody's
// attention within a day.
//
// ABSENT FROM THE DOM ENTIRELY when the mode is off — and when the account is not an admin, the
// component never renders anything at all, because `isAdmin` is false and there is nothing here to
// find. The same rule the toggle follows: invisible rather than hidden.
//
// IT SITS ABOVE THE SHELL beside `EnforcementStrip`, which is the other thing in this app that is
// true about the whole session rather than about whatever is on screen. The two are never on
// together in practice, and if they were, both being visible is the correct outcome.

import { useState } from "react";
import { useSessionStore } from "../store/sessionStore.ts";
import { ICON } from "../lib/tokens.ts";
import { AlertTriangleIcon } from "./panelIcons.tsx";

export function AdminModeBanner() {
  const user = useSessionStore((s) => s.user);
  const setAdminMode = useSessionStore((s) => s.setAdminMode);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Nothing at all for anybody who is not currently bypassing limits. Both flags, because
  // `adminMode` alone would render this for a session whose claim the server never honoured.
  if (!user?.isAdmin || !user.adminMode) return null;

  const turnOff = async (): Promise<void> => {
    setBusy(true);
    setError(null);
    try {
      await setAdminMode(false);
    } catch (err) {
      // Surfaced in the banner rather than swallowed: failing to turn admin mode OFF is the one
      // direction of this control that matters, and a silent failure here leaves somebody
      // believing they are back to normal.
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="shrink-0 border-b border-err/50 bg-err/[0.12] px-4 py-2">
      <div className="flex items-center gap-2">
        <span className="shrink-0 text-err"><AlertTriangleIcon size={ICON.sm} /></span>
        <span className="text-[12px] font-medium text-ink">
          Admin mode enabled — bypassing tier limits
        </span>
        <span className="text-[11px] text-muted">
          Every limit is off and every bypass is logged.
        </span>
        <button
          type="button"
          className="ml-auto shrink-0 rounded-control border border-err/50 px-2.5 py-1 text-[11px] text-ink transition-colors hover:bg-err/20 focus-visible:outline-none focus-visible:shadow-focusring disabled:opacity-50"
          disabled={busy}
          onClick={() => void turnOff()}
        >
          {busy ? "Turning off…" : "Turn off"}
        </button>
      </div>
      {error && <p className="mt-1 text-[11px] text-err">Could not turn it off — {error}</p>}
    </div>
  );
}
