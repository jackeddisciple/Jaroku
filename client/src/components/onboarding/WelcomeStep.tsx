// Step 1 — the framing, and nothing else.
//
// A full-screen view that mounts none of Sidebar / BuildPane / RightPanel. That is not a
// styling choice: the three columns are the most expensive thing this app renders, and a
// first-run user has no agent, no trace and no runs, so mounting them underneath a cover would
// pay for three empty panels to be invisible.
//
// No skip. Every other step has one — this one costs a click, shown once, and there is nothing
// here to skip past: it is the sentence that tells you what the product does before it asks
// you for anything.

import { useUiStore } from "../../store/uiStore.ts";
import { JarokuGlyph } from "../../lib/icons.tsx";
import { OnboardingSurface } from "./OnboardingSurface.tsx";
import { SURFACE, TEXT } from "../../lib/tokens.ts";

export function WelcomeStep() {
  const setStep = useUiStore((s) => s.setOnboardingStep);

  return (
    <OnboardingSurface>
      <div className="flex flex-col items-center text-center">
        {/* The mark at the size the top bar uses it, scaled up — the same glyph the app wears
            everywhere else rather than a bespoke splash logo. */}
        <JarokuGlyph size={44} />
        <h1 className="mt-5 text-[28px] font-semibold leading-tight text-ink">Welcome to Jaroku</h1>

        {/* The product's own tagline, verbatim from the README. Deliberately not rewritten for
            this screen: what it promises is precisely what the next four minutes deliver, and a
            softer marketing version would be a smaller claim than the one the product keeps. */}
        <p className="mt-4 max-w-[560px] text-[15px] leading-[1.6] text-muted">
          You describe an agent. Jaroku plans it, writes it as a real LangGraph project on your
          disk, runs it, and shows you every LLM call, tool call, routing decision and state
          mutation it made.
        </p>

        <button
          type="button"
          onClick={() => setStep("provider")}
          autoFocus
          className="mt-9 rounded-control px-6 py-2.5 text-[13px] font-medium transition-opacity hover:opacity-90 focus:outline-none focus:shadow-focusring"
          style={{ background: TEXT.ink, color: SURFACE.bg }}
        >
          Get started
        </button>

        {/* Two facts worth having before the next screen asks for a credential: nothing is
            uploaded, and there is a free path. Said here so the ask arrives expected. */}
        <p className="mt-6 text-[12px] text-faint">
          Everything runs locally. There is a free path that needs no API key at all.
        </p>
      </div>
    </OnboardingSurface>
  );
}
