// Two version snapshots in, a staging column out — with no object store anywhere.
//
// THE MAPPING UNDER TEST is the one B.4 rests on: the last pushed version stands in for the last
// committed blob, and the current version stands in for the working tree file. Everything below is
// about that mapping producing the same answers a git client's index would, in a product that has
// neither a working tree nor a local repository.
//
// THE PROPERTY THAT MATTERS MOST is the one a user notices only after the fact: staging a subset
// must not touch a file the subset did not name. A tree built by starting at the CURRENT state and
// un-applying is the natural-looking implementation and the wrong one — it reverts through a diff
// computed in the opposite direction, and the off-by-one shows up as a line that quietly vanished
// from a file somebody did not stage.
//
//   npm run test:github-staging

import { everything, isWholeVersion, stagedFiles, stagedTree } from "./githubStaging.ts";
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
const at = (files: readonly StoredFile[], path: string): string | undefined =>
  files.find((x) => x.path === path)?.content;
/** Takes anything with a path, so one helper serves both the file rows and the reconstructed tree. */
const paths = (files: readonly { path: string }[]): string => files.map((x) => x.path).join(",");

// Far enough apart to be two hunks: jsdiff carries three lines of context either side.
const OLD_AGENT = [
  "def get_weather(city):",
  "    return fetch(city)",
  "",
  "def spacer():",
  "    pass",
  "    pass",
  "    pass",
  "    pass",
  "",
  "def log_it(x):",
  "    print(x)",
  "",
].join("\n");
const NEW_AGENT = [
  "def get_weather(city):",
  "    with retry(3):",
  "        return fetch(city)",
  "",
  "def spacer():",
  "    pass",
  "    pass",
  "    pass",
  "    pass",
  "",
  "def log_it(x):",
  "",
].join("\n");

const PUSHED = [f("agent.py", OLD_AGENT), f("tools/gone.py", "x = 1\n"), f("tools/mcp_bridge.py", "reviewed\n")];
const CURRENT = [f("agent.py", NEW_AGENT), f("tools/new.py", "y = 2\n"), f("tools/mcp_bridge.py", "tampered\n")];
const CONNECTORS: string[] = [];

console.log("\nwhat changed between the pushed state and the current one");
{
  const files = stagedFiles(PUSHED, CURRENT, CONNECTORS);
  check(paths(files) === "agent.py,tools/gone.py,tools/mcp_bridge.py,tools/new.py",
    "one row per differing path, sorted so checkbox indices do not move between renders", paths(files));

  const agent = files.find((x) => x.path === "agent.py")!;
  check(agent.status === "modified" && agent.hunks.length === 2, "a modified file carries its hunks", String(agent.hunks.length));
  check(agent.additions === 2 && agent.deletions === 2, "with figures summed from them", `+${agent.additions}/-${agent.deletions}`);

  const added = files.find((x) => x.path === "tools/new.py")!;
  check(added.status === "added" && added.hunks.length === 1, "a new file is one hunk, which is stageable like any other");

  // A file is in the tree or it is not. A checkbox offering half of a disappearance would be a
  // state with no meaning, which is what git's own `add -p` decides too.
  const gone = files.find((x) => x.path === "tools/gone.py")!;
  check(gone.status === "deleted" && gone.hunks.length === 0, "a deletion is all-or-nothing and has no hunks");
  check(gone.deletions > 0, "…and still reports a figure, on the status where the number is largest");

  // §3.3's rule: listed, visible, never stageable. Hiding it would make the panel quieter and less
  // true about a file somebody outside the product changed.
  const locked = stagedFiles(PUSHED, CURRENT, ["mcp_bridge.py"]).find((x) => x.path === "tools/mcp_bridge.py");
  check(locked?.locked === true, "a protected file that changed is listed and marked");
}

console.log("\nthe tree a selection would push");
{
  const files = stagedFiles(PUSHED, CURRENT, CONNECTORS);
  const agent = files.find((x) => x.path === "agent.py")!;

  // The whole point of the feature: one of two hunks, and the file's other change stays behind.
  const first = stagedTree(PUSHED, CURRENT, [{ path: "agent.py", hunks: [agent.hunks[0]!.index] }], CONNECTORS);
  check(at(first, "agent.py")?.includes("with retry(3):") === true, "the staged hunk lands");
  check(at(first, "agent.py")?.includes("    print(x)") === true, "and the unstaged one is still the pushed version's");

  // A file nobody selected keeps whatever the pushed state has, INCLUDING NOT EXISTING. That is
  // what makes "stage two of five files" mean what it says.
  check(at(first, "tools/new.py") === undefined, "a file not in the selection is not created");
  check(at(first, "tools/gone.py") === "x = 1\n", "and one not in the selection is not deleted");
  check(at(first, "tools/mcp_bridge.py") === "reviewed\n", "the protected file keeps the pushed content it always had");

  const everythingTree = stagedTree(PUSHED, CURRENT, everything(files), CONNECTORS);
  check(at(everythingTree, "agent.py") === NEW_AGENT, "staging everything reproduces the current file byte for byte");
  check(at(everythingTree, "tools/gone.py") === undefined, "…including the deletion");
  check(at(everythingTree, "tools/new.py") === "y = 2\n", "…and the addition");

  const nothing = stagedTree(PUSHED, CURRENT, [], CONNECTORS);
  check(JSON.stringify(nothing) === JSON.stringify([...PUSHED].sort((a, b) => (a.path < b.path ? -1 : 1))),
    "staging nothing is the pushed tree exactly", paths(nothing));
}

console.log("\na protected file cannot be staged, and does not fail the push");
{
  const files = stagedFiles(PUSHED, CURRENT, ["mcp_bridge.py"]);
  const tree = stagedTree(
    PUSHED,
    CURRENT,
    [{ path: "tools/mcp_bridge.py", hunks: [0] }, { path: "tools/new.py", hunks: [0] }],
    ["mcp_bridge.py"],
  );
  check(at(tree, "tools/mcp_bridge.py") === "reviewed\n", "the protected file is dropped from the selection");
  check(at(tree, "tools/new.py") === "y = 2\n", "and the other four files still go — a refusal here would lose them");
  check(files.find((x) => x.path === "tools/mcp_bridge.py")?.locked === true, "the row says why it did not move");
}

console.log("\na selection that reconstructs the pushed content is not a change");
{
  // Ticking every hunk and then unticking them one at a time ends here, and a tree carrying a
  // no-op blob shows on GitHub as a touched file in a commit that did not touch it.
  const tree = stagedTree(PUSHED, CURRENT, [{ path: "agent.py", hunks: [] }], CONNECTORS);
  check(at(tree, "agent.py") === OLD_AGENT, "the file is left at the pushed content");
  const added = stagedTree(PUSHED, CURRENT, [{ path: "tools/new.py", hunks: [] }], CONNECTORS);
  check(at(added, "tools/new.py") === undefined, "and a new file with no hunk staged is simply not created");
}

console.log("\nwhether this is still one version — §B.4.2");
{
  const files = stagedFiles(PUSHED, CURRENT, CONNECTORS);
  check(isWholeVersion(files, everything(files)), "everything staged maps one version to one commit");

  const agent = files.find((x) => x.path === "agent.py")!;
  const partialHunks = everything(files).map((s) =>
    s.path === "agent.py" ? { path: s.path, hunks: [agent.hunks[0]!.index] } : s,
  );
  check(!isWholeVersion(files, partialHunks), "half a file is hand-staged, and routes through ✦ generate");

  // Easy to miss when the question is phrased per file: omitting a changed file entirely is exactly
  // as far from "one version" as staging half of each.
  const missingFile = everything(files).filter((s) => s.path !== "tools/new.py");
  check(!isWholeVersion(files, missingFile), "and so is omitting a changed file altogether");

  // A protected file is not part of what "everything" means, so its presence must not make an
  // otherwise-complete selection look partial forever.
  const withLocked = stagedFiles(PUSHED, CURRENT, ["mcp_bridge.py"]);
  check(isWholeVersion(withLocked, everything(withLocked)),
    "a protected file does not make every push hand-staged");
}

console.log("\nthe first push, where there is no pushed state at all");
{
  const files = stagedFiles([], CURRENT, CONNECTORS);
  check(files.every((x) => x.status === "added"), "every file is an addition");
  check(files.every((x) => x.hunks.length === 1), "each one hunk, so a subset of a first push is still stageable");
  const partial = stagedTree([], CURRENT, [{ path: "agent.py", hunks: [0] }], CONNECTORS);
  check(paths(partial) === "agent.py", "and staging one of them writes exactly one file", paths(partial));
}

console.log(failures === 0 ? "\nALL CORRECT" : `\n${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
