// Versions in, commits out — with no repository anywhere.
//
// Three properties this suite exists to hold, and each one is a specific way a push can quietly
// destroy something:
//
//   A FILE DROPPED BETWEEN TWO VERSIONS BECOMES A DELETION. `file_stats` has no `deleted` status
//   (migration 014), so the only honest source is the difference between trees. Get this wrong and
//   a tool the user removed lives on in their repository forever.
//
//   A SUBDIRECTORY PUSH DELETES NOTHING OUTSIDE ITSELF. In a monorepo the base tree carries every
//   other agent, and a deletion pass that walked the whole tree would remove all of them in one
//   commit.
//
//   A SQUASH KEEPS THE SENTENCES. Six versions collapsed into one commit whose message is "Agent
//   updates" has thrown away the most valuable thing in the push.
//
//   npm run test:github-push

import type { AgentVersion } from "./db/repositories/agents.ts";
import type { StoredFile } from "./storage/projectStore.ts";
import {
  messageFor, planPush, pushableFiles, repoPath, squashMessageFor, withVersionTrailer,
  type VersionSnapshot,
} from "./githubPush.ts";

let failures = 0;
const check = (ok: boolean, msg: string, detail = ""): void => {
  if (ok) console.log(`  ok   ${msg}`);
  else {
    failures++;
    console.log(`  FAIL ${msg}${detail ? ` — ${detail}` : ""}`);
  }
};

function version(n: number, patch: Partial<AgentVersion> = {}): AgentVersion {
  return {
    id: `ver-${n}`,
    agent_id: "agent-1",
    version: n,
    manifest: {},
    source: "edit",
    instruction: null,
    summary: null,
    file_stats: [],
    total_bytes: 0,
    undone_at: null,
    created_at: new Date(n * 1000).toISOString(),
    ...patch,
  };
}

const file = (path: string, content = "x = 1\n"): StoredFile => ({ path, content });

const snap = (n: number, files: StoredFile[], patch: Partial<AgentVersion> = {}): VersionSnapshot => ({
  version: version(n, patch),
  files,
});

console.log("\nwhere a file lands");
{
  check(repoPath("agent.py") === "agent.py", "no subdirectory means the repository root");
  check(repoPath("agent.py", "agents/weather") === "agents/weather/agent.py", "a subdirectory prefixes it");
  check(repoPath("agent.py", "/agents/weather/") === "agents/weather/agent.py", "stray slashes are the same intent");
  // The Unreleased separator bug, one layer up. A backslash reaching a git tree path does not make
  // a directory — it makes one file whose name contains a backslash.
  check(repoPath("tools/x.py", "agents\\weather") === "agents/weather/tools/x.py", "a Windows separator is normalised, not carried");
  check(repoPath("agent.py", "  ") === "agent.py", "whitespace is not a subdirectory");
}

console.log("\nwhat gets pushed");
{
  const files = [file("agent.py"), file("Dockerfile"), file("pyproject.toml"), file("tools/mcp_bridge.py")];
  const all = pushableFiles(files, {});
  check(all.length === 4, "everything by default, artifacts included");
  // Read-only in Jaroku is about who may EDIT a file, never about whether it belongs in the repo:
  // an export missing the bridge is an agent that does not import.
  check(all.some((f) => f.path === "tools/mcp_bridge.py"), "including the reviewed bridge, which is read-only but not private");

  const without = pushableFiles(files, { includeArtifacts: false });
  check(
    !without.some((f) => f.path === "Dockerfile" || f.path === "pyproject.toml"),
    "unticking the box holds back the deploy artifacts",
  );
  check(without.some((f) => f.path === "agent.py"), "...and nothing else");
  check(
    all.map((f) => f.path).join() === [...all].map((f) => f.path).sort().join(),
    "the tree is sorted, so two pushes of the same files produce the same request",
  );
}

console.log("\none commit per version");
{
  const plan = planPush([
    snap(11, [file("agent.py")], { source: "generation" }),
    snap(12, [file("agent.py"), file("tools/weather.py")], { instruction: "Add a weather tool" }),
  ]);
  check(plan.commits.length === 2, "two versions is two commits");
  check(plan.commits[0]!.version === 11, "oldest first, so the history reads the way it happened");
  check(plan.headVersionId === "ver-12", "the pointer moves to the newest");
  check(
    plan.commits[0]!.message.startsWith("Initial generation"),
    "a version with no instruction is named by its source, not left blank",
  );
  check(
    plan.commits[1]!.message.includes("Jaroku-Version: 12"),
    "every commit carries the version it came from, for a `git log` read months later",
  );
}

console.log("\na file that went away");
{
  // v13 drops tools/weather.py. Nothing in file_stats says so — it only records what changed —
  // so the deletion has to come from the difference between the trees.
  const plan = planPush([
    snap(12, [file("agent.py"), file("tools/weather.py")]),
    snap(13, [file("agent.py")]),
  ]);
  check(plan.commits[1]!.deletions.join() === "tools/weather.py", "a dropped file becomes a deletion");
  check(plan.commits[0]!.deletions.length === 0, "...and the first commit deletes nothing, having no predecessor");

  // On a first push the previous tree is the REMOTE's, not a prior version's.
  const first = planPush([snap(14, [file("agent.py")])], { remotePaths: ["agent.py", "stale.py"] });
  check(first.commits[0]!.deletions.join() === "stale.py", "a file only the remote has is removed on the first push");
}

console.log("\na subdirectory in a monorepo");
{
  const plan = planPush([snap(12, [file("agent.py")])], {
    subdirectory: "agents/weather",
    // Two other agents live in this repository. Neither is ours to touch.
    remotePaths: ["agents/weather/old.py", "agents/slack/agent.py", "README.md"],
  });
  check(plan.commits[0]!.files[0]!.path === "agents/weather/agent.py", "files land under the subdirectory");
  check(plan.commits[0]!.deletions.join() === "agents/weather/old.py", "a stale file inside our directory is removed");
  check(
    !plan.commits[0]!.deletions.some((p) => p.startsWith("agents/slack") || p === "README.md"),
    "...and nothing outside it is, which is the whole monorepo case",
  );
}

console.log("\nsquash");
{
  const versions = [
    snap(11, [file("agent.py")], { instruction: "Fix slug validation" }),
    snap(12, [file("agent.py"), file("tools/weather.py")], { instruction: "Add retry on tool failure" }),
    snap(13, [file("agent.py"), file("tools/weather.py")], { instruction: "Tidy the prompt" }),
  ];
  const plan = planPush(versions, { squash: true });
  check(plan.commits.length === 1, "six small edits can become one meaningful commit");
  check(plan.commits[0]!.versionIds.length === 3, "...which still names every version it stands for");
  check(plan.commits[0]!.version === 13, "...and moves the pointer to the newest");
  // The reason squash is not the default, made concrete: the sentences survive it.
  const message = plan.commits[0]!.message;
  check(message.includes("Fix slug validation") && message.includes("Tidy the prompt"), "every version's sentence is in the body");
  check(message.startsWith("Agent updates: v11–v13"), "and the subject names the range");
  check(
    squashMessageFor([version(11, { instruction: "Only one" })]).startsWith("Only one"),
    "a squash of one is just that version's message, not a range of one",
  );
}

console.log("\na message somebody typed");
{
  const run = [version(11), version(12), version(13)];
  const typed = withVersionTrailer("Rewrite the retry ladder\n\nBackoff was linear.", run);
  check(typed.startsWith("Rewrite the retry ladder"), "the typed subject is the commit's subject");
  check(typed.includes("Backoff was linear."), "...and the typed body survives with it");
  // The trailer is what `remoteOnlyCommits` identifies a Jaroku commit by. Without it the panel
  // reports its own commit as somebody else's work on the very next fetch.
  check(typed.endsWith("Jaroku-Versions: 11-13"), "and the run's trailer is re-attached");
  check(
    withVersionTrailer("One version", [version(7)]).endsWith("Jaroku-Version: 7"),
    "a run of one gets the singular trailer, matching what messageFor writes",
  );
  check(
    withVersionTrailer("Pasted back\n\nJaroku-Versions: 11-13", run).match(/Jaroku-Versions:/g)?.length === 1,
    "a message that already carries a trailer does not get a second",
  );
  check(withVersionTrailer("   ", run) === "Jaroku-Versions: 11-13", "an empty box leaves the trailer alone");
}

console.log("\nedges");
{
  check(planPush([]).commits.length === 0, "nothing to push plans nothing");
  const long = "x".repeat(200);
  check(messageFor(version(1, { instruction: long })).split("\n")[0]!.length <= 72, "a runaway subject is capped at git's column");
  check(
    messageFor(version(1, { instruction: "Same", summary: "Same" })).split("\n\n").length === 2,
    "a body that repeats the subject is dropped rather than duplicated",
  );
}

console.log(failures === 0 ? "\nALL CORRECT" : `\n${failures} FAILURES`);
process.exit(failures === 0 ? 0 : 1);
