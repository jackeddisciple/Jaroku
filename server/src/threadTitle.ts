// §5's title: the first thing somebody said, cut where a word ends.
//
// NO MODEL CALL. A thread is titled the moment its first message lands, thousands of times a day, and
// a title that cost a token would be a title somebody eventually turns off. So it is the first line,
// truncated, and it is deterministic — the same message always produces the same title, which also
// means a test can assert one.
//
// WHY THE CUT HAPPENS HERE RATHER THAN BEING REPAIRED LATER. `client/src/lib/title.ts` exists because
// `generator.ts` cuts an agent's name at exactly 60 characters with `.slice(0, 60)` and sends the
// result — so "…looks up orders in Postgres" arrives as "…looks up orders in Postgre", stopped
// mid-word, mid-thought, with nothing saying anything was removed. That module reconstructs what was
// lost by comparing the name against the full description, which works and is a repair.
//
// A thread title needs no repair, because this is the cut. It stops at a word boundary and says so
// with an ellipsis, so `displayTitle` has nothing to fix and the row can render the string as it
// stands. Same rule, one implementation each side of the process boundary and no third one — the
// same arrangement `pricing.json` has with its Node and Python readers.
//
// ONE LINE, ALWAYS. A pasted stack trace or a three-paragraph brief has a first line, and that line
// is what somebody would recognise the session by. Joining the rest with spaces would produce a title
// whose beginning is the same as every other paste of the same shape.

import { UNTITLED } from "./threadStore.ts";

/**
 * How long a title may be before it is cut.
 *
 * Sixty, the same number `generator.ts` cuts an agent name at — not because a row is sixty characters
 * wide (it is not; the row truncates with CSS on top of this) but because two limits on the same kind
 * of string with different values is how you get two different answers to "was this shortened".
 */
export const TITLE_CAP = 60;

/**
 * A title from the user's first message, or `UNTITLED` when there is nothing to make one from.
 *
 * §5 is explicit that a very short message produces a very short title — "fix this" is an acceptable
 * title, because the agent chip and the state fragment supply the rest of the context. So nothing here
 * pads, expands or looks for something better to say.
 */
export function threadTitle(message: string): string {
  // The first line WITH SOMETHING ON IT. A message that begins with a blank line — which is most
  // pasted text, and anything typed after a stray Enter — has an empty first line, and titling from
  // it would call the thread "Untitled thread" while there was a perfectly good sentence one line
  // down.
  const firstLine = message.split("\n").map((l) => l.trim()).find((l) => l.length > 0) ?? "";
  if (!firstLine) return UNTITLED;
  if (firstLine.length <= TITLE_CAP) return firstLine;

  // The cut, then back to the last word boundary before it. Splitting on the boundary rather than
  // trimming a partial word off afterwards, so a single sixty-character word — a URL, a stack frame —
  // does not become an ellipsis on its own.
  const cut = firstLine.slice(0, TITLE_CAP);
  const lastSpace = cut.lastIndexOf(" ");
  const clipped = lastSpace > 0 ? cut.slice(0, lastSpace) : cut;
  return `${clipped.replace(/[\s,;:.]+$/, "")}…`;
}
