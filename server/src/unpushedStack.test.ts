// Reordering an unpushed run, with no repository, no database and no Python.
//
// THE IDENTITY THIS RESTS ON: replaying every delta in the original order reproduces the original
// final snapshot exactly. If that is ever false, the delta model has stopped describing what the
// versions actually did, and every refusal and every success computed on top of it is arithmetic on
// the wrong numbers.
//
// AND THE PROPERTY THE FEATURE EXISTS FOR: a reorder that leaves a BROKEN INTERMEDIATE state is
// refused by position. Every state in the middle of the stack is one somebody can still promote or
// reference (§3.6's pull machinery does not distinguish "was it ever the tip"), so an order that
// only works at the end has left a broken version, not merely an awkward history.
//
// The scope rules are asserted as scope rather than as behaviour, because that is what they are: no
// function in the module takes a pushed version, and amend is offered on exactly one row.
//
//   npm run test:unpushed-stack

import {
  amendTarget, checkSteps, deltasFor, fileDelta, firstBrokenState, identitySteps, replay,
  type StackEntry, type StackState,
} from "./unpushedStack.ts";
import type { StoredFile } from "./storage/projectStore.ts";

let failures = 0;
const check = (ok: boolean, msg: string, detail = ""): void => {
  if (ok) console.log(`  ok   ${msg}`);
  else {
    failures++;
    console.log(`  FAIL ${msg}${detail ? ` — ${detail}` : ""}`);
  }
};

const f = (path: string, content: string): StoredFile => ({ path, content });
const paths = (files: readonly StoredFile[]): string => files.map((x) => x.path).join(",");
const contentAt = (files: readonly StoredFile[], path: string): string | undefined =>
  files.find((x) => x.path === path)?.content;

const entry = (version: number, files: StoredFile[], summary = `v${version}`): StackEntry => ({
  versionId: `ver-${version}`,
  version,
  summary,
  files,
});

// The last pushed state: what GitHub already has.
const BASE = [f("agent.py", "from tools import TOOLS\n"), f("tools/__init__.py", "TOOLS = []\n")];

// v13 adds a helper. v14 calls it. That dependency is the whole reason a reorder can fail.
const V13 = [
  f("agent.py", "from tools import TOOLS\n"),
  f("tools/__init__.py", "TOOLS = []\n"),
  f("tools/helper.py", "def backoff(n):\n    return n * 2\n"),
];
const V14 = [
  f("agent.py", "from tools import TOOLS\nfrom tools.helper import backoff\n"),
  f("tools/__init__.py", "TOOLS = []\n"),
  f("tools/helper.py", "def backoff(n):\n    return n * 2\n"),
];
const RUN = [entry(13, V13, "Add a backoff helper"), entry(14, V14, "Use it in the agent")];

console.log("\nwhat one version changed");
{
  const delta = fileDelta(BASE, V13);
  check(paths(delta.writes) === "tools/helper.py", "only the file that actually changed is a write", paths(delta.writes));
  check(delta.deletes.length === 0, "and nothing was removed");

  // `file_stats` has no `deleted` status, so the difference between two sets is the only honest
  // source for "this file is gone" — the same reason planPush computes deletions against the tree.
  const removed = fileDelta(V13, BASE);
  check(removed.deletes.join() === "tools/helper.py", "a file that stopped existing is a delete");

  const untouched = fileDelta(V13, V13);
  check(untouched.writes.length === 0 && untouched.deletes.length === 0, "an identical set is not a change");
}

console.log("\nthe identity: the original order reproduces the original snapshot");
{
  const deltas = deltasFor(BASE, RUN);
  const states = replay(BASE, deltas, identitySteps(RUN));
  check(states.length === 2, "two versions replay as two states");
  check(JSON.stringify(states[1]!.files) === JSON.stringify([...V14].sort((a, b) => (a.path < b.path ? -1 : 1))),
    "and the last state is v14's own snapshot, file for file", paths(states[1]!.files));
  check(JSON.stringify(states[0]!.files) === JSON.stringify([...V13].sort((a, b) => (a.path < b.path ? -1 : 1))),
    "and the first is v13's");
}

console.log("\nreordering replays the deltas, it does not swap the snapshots");
{
  const deltas = deltasFor(BASE, RUN);
  const swapped = replay(BASE, deltas, [{ versionIds: ["ver-14"] }, { versionIds: ["ver-13"] }]);
  // If reorder simply swapped snapshots, position 0 would BE v14 — complete and consistent, and the
  // dependency this feature exists to catch would be invisible.
  check(contentAt(swapped[0]!.files, "agent.py")?.includes("from tools.helper import backoff") === true,
    "position 0 now has v14's import…");
  check(contentAt(swapped[0]!.files, "tools/helper.py") === undefined,
    "…and not the helper it imports, which is the broken intermediate state");
  check(contentAt(swapped[1]!.files, "tools/helper.py") !== undefined,
    "by the end everything is present again, which is why checking only the end proves nothing");
}

console.log("\na broken intermediate state is refused by position");
{
  const deltas = deltasFor(BASE, RUN);
  const swapped = replay(BASE, deltas, [{ versionIds: ["ver-14"] }, { versionIds: ["ver-13"] }]);
  // Standing in for the real validator's import check: an agent that imports a module the state
  // does not contain is exactly v0.1.0's "syntactically valid, fails on import" class.
  const validate = async (state: StackState) => {
    const agent = contentAt(state.files, "agent.py") ?? "";
    const missing = /from tools\.helper import/.test(agent) && !contentAt(state.files, "tools/helper.py");
    return missing
      ? { ok: false, problems: ["the project fails to import: no module named tools.helper"] }
      : { ok: true, problems: [] };
  };

  const refusal = await firstBrokenState(swapped, validate);
  check(refusal !== null, "the reorder is refused");
  check(refusal?.position === 0, "at the position that broke, not at the end", String(refusal?.position));
  check(refusal?.reason.includes("position 1") === true, "named one-based, as a person counts them", refusal?.reason);
  check(refusal?.problems?.[0]?.includes("tools.helper") === true, "with what the validator actually said");

  const ordered = replay(BASE, deltas, identitySteps(RUN));
  check((await firstBrokenState(ordered, validate)) === null, "and the original order still passes");
}

console.log("\nsquashing collapses the states it is collapsing");
{
  const deltas = deltasFor(BASE, RUN);
  const squashed = replay(BASE, deltas, [{ versionIds: ["ver-13", "ver-14"] }]);
  check(squashed.length === 1, "two versions in one step is one state");
  check(
    contentAt(squashed[0]!.files, "tools/helper.py") !== undefined &&
      contentAt(squashed[0]!.files, "agent.py")?.includes("backoff") === true,
    "and it is the state after both, which is v14's snapshot",
  );

  // The point of squashing: the state BETWEEN the members is being collapsed out of existence, so
  // requiring it to validate would refuse exactly the case people squash for.
  const backwards = replay(BASE, deltas, [{ versionIds: ["ver-14", "ver-13"] }]);
  check(backwards.length === 1, "even members in the awkward order produce one state");
  check(contentAt(backwards[0]!.files, "tools/helper.py") !== undefined, "…which is complete, because nothing in between is checked");
}

console.log("\ndropping is expressed by omission");
{
  const deltas = deltasFor(BASE, RUN);
  const dropped = replay(BASE, deltas, [{ versionIds: ["ver-13"] }]);
  check(dropped.length === 1 && contentAt(dropped[0]!.files, "agent.py")?.includes("backoff") !== true,
    "dropping v14 leaves v13's state and nothing of v14's");

  // A version that has left the frontier — pushed in another tab — is skipped, not thrown over. The
  // selection can be a snapshot behind, and refusing the whole restack would lose the rest of it.
  const stale = replay(BASE, deltas, [{ versionIds: ["ver-99"] }, { versionIds: ["ver-13"] }]);
  check(stale.length === 2 && contentAt(stale[1]!.files, "tools/helper.py") !== undefined,
    "a step naming a version that is gone replays what is still there");
}

console.log("\nwhat a restack is not allowed to be");
{
  check(checkSteps(RUN, identitySteps(RUN)) === null, "the identity is legal, obviously");
  check(checkSteps(RUN, [{ versionIds: ["ver-14"] }, { versionIds: ["ver-13"] }]) === null, "so is any permutation");
  check(checkSteps(RUN, [{ versionIds: ["ver-13", "ver-14"] }]) === null, "so is a squash of both");
  check(checkSteps(RUN, [{ versionIds: ["ver-13"] }]) === null, "so is a drop");

  const twice = checkSteps(RUN, [{ versionIds: ["ver-13"] }, { versionIds: ["ver-13"] }]);
  check(twice?.position === 1, "a version cannot appear twice — its delta would replay twice", JSON.stringify(twice));
  const alien = checkSteps(RUN, [{ versionIds: ["ver-1"] }]);
  check(alien?.reason.includes("not in the unpushed list") === true, "and a version outside the frontier is not addressable here");
  const hollow = checkSteps(RUN, [{ versionIds: [] }]);
  check(hollow?.reason.includes("no version") === true, "a step with nothing in it is not a commit");

  // Dropping everything is a way of discarding work, and §3.6 treats discarding work as its own
  // confirmed action rather than a side effect of rearranging.
  const empty = checkSteps(RUN, []);
  check(empty?.position === null && empty.reason.includes("Discarding work"), "an empty result is refused, and says why", JSON.stringify(empty));
}

console.log("\namend is offered on exactly one row");
{
  // The list arrives newest first, which is the order githubService already hands the panel.
  const newestFirst = [entry(14, V14), entry(13, V13)];
  check(amendTarget(newestFirst)?.version === 14, "the single most recent unpushed version");
  check(amendTarget([]) === null, "and nothing at all when everything is pushed — §B.4.3's whole bound");
  // There is no argument through which a pushed version could reach this function, which is a
  // stronger guarantee than checking for one. The assertion is that the signature stays that way.
  check(amendTarget([entry(13, V13)])?.version === 13, "with one unpushed version, that one is the tip");
}

console.log(failures === 0 ? "\nALL CORRECT" : `\n${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
