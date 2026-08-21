// §5's five steps, as a shape rather than as five components that each know what comes next.
//
// THE STEPS ARE DATA AND THE TRANSITIONS ARE ARITHMETIC, which is what makes §5.3's resume
// possible at all. The server stores an integer; a screen is `STEPS[n - 1]`; "advance" is `n + 1`.
// A flow whose transitions were `setScreen("workspace")` calls scattered through five components
// would have no way to answer "where was this person" from a number, and the number is the only
// thing that survives a laptop closing.
//
// WHY THE NUMBERS ARE THE SPECIFICATION'S OWN. §5.1 draws five screens in an order, §5.3 says
// `onboarding_step` tracks 1-5, and §5.2 defines completion in terms of "past step 3". Renumbering
// them — dropping the welcome screen because it has no input on it, say — would make every one of
// those sentences say something different about a database column people already have values in.

/** The five, in order. The index into this array plus one IS `users.onboarding_step`. */
export const ONBOARDING_STEPS = ["welcome", "workspace", "provider", "agent", "ready"] as const;

export type OnboardingStepId = (typeof ONBOARDING_STEPS)[number];

/** 1-5. Deliberately one-based, because the column is. */
export type OnboardingStepNumber = 1 | 2 | 3 | 4 | 5;

export const FIRST_STEP: OnboardingStepNumber = 1;
export const LAST_STEP: OnboardingStepNumber = ONBOARDING_STEPS.length as OnboardingStepNumber;

/**
 * Which screen a step number names, clamped.
 *
 * CLAMPED RATHER THAN REFUSED, because the input is a column and a column can hold a number no
 * screen renders — a row written by a newer build, a value somebody set by hand, a migration that
 * defaulted differently. A person meeting a blank onboarding they cannot leave is a far worse
 * outcome than one meeting the first screen twice.
 */
export function stepAt(step: number): OnboardingStepId {
  const index = Math.min(Math.max(Math.floor(step), FIRST_STEP), LAST_STEP) - 1;
  return ONBOARDING_STEPS[index]!;
}

/** The next step, or the last one. Never past the end. */
export function nextStep(step: number): OnboardingStepNumber {
  return Math.min(Math.max(Math.floor(step), FIRST_STEP) + 1, LAST_STEP) as OnboardingStepNumber;
}

/** The previous step, or the first one. What "Back" means. */
export function previousStep(step: number): OnboardingStepNumber {
  return Math.max(Math.min(Math.floor(step), LAST_STEP) - 1, FIRST_STEP) as OnboardingStepNumber;
}

/**
 * §5.2 — whether reaching this point counts as having onboarded.
 *
 * "onboarding_completed_at is set when: all mandatory steps completed (workspace name — the only
 * truly mandatory step) AND the user has taken an engagement action: either clicked 'Open Jaroku'
 * on Step 5, OR closed the onboarding modal via any means after reaching at least Step 3."
 *
 * SO THE THRESHOLD IS THREE, AND THE REASON IS THE SENTENCE AFTER IT: "Auth alone does not count.
 * The engagement moment is what makes onboarding meaningful — a user who signed in and immediately
 * closed the app has not been onboarded." Somebody who got to step 3 has named a workspace and seen
 * what the product is for; somebody who bounced off step 1 has seen a greeting.
 *
 * THE CONSEQUENCE OF GETTING THIS WRONG IN EITHER DIRECTION IS REAL. Too low, and closing the
 * window on the welcome screen marks somebody onboarded — they never see the flow again and never
 * name a workspace. Too high, and somebody who set everything up and closed the app on the last
 * screen is walked through it all again on their next launch.
 */
export const ENGAGEMENT_STEP = 3;

export function countsAsEngaged(step: number): boolean {
  return Math.floor(step) >= ENGAGEMENT_STEP;
}

/**
 * The first name, for §5.1's greeting and §5.2's pre-filled workspace name.
 *
 * THE FIRST WHITESPACE-SEPARATED TOKEN, and no cleverer than that on purpose. Every heuristic
 * beyond it is wrong for a large share of the world: "李伟" is a family name followed by a given
 * name and splitting it is backwards, "Maria del Carmen" has a first name of three words, and a
 * mononym has no split at all. What this produces for those is "李伟", "Maria" and the whole name —
 * which are, respectively, right, acceptable, and right.
 *
 * IT NEVER FALLS BACK TO AN EMAIL ADDRESS. "Welcome, ada.lovelace+jaroku" is worse than no greeting,
 * and the null this returns is what lets the screen say "Welcome" on its own instead.
 */
export function firstNameOf(displayName: string | null): string | null {
  if (!displayName) return null;
  const first = displayName.trim().split(/\s+/)[0];
  return first && first.length > 0 ? first : null;
}

/**
 * §5.1 step 2's pre-filled value.
 *
 * "Pre-filled with {firstName}'s workspace." And with no name — which happens if somebody skipped
 * §3.4, or if a Google profile carried none — it is "My workspace" rather than an empty box: a
 * mandatory field that starts empty is a mandatory field somebody has to think about, and this one
 * has a perfectly good default that they can accept without reading.
 */
export function defaultWorkspaceName(displayName: string | null): string {
  const first = firstNameOf(displayName);
  return first ? `${first}'s workspace` : "My workspace";
}

/** §5.1: "1-60 chars, trimmed, non-empty." The server holds the same number in WORKSPACE_NAME_MAX. */
export const WORKSPACE_NAME_MAX = 60;
