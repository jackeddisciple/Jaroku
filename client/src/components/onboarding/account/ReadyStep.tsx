// §5.1 step 5 — the last screen, and the one that decides somebody has onboarded.
//
// §5.2: "onboarding_completed_at is set when … the user has taken an engagement action: either
// clicked 'Open Jaroku' on Step 5, OR closed the onboarding modal via any means after reaching at
// least Step 3. Auth alone does not count. The engagement moment is what makes onboarding
// meaningful — a user who signed in and immediately closed the app has not been onboarded."
//
// SO THIS BUTTON IS THE ENGAGEMENT ACTION, and the other half of that sentence — closing after step
// 3 — is handled where closing is observable, which is not here. See `AccountOnboardingCloseGuard`
// below.
//
// THE THREE SUGGESTIONS ARE §5.1'S OWN AND THEY ARE NOT DECORATION. Each names a thing the person
// can do in the next thirty seconds with what they now have, and each is a place in the app rather
// than a concept — "the Graph tab", "the composer". A closing screen that said "you're all set!"
// and nothing else would be a screen that has finished a setup and started nothing.

import { PrimaryButton } from "../../auth/controls.tsx";
import { AuthNotice } from "../../auth/AuthShell.tsx";
import { ICON } from "../../../lib/tokens.ts";
import { useAccountOnboardingStore } from "../../../store/accountOnboardingStore.ts";
import { Reveal } from "../Reveal.tsx";

/** §5.1's three, verbatim in intent. Each is one thing to do next, in the place it happens. */
const NEXT = [
  "Run your agent to see it work",
  "Check the Graph tab to see its structure",
  "Ask Jaroku to change it, in the composer",
];

export function ReadyStep() {
  const finish = useAccountOnboardingStore((s) => s.finish);

  return (
    <AuthNotice>
      <Reveal>
        <span className="mx-auto flex h-14 w-14 items-center justify-center rounded-full border border-ok/30 bg-ok/10 text-ok animate-check-in motion-reduce:animate-none">
          <svg
            width={ICON.md * 1.5}
            height={ICON.md * 1.5}
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <path d="M20 6 9 17l-5-5" />
          </svg>
        </span>
      </Reveal>

      <Reveal delay={60}>
        <h1 className="mt-7 text-display text-ink">You&rsquo;re all set</h1>
      </Reveal>

      <Reveal delay={120}>
        <p className="mt-3 text-label leading-[1.6] text-muted">A few things to try next:</p>
      </Reveal>

      <Reveal delay={180}>
        <ul className="mx-auto mt-4 flex max-w-[34ch] flex-col gap-2.5 text-left">
          {NEXT.map((item) => (
            <li key={item} className="flex items-baseline gap-3">
              <span aria-hidden className="h-1 w-1 shrink-0 rounded-full bg-muted" />
              <span className="text-label leading-[1.5] text-ink">{item}</span>
            </li>
          ))}
        </ul>
      </Reveal>

      <Reveal delay={260}>
        <div className="mx-auto mt-9 max-w-[300px]">
          <PrimaryButton onClick={finish} autoFocus>
            Open Jaroku
          </PrimaryButton>
        </div>
      </Reveal>
    </AuthNotice>
  );
}
