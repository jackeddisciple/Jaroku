// The build check §3.9 was already talking about, actually written down.
//
// §3.9 argues that CI status on a pull request is a genuine gate here rather than decoration,
// because Jaroku emits a Dockerfile and a repository with one can run real build checks. That claim
// was only ever as true as whatever workflow the user happened to write by hand — and a repository
// with no CI configured has no checks to pass, so the PR card's "checks passing" line had nothing
// to report and rendered the honest `null` that §3.9's own comment insists must not be drawn as a
// tick. This file is what gives that line something real to say.
//
// HOST-OWNED, IN THE SAME SENSE `jaroku.json` IS. v0.1.0's staged-write guarantee said the
// generation and edit models never author or silently overwrite the project's own manifest; §B.6.2
// extends exactly that from the object store to a git-tracked file. No model writes this. It is
// synthesised from a template, by this module, and nothing in the prompt path can reach it.
//
// AND THE PART THAT IS NOT OBVIOUS: WHAT HAPPENS WHEN A HUMAN EDITS IT. A person hand-editing the
// workflow on GitHub is editing `main` normally, which §3.1 says is theirs to do — that is their
// file to keep. What is refused is Jaroku's OWN next push silently clobbering it. So the rule here
// is written-once-then-diffed: absent, it is created; present and unchanged from what we wrote, it
// is left alone; present and CHANGED, it is surfaced and never overwritten. That is the same
// posture §3.7 takes to a diverged branch — detect and hand off, never resolve — applied to one
// file.

import { createHash } from "node:crypto";

/** Where it goes. GitHub's own path, and not configurable: Actions reads this directory and no other. */
export const WORKFLOW_PATH = ".github/workflows/jaroku-build.yml";

/**
 * The marker that makes "did we write this?" answerable from the file itself.
 *
 * A COMMENT CARRYING A CONTENT HASH, and both halves are load-bearing. The comment says Jaroku
 * wrote it, which is what distinguishes this file from a workflow the user already had at the same
 * path — we do not get to overwrite that either. The hash is of the body BELOW the marker, so
 * "unchanged since we wrote it" is a comparison rather than a memory: nothing has to be stored, and
 * a workspace that relinked, or a second replica, reaches the same answer.
 *
 * The same reasoning `githubService.remoteOnlyCommits` uses for the version trailer: a marker in the
 * artefact survives everything, and a record in a database only survives what we control.
 */
const MARKER = "# jaroku-managed:";

const bodyHash = (body: string): string =>
  createHash("sha256").update(body.trimEnd(), "utf8").digest("hex").slice(0, 16);

/**
 * The workflow, for one linked agent.
 *
 * `docker build` AND NOTHING ELSE. It is tempting to add a lint step, a test step, a push to a
 * registry — and every one of those is a decision about somebody's repository that they did not
 * ask for. What §3.9 needs is a check that proves the emitted project BUILDS, which is exactly what
 * the Dockerfile is for and exactly what this runs. B.1's eval check is the other half — one proves
 * the agent builds, the other proves it still works — and §B.6.2 is explicit that the PR view
 * renders both without implying a hierarchy.
 *
 * `pull_request` ONLY, NOT `push`. A check exists to gate a merge; running the same build again on
 * every push to `main` after the merge spends the repository owner's Actions minutes to re-prove
 * something a check already proved. Somebody who wants that has a file they can edit — and this
 * module will never overwrite it once they have.
 *
 * SCOPED TO THE SUBDIRECTORY when there is one, so a monorepo holding four agents does not run four
 * identical builds on a pull request that touched one of them. The `paths` filter is the only place
 * the link's own configuration reaches this file.
 */
export function buildWorkflow(opts: { agentSlug: string; subdirectory?: string | null }): string {
  const dir = (opts.subdirectory ?? "").replace(/\\/g, "/").replace(/^\/+|\/+$/g, "");
  const context = dir || ".";
  const body = [
    "",
    `name: jaroku build (${opts.agentSlug})`,
    "",
    "# Written by Jaroku when this repository was linked, to give the pull request's",
    "# \"checks passing\" line something real to report. It proves the emitted project BUILDS;",
    "# it does not prove the agent still works — that is the eval check, which is a separate",
    "# thing and neither replaces the other.",
    "#",
    "# This file is yours. Edit it and Jaroku will leave it alone from then on: a changed",
    "# workflow is surfaced on the next push, never overwritten.",
    "",
    "on:",
    "  pull_request:",
    ...(dir ? ["    paths:", `      - "${dir}/**"`, `      - "${WORKFLOW_PATH}"`] : []),
    "",
    "permissions:",
    "  # Read-only. This workflow builds an image and reports; it has no reason to write to the",
    "  # repository, and a token that could is a token a malicious dependency could use.",
    "  contents: read",
    "",
    "jobs:",
    "  build:",
    "    runs-on: ubuntu-latest",
    "    steps:",
    "      - uses: actions/checkout@v4",
    "      - name: Build the agent image",
    "        run: |",
    `          docker build --file ${context}/Dockerfile ${context}`,
    "",
  ].join("\n");
  return `${MARKER}${bodyHash(body)}\n${body}`;
}

/** What the push path should do about the workflow file currently on the branch. */
export type WorkflowVerdict =
  /** Nothing there. Write it. */
  | { action: "create"; content: string }
  /** Ours, unchanged. Leave it — rewriting identical bytes is a commit that says nothing. */
  | { action: "keep" }
  /** Ours, and we would write something different now. Update it. */
  | { action: "update"; content: string }
  /**
   * Somebody's, or ours-and-since-edited. Surfaced, never overwritten.
   *
   * `reason` is the sentence the panel renders. Two causes, and they are genuinely different: a
   * workflow that was never ours is a file we have no claim on at all, and one that was ours and
   * has been edited is a customisation §B.6.2 says we must not clobber. Both end here; saying
   * which is what lets somebody decide whether they meant to.
   */
  | { action: "surface"; reason: string };

/**
 * Whether to write, keep, update or hand off.
 *
 * THE COMPARISON IS AGAINST THE MARKER'S HASH AND NOT AGAINST THE CURRENT TEMPLATE. Those differ
 * the moment this module's output changes — a new Actions version, a `paths` filter added — and
 * comparing against the current template would report every user's untouched file as edited on the
 * release that changed the template. The marker records what WAS written; the question "has a human
 * touched it" is only answerable against that.
 */
export function workflowVerdict(existing: string | null, desired: string): WorkflowVerdict {
  if (existing === null) return { action: "create", content: desired };
  if (existing === desired) return { action: "keep" };

  const firstLine = existing.split("\n")[0] ?? "";
  if (!firstLine.startsWith(MARKER)) {
    return {
      action: "surface",
      reason:
        "there is already a workflow at that path that Jaroku did not write. It is untouched, and no build check was added.",
    };
  }

  const recorded = firstLine.slice(MARKER.length).trim();
  const actual = bodyHash(existing.slice(firstLine.length + 1));
  if (recorded !== actual) {
    return {
      action: "surface",
      reason:
        "the build workflow has been edited on GitHub since Jaroku wrote it. That is your file to keep — it is untouched, and Jaroku will not write it again.",
    };
  }
  return { action: "update", content: desired };
}
