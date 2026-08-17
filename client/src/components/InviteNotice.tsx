// The one thing an invitation link has to say for itself.
//
// It is app-level rather than a strip in a panel, and that is forced by when it happens: somebody
// arrives from a link, signs in, and the redemption resolves before they have opened anything. There
// is no panel it could belong to — and on success the very next thing that happens is a workspace
// switch, which empties every workspace store and would take a notice held in one with it.
//
// A FAILURE IS THE IMPORTANT HALF. Every reason a redemption fails is final: expired, revoked,
// already used, addressed to somebody else. Without this, the link would appear to do nothing at
// all, which is indistinguishable from the product being broken.

import { useUiStore } from "../store/uiStore.ts";
import { ICON } from "../lib/tokens.ts";
import { CheckIcon, XIcon } from "./panelIcons.tsx";

export function InviteNotice() {
  const notice = useUiStore((s) => s.inviteNotice);
  const dismiss = useUiStore((s) => s.setInviteNotice);
  if (!notice) return null;

  return (
    <div className="pointer-events-none fixed inset-x-0 bottom-10 z-40 flex justify-center px-4">
      <div
        className={`pointer-events-auto flex max-w-lg items-start gap-2 rounded-card border bg-panel px-3 py-2 shadow-overlay ${
          notice.ok ? "border-ok/40" : "border-err/40"
        }`}
      >
        <span className={`mt-0.5 shrink-0 ${notice.ok ? "text-ok" : "text-err"}`}>
          {notice.ok ? <CheckIcon size={ICON.xs} /> : <XIcon size={ICON.xs} />}
        </span>
        <p className="min-w-0 flex-1 text-[12px] leading-[1.5] text-ink">{notice.message}</p>
        <button
          onClick={() => dismiss(null)}
          title="Dismiss"
          className="shrink-0 rounded-control px-1 py-0.5 text-faint transition-colors hover:bg-active hover:text-ink"
        >
          <XIcon size={ICON.xs} />
        </button>
      </div>
    </div>
  );
}
