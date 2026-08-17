// §3.4's refinement: naming what was set aside, without asking permission to set it aside.
//
// ARCHIVING STAYS IMMEDIATE. `E` archives with no modal in between and no confirmation dialog anywhere —
// §3.4 is explicit that there is no delete path to confirm, and §2's "selecting IS the transition, there
// is no confirm step" applies to this too. What is added here is narrower: when the thread being archived
// had something OUTSTANDING, a notice says what.
//
// A NOTICE IS NOT A GATE. It appears after the fact, it is dismissible, and its Undo is a call to the
// existing `restoreThread` command rather than a new mutation path — so nothing about this can fail in a
// way that leaves a thread half-archived. It is the same posture this product takes toward disabled
// controls: state what is true, and do not ask permission for something that is already reversible.
//
// AND AN IDLE THREAD GETS NO NOTICE AT ALL. Nothing was outstanding, so there is nothing to name — and a
// toast on every archive would be the kind of confirmation-by-another-name that trains people to dismiss
// notices without reading them, at which point the one that matters is invisible too.

import type { ThreadView } from "../types.ts";

/**
 * What the toast should say, or null when the thread had nothing outstanding.
 *
 * Reads the row's own fragment rather than asking the server for a second description of the same fact.
 * The fragment is what the row was showing a moment ago, so the notice names the thing the person was
 * looking at, in the words they were looking at.
 */
export function archiveNotice(thread: ThreadView): string | null {
  // `archived_at` is already set by the time a snapshot comes back, so this is called with the row as it
  // was BEFORE the archive — see `noteArchived` in the store.
  const f = thread.fragment ?? "";
  const diff = /([+]\d+[−-]\d+)/.exec(f);
  if (f.startsWith("diff pending") && diff) return `discarded a pending diff (${diff[1]})`;
  if (f.startsWith("plan awaiting")) return "set aside a plan awaiting confirmation";
  if (f.includes("confirmation")) return "set aside a confirmation a run is waiting on";
  if (f === "generation rejected") return "set aside a refused generation";
  if (/^\d+ failed step/.test(f)) return `set aside ${f} nobody retried`;
  // A blocked thread whose fragment says something this function has not been taught — a status added
  // later, or a fragment reworded. Naming it generically is better than saying nothing: the whole point
  // is that something was outstanding, and the row's own words are the next best thing to a specific
  // sentence.
  if (thread.status === "needs_you" || thread.status === "errored") {
    return f ? `set aside ${f}` : "set aside unfinished work";
  }
  return null;
}
