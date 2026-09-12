// §14 — the chat surface's bindings, as a decision table rather than as conditions in a listener.
//
// §14 OPENS WITH THE GAP: "the product describes itself as keyboard-first and every action reachable
// without a mouse. Threads has J/K and the Cmd+K palette; the trace has J/K. Chat currently has
// neither a binding set nor a defined focus model."
//
// A PURE FUNCTION BECAUSE EVERY ONE OF §14's RULES IS A CONDITION, and every one of them has a
// wrong answer that is invisible until somebody hits it:
//
//   `↑` ONLY WHEN THE COMPOSER IS EMPTY, "so it never eats cursor movement inside a draft". A
//   binding that ignored that would move somebody's caret out of the third line of a paragraph they
//   were writing, and they would not know why.
//
//   `R` IS ALREADY TAKEN, and by something that spends money: `BuildPane` binds bare `R` to running
//   the agent on its last test input. The product owner's call (2026-09-12) is that the selection
//   decides — with a turn selected, `R` regenerates it; with nothing selected, `R` keeps re-running
//   the agent. So this table answers "which R" rather than either owner guessing.
//
//   `Esc` WITH NO STREAM OPEN "clears the composer selection state; NEVER closes the view". A
//   handler that let Esc bubble would take the whole pane away from somebody who meant to stop an
//   answer that had already finished.
//
//   npm run test:chat-keys

/** What the chat surface needs to know about the moment a key arrives. */
export interface ChatKeyState {
  /** True when a reply is streaming in the open thread — what `Esc` acts on. */
  streaming: boolean;
  /** The turn J/K has selected, or null. What `R` and `Enter` act on. */
  selectedTurnId: string | null;
  /** Whether the selected turn is an assistant turn that can be regenerated (§6.2). */
  selectedIsRegenerable: boolean;
  /** Whether the composer has anything in it — what decides `↑` (§14.1). */
  composerEmpty: boolean;
  /** True while the caret is inside the composer or another typing target. */
  typing: boolean;
  /** A full-screen destination owns the screen, so it owns the bare keys. See `bareKeys.ts`. */
  viewOwnsScreen: boolean;
  /** The palette is an overlay over everything beneath it. */
  paletteOpen: boolean;
}

/** What the chat surface should do about a key. */
export type ChatKeyAction =
  | { do: "stop" }
  | { do: "editLast" }
  | { do: "moveTurn"; delta: 1 | -1 }
  | { do: "expandTurn" }
  | { do: "regenerate" }
  /** §14.2's keyboard escape: a printable character while a turn is selected starts a draft. */
  | { do: "startDraft"; char: string }
  /** §14.1: `Esc` with no stream open clears the selection and never closes the view. */
  | { do: "clearSelection" }
  /** Not ours — let it through untouched. */
  | null;

/** The parts of a `KeyboardEvent` this decision reads. A real event satisfies it. */
export interface ChatKeyEvent {
  key: string;
  metaKey: boolean;
  ctrlKey: boolean;
  altKey: boolean;
  shiftKey: boolean;
}

/**
 * §14.1's table, in one place.
 *
 * THE ORDER OF THE CLAUSES IS THE DESIGN, and the two at the top are the ones that keep every other
 * binding safe:
 *
 *   A MODIFIER MEANS IT IS NOT OURS. `⌘↵` is the composer's send and `⌘K` is the palette; a table
 *   that claimed bare letters without checking would have eaten both.
 *
 *   AND AN OVERLAY OR A FULL-SCREEN DESTINATION OWNS THE SCREEN. `bareKeys.ts` states the rule and
 *   the reason: pressing `r` on the Threads board once dispatched a real run of whichever agent was
 *   selected in the sidebar, because that listener guarded the modifiers and the typing target and
 *   missed the one about the rest of the application.
 */
export function chatKeyAction(e: ChatKeyEvent, s: ChatKeyState): ChatKeyAction {
  // `Esc` IS THE ONE KEY THAT WORKS WHILE TYPING, and it has to: §14.2 says "on Esc: the stream
  // stops and focus returns to the composer", and somebody who has started typing their next
  // message is exactly the person who wants to stop the answer to the last one.
  if (e.key === "Escape" && !e.metaKey && !e.ctrlKey && !e.altKey) {
    if (s.paletteOpen) return null;
    // §14.1: "With no stream open, clears the composer selection state; NEVER closes the view."
    return s.streaming ? { do: "stop" } : { do: "clearSelection" };
  }

  if (e.metaKey || e.ctrlKey || e.altKey) return null;
  if (s.paletteOpen || s.viewOwnsScreen) return null;

  // §14.1's `↑`: "only when the composer is empty, so it never eats cursor movement inside a
  // draft." The typing check is not enough on its own — the caret is IN the composer for the case
  // this rule is about.
  if (e.key === "ArrowUp") {
    return s.typing && !s.composerEmpty ? null : { do: "editLast" };
  }

  // EVERY BINDING BELOW IS A BARE LETTER, so a typing target owns them all — a filter field, a
  // rename in progress, the composer. `bareKeys.ts` is where that rule lives; this is the one
  // place in the chat surface that asks it.
  if (s.typing) return null;

  if (e.key === "j" || e.key === "J") return { do: "moveTurn", delta: 1 };
  if (e.key === "k" || e.key === "K") return { do: "moveTurn", delta: -1 };
  if (e.key === "Enter") return s.selectedTurnId ? { do: "expandTurn" } : null;

  // §14.1's `R`, AND THE COLLISION IT RESOLVES. `R` already re-runs the AGENT on its last test
  // input — a real run that spends money — and §14 asks for it to regenerate the selected turn.
  // The selection decides: a turn selected means regenerate it, and nothing selected leaves the
  // existing binding exactly as it was. Neither owner has to know about the other.
  if (e.key === "r" || e.key === "R") {
    return s.selectedTurnId && s.selectedIsRegenerable ? { do: "regenerate" } : null;
  }

  // §14.2's KEYBOARD ESCAPE: "typing a printable character returns focus to the composer and starts
  // a draft with that character, SO THE KEYBOARD NEVER BECOMES A TRAP." Without it, J/K navigation
  // is a mode somebody has to know how to leave — and the way out would be the mouse, in a surface
  // whose whole claim is that it does not need one.
  if (s.selectedTurnId && isPrintable(e.key)) return { do: "startDraft", char: e.key };

  return null;
}

/**
 * One character that would appear if it were typed into a field.
 *
 * LENGTH ONE IS THE WHOLE TEST, and it is the right one: `KeyboardEvent.key` is the character for a
 * printable key and a NAME — `ArrowLeft`, `Tab`, `F5`, `Backspace` — for every other. Space is
 * deliberately excluded: it is how somebody scrolls a conversation they are reading, and starting a
 * draft with a leading space would take the page out from under them.
 */
function isPrintable(key: string): boolean {
  return key.length === 1 && key !== " ";
}
