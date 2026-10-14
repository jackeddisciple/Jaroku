// A line diff, for showing an edited field against what it was (the re-run editor, 2026-10-14). The
// longest common subsequence of the two texts' lines; everything else is a removal or an addition.
// Small inputs only — a state field somebody is typing into — so the plain O(n·m) table is fine, and
// past DIFF_LIMIT lines a side it gives up and says the whole thing changed.
//
//   npm run test:trace-view

export interface DiffLine {
  kind: "same" | "add" | "del";
  text: string;
}

const DIFF_LIMIT = 400;

export function lineDiff(before: string, after: string): DiffLine[] {
  const a = before.split("\n");
  const b = after.split("\n");
  if (a.length > DIFF_LIMIT || b.length > DIFF_LIMIT) {
    return [...a.map((text) => ({ kind: "del" as const, text })), ...b.map((text) => ({ kind: "add" as const, text }))];
  }
  // lcs[i][j]: the longest common run of a[i..] and b[j..].
  const lcs: number[][] = Array.from({ length: a.length + 1 }, () => new Array<number>(b.length + 1).fill(0));
  for (let i = a.length - 1; i >= 0; i--) {
    for (let j = b.length - 1; j >= 0; j--) {
      lcs[i]![j] = a[i] === b[j] ? lcs[i + 1]![j + 1]! + 1 : Math.max(lcs[i + 1]![j]!, lcs[i]![j + 1]!);
    }
  }
  const out: DiffLine[] = [];
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      out.push({ kind: "same", text: a[i]! });
      i++;
      j++;
    } else if (lcs[i + 1]![j]! >= lcs[i]![j + 1]!) out.push({ kind: "del", text: a[i++]! });
    else out.push({ kind: "add", text: b[j++]! });
  }
  while (i < a.length) out.push({ kind: "del", text: a[i++]! });
  while (j < b.length) out.push({ kind: "add", text: b[j++]! });
  return out;
}

/**
 * The changed lines and one line either side of each, as a hunk shows them; `null` stands for a run
 * of unchanged lines left out — before, between or after the hunks.
 */
export function diffHunks(lines: readonly DiffLine[], context = 1): (DiffLine | null)[] {
  const keep = lines.map(() => false);
  lines.forEach((l, i) => {
    if (l.kind === "same") return;
    for (let k = Math.max(0, i - context); k <= Math.min(lines.length - 1, i + context); k++) keep[k] = true;
  });
  const out: (DiffLine | null)[] = [];
  lines.forEach((l, i) => {
    if (keep[i]) out.push(l);
    else if (out.length === 0 || out[out.length - 1] !== null) out.push(null);
  });
  return out;
}
