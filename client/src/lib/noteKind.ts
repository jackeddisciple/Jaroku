// What kind of thing a "worth knowing" note is.
//
// The plan's notes arrive as a plain `string[]` (types.ts AgentPlan) with no severity on them, but
// they are not one kind of statement. "Drafts replies only; never sends" is a rule the agent will
// obey — it bounds what the thing can do, and reading past it is how a user ends up surprised.
// "current_email is optional and cleared between requests" is a fact about how it works. Rendering
// both as the same grey bullet asks the reader to work out which is which, every time.
//
// There is no field to read, so the text has to say it. What separates the two in practice is
// prohibition and obligation language: a constraint is written with *never*, *only*, *must*,
// *cannot*, *does not*. A note that merely describes behaviour rarely reaches for those words.
//
// This is a heuristic and it will occasionally be wrong. The cost of being wrong is one icon and
// one step of text contrast — the note still reads identically either way — which is why a
// heuristic is worth it here and would not be somewhere it could change what the user does.
//
// Deliberately pure and dependency-free so it can be tested directly (noteKind.test.ts) and so the
// trace panel could classify step annotations the same way later without importing a component.

export type NoteKind = "constraint" | "info";

/**
 * The words that make a sentence a rule rather than a description.
 *
 * Kept tight on purpose. Terms like "requires" or "is not" were considered and left out: they turn
 * up as often in ordinary description as in prohibition, and a marker that fires on half the notes
 * stops being a distinction at all.
 */
const CONSTRAINT_MARKERS = [
  /\bnever\b/,
  /\balways\b/,
  /\bonly\b/,
  /\bmust\b/,
  /\bcannot\b/,
  /\bcan['’]t\b/,
  /\bdoes not\b/,
  /\bdoesn['’]t\b/,
  /\bdo not\b/,
  /\bdon['’]t\b/,
  /\bwill not\b/,
  /\bwon['’]t\b/,
  /\bread-only\b/,
  /\bnot allowed\b/,
  /\bforbidden\b/,
  /\brefuses?\b/,
];

/** Classify one note. Everything that isn't recognisably a rule is information. */
export function noteKind(note: string): NoteKind {
  const s = note.toLowerCase();
  return CONSTRAINT_MARKERS.some((re) => re.test(s)) ? "constraint" : "info";
}
