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
//
// The composition, top to bottom, is an argument in four moves: the mark says who, the promise
// says what, the paragraph says how, and the button is the only thing left to do. It arrives in
// that order too — see Reveal — because a screen that fades in all at once has no opinion about
// what to read first, and this one does.
//
// What it replaced had the same four pieces, evenly spaced and all one weight. Everything true
// about the product was on it and none of it was the first thing you saw. The fix is hierarchy
// rather than furniture: one line of type large enough to be the claim, one paragraph small
// enough to be the detail, one filled control, and a rule under the three facts that decide
// whether somebody is willing to type an API key at all.

import { useUiStore } from "../../store/uiStore.ts";
import { JarokuGlyph } from "../../lib/icons.tsx";
import { ICON } from "../../lib/tokens.ts";
import { LockIcon, ShieldCheckIcon, ZapIcon } from "../panelIcons.tsx";
import { OnboardingSurface } from "./OnboardingSurface.tsx";
import { PrimaryCta } from "./Cta.tsx";
import { Reveal } from "./Reveal.tsx";

/**
 * The three facts worth having before the next screen asks for a credential.
 *
 * They were one grey sentence under the button, which is where copy goes when nobody has decided
 * whether it matters. Two of them decide whether a person is willing to type an API key at all,
 * so they are given a row of their own, each with its own mark, level with each other. Still the
 * quietest thing on the screen — but read, rather than skipped.
 */
const FACTS = [
  { icon: LockIcon, label: "Runs on your machine", hint: "keys and agents stay on this disk" },
  { icon: ShieldCheckIcon, label: "No account", hint: "nothing is proxied through us" },
  // The same mark the free path wears on step 3, so the promise made here is recognisable
  // when it is kept two screens later.
  { icon: ZapIcon, label: "A free path", hint: "the dry-run provider needs no key" },
];

export function WelcomeStep() {
  const setStep = useUiStore((s) => s.setOnboardingStep);

  return (
    <OnboardingSurface step="welcome">
      <div className="flex flex-col items-center text-center">
        {/* The mark, with its own light behind it. Bigger than it is anywhere else in the app,
            because this is the one screen where it is the subject rather than the signature. */}
        <Reveal>
          <div className="relative flex items-center justify-center">
            <span
              aria-hidden
              className="absolute h-24 w-24 rounded-full animate-breathe motion-reduce:animate-none"
              style={{
                background:
                  "radial-gradient(circle, rgba(228,228,231,0.13), rgba(228,228,231,0.03) 52%, transparent 72%)",
                filter: "blur(10px)",
              }}
            />
            <span className="relative text-ink">
              <JarokuGlyph size={40} />
            </span>
          </div>
        </Reveal>

        {/* The promise, verbatim from §11 — the one line the doc says appears everywhere. It is
            the headline now rather than "Welcome to Jaroku", which named the screen instead of
            the product.
            Broken where the sentence already breaks: the first line is what the product asks of
            you and the second is what it gives back, so the two halves can carry different ink
            without the split reading as arbitrary. The break is hard rather than left to the
            container, because a promise that re-wraps at 900px is a promise with a typo in it. */}
        <Reveal delay={60}>
          <h1 className="mt-6 text-[30px] font-semibold leading-[1.25] tracking-[-0.01em] text-ink">
            Describe your agent. Watch it think.
            <br />
            <span className="text-muted">Fix it by talking. Ship it.</span>
          </h1>
        </Reveal>

        {/* The claim above is a promise; this is what actually happens. Deliberately not
            rewritten softer — what it describes is precisely what the next four minutes do. */}
        <Reveal delay={120}>
          <p className="mt-4 max-w-[58ch] text-[14px] leading-[1.65] text-muted">
            You describe an agent in plain English. Jaroku plans it, writes it as a real LangGraph
            project on your disk, runs it, and shows you every LLM call, tool call, routing
            decision and state mutation it made.
          </p>
        </Reveal>

        <Reveal delay={200}>
          <div className="mt-9">
            <PrimaryCta onClick={() => setStep("prompt")} autoFocus kbd="↵">
              Get started
            </PrimaryCta>
          </div>
        </Reveal>

        <Reveal delay={260} className="w-full">
          <ul className="mt-9 flex flex-wrap items-start justify-center gap-x-8 gap-y-3 border-t border-hair pt-5">
            {FACTS.map((f) => (
              <li key={f.label} className="flex items-start gap-2 text-left">
                <span className="mt-[2px] shrink-0 text-faint" aria-hidden>
                  <f.icon size={ICON.xs} />
                </span>
                <span>
                  <span className="block text-[12px] leading-[1.4] text-muted">{f.label}</span>
                  <span className="block text-[11px] leading-[1.4] text-faint">{f.hint}</span>
                </span>
              </li>
            ))}
          </ul>
        </Reveal>
      </div>
    </OnboardingSurface>
  );
}
