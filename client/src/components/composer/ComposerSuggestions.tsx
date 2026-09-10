// The new-agent screen's four suggestions, under the greeting.
//
// EACH CARD STARTS A SENTENCE RATHER THAN SENDING ONE. A click puts the first word of the card's
// sentence into the composer — `Plan`, `Build`, `Explain`, `Trace` — with the caret after it, and
// nothing else happens: where the message goes is decided by the composer's own rules when it is
// sent, exactly as if the word had been typed. A card never acts on its own.
//
// THE WORD IS READ OFF THE SENTENCE rather than written down beside it, so the command and the
// sentence it begins cannot drift apart.
//
// WHETHER THE CARDS SHOW IS THE CALLER'S, AND IT IS NOT STATE. They are shown while the composer is
// empty and hidden the moment it is not — a reading of the draft, never a flag set by a click.
// Hidden cards keep their space, so the greeting above them does not move while somebody types.
//
// AND THEY ARRIVE RATHER THAN APPEAR, the same way every time. When the screen mounts — a sign-in, a
// return to New — each card rises in on the same `Reveal` the welcome screen uses, sixty milliseconds
// apart. When an emptied composer brings them back, they rise in again exactly as they did the first
// time; leaving is a short fade, because nobody is waiting on it.

import { useState } from "react";
import { ICON } from "../../lib/tokens.ts";
import { Icon, type IconComponent } from "../../lib/icons/registry.ts";
import { Reveal } from "../onboarding/Reveal.tsx";

/**
 * The four cards, in order.
 *
 * EACH MARK HAS ITS OWN COLOUR, and every one of them is a palette token rather than a value of its
 * own: amber for Plan, the bespoke purple for Build, success green for Explain, danger red for Trace.
 * A palette change moves them with everything else, and the colour suite's "no component carries its
 * own palette" rule holds.
 */
const SUGGESTIONS: { sentence: string; Mark: IconComponent; tone: string }[] = [
  { sentence: "Plan an agent from an idea", Mark: Icon.emptyState.plan, tone: "text-run" },
  { sentence: "Build and modify your agent", Mark: Icon.emptyState.build, tone: "text-bespoke" },
  { sentence: "Explain what your agent is doing", Mark: Icon.emptyState.explain, tone: "text-ok" },
  { sentence: "Trace an agent execution", Mark: Icon.emptyState.trace, tone: "text-err" },
];

/** The command a card inserts: the first word of its sentence. */
export function commandOf(sentence: string): string {
  return sentence.trim().split(/\s+/, 1)[0] ?? "";
}

export function ComposerSuggestions({
  hidden,
  onPick,
  className = "",
}: {
  hidden: boolean;
  onPick: (command: string) => void;
  className?: string;
}) {
  /**
   * How many times the cards have come back. Each return re-keys the grid, so every card's `Reveal`
   * mounts again and rises in as it did the first time. Adjusted DURING RENDER, React's pattern for
   * following a prop, rather than in an effect — an effect runs after paint, which would show the
   * cards fully there for one frame and then snap them back to the start of their rise.
   *
   * THIS IS NOT A SECOND ANSWER TO "ARE THE CARDS SHOWING". That is still `hidden`, read off the
   * draft by the caller; this only counts the moments it turned false.
   */
  const [round, setRound] = useState(0);
  const [wasHidden, setWasHidden] = useState(hidden);
  if (wasHidden !== hidden) {
    setWasHidden(hidden);
    if (wasHidden) setRound(round + 1);
  }

  return (
    // THE WRAPPER CARRIES SHOWING AND HIDING; the cards inside carry their own entrance. Two elements,
    // because the entrance is an animation and the show/hide is a transition, and one element doing
    // both would have whichever finished last decide its opacity.
    //
    // `visibility` IS IN THE TRANSITION ON PURPOSE. It switches to visible at the start of a fade in
    // and to hidden at the end of a fade out, so the cards are seen for the whole of both and are out
    // of the tab order and the accessibility tree once they have gone. `pointer-events-none` applies
    // at once, so a card that is still fading out cannot be clicked over what somebody just typed.
    <div
      //
      // AS WIDE AS THE COMPOSER AND NO WIDER. 45rem is the composer card's own width, so the row of
      // cards and the box they start share both edges — the product owner's call on 2026-09-10, when
      // the cards grew from a 40rem row.
      className={`w-full max-w-[45rem] transition-[opacity,transform,visibility] duration-collapse ease-smooth motion-reduce:transition-none ${
        hidden ? "pointer-events-none invisible translate-y-1 opacity-0" : "visible translate-y-0 opacity-100"
      } ${className}`}
    >
      {/* FOUR ACROSS WHERE THERE IS ROOM, fewer where there is not. The columns are sized off the
          panel the cards sit in rather than off the window, because the middle panel's width moves
          with the sidebar and the right panel, and a viewport breakpoint would get that wrong. */}
      <div key={round} className="grid grid-cols-[repeat(auto-fit,minmax(8.5rem,1fr))] gap-3">
        {SUGGESTIONS.map(({ sentence, Mark, tone }, i) => (
          <Reveal key={sentence} delay={i * 60} className="flex">
            <button
              type="button"
              onClick={() => onPick(commandOf(sentence))}
              // LIFTED AT REST, ON PURPOSE. Everywhere else in the client a card rests flat; these four
              // are the only things on an otherwise empty screen, and flat they read as part of the page
              // rather than as something to press. So they sit on the card surface at E2 — the product's
              // decision, and named as an exception in surfaceSystem.test.ts rather than slipped past it.
              // The pointer brightens the face and deepens the border; the focus ring is how a keyboard
              // user sees where they are.
              className="group flex w-full flex-col items-start gap-4 rounded-lg border border-hair bg-panel p-5 text-left
                shadow-floating outline-none transition-colors duration-fast hover:border-edge hover:bg-elevated
                focus-visible:bg-elevated focus-visible:shadow-focusring"
            >
              <span className={tone} aria-hidden>
                <Mark size={ICON.md} />
              </span>
              <span className="text-balance text-label leading-[1.4] text-muted transition-colors duration-fast group-hover:text-ink group-focus-visible:text-ink">
                {sentence}
              </span>
            </button>
          </Reveal>
        ))}
      </div>
    </div>
  );
}
