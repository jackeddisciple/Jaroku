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
// Hidden cards keep their space (`invisible`), so the greeting above them does not move while
// somebody types; `visibility: hidden` also takes them out of the tab order and the accessibility tree.

import { ICON } from "../../lib/tokens.ts";
import { Icon, type IconComponent } from "../../lib/icons/registry.ts";

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
  return (
    // FOUR ACROSS WHERE THERE IS ROOM, fewer where there is not. The columns are sized off the panel
    // the cards sit in rather than off the window, because the middle panel's width moves with the
    // sidebar and the right panel, and a viewport breakpoint would get that wrong in both directions.
    <div
      className={`grid w-full max-w-[40rem] grid-cols-[repeat(auto-fit,minmax(8.5rem,1fr))] gap-2 ${
        hidden ? "invisible" : ""
      } ${className}`}
    >
      {SUGGESTIONS.map(({ sentence, Mark, tone }) => (
        <button
          key={sentence}
          type="button"
          onClick={() => onPick(commandOf(sentence))}
          // LIFTED AT REST, ON PURPOSE. Everywhere else in the client a card rests flat; these four
          // are the only things on an otherwise empty screen, and flat they read as part of the page
          // rather than as something to press. So they sit on the card surface at E2 — the product's
          // decision, and named as an exception in surfaceSystem.test.ts rather than slipped past it.
          // The pointer brightens the face and deepens the border; the focus ring is how a keyboard
          // user sees where they are.
          className="group flex flex-col items-start gap-4 rounded-lg border border-hair bg-panel px-4 py-3.5 text-left
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
      ))}
    </div>
  );
}
