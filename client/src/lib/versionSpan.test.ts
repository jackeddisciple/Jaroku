// §6's version comparison sums what changed, and an undone version is the case it must not sum.
//
//   npm run test:version-span

import { changesBetween, skippedSentence } from "./versionSpan.ts";
import type { AgentVersionView } from "../types.ts";

let failures = 0;
const check = (name: string, ok: boolean, detail = ""): void => {
  if (ok) console.log(`  ok   ${name}`);
  else { failures++; console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ""}`); }
};

const at = (day: number): string => new Date(Date.UTC(2026, 7, day)).toISOString();

const version = (
  n: number,
  day: number,
  stats: [string, number, number][],
  undoneDay: number | null = null,
): AgentVersionView => ({
  version: n,
  source: n === 1 ? "generation" : "edit",
  instruction: null,
  summary: null,
  file_stats: stats.map(([path, additions, deletions]) => ({ path, status: "modified", additions, deletions })),
  total_bytes: 0,
  undone_at: undoneDay === null ? null : at(undoneDay),
  created_at: at(day),
  created_by: null,
  restored_from: null,
  current: false,
});

// The history the report seeded: v3 was undone before v4 was published on top of v2.
const history = [
  version(4, 10, [["README.md", 9, 0]]),
  version(3, 5, [["tools/city_time.py", 31, 2]], 6),
  version(2, 3, [["tools/city_time.py", 18, 6], ["README.md", 1, 1]]),
  version(1, 1, [["agent.py", 40, 0]]),
];

console.log("\nan undo reverts, so the version it undid is not between its neighbours");
{
  const span = changesBetween(history, 1, 4);
  const city = span.changes.find(([p]) => p === "tools/city_time.py")?.[1];
  check("v3's reverted edit is not added to v1 → v4", city?.additions === 18 && city.deletions === 6,
    JSON.stringify(city));
  check("...and the span says it left v3 out", JSON.stringify(span.skipped) === "[3]", JSON.stringify(span.skipped));
  check("...v1's own changes are not between v1 and anything", !span.changes.some(([p]) => p === "agent.py"));
  const readme = span.changes.find(([p]) => p === "README.md")?.[1];
  check("a file two versions touched is one row with the total", readme?.additions === 10 && readme.touched === 2,
    JSON.stringify(readme));
  check("the order the ends are picked in does not matter",
    JSON.stringify(changesBetween(history, 4, 1)) === JSON.stringify(span));
}

console.log("\n...but a span that ends ON the undone version is about that version");
{
  const span = changesBetween(history, 2, 3);
  check("v2 → v3 counts v3's own changes", span.changes[0]?.[1].additions === 31, JSON.stringify(span.changes));
  check("...and skips nothing", span.skipped.length === 0);
}

console.log("\n...and one undone only after the newer end existed is still in its lineage");
{
  // v5 published on v4, then v5 undone, then v4 undone: v4 was live when v5 was made.
  const stacked = [
    version(5, 12, [["b.py", 2, 0]], 14),
    version(4, 11, [["a.py", 5, 1]], 15),
    version(3, 9, [["a.py", 1, 0]]),
  ];
  const span = changesBetween(stacked, 3, 5);
  check("v4's changes count toward v3 → v5", span.changes.some(([p]) => p === "a.py"));
  check("...and nothing is reported skipped", span.skipped.length === 0, JSON.stringify(span.skipped));
}

console.log("\nthe sentence under the comparison");
{
  check("none skipped says nothing", skippedSentence([]) === null);
  check("one is named", skippedSentence([3]) === "v3 was undone, so its changes are not in this span and are not counted.");
  check("several are listed", skippedSentence([3, 5, 6])?.startsWith("v3, v5 and v6 were undone") === true,
    String(skippedSentence([3, 5, 6])));
}

console.log(failures === 0 ? "\nALL CORRECT" : `\n${failures} FAILURES`);
(globalThis as { process?: { exit(code: number): void } }).process?.exit(failures === 0 ? 0 : 1);
