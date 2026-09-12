// What a user's turn CAUSED, in the words the record can support — §6.3's side-effect rule.
//
// §6.3: "a turn that produced a side effect — an applied edit, a confirmed plan, a started run — is
// NOT editable in place. Those turns fork from the point BEFORE the side effect and say so, because
// the side effect already happened on disk and a fork cannot unhappen it."
//
// ITS OWN MODULE, AND THAT IS WHY IT IS TESTABLE. This was a private function inside index.ts,
// where the only way to assert §6.5's acceptance — "refused with an explanation NAMING the side
// effect" — would have been to import a module that opens the database, constructs the relay and
// starts the run pools at module scope. It is a pure function over the item list, so it moves out
// whole and `editTurn` calls the same one the suite drives. The alternative the test could have
// taken is a copy of the naming table in the suite, which would then agree with itself forever.
//
//   npm run test:thread-branch

import type { ThreadItemKind } from "./threadStore.ts";

/**
 * The sentence for each kind of consequence.
 *
 * IT NAMES WHAT `thread_items` HOLDS AND NOTHING MORE. §6.5 asks for an explanation "naming the
 * side effect", and the honest name is the kind of thing that happened: a proposal row says a
 * change was PROPOSED, and whether it was ever APPLIED lives in the editor's memory rather than in
 * this table. Saying "an edit was applied" about a proposal somebody discarded would be the product
 * lying about its own state, which §8.3 treats as the most serious class there is — so this says
 * what is written down.
 *
 * `message` AND `plan` ARE DELIBERATELY ABSENT. A message is prose, and a `plan` row is a plan that
 * was WRITTEN — confirming one produces the `generation` row below. A fork placed before an
 * unconfirmed plan unhappens nothing, so naming it would describe a consequence that did not occur.
 */
const NAMED: Partial<Record<ThreadItemKind, string>> = {
  generation: "an agent was generated",
  proposal: "a change to the code was proposed",
  run: "a run was started",
  work: "a job was given to a deployed agent",
  eval: "an eval was run",
};

/** The shape this needs off a thread item — anything wider is the caller's business. */
export interface ItemForEffects {
  id: string;
  kind: ThreadItemKind;
  role: "user" | null;
}

/**
 * Every consequence of one turn, de-duplicated, in the order they were written.
 *
 * THE WINDOW IS "UNTIL THE NEXT USER MESSAGE", because that is what "this turn produced" means in a
 * conversation: everything between what somebody said and what they said next is the consequence of
 * the first.
 *
 * A TURN THAT IS NOT IN THE LIST NAMES NOTHING rather than throwing. A scoped read of another
 * workspace's thread returns no items at all, so a foreign turn id is simply not here — and
 * `editTurn` refuses it separately, with the same sentence it gives a deleted one.
 */
export function sideEffectsAfter(items: readonly ItemForEffects[], turnId: string): string[] {
  const at = items.findIndex((i) => i.id === turnId);
  if (at < 0) return [];
  const out: string[] = [];
  for (let i = at + 1; i < items.length; i++) {
    const item = items[i];
    if (!item) continue;
    if (item.kind === "message" && item.role === "user") break;
    const name = NAMED[item.kind];
    // DE-DUPLICATED, so three runs from one message read as "a run was started" once. The sentence
    // is about what KIND of thing cannot be unhappened, not about how many there were.
    if (name && !out.includes(name)) out.push(name);
  }
  return out;
}
