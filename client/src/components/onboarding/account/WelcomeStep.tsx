// §5.1 step 1 — the framing, personalised, and one decision.
//
// IT IS THE ONE SCREEN IN THE FLOW THAT ASKS FOR NOTHING, and that is deliberate: launching
// straight into "name your workspace" reads as a form, and the three lines below are what make the
// next four screens feel like setup rather than paperwork. They are also a promise — "about a
// minute" — which is why the rail underneath is worth having.
//
// THE GREETING USES A FIRST NAME OR NOTHING. `firstNameOf` never falls back to an email address:
// "Welcome, ada.lovelace+jaroku" is worse than no greeting, so a person with no name on file gets
// "Welcome to Jaroku" and the screen reads perfectly well without them.
//
// AND "SKIP SETUP" IS HERE RATHER THAN A "SKIP FOR NOW". §5.1 distinguishes them: this one leaves
// the whole flow and lands somebody in the app with a persistent banner, while the skips on steps
// 2-4 move to the next screen. Two different actions, two different words.

import { PrimaryButton } from "../../auth/controls.tsx";
import { useAccountOnboardingStore } from "../../../store/accountOnboardingStore.ts";
import { StepShell } from "./StepShell.tsx";
import { Reveal } from "../Reveal.tsx";

/** §5.1's own list, verbatim. Three lines, and two of them say "optional" out loud. */
const PLAN = [
  { text: "Name your workspace", optional: false },
  { text: "Connect a model provider", optional: true },
  { text: "Generate your first agent", optional: true },
];

export function WelcomeStep({ firstName }: { firstName: string | null }) {
  const advance = useAccountOnboardingStore((s) => s.advance);
  const skip = useAccountOnboardingStore((s) => s.skip);

  return (
    <StepShell
      step={1}
      title={firstName ? `Welcome, ${firstName}` : "Welcome to Jaroku"}
      subtitle="Let's get your workspace set up in about a minute."
      // SKIP SETUP, NOT SKIP FOR NOW. See the header — this one leaves the flow entirely.
      skip={{ label: "Skip setup", onSkip: skip }}
    >
      <div className="flex flex-col gap-6">
        <Reveal>
          <ul className="flex flex-col gap-3">
            {PLAN.map((item) => (
              <li key={item.text} className="flex items-baseline gap-3">
                <span aria-hidden className="mt-[1px] h-1 w-1 shrink-0 rounded-full bg-muted" />
                <span className="text-[13px] leading-[1.5] text-ink">
                  {item.text}
                  {/* SAID ON THE SCREEN THAT SETS EXPECTATIONS, not only on the step itself.
                      Somebody deciding whether to spend a minute on this needs to know that two of
                      the three things are optional BEFORE they start, not when they arrive at one. */}
                  {item.optional && <span className="text-muted"> — optional</span>}
                </span>
              </li>
            ))}
          </ul>
        </Reveal>

        <Reveal delay={120}>
          <PrimaryButton onClick={advance} autoFocus>
            Let&rsquo;s go
          </PrimaryButton>
        </Reveal>
      </div>
    </StepShell>
  );
}
