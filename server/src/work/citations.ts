// `[work:<id>]` — the marker that turns a sentence into a claim somebody can check.
//
// §7.4 IS EXPLICIT THAT THIS IS NOT DECORATION: "Every claim cites a work item, and the citation is
// clickable. This is the anti-hallucination mechanism... a sentence with nothing behind it is
// visibly a sentence with nothing behind it, and the user can open the item and check."
//
// SO THE WHOLE OF THIS MODULE IS A FILTER, AND THE THING IT FILTERS AGAINST IS THE PACK. A model
// asked to cite will sometimes cite something that is not there — a plausible uuid, an id from
// earlier in the conversation, a run id where a work id belongs. The answer to that is not a better
// prompt: it is that the only ids which can become a clickable chip are the ids that were IN the
// material the model was given, and that set was assembled by a workspace-scoped read.
//
// WHICH IS ALSO WHY A CROSS-WORKSPACE CITATION IS IMPOSSIBLE RATHER THAN REFUSED. There is no
// lookup here — nothing takes an id and goes and asks whether it exists. The allowed set IS the
// fact pack, the fact pack came out of `WHERE workspace_id = ?`, and an id from another tenant is
// therefore not in it for the same reason a made-up one is not. §13 asks for that property
// directly, and this is the shape that makes it true by construction instead of by a check somebody
// could forget to write.
//
// AN INVENTED CITATION IS REPORTED, NEVER SILENTLY STRIPPED. Two reasons, and the second is the
// important one. A stripped marker leaves a fluent sentence with no visible defect, which is
// exactly the failure §7.4 is about — the reader cannot see that nothing is behind it. And the
// count of them is the only measurement anybody has of whether the prompt is working; a filter that
// hid its own hit rate would make the honesty rules unfalsifiable.

/**
 * The marker, and it is deliberately narrow.
 *
 * A `work_items.id` is a uuid on Postgres and a uuid-shaped TEXT on SQLite — migration 044's header
 * makes the same point about `thread_items` and its backfill goes to some trouble to write real v4
 * uuids for exactly this reason. So the pattern matches the SHAPE of an id rather than anything at
 * all between brackets, which keeps `[work:the invoice one]` from becoming a citation-looking thing
 * the resolver then has to reject by a second rule.
 */
const MARKER = /\[work:([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12})\]/g;

/** What a chip needs before somebody clicks it. Everything else is the work detail's job. */
export interface CitationView {
  /** `work_items.id`. What the client sends to `loadWorkItem`. */
  id: string;
  status: string;
  agent_name: string;
  created_at: string;
}

export interface CitationResult {
  /** In the order they first appear in the answer, deduplicated. What becomes chips. */
  cited: CitationView[];
  /**
   * Ids the answer cited that were not in the pack.
   *
   * REPORTED RATHER THAN THROWN. The answer is already streaming by the time this runs, and an
   * exception would replace a mostly-good answer with an error. What this is for is the log line
   * and the test — see the header.
   */
  invented: string[];
}

/** Every id the text cites, in order, deduplicated. Cheap, and used by both callers below. */
export function citedIds(text: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  // `matchAll` RATHER THAN `exec` IN A LOOP, because `MARKER` is a module-level regex with the
  // global flag: `exec` advances `lastIndex` on the shared object, so two calls interleaved would
  // each start where the other left off. The bug that produces is a citation resolving in one
  // answer and not in the next, with nothing different about either.
  for (const m of text.matchAll(MARKER)) {
    const id = m[1]!.toLowerCase();
    if (seen.has(id)) continue;
    seen.add(id);
    out.push(id);
  }
  return out;
}

/**
 * Which of an answer's citations are real, and which the model made up.
 *
 * `allowed` IS A MAP FROM THE PACK rather than a set plus a second lookup, so that the chip's label
 * comes from the same row the claim was grounded in. A resolver that returned ids and let the
 * caller fetch the labels would be a second read of rows it already had — and a window in which the
 * row could change between the answer and its own citation.
 */
export function resolveCitations(
  text: string,
  allowed: ReadonlyMap<string, CitationView>,
): CitationResult {
  const cited: CitationView[] = [];
  const invented: string[] = [];
  for (const id of citedIds(text)) {
    const hit = allowed.get(id);
    if (hit) cited.push(hit);
    else invented.push(id);
  }
  return { cited, invented };
}

/**
 * The pack's own rows, keyed for the resolver.
 *
 * Here rather than at the call site so that "what may be cited" has exactly one definition: the
 * items in the pack that was sent to the model. Not the workspace's items, not the agent's — the
 * ones the model could actually see, which is what §7.5's "not in the pack, not in the answer" means
 * one layer down.
 */
export function citableFrom(
  items: readonly { id: string; status: string; agent_name: string; created_at: string }[],
): Map<string, CitationView> {
  return new Map(
    items.map((i) => [
      i.id.toLowerCase(),
      { id: i.id, status: i.status, agent_name: i.agent_name, created_at: i.created_at },
    ]),
  );
}
