// §5 — the five screens between a session and a working workspace.
//
// FIVE SCREENS, LINEAR, EACH SKIPPABLE, AND ONE OF THEM MANDATORY. §5.1 draws them in an order and
// §5.2 names the only step that cannot truly be skipped: "workspace name — the only truly mandatory
// step in this flow; provider key and first agent are optional". Even that one is skippable in the
// sense that matters — skipping it accepts the pre-filled name rather than refusing to move —
// because a workspace has to exist for anybody to do anything, so the choice is between "name it"
// and "name it for them", never between "name it" and "have none".
//
// THE STEP LIVES ON THE SERVER AND IS READ ONCE. §5.3's resume is the reason: somebody who closes
// the app on step 3 resumes on step 3, on a different machine, which a browser cannot answer. See
// store/accountOnboardingStore.ts.
//
// AND IT REPLACES THE OLD WELCOME SCREEN RATHER THAN SITTING IN FRONT OF IT. There used to be a
// browser-tracked `welcome → prompt → run` flow whose first screen was a full-bleed introduction;
// §5.1 step 1 is that screen, personalised and server-tracked. What survives from the old one is
// the progressive reveal — the sidebar and right panel arriving as the first agent generates —
// which is a different thing and still lives in `uiStore`.

import { useEffect } from "react";
import { firstNameOf, stepAt } from "../../../lib/accountOnboarding.ts";
import { accountOnboardingOnScreen, useAccountOnboardingStore } from "../../../store/accountOnboardingStore.ts";
import { useSessionStore } from "../../../store/sessionStore.ts";
import { WelcomeStep } from "./WelcomeStep.tsx";
import { WorkspaceStep } from "./WorkspaceStep.tsx";
import { ProviderStep } from "./ProviderStep.tsx";
import { AgentStep } from "./AgentStep.tsx";
import { ReadyStep } from "./ReadyStep.tsx";

export function AccountOnboarding() {
  const step = useAccountOnboardingStore((s) => s.step);
  const displayName = useSessionStore((s) => s.user?.displayName ?? null);
  const firstName = firstNameOf(displayName);

  // Nothing to render until the resume point has landed. `accountOnboardingOnScreen` already
  // guards this, and the check is repeated rather than assumed because a component that renders
  // `stepAt(null)` is a component one refactor away from rendering step 1 over a working app.
  if (step === null) return null;

  const at = stepAt(step);
  if (at === "workspace") return <WorkspaceStep firstName={firstName} />;
  if (at === "provider") return <ProviderStep />;
  if (at === "agent") return <AgentStep />;
  if (at === "ready") return <ReadyStep />;
  return <WelcomeStep firstName={firstName} />;
}

/**
 * Read the resume point off the session, once it lands.
 *
 * A HOOK RATHER THAN AN EFFECT INSIDE `AccountOnboarding`, because the store has to hydrate whether
 * or not the flow is on screen: `accountOnboardingOnScreen` reads `step !== null`, so a component
 * that only hydrated while it was already rendering would never render at all. It is called from
 * `App`, beside the other session-shaped effects.
 */
export function useAccountOnboardingHydration(): void {
  const onboardingStep = useSessionStore((s) => s.user?.onboardingStep ?? null);
  const hydrate = useAccountOnboardingStore((s) => s.hydrate);
  useEffect(() => {
    if (onboardingStep !== null) hydrate(onboardingStep);
  }, [onboardingStep, hydrate]);
}

/** Whether the five screens should be showing. Re-exported so `App` imports one thing. */
export { accountOnboardingOnScreen };
