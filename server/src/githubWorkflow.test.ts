// A file Jaroku writes into somebody else's repository, and the rule that it only writes it once.
//
// THE PROPERTY THIS SUITE IS ABOUT is not the YAML. It is the four-way verdict, and specifically
// the two branches that end in `surface`: a workflow somebody else wrote, and one Jaroku wrote that
// a human has since edited. §B.6.2 says a person hand-editing it is editing `main` normally, which
// §3.1 says is theirs to do — what is refused is Jaroku's own next push silently clobbering it.
//
// AND THE TRAP THE MARKER EXISTS TO AVOID: comparing against the CURRENT template rather than
// against what was written. Those differ the moment this module's output changes — a new Actions
// version, a `paths` filter added — and a comparison against the template would report every
// untouched file in every repository as edited, on the release that changed it.
//
//   npm run test:github-workflow

import { WORKFLOW_PATH, buildWorkflow, workflowVerdict } from "./githubWorkflow.ts";

let failures = 0;
const check = (ok: boolean, msg: string, detail = ""): void => {
  if (ok) console.log(`  ok   ${msg}`);
  else {
    failures++;
    console.log(`  FAIL ${msg}${detail ? ` — ${detail}` : ""}`);
  }
};

const OURS = buildWorkflow({ agentSlug: "weather-agent" });

console.log("\nwhat gets written");
{
  check(WORKFLOW_PATH === ".github/workflows/jaroku-build.yml", "GitHub's own path, which is not configurable");
  check(OURS.includes("name: jaroku build (weather-agent)"), "the workflow names the agent it is for");
  check(OURS.includes("docker build"), "and runs a docker build against the synthesised Dockerfile");

  // §3.9 needs a check that proves the project BUILDS. A lint step, a test step or a registry push
  // would each be a decision about somebody's repository that they did not ask for.
  check(!OURS.includes("ruff") && !OURS.includes("pytest") && !OURS.includes("docker push"),
    "and nothing else — every extra step is a decision nobody asked for");

  // A check exists to gate a merge. Running it again on every push to main after the merge spends
  // the repository owner's Actions minutes re-proving what a check already proved.
  check(OURS.includes("pull_request:") && !/^on:[\s\S]*?\n  push:/m.test(OURS),
    "it runs on pull requests and not on pushes");
  check(OURS.includes("contents: read"), "with a read-only token, because it has no reason to write");

  const scoped = buildWorkflow({ agentSlug: "weather-agent", subdirectory: "agents/weather" });
  check(scoped.includes('- "agents/weather/**"'),
    "a monorepo link scopes the trigger, so four agents are not four builds per pull request");
  check(!OURS.includes("paths:"), "and a root link has nothing to scope");
  check(
    buildWorkflow({ agentSlug: "a", subdirectory: "/agents/weather/" }).includes('- "agents/weather/**"'),
    "the subdirectory is normalised, as it is everywhere else",
  );
}

console.log("\nthe four verdicts");
{
  check(workflowVerdict(null, OURS).action === "create", "nothing there means write it");
  check(workflowVerdict(OURS, OURS).action === "keep",
    "ours and unchanged means leave it — rewriting identical bytes is a commit that says nothing");

  // The release that changes the template. Every untouched file in every repository must come back
  // `update`, not `surface`.
  const newer = buildWorkflow({ agentSlug: "weather-agent", subdirectory: "agents/weather" });
  const verdict = workflowVerdict(OURS, newer);
  check(verdict.action === "update", "ours, and we would write something different now, means update", verdict.action);
  check(verdict.action === "update" && verdict.content === newer, "…with the new content");
}

console.log("\nand the two that hand off instead");
{
  const theirs = "name: my own build\non: [push]\njobs:\n  build:\n    runs-on: ubuntu-latest\n";
  const notOurs = workflowVerdict(theirs, OURS);
  check(notOurs.action === "surface", "a workflow at that path that Jaroku did not write is never overwritten");
  check(notOurs.action === "surface" && notOurs.reason.includes("did not write"),
    "and the sentence says which of the two cases this is", notOurs.action === "surface" ? notOurs.reason : "");

  // §B.6.2's actual requirement: a changed workflow on the remote is diffed and surfaced, not
  // overwritten. The marker is still there — the edit was to the body — so this is the case a
  // naive "did we write this?" check would get wrong.
  const edited = OURS.replace("ubuntu-latest", "ubuntu-22.04");
  const customised = workflowVerdict(edited, OURS);
  check(customised.action === "surface", "ours, then edited by a person, is also never overwritten");
  check(customised.action === "surface" && customised.reason.includes("edited on GitHub"),
    "with a different sentence, because it is a different thing to have happened",
    customised.action === "surface" ? customised.reason : "");

  // The marker line itself being tampered with reads as somebody else's file, which is the safe
  // direction: we do not overwrite what we cannot prove we wrote.
  const stripped = OURS.split("\n").slice(1).join("\n");
  check(workflowVerdict(stripped, OURS).action === "surface", "a file with the marker removed is not ours to touch");
}

console.log("\nthe marker records what was written, not what we would write");
{
  // The whole reason the hash is of the BODY and lives in the file rather than in a database: a
  // second replica, a relinked workspace and a fresh checkout all reach the same answer with
  // nothing stored anywhere.
  const first = OURS.split("\n")[0]!;
  check(first.startsWith("# jaroku-managed:"), "the first line says who wrote it", first);
  check(first.length > "# jaroku-managed:".length + 8, "and carries a hash of the body", first);
  check(
    buildWorkflow({ agentSlug: "weather-agent" }) === OURS,
    "the same inputs produce the same file, byte for byte — otherwise every link would be an update",
  );
  check(
    buildWorkflow({ agentSlug: "other-agent" }).split("\n")[0] !== first,
    "and a different body produces a different marker",
  );
}

console.log(failures === 0 ? "\nALL CORRECT" : `\n${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
