// The agent's name, as something a person can read.
//
// When you don't type a name, the server makes one: the first line of your prompt, cut to 60
// characters, no ellipsis (server/src/generator.ts). So "a support agent that reads Gmail, looks up
// orders in Postgres, and drafts replies" arrives at the client as
//
//     a support agent that reads Gmail, looks up orders in Postgre
//
// — stopped mid-word, mid-thought, and not saying that anything was removed. CSS cannot fix that:
// those characters were gone before the client saw them, and `text-overflow: ellipsis` would only
// add a second cut on top of the first.
//
// What CSS also can't do is stop *its* cut landing mid-word, since it truncates by pixel. This
// module handles the first cut — the one that already happened — and the header pairs it with a
// tooltip carrying the untruncated original.
//
// The original is `agent.description`, which for generated agents is the full prompt (capped at 500
// chars, effectively never reached). It has always been sent to the client and rendered nowhere.
//
// Presentation only. The stored name is not touched — this is about how it reads, and rewriting an
// agent's identity to make a header prettier would be a different and much worse change.

/** The server's cut (`generator.ts` — `.slice(0, 60)`). A name shorter than this was never cut. */
const SERVER_NAME_CAP = 60;

/**
 * A display title that never ends mid-word.
 *
 * Returns the name unchanged unless it is provably the truncated head of something longer, in which
 * case the partial word goes and a real ellipsis replaces it. "…in Postgre" becomes "…in", which is
 * honest: it says the sentence continues rather than inventing a word that was never there.
 *
 * `full` is the untruncated text — `agent.description`. Without it, nothing can be proven and the
 * name is returned as-is; a name is never mangled on suspicion alone.
 */
export function displayTitle(name: string, full?: string): string {
  const trimmed = name.trim();
  // Measured before trimming: a cut that lands on a space produces a 60-character name whose
  // trimmed form is 59, and trimming first would let exactly that case slip through as "not cut".
  if (name.length < SERVER_NAME_CAP) return trimmed;

  const firstLine = (full ?? "").trim().split("\n")[0]?.trim() ?? "";
  // Not the head of the original — an explicitly typed name, or a description that says something
  // else entirely. Either way there is nothing to restore.
  if (!firstLine.startsWith(trimmed) || firstLine.length <= trimmed.length) return trimmed;

  // If the next character continues a word, the cut landed inside one; drop the partial word.
  // If it doesn't, the cut was already at a boundary and only the ellipsis is missing.
  const next = firstLine[trimmed.length] ?? "";
  const clipped = /\w/.test(next) ? trimmed.replace(/\s*\S+$/, "") : trimmed;
  return `${clipped || trimmed}…`;
}

/** What the tooltip should say: the whole thing, or the name when there is nothing more. */
export function fullTitle(name: string, full?: string): string {
  const original = (full ?? "").trim();
  return original.length > name.trim().length ? original : name.trim();
}
