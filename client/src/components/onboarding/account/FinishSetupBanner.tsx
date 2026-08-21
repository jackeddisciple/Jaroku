// §5.1's consequence of "Skip setup": "Clicking it lands the user in the main app with a persistent
// top banner: 'Finish setting up your workspace →' that reopens onboarding."
//
// PERSISTENT IS THE LOAD-BEARING WORD. It has no dismiss, and that is a deliberate departure from
// how this product treats almost everything else — the invite notice can be closed, the undo toast
// expires, the enforcement strip disappears when the rung lifts. This one stays, because the state
// it describes does not resolve on its own and there is no other surface that mentions it. A banner
// somebody can dismiss is a banner that becomes invisible thirty seconds after they meant to come
// back to it, and then the workspace is unnamed forever.
//
// IT IS NOT AN ERROR AND IT DOES NOT LOOK LIKE ONE. Skipping setup is a legitimate choice — §5.1
// offers it — so this is a quiet strip in the panel colour rather than the amber `EnforcementStrip`
// or anything with a status hue on it. What it says is "there is more here", not "something is
// wrong".
//
// AND IT RENDERS NOTHING FOR ALMOST EVERYBODY. `skipped` is false for anyone who went through the
// flow, and false again on the next launch — the flag is this window's, so a relaunch shows the
// five screens from wherever they were, which is the honest reading of "they have not set up yet".

import { ICON } from "../../../lib/tokens.ts";
import { useAccountOnboardingStore } from "../../../store/accountOnboardingStore.ts";
import { useSessionStore } from "../../../store/sessionStore.ts";

export function FinishSetupBanner() {
  const skipped = useAccountOnboardingStore((s) => s.skipped);
  const resume = useAccountOnboardingStore((s) => s.resume);
  // BOTH CONDITIONS, because `skipped` alone is not enough: somebody who skipped and later finished
  // the flow from this very banner has `skipped: false` again, but somebody who skipped and then
  // completed onboarding another way would not — and a banner offering to finish something already
  // finished is worse than no banner.
  const onboarded = useSessionStore((s) => s.user?.onboarded ?? true);

  if (!skipped || onboarded) return null;

  return (
    <div className="flex shrink-0 flex-wrap items-center gap-x-3 gap-y-2 border-b border-edge bg-panel px-4 py-2">
      <span className="text-[12px] leading-[1.5] text-muted">
        Your workspace isn&rsquo;t set up yet.
      </span>
      <button
        type="button"
        onClick={resume}
        className="group inline-flex items-center gap-1.5 rounded-control px-1.5 py-0.5 text-[12px]
          font-medium text-ink outline-none transition-colors duration-fast hover:text-ember
          focus-visible:shadow-focusring"
      >
        Finish setting up
        {/* The arrow §5.1 draws. It moves on hover, which is the smallest possible way to say the
            control goes somewhere rather than doing something in place. */}
        <svg
          width={ICON.xs}
          height={ICON.xs}
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth={ICON.strokeWidth}
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden
          className="transition-transform duration-fast group-hover:translate-x-0.5"
        >
          <path d="M5 12h14M13 6l6 6-6 6" />
        </svg>
      </button>
    </div>
  );
}
