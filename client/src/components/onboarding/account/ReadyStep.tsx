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
import { useBuildStore } from "../../../store/buildStore.ts";
import { Reveal } from "../Reveal.tsx";

/** §5.1's three, verbatim in intent. Each is one thing to do next, in the place it happens. */
const NEXT = [
  "Run your agent to see it work",
  "Check the Graph tab to see its structure",
  "Ask Jaroku to change it, in the composer",
];

/**
 * The same screen for somebody who has no agent, which step 4's Skip makes a real state.
 *
 * ALL THREE OF THE LINES ABOVE ARE ABOUT AN AGENT — run it, read its graph, change it — and they were
 * rendered unconditionally, so pressing "Skip for now" one screen earlier led straight to a
 * congratulation and three instructions about a thing that does not exist. That is the one failure a
 * closing screen can have: it is the last word, and there is nothing after it to correct the record.
 *
 * SAME SHAPE, SAME PLACES. Each of these is still one thing to do in the next thirty seconds, named
 * by where it happens rather than by what it is — the composer, the plan card, the Secrets tab —
 * because that is what made the original three worth printing.
 */
const NEXT_WITHOUT_AGENT = [
  "Describe the agent you want, in the composer",
  "Approve the plan you get back — nothing is written until you do",
  "Add a provider key in Secrets to run on a real model",
];

export function ReadyStep() {
  const finish = useAccountOnboardingStore((s) => s.finish);
  /**
   * Did step 4 start anything?
   *
   * TWO SOURCES BECAUSE THERE ARE TWO WAYS TO HAVE ONE. `agentStarted` covers the generation this
   * flow just dispatched, which is still in flight when this screen paints and therefore not in the
   * list yet; the list covers a resume that landed on step 5 in a workspace that already has agents.
   * Either is enough, and neither alone is.
   */
  const started = useAccountOnboardingStore((s) => s.agentStarted);
  const hasAgent = useBuildStore((s) => s.agents.length > 0);
  const next = started || hasAgent ? NEXT : NEXT_WITHOUT_AGENT;

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
          {next.map((item) => (
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
