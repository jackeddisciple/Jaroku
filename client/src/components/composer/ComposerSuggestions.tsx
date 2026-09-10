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
          // A hairline and a hover fill one step off the canvas — a suggestion, not a button asking to
          // be pressed. The focus ring is the one exception to "no shadow": it is how a keyboard user
          // sees where they are.
          className="group flex flex-col items-center gap-2 rounded-card border border-hair px-3 py-3 text-center
            outline-none transition-colors duration-fast hover:border-edge hover:bg-panel
            focus-visible:bg-panel focus-visible:shadow-focusring"
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
