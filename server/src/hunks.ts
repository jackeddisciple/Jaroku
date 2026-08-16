// Hunk-level staging: git's indexing mechanic, over a diff Jaroku itself produced.
//
// THIS FILE IS WHERE §B.4'S CAREFUL FRAMING HAS TO BE TRUE OR THE FEATURE SHOULD NOT EXIST, so it
// is stated here rather than only in the spec. v0.1.0 rejected patch-based editing outright — "patch
// based edits could apply against the wrong lines, which is why edits became full file rewrites" —
// and nothing below reopens that decision. The difference is one layer down:
//
//   v0.1.0's REJECTED PATCHES were the mechanism by which a MODEL proposed a change. A patch arrived
//   as text from a language model, was applied against a file the model had not seen the current
//   state of, and could land in the wrong place while typechecking perfectly.
//
//   THE HUNKS HERE are the difference between two strings Jaroku already holds in full — the last
//   committed blob and the current working file, both of which came out of the object store. The
//   hunk is derived FROM those two, and applying a subset of it reconstructs a third string from
//   the same two. No patch is asked of a model, applied blind, or trusted without re-validation.
//
// The test for whether that distinction held is mechanical and this module is built around it:
// selecting EVERY hunk must reproduce the working file byte for byte, and selecting NONE must
// reproduce the base file byte for byte. If either is ever false, the reconstruction is doing
// something the diff did not describe, and the whole framing above is wrong.
//
// LINE ENDINGS ARE PRESERVED, NOT NORMALISED. A project can carry CRLF — `projectFs` does not
// rewrite it and neither does the object store — and a stager that normalised on the way in would
// turn "stage one hunk" into "rewrite every line ending in the file", which is a whole-file
// overwrite wearing a hunk's name. Splitting keeps the terminators with their lines.
//
// NOTHING HERE VALIDATES ANYTHING, and that is the boundary rather than an omission. This module
// returns a string. Whether that string is allowed to become a commit is `validator.ts`'s question,
// asked by the caller, on the reconstructed file set — which is §B.4.3's rule for amend and
// §B.4.4's for a reorder, and is why neither of those can be reached from here.

import { structuredPatch } from "diff";

/** One hunk, in jsdiff's `structuredPatch` shape — the same one the diff card already renders. */
export interface Hunk {
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
  /** `" ctx"` | `"+add"` | `"-del"`, and `"\\ No newline at end of file"` from jsdiff. */
  lines: string[];
}

/** A hunk with the things a checkbox row needs beside it. §B.4.1's expandable card. */
export interface StageableHunk extends Hunk {
  /** Position in the file's hunk list. What a selection names — see `applyHunks`. */
  index: number;
  additions: number;
  deletions: number;
  /**
   * `@@ -12,6 +12,9 @@ retry wrapper` — the header a person reads, header text included.
   *
   * Composed here rather than in the browser because it is derived from the same numbers the
   * selection is keyed on, and two places computing a label from a hunk is two places that can
   * disagree about which hunk a checkbox belongs to.
   */
  header: string;
}

/** How many lines of unchanged context each hunk carries. jsdiff's default, stated rather than left. */
const CONTEXT_LINES = 3;

/**
 * Split text into lines that still carry their own terminators.
 *
 * `split("\n")` loses whether the file ended with a newline and turns every CRLF into a line with a
 * stray `\r` on the end — which then gets written back as a change nobody made. The regex keeps
 * each terminator attached to the line it terminated, so joining the pieces is the identity.
 */
function splitKeepingEndings(text: string): string[] {
  if (text === "") return [];
  return text.match(/[^\n]*\n|[^\n]+/g) ?? [];
}

/** The same split, with terminators stripped — what jsdiff's line arrays are in. */
function contentOf(line: string): string {
  return line.replace(/\r?\n$/, "");
}

/**
 * The hunks between two texts, ready to be checkboxed.
 *
 * BASE FIRST, WORKING SECOND, and the direction is load-bearing: staging a hunk means moving a
 * change FROM the working file INTO what will be committed, so `+` lines are the working file's and
 * `-` lines are the base's. Reversing the arguments would produce a diff that reads correctly and
 * stages backwards, which is the failure that costs somebody their edit.
 */
export function hunksBetween(base: string, working: string): StageableHunk[] {
  const patch = structuredPatch("a", "b", base, working, "", "", { context: CONTEXT_LINES });
  return patch.hunks.map((hunk, index) => {
    let additions = 0;
    let deletions = 0;
    for (const line of hunk.lines) {
      if (line.startsWith("+")) additions++;
      else if (line.startsWith("-")) deletions++;
    }
    return {
      oldStart: hunk.oldStart,
      oldLines: hunk.oldLines,
      newStart: hunk.newStart,
      newLines: hunk.newLines,
      lines: [...hunk.lines],
      index,
      additions,
      deletions,
      header: headerFor(hunk, base),
    };
  });
}

/**
 * `@@ -12,6 +12,9 @@ retry wrapper`.
 *
 * The trailing text is the nearest enclosing definition AT OR ABOVE THE HUNK'S FIRST LINE, which is
 * git's own `xfuncname` rule and what makes a checkbox row nameable — `@@ -40,2 +43,3 @@` alone
 * tells a person nothing about what they are about to stage.
 *
 * AT OR ABOVE, not strictly above, and the difference shows on the commonest hunk there is: an edit
 * to the first statement of a function puts the `def` line itself in the hunk's leading context, and
 * a search that started one line higher would walk past it and name the PREVIOUS function — a label
 * that is not merely unhelpful but points at the wrong place in the file.
 *
 * Restricted to Python's two definition forms because that is what an agent project contains; a file
 * with neither simply gets no suffix, which is honest rather than a guess at what the region is
 * called.
 */
function headerFor(hunk: Hunk, base: string): string {
  const range = `@@ -${hunk.oldStart},${hunk.oldLines} +${hunk.newStart},${hunk.newLines} @@`;
  const lines = splitKeepingEndings(base);
  for (let i = Math.min(hunk.oldStart, lines.length) - 1; i >= 0; i--) {
    const text = contentOf(lines[i] ?? "");
    if (/^\s*(def|class)\s+\w+/.test(text)) return `${range} ${text.trim()}`;
  }
  return range;
}

/**
 * The file that results from applying only the named hunks.
 *
 * NO LINE IS EVER SYNTHESISED. Every line of the output is lifted verbatim, terminator included,
 * out of `base` or out of `working` — the two real files — and the hunk list is used only to decide
 * WHICH of the two each range comes from. That is what makes the terminator questions disappear
 * rather than be answered: a CRLF file stays CRLF because its own bytes were copied, and a file
 * with no trailing newline keeps not having one because the line that lacked it is the line that
 * was copied. An implementation that rebuilt lines from jsdiff's stripped text would have to infer
 * both, and would be wrong about one of them on some file.
 *
 * WALKED ONCE, IN ORDER, WITH A CURSOR INTO EACH FILE — never by applying patches one at a time.
 * Applying hunk 3 to a file that already has hunk 1 applied means hunk 3's line numbers are wrong
 * by however much hunk 1 moved things, which is precisely the "applies against the wrong lines"
 * failure v0.1.0 rejected patches over. Here every hunk's `oldStart` and `newStart` are read
 * against the two UNCHANGED files, so no line number is ever stale.
 *
 * THE TWO IDENTITIES THIS MUST HOLD, asserted in the suite and worth naming in the code:
 * selecting every hunk returns `working` exactly, and selecting none returns `base` exactly.
 *
 * A hunk index that does not exist is IGNORED rather than an error. A selection arrives from a
 * browser that may be a snapshot behind — somebody discarded a hunk in another tab — and refusing
 * the whole stage over one stale index would lose the four hunks that are still valid. What
 * protects the user is not this function rejecting the request; it is the validator running on
 * whatever this produces.
 */
export function applyHunks(base: string, working: string, selected: Iterable<number>): string {
  const wanted = new Set(selected);
  const hunks = hunksBetween(base, working);
  const baseLines = splitKeepingEndings(base);
  const workingLines = splitKeepingEndings(working);
  const out: string[] = [];
  // One-based, matching a hunk's own `oldStart`, so the arithmetic below reads like the header.
  let cursor = 1;

  for (const [index, hunk] of hunks.entries()) {
    // Everything between the last hunk and this one is unchanged text, present identically in both
    // files, whether or not this hunk is selected.
    for (; cursor < hunk.oldStart; cursor++) out.push(baseLines[cursor - 1] ?? "");

    if (!wanted.has(index)) {
      // Not staged: this range comes from the BASE — its context plus the lines the edit would have
      // removed, which are the lines that are there today. Skipping it would delete them.
      for (let n = 0; n < hunk.oldLines; n++) out.push(baseLines[cursor - 1 + n] ?? "");
    } else {
      // Staged: this range comes from the WORKING file, which is exactly the lines the hunk's ` `
      // and `+` entries describe, in order, starting at `newStart`.
      for (let n = 0; n < hunk.newLines; n++) out.push(workingLines[hunk.newStart - 1 + n] ?? "");
    }
    cursor += hunk.oldLines;
  }

  for (; cursor <= baseLines.length; cursor++) out.push(baseLines[cursor - 1] ?? "");

  // A plain concatenation, because every element already carries whatever terminator it had.
  return out.join("");
}

/**
 * The working file with ONE hunk reverted — §B.4.1's per-hunk `↺`.
 *
 * REVERTS JUST THAT RANGE AND NEVER THE WHOLE FILE, which is the entire point: somebody discarding
 * a stray log line is keeping the other eighteen lines of their edit, and a discard implemented as
 * "write the base back" would take those with it. Expressed as "apply every hunk except this one",
 * so discard and stage are the same reconstruction rather than two inverses that can drift.
 */
export function discardHunk(base: string, working: string, index: number): string {
  const keep = hunksBetween(base, working)
    .map((h) => h.index)
    .filter((i) => i !== index);
  return applyHunks(base, working, keep);
}

/**
 * Whether a selection is the whole file.
 *
 * The caller needs this to answer §B.4.2's question — whether a staged subset still corresponds to
 * ONE version, and therefore whether the commit gets a filled version dot in HISTORY or routes
 * through ✦ generate like any other hand-staged commit. A partial selection anywhere in the set
 * makes the whole push hand-staged, so this takes files rather than a file.
 */
export function isWholeFileSelection(
  files: readonly { hunks: readonly Hunk[]; selected: readonly number[] }[],
): boolean {
  return files.every((f) => f.hunks.every((_, i) => f.selected.includes(i)));
}
