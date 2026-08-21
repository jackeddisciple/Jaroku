// The shape all five of §5's screens take, and the rail that says which one this is.
//
// A RAIL, BECAUSE FIVE SCREENS IS ENOUGH TO NEED ONE. §5.1's own copy sets the expectation on the
// first screen — "let's get your workspace set up in about a minute" — and a flow that makes that
// promise has to keep it visibly. "There are five of these and you are on the second" is the fact
// that makes somebody read a screen instead of hunting for the way out of it, and it is the same
// argument `OnboardingSurface`'s three-segment rail already makes one flow over.
//
// IT SHOWS SEGMENTS RATHER THAN "STEP 2 OF 5". A number invites counting how many are left; a row
// of segments where one is lit reads as progress without being a countdown. The label is there for
// screen readers, where a count IS the useful form.
//
// THE SKIP IS ALWAYS IN THE SAME PLACE, and that is worth more than it sounds. §5.1 puts one on
// four consecutive screens, and a skip that moved would be a skip somebody has to find each time —
// which is exactly how an optional step becomes a step people abandon the flow at.

import { QuietButton } from "../../auth/controls.tsx";
import { AuthShell } from "../../auth/AuthShell.tsx";
import { LAST_STEP, ONBOARDING_STEPS } from "../../../lib/accountOnboarding.ts";
import { useAccountOnboardingStore } from "../../../store/accountOnboardingStore.ts";

export interface StepShellProps {
  /** 1-5. Drives the rail and nothing else; the screen decides what it renders. */
  step: number;
  title: string;
  subtitle?: React.ReactNode;
  children: React.ReactNode;
  /**
   * The quiet way past this screen, when there is one.
   *
   * ABSENT ON THE LAST SCREEN AND PRESENT ON THE OTHER FOUR. §5.1's step 5 has one button on it and
   * nothing to skip — it is a summary, and a "skip" on it would be a second way to do the only
   * thing the screen does.
   */
  skip?: { label: string; onSkip: () => void };
  width?: "narrow" | "wide";
}

export function StepShell({ step, title, subtitle, children, skip, width = "narrow" }: StepShellProps) {
  return (
    <AuthShell
      title={title}
      subtitle={subtitle}
      // THE MARK IS OFF INSIDE THE FLOW. It is the subject on the screens before a session — that
      // is what `BRAND.screen` is for — and by step 2 somebody is signed in and setting up their
      // own workspace, where a logo above every heading is furniture rather than identity.
      mark={step === 1}
      width={width}
      footnote={
        <div className="flex flex-col items-center gap-4">
          <Rail at={step} />
          {skip && <QuietButton onClick={skip.onSkip}>{skip.label}</QuietButton>}
        </div>
      }
    >
      {children}
    </AuthShell>
  );
}

/**
 * Five segments, one lit.
 *
 * The same treatment `OnboardingSurface`'s rail uses — the segment carries the state and the label
 * only names it — so somebody who met that flow recognises this one. Widths differ rather than
 * colours alone, because a colour shift on a two-pixel line is not readable at a glance and "which
 * one am I on" is a glance-level question.
 */
function Rail({ at }: { at: number }) {
  return (
    <div
      className="flex items-center gap-1.5"
      role="group"
      aria-label={`Step ${Math.min(at, LAST_STEP)} of ${ONBOARDING_STEPS.length}`}
    >
      {ONBOARDING_STEPS.map((id, i) => {
        const index = i + 1;
        const here = index === at;
        const done = index < at;
        return (
          <span
            key={id}
            aria-hidden
            className={`h-[3px] rounded-full transition-[width,background-color] duration-base ease-state ${
              here ? "w-7 bg-ink" : done ? "w-3 bg-muted" : "w-3 bg-chrome"
            }`}
          />
        );
      })}
    </div>
  );
}

/**
 * The pair of controls every step but the last carries: a primary action and a quiet skip beside it.
 *
 * TWO WEIGHTS, NOT TWO BUTTONS. §5.1 draws "[ Continue ] [ Skip for now ]" and the temptation is
 * two bordered controls side by side — which is a screen that has not said which one it expects.
 * The skip is genuinely first-class (§5.1 says so about the provider step in as many words) and it
 * is still not what the step is FOR, and those two facts are exactly what a filled button beside a
 * text button says.
 */
export function StepActions({
  children,
  onSkip,
  skipLabel = "Skip for now",
}: {
  children: React.ReactNode;
  onSkip?: () => void;
  skipLabel?: string;
}) {
  return (
    <div className="flex flex-col gap-2">
      {children}
      {onSkip && (
        <div className="flex justify-center">
          <QuietButton onClick={onSkip}>{skipLabel}</QuietButton>
        </div>
      )}
    </div>
  );
}

/** Advance, from a step that has nothing to save. The one-liner four screens share. */
export function useAdvance(): () => void {
  return useAccountOnboardingStore((s) => s.advance);
}
