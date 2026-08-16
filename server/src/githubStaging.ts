// What "the working tree" means in a product that does not have one.
//
// A git client's staging area sits between two things it can point at: the file on disk and the
// blob in the last commit. Jaroku has neither. An agent's files are IMMUTABLE PER VERSION — the
// object store is content-addressed and nothing rewrites a published version — so there is no file
// on disk to be half-edited, and there is no local repository for a commit to be in.
//
// THE MAPPING THIS MODULE ESTABLISHES, and the whole of B.4 rests on it being the honest one:
//
//   the last committed blob   →  the file as the LAST PUSHED VERSION published it
//   the working tree file     →  the file as the CURRENT VERSION publishes it
//
// That is exactly the pair §3.3's Changes region is already computed from — "the uncommitted change
// a git client would show is, here, the set of paths the versions since the last push touched" — so
// hunk staging is a finer view of a list the panel already renders, rather than a second notion of
// what is pending. A user who stages half of `agent.py` is choosing which half of the difference
// between two published versions goes into this push.
//
// AND THE CONSEQUENCE, WHICH §B.4.2 ALREADY DESIGNED FOR: a partial selection does not correspond to
// any version, so the commit it produces gets no filled version dot in HISTORY and routes through
// ✦ generate for its message, exactly like every other hand-staged commit since §3.4. Hunk staging
// is a finer knife for arriving at a case the spec has a fully-supported answer for; it is not a new
// category, and nothing here invents one.
//
// NOTHING IN THIS FILE WRITES. It reads two version snapshots and returns hunks and reconstructions.
// The push runner decides what to do with them and the validator decides whether it may — which is
// the same split `githubPush.ts` and `githubPushRunner.ts` already hold, one layer down.

import { applyHunks, hunksBetween, isWholeFileSelection, type StageableHunk } from "./hunks.ts";
import { readOnlyPaths } from "./projectFs.ts";
import type { StoredFile } from "./storage/projectStore.ts";

/** One changed file, with the hunks a checkbox column renders. §B.4.1's expandable card. */
export interface StagedFile {
  /** Project-relative, POSIX — the same path space `changes` and `protectedPaths` use. */
  path: string;
  status: "added" | "modified" | "deleted";
  additions: number;
  deletions: number;
  /**
   * §3.3's PROTECTED group. A locked file is LISTED and never stageable, which is the same posture
   * the Changes region already takes — a protected file that changed is a fact somebody should see,
   * and hiding it would make the panel quieter and less true.
   */
  locked: boolean;
  hunks: StageableHunk[];
}

/** What the caller staged: which hunks of which files. Absent from the map means the whole file. */
export interface HunkSelection {
  path: string;
  /** Hunk indices, as `StageableHunk.index` numbers them. */
  hunks: number[];
}

/**
 * A file present in one snapshot and not the other.
 *
 * A DELETION HAS NO HUNKS, and that is not an omission. jsdiff would happily produce one hunk
 * removing every line, and a checkbox on it would offer "stage half of this file's disappearance" —
 * a state with no meaning, because a file is either in the tree or it is not. So a deleted file is
 * an all-or-nothing row, which is what git's own `add -p` does with one.
 */
const DELETED_HAS_NO_HUNKS: StageableHunk[] = [];

const byPath = (files: readonly StoredFile[]): Map<string, string> =>
  new Map(files.map((f) => [f.path, f.content]));

/**
 * Every file that differs between the pushed state and the current one, with its hunks.
 *
 * `pushed` IS EMPTY ON A FIRST PUSH AND THAT IS THE RIGHT ANSWER, not a special case: every file is
 * an addition, every addition is one hunk, and staging a subset of a first push is a legitimate
 * thing to want — pushing the agent without the Dockerfile, say, before deciding about artifacts.
 *
 * SORTED BY PATH, so two reads of an unchanged pair produce an identical list and the checkbox
 * indices a browser is holding do not move underneath it between renders.
 */
export function stagedFiles(
  pushed: readonly StoredFile[],
  current: readonly StoredFile[],
  connectorFiles: readonly string[] = [],
): StagedFile[] {
  const before = byPath(pushed);
  const after = byPath(current);
  const locked = readOnlyPaths([...connectorFiles]);
  const out: StagedFile[] = [];

  for (const [path, content] of after) {
    const old = before.get(path);
    if (old === content) continue;
    const hunks = hunksBetween(old ?? "", content);
    out.push({
      path,
      status: old === undefined ? "added" : "modified",
      additions: hunks.reduce((n, h) => n + h.additions, 0),
      deletions: hunks.reduce((n, h) => n + h.deletions, 0),
      locked: locked.has(path),
      hunks,
    });
  }

  for (const [path, content] of before) {
    if (after.has(path)) continue;
    out.push({
      path,
      status: "deleted",
      additions: 0,
      // The whole file, counted, so the row's figures are not silently zero on the one status
      // where the number is largest.
      deletions: content === "" ? 0 : content.split("\n").length,
      locked: locked.has(path),
      hunks: DELETED_HAS_NO_HUNKS,
    });
  }

  return out.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
}

/**
 * The tree a selection would push: the pushed state with the chosen hunks applied.
 *
 * BUILT FROM THE PUSHED STATE UP, never from the current state down. Starting at the current state
 * and un-applying what was not selected would mean reverting hunks, which is the same arithmetic
 * run backwards through a diff computed forwards — and one of the two directions is always the one
 * with an off-by-one nobody notices until a line goes missing. Forwards is also what git does.
 *
 * A FILE NOBODY SELECTED IS NOT TOUCHED — it keeps whatever the pushed state has, including not
 * existing. That is what makes "stage two files out of five" mean what it says.
 *
 * A LOCKED FILE IS DROPPED FROM THE SELECTION RATHER THAN REFUSED, and the difference matters: a
 * selection arriving with `tools/mcp_bridge.py` in it is a client that is a version behind or a
 * request somebody hand-wrote, and the answer §3.3 gives is that the file is not stageable, not
 * that the push fails. The other four files still go.
 */
export function stagedTree(
  pushed: readonly StoredFile[],
  current: readonly StoredFile[],
  selections: readonly HunkSelection[],
  connectorFiles: readonly string[] = [],
): StoredFile[] {
  const before = byPath(pushed);
  const after = byPath(current);
  const locked = readOnlyPaths([...connectorFiles]);
  const result = new Map(before);

  for (const selection of selections) {
    if (locked.has(selection.path)) continue;
    const old = before.get(selection.path);
    const now = after.get(selection.path);

    if (now === undefined) {
      // A deletion. All-or-nothing — see DELETED_HAS_NO_HUNKS — so the presence of the path in the
      // selection at all is the whole instruction.
      result.delete(selection.path);
      continue;
    }
    const staged = applyHunks(old ?? "", now, selection.hunks);
    // A selection that reconstructs the pushed content exactly is not a change, and writing it
    // would put a no-op blob in the tree that git then shows as a touched file.
    if (staged === (old ?? "")) {
      if (old === undefined) result.delete(selection.path);
      continue;
    }
    result.set(selection.path, staged);
  }

  return [...result.entries()]
    .map(([path, content]) => ({ path, content }))
    .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
}

/**
 * Whether this selection is still one version's worth of change — §B.4.2.
 *
 * WHAT THE ANSWER DECIDES, in the panel and nowhere else: a `true` push maps one version to one
 * commit and renders a filled version dot in HISTORY; a `false` push is hand-staged, gets its
 * message from ✦ generate rather than from a stored instruction, and renders a hollow one. §3.4
 * designed both of those before hunks existed, which is why this returns a boolean rather than a
 * new mode.
 *
 * A SELECTION THAT OMITS A CHANGED FILE ENTIRELY IS ALSO PARTIAL, which is easy to miss when the
 * question is phrased per file: staging all of `agent.py` and none of `tools/weather.py` is exactly
 * as far from "one version" as staging half of each. So the file list is compared as well as the
 * hunks within it.
 */
export function isWholeVersion(files: readonly StagedFile[], selections: readonly HunkSelection[]): boolean {
  const stageable = files.filter((f) => !f.locked);
  const chosen = new Map(selections.map((s) => [s.path, s.hunks]));
  if (stageable.length !== chosen.size) return false;
  return isWholeFileSelection(
    stageable.map((file) => ({
      hunks: file.hunks,
      selected: chosen.get(file.path) ?? [],
    })),
  );
}

/**
 * The selection meaning "everything", for the ordinary push that stages nothing by hand.
 *
 * Exists so the push path has ONE shape rather than two: a plain Push and a hand-staged Push both
 * arrive at `stagedTree` with a selection, and the plain one's selection is this. A second code
 * path for "no selection" would be a second answer to what a push writes, and the day the two
 * disagree the ordinary case is the one nobody tested.
 */
export function everything(files: readonly StagedFile[]): HunkSelection[] {
  return files
    .filter((f) => !f.locked)
    .map((f) => ({ path: f.path, hunks: f.hunks.map((h) => h.index) }));
}
