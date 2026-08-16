// Reordering, squashing and dropping — inside the unpushed frontier and nowhere near it.
//
// §B.4.4 draws one line and this module exists to make it structural rather than remembered: no
// rebase, ever, across the pushed boundary. That is the same restraint §3.7 exercises for merge
// conflicts, applied one region over — a capability general-purpose git clients have, that here
// would mean rewriting history the product has already promised (§3.6, §6) it will never silently
// touch. So every function below takes ONLY the unpushed list. There is no parameter through which
// a pushed version could reach any of them, which is a stronger guarantee than a check.
//
// THE MODEL: VERSIONS ARE SNAPSHOTS, AND THAT IS WHY REORDERING IS NOT TRIVIAL. Every
// `agent_versions` row holds the whole project, so a naive reorder — "swap which snapshot comes
// first" — would always succeed and would always be meaningless, because each snapshot is already
// internally consistent. What a reorder actually asks is the git question: replay these changes in
// a different order, and is each state along the way still a working agent? So each version is
// reduced to its DELTA against its predecessor — which files it wrote, which it removed — and the
// deltas are replayed. v13 adds a helper and v14 calls it; reorder them and the state after the
// first step calls a function that does not exist yet. That is the failure §B.4.4 requires be
// refused by NAME OF POSITION, and it is only visible in the delta model.
//
// THE DELTA IS FILE-GRANULAR AND NEVER LINE-GRANULAR, which is what keeps this on the right side of
// v0.1.0's rejection of patch-based editing. A delta here is "these whole files, as this version
// published them, plus these paths removed". Replaying it is a map assignment. Nothing is applied
// against line numbers, nothing can land in the wrong place, and the result of replaying every
// delta in the original order is the original final snapshot, byte for byte — which is the identity
// the suite pins.
//
// NOTHING HERE VALIDATES, AND THAT IS THE BOUNDARY. This module produces states. Whether a state is
// allowed to become a commit is `validator.ts`'s question, and `firstBrokenState` is the shape the
// caller asks it in — injected, so the interesting cases below are assertable without a Python
// interpreter anywhere.

import type { StoredFile } from "./storage/projectStore.ts";

/** One unpushed version, with the files it published. The unit a restack operates on. */
export interface StackEntry {
  versionId: string;
  version: number;
  /** The one-line summary, so a refusal can name the version a person recognises. */
  summary: string;
  files: StoredFile[];
}

/**
 * What one version changed, relative to the state before it.
 *
 * `writes` CARRIES WHOLE FILES rather than diffs — see the header. `deletes` exists because
 * `file_stats` has no `deleted` status (migration 014) and the only honest source for "this file is
 * gone" is the difference between two file sets, exactly as `planPush` computes deletions against
 * the previous tree rather than against the version's own stats.
 */
export interface VersionDelta {
  versionId: string;
  version: number;
  writes: StoredFile[];
  deletes: string[];
}

/**
 * One step of a restacked history.
 *
 * A step with more than one version id is a SQUASH. Dropping is expressed by omission — there is no
 * `drop` step, because a dropped version is not a thing that happens in the new history, and a step
 * type for it would be a step the replay had to remember to skip.
 */
export interface RestackStep {
  versionIds: string[];
}

/** The project as it stands after one step, and which step produced it. */
export interface StackState {
  /** Position in the new history, zero-based. What a refusal names. */
  position: number;
  versionIds: string[];
  files: StoredFile[];
}

/** Why a restack was refused, in words a panel can render without composing a sentence. */
export interface RestackRefusal {
  reason: string;
  /** The position that failed, when one did. Null for a refusal about the request's shape. */
  position: number | null;
  /** What the validator said, when it is the validator that refused. */
  problems?: string[];
}

const byPath = (files: readonly StoredFile[]): Map<string, string> =>
  new Map(files.map((f) => [f.path, f.content]));

const toFiles = (map: Map<string, string>): StoredFile[] =>
  [...map.entries()]
    .map(([path, content]) => ({ path, content }))
    .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));

/**
 * The delta between two file sets.
 *
 * A file whose content is IDENTICAL is not a write, and that matters for more than size: a squash
 * that re-wrote every unchanged file would produce a step whose `writes` list is the whole project,
 * and the refusal message "position 1 broke" would then be unable to say which file the caller
 * should look at. Comparison is by content because that is what the object store is keyed on.
 */
export function fileDelta(
  before: readonly StoredFile[],
  after: readonly StoredFile[],
): { writes: StoredFile[]; deletes: string[] } {
  const prev = byPath(before);
  const next = byPath(after);
  const writes: StoredFile[] = [];
  for (const [path, content] of next) {
    if (prev.get(path) !== content) writes.push({ path, content });
  }
  const deletes = [...prev.keys()].filter((p) => !next.has(p)).sort();
  writes.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  return { writes, deletes };
}

/**
 * Each unpushed version reduced to what it changed.
 *
 * OLDEST FIRST, AND `base` IS THE LAST PUSHED STATE. The first unpushed version's delta is measured
 * against what GitHub already has, not against nothing — otherwise its "writes" would be the entire
 * project and dropping any later version would look like it deleted files it never touched.
 */
export function deltasFor(base: readonly StoredFile[], entries: readonly StackEntry[]): VersionDelta[] {
  const out: VersionDelta[] = [];
  let previous: readonly StoredFile[] = base;
  for (const entry of entries) {
    const { writes, deletes } = fileDelta(previous, entry.files);
    out.push({ versionId: entry.versionId, version: entry.version, writes, deletes });
    previous = entry.files;
  }
  return out;
}

/**
 * Replay a new order of steps and return the state after each one.
 *
 * EVERY INTERMEDIATE STATE IS PRODUCED, not just the final one, and §B.4.4 is explicit about why: a
 * version in the middle of the stack can still be individually promoted or referenced later —
 * §3.6's pull and candidate machinery does not distinguish "was it ever the tip" — so a reorder that
 * leaves a broken state in the middle has left a broken version, not merely an awkward history.
 *
 * A SQUASH STEP APPLIES ITS MEMBERS' DELTAS IN THE ORDER THEY ARE LISTED and produces ONE state, so
 * the states its members would individually have passed through are deliberately not checked. That
 * is the point of squashing: those states are being collapsed out of existence, and requiring them
 * to be valid would make squash refuse exactly the case people squash for — three commits that only
 * make sense together.
 */
export function replay(
  base: readonly StoredFile[],
  deltas: readonly VersionDelta[],
  steps: readonly RestackStep[],
): StackState[] {
  const byId = new Map(deltas.map((d) => [d.versionId, d]));
  const current = byPath(base);
  const states: StackState[] = [];

  for (const [position, step] of steps.entries()) {
    for (const id of step.versionIds) {
      const delta = byId.get(id);
      // A step naming a version that is not in the unpushed set is skipped rather than thrown over.
      // The selection arrives from a browser that may be a snapshot behind — a version pushed in
      // another tab has left the frontier — and the honest answer is to restack what is still
      // there. What refuses a bad result is the validation below, never a lookup.
      if (!delta) continue;
      for (const file of delta.writes) current.set(file.path, file.content);
      for (const path of delta.deletes) current.delete(path);
    }
    states.push({ position, versionIds: [...step.versionIds], files: toFiles(current) });
  }
  return states;
}

/**
 * The steps that mean "leave the history exactly as it is".
 *
 * Exists so the identity the suite pins has a name: restacking with this must reproduce the final
 * snapshot byte for byte, and any change to `replay` that breaks it has broken the delta model
 * rather than the reorder.
 */
export function identitySteps(entries: readonly StackEntry[]): RestackStep[] {
  return entries.map((e) => ({ versionIds: [e.versionId] }));
}

/**
 * Whether a set of steps is a legal restack of this frontier.
 *
 * THE RULES ARE ABOUT THE SET, NOT THE ORDER, because order is the whole point of the feature. What
 * is checked is that nothing was invented and nothing was silently duplicated: a version may appear
 * once or not at all, and a step must contain at least one version. A version appearing twice would
 * replay its delta twice, which for a delete-then-rewrite pair produces a state neither the user nor
 * the validator ever saw.
 *
 * A DROP IS LEGAL AND AN EMPTY RESULT IS NOT. Dropping every unpushed version leaves nothing to
 * push, and a restack that ends with an empty history is a way of discarding work that has no
 * confirmation attached to it — which is precisely what §3.6 treats as a destructive action rather
 * than an ordinary one. Refused here so it has to be spelled as its own thing if it is ever wanted.
 */
export function checkSteps(
  entries: readonly StackEntry[],
  steps: readonly RestackStep[],
): RestackRefusal | null {
  const known = new Set(entries.map((e) => e.versionId));
  const seen = new Set<string>();
  for (const [position, step] of steps.entries()) {
    if (step.versionIds.length === 0) {
      return { reason: "a step with no version in it is not a commit", position };
    }
    for (const id of step.versionIds) {
      if (!known.has(id)) {
        return { reason: "that version is not in the unpushed list", position };
      }
      if (seen.has(id)) {
        return { reason: "a version can appear once in the new order, not twice", position };
      }
      seen.add(id);
    }
  }
  if (steps.length === 0) {
    return {
      reason: "that would drop every unpushed version. Discarding work is its own action, not a reorder.",
      position: null,
    };
  }
  return null;
}

/** What a caller's validator has to answer for one state. Injected — see the header. */
export type StateValidator = (state: StackState) => Promise<{ ok: boolean; problems: string[] }>;

/**
 * The first state that does not validate, or null.
 *
 * §B.4.4: "a reorder that leaves a broken intermediate state is refused, naming which reordered
 * position fails". Naming the POSITION rather than the version is deliberate — the user just moved
 * things, and "v13 is broken" sends them to look at a version that was fine where it used to be.
 *
 * STOPS AT THE FIRST FAILURE. Every state after a broken one is built on top of it, so the rest of
 * the list would be a cascade of consequences reported as independent problems — and running the
 * import check on each of them costs twenty seconds apiece for answers nobody can act on.
 */
export async function firstBrokenState(
  states: readonly StackState[],
  validate: StateValidator,
): Promise<RestackRefusal | null> {
  for (const state of states) {
    const result = await validate(state);
    if (!result.ok) {
      return {
        reason: `position ${state.position + 1} does not validate — the history has to work at every step, not just at the end`,
        position: state.position,
        problems: result.problems,
      };
    }
  }
  return null;
}

/**
 * Which version, if any, may be amended — §B.4.3.
 *
 * THE SINGLE MOST RECENT UNPUSHED VERSION, AND NOTHING ELSE. A pushed version is never amendable
 * from this panel, and the reason is not conservatism: rewriting published history is exactly the
 * force-push case §3.6 and §6 already treat as a confirmed, audit-logged, destructive action, and
 * an amend of a pushed commit would be that same action wearing a friendlier name — reachable
 * without the slug confirmation, without the audit row, and without the sentence that says what is
 * about to be destroyed.
 *
 * NOT THE SECOND-MOST-RECENT EITHER, even though it is unpushed and the machinery above could do
 * it. Amending anything but the tip is a reorder in disguise: every version after it has to be
 * replayed on top of the amended one, which is `replay`'s job and comes with `firstBrokenState`
 * attached. Offering it here would be offering the same operation without the check.
 *
 * Takes the unpushed list NEWEST FIRST, which is the order `githubService` already hands it to the
 * panel in, so no caller has to reverse a list to ask this question.
 */
export function amendTarget(unpushedNewestFirst: readonly StackEntry[]): StackEntry | null {
  return unpushedNewestFirst[0] ?? null;
}
