// What changed between two versions of an agent — §6's comparison, out of the version rows alone.
//
// OUT OF `AgentVersions` SO IT CAN BE ASSERTED. The rule below has one case that is easy to get
// backwards and impossible to see in a screenshot, which is what an undone version means to a sum.
//
//   npm run test:version-span

import type { AgentVersionView } from "../types.ts";

/** One file's movement across the span. */
export interface SpanStat {
  additions: number;
  deletions: number;
  /** How many versions in the span touched it. */
  touched: number;
  /**
   * Whether the file did not exist at the older end — the earliest version in the span that
   * touched it recorded it as `added`. The one thing a `+n −n` cannot say.
   */
  added: boolean;
}

export interface Span {
  /** Per path, sorted by path. */
  changes: [string, SpanStat][];
  /** Versions inside the span whose changes are not in its newer end, ascending. */
  skipped: number[];
}

/**
 * The union of what changed between two versions, exclusive of the lower one.
 *
 * EXCLUSIVE OF `from` AND INCLUSIVE OF `to`, which is what "between v3 and v7" means to somebody
 * asking: v3's own changes are what got it TO v3 and are not between the two. Summed per path rather
 * than concatenated, because a file touched in three of the four versions is one row with the total.
 *
 * AN UNDONE VERSION IS COUNTED ONLY IF THE NEWER END WAS BUILT ON IT. An undo moves the pointer back
 * and the next publish starts from there, so the changes of a version undone before `to` existed are
 * not in `to` at all — adding them would report edits that were reverted. It is still in the span
 * when `to` IS it, or when it was undone only after `to` was published (undo walks back from the top,
 * so a later version has to be undone first). The ones left out are returned, so the comparison can
 * say so rather than quietly being shorter than the list beside it.
 */
export function changesBetween(versions: readonly AgentVersionView[], from: number, to: number): Span {
  const lo = Math.min(from, to);
  const hi = Math.max(from, to);
  const top = versions.find((v) => v.version === hi);
  const madeAt = top ? Date.parse(top.created_at) : Number.POSITIVE_INFINITY;
  const byPath = new Map<string, SpanStat>();
  /** The lowest version in the span that touched each path, which decides `added`. */
  const earliest = new Map<string, number>();
  const skipped: number[] = [];
  for (const v of versions) {
    if (v.version <= lo || v.version > hi) continue;
    const inLineage = v.version === hi || v.undone_at === null || Date.parse(v.undone_at) > madeAt;
    if (!inLineage) {
      skipped.push(v.version);
      continue;
    }
    for (const stat of v.file_stats) {
      const at = byPath.get(stat.path) ?? { additions: 0, deletions: 0, touched: 0, added: false };
      at.additions += stat.additions;
      at.deletions += stat.deletions;
      at.touched += 1;
      if (v.version < (earliest.get(stat.path) ?? Number.POSITIVE_INFINITY)) {
        earliest.set(stat.path, v.version);
        at.added = stat.status === "added";
      }
      byPath.set(stat.path, at);
    }
  }
  return {
    changes: [...byPath.entries()].sort(([a], [b]) => a.localeCompare(b)),
    skipped: skipped.sort((a, b) => a - b),
  };
}

/** The sentence that says which versions a span left out, or null when it left out none. */
export function skippedSentence(skipped: readonly number[]): string | null {
  if (skipped.length === 0) return null;
  const names = skipped.map((v) => `v${v}`);
  const list = names.length === 1 ? names[0]! : `${names.slice(0, -1).join(", ")} and ${names.at(-1)}`;
  return names.length === 1
    ? `${list} was undone, so its changes are not in this span and are not counted.`
    : `${list} were undone, so their changes are not in this span and are not counted.`;
}
