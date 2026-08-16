// Turning a run of Jaroku versions into a run of git commits.
//
// The mapping is not obvious and §2.3 makes a specific choice about it, so this module exists to
// hold that choice in one testable place rather than inline in a handler.
//
// ONE COMMIT PER VERSION IS THE DEFAULT, AND SQUASH IS AN OPT-IN PER PUSH. Jaroku versions are
// fine-grained — every applied edit is one — so a session of six small fixes is six versions, and
// a user who wanted one meaningful commit gets six. That is the argument FOR squashing. The
// argument against making it the default is stronger: the lineage is the product's own record of
// how an agent got here, the whole feature is about reconciling two lineages, and a default that
// destroyed one of them on the way out would be the feature undoing its own premise. So: preserve
// by default, collapse when asked, per push and never as a stored preference.
//
// A COMMIT MESSAGE IS BUILT FROM DATA THE VERSION ALREADY HOLDS. Migration 014 put `instruction`
// and `summary` on the row for the history list, and those are exactly the subject and body a
// commit wants. No model call is needed for the default message, which matters more than it
// sounds: a push that had to generate text would be a push that costs money, can fail for reasons
// unrelated to git, and cannot run when a provider key is missing.
//
// WHAT THIS MODULE DOES NOT DO. It never touches the network and never reads the object store. It
// is given the files of each version and returns a plan; `githubApi.ts` executes it. That split is
// why the interesting cases below — a deleted file, a subdirectory, an artifact filter, a squash
// across six versions — are asserted without a repository existing anywhere.

import { DEPLOY_ARTIFACTS } from "./projectFs.ts";
import {
  squashTrailerLines, trailerLines, withTrailerBlock, type VersionProvenance,
} from "./githubTrailers.ts";
import type { AgentVersion } from "./db/repositories/agents.ts";
import type { StoredFile } from "./storage/projectStore.ts";

/** One version, with the files it published. The unit a commit is planned from. */
export interface VersionSnapshot {
  version: AgentVersion;
  files: StoredFile[];
}

/** One file as it will exist in the repository, at its repository-relative path. */
export interface PlannedFile {
  /** Repository-relative, POSIX. Already carries the subdirectory prefix if there is one. */
  path: string;
  content: string;
}

export interface PlannedCommit {
  /** The versions this commit represents, oldest first. More than one only when squashing. */
  versionIds: string[];
  /** The newest version number in the commit — what the link's pointer will be moved to. */
  version: number;
  message: string;
  /** Every file the tree should contain at this commit. */
  files: PlannedFile[];
  /** Repository-relative paths to remove. Sent to the tree API as a null sha. */
  deletions: string[];
}

export interface PushPlan {
  commits: PlannedCommit[];
  /** The version id the link's pointer moves to once every commit has landed. */
  headVersionId: string | null;
  headVersion: number | null;
}

export interface PlanOptions {
  /** `agents/weather` or null for the repository root. Never an empty string — see migration 034. */
  subdirectory?: string | null;
  /** §2.2's checkbox. When false the deploy artifacts are held back from the tree. */
  includeArtifacts?: boolean;
  /** §2.3's opt-in: collapse the whole run into one commit. */
  squash?: boolean;
  /**
   * Paths already in the remote tree under our subdirectory, so a file dropped between two
   * versions becomes a deletion rather than a leftover. Absent on a first push, where there is
   * nothing to have left behind.
   */
  remotePaths?: string[];
  /**
   * §B.8.1's receipt, for every commit this plan writes.
   *
   * ONE RECORD FOR THE WHOLE PUSH RATHER THAN ONE PER VERSION, because the fields that vary per
   * version — the version number, the gates its source implies — are already read off the version
   * row inside the trailer builder, and the fields that do not vary are the agent and the model.
   * Per-version cost is the exception and is passed as `costs`, index-aligned with `snapshots`
   * after they are ordered, so a squash can refuse to sum a partial set.
   */
  provenance?: VersionProvenance;
  /**
   * Per-version cost in USD, index-aligned with the OLDEST-FIRST version order.
   *
   * A `null` entry is "nothing priced this version", and one of them makes a squashed commit's
   * total null too — see `squashTrailerLines`. Absent entirely means no version was priced, which
   * omits the line rather than writing a zero.
   */
  costs?: readonly (number | null | undefined)[];
}

/**
 * A repository-relative path for a project-relative one.
 *
 * NORMALISED TO POSIX AND STRIPPED OF ANY LEADING OR TRAILING SLASH, because the subdirectory
 * arrives from a text field a person typed into. `/agents/weather/` and `agents/weather` are the
 * same intent and must produce the same tree; `agents\weather` typed on Windows is the same
 * intent again, and a backslash reaching a git tree path creates a file whose name contains a
 * backslash rather than a directory — the same class of failure the Unreleased separator bug was,
 * one layer up.
 */
export function repoPath(projectPath: string, subdirectory?: string | null): string {
  const prefix = repoPrefix(subdirectory);
  const file = projectPath.replace(/\\/g, "/").replace(/^\/+/, "");
  return prefix ? `${prefix}/${file}` : file;
}

/**
 * The link's subdirectory, normalised, with NO trailing slash — and `""` for the repository root.
 *
 * EXTRACTED BECAUSE `repoPath("", sub)` WAS BEING USED FOR THIS AND IS NOT THE SAME FUNCTION. It
 * returns `agents/weather/` — a path with an empty filename on the end — and every caller that
 * then wrote ``path.startsWith(`${prefix}/`)`` was testing for `agents/weather//`, which nothing
 * in a git tree matches. That is not a cosmetic slip: it silently emptied a set. A pull under a
 * subdirectory link found zero files and refused with "there is nothing on that branch to pull",
 * and the FROM REMOTE group never listed a file, on repositories where both were working
 * correctly. The one-character difference between "prefix" and "prefix plus a separator" is worth
 * a named function precisely because it typechecks either way.
 */
export function repoPrefix(subdirectory?: string | null): string {
  return (subdirectory ?? "")
    .replace(/\\/g, "/")
    .split("/")
    .map((s) => s.trim())
    .filter((s) => s.length > 0 && s !== ".")
    .join("/");
}

/** Whether a repository-relative path is inside the link's subdirectory. `""` means everything. */
export function inSubdirectory(path: string, subdirectory?: string | null): boolean {
  const prefix = repoPrefix(subdirectory);
  return prefix === "" || path.startsWith(`${prefix}/`);
}

/**
 * Which of a version's files are pushed.
 *
 * THE ARTIFACT FILTER IS THE ONLY EXCLUSION, and that is deliberate. It is tempting to also hold
 * back the reviewed connector templates and the MCP bridge — they are read-only in Jaroku, so why
 * push them? Because the repository has to be something somebody can clone and run. A pushed
 * project missing `tools/mcp_bridge.py` is a project whose agent does not import, and "deploy-ready
 * rather than source-only" (§2.2) would be false in the one case that matters. Read-only in Jaroku
 * is about who may EDIT a file, not about whether it belongs in the export — and §3.3's PROTECTED
 * group is the surface that enforces the first without confusing it with the second.
 */
export function pushableFiles(files: StoredFile[], opts: PlanOptions): PlannedFile[] {
  const includeArtifacts = opts.includeArtifacts ?? true;
  return files
    .filter((f) => includeArtifacts || !DEPLOY_ARTIFACTS.has(f.path))
    .map((f) => ({ path: repoPath(f.path, opts.subdirectory), content: f.content }))
    .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
}

/**
 * The commit message for one version.
 *
 * SUBJECT FROM `instruction`, BODY FROM `summary`, and a trailer BLOCK naming the version and
 * everything else §B.8.1 asks a commit to carry. The trailer is not decoration: it is what makes a
 * commit in somebody's repository traceable back to a row in `agent_versions` months later, when
 * the panel is closed and all anybody has is `git log` — and what tells a reader with no Jaroku
 * access which gates the code passed and what it cost.
 *
 * THE BLOCK IS BUILT IN `githubTrailers.ts` AND NOT HERE, because every field in it is subject to
 * the same omit-rather-than-guess rule and that rule is easier to hold in one place than in three
 * call sites. What this function keeps is the shape: subject, body, blank line, block.
 *
 * The subject is capped at git's conventional 72 columns and the body is left alone. Truncating a
 * summary would lose the half that explains why, and a long body in a commit message is not a
 * problem anybody has.
 */
export function messageFor(version: AgentVersion, provenance: VersionProvenance = {}): string {
  const subject = firstLine(
    version.instruction?.trim() || version.summary?.trim() || defaultSubject(version),
  );
  const body = version.summary?.trim();
  // Only when it adds something. A body that repeats the subject is noise in every log viewer.
  const parts = [subject];
  if (body && firstLine(body) !== subject) parts.push("", body);
  return withTrailerBlock(parts.join("\n"), trailerLines(version, provenance));
}

/**
 * The message for a squashed run.
 *
 * NAMES THE RANGE AND LISTS WHAT WENT IN. A squash that said only "Agent updates" would throw away
 * the six sentences the user wrote, which are the most valuable thing in the push — so the subject
 * summarises and the body is the list, one line per version, oldest first. Anybody reading the
 * commit gets the same history the panel would have shown them.
 */
export function squashMessageFor(
  versions: AgentVersion[],
  provenance: VersionProvenance & { costs?: readonly (number | null | undefined)[] } = {},
): string {
  const oldest = versions[0];
  const newest = versions[versions.length - 1];
  if (!oldest || !newest) return "Agent updates\n";
  const subject =
    versions.length === 1
      ? firstLine(oldest.instruction?.trim() || oldest.summary?.trim() || defaultSubject(oldest))
      : `Agent updates: v${oldest.version}–v${newest.version}`;
  const lines = versions.map(
    (v) => `- v${v.version} ${firstLine(v.instruction?.trim() || v.summary?.trim() || defaultSubject(v))}`,
  );
  return withTrailerBlock([subject, "", ...lines].join("\n"), squashTrailerLines(versions, provenance));
}

/**
 * A message a person typed, carrying the trailer a Jaroku commit has to have.
 *
 * THE TRAILER IS NOT DECORATION AND IS NOT THE USER'S TO DROP. `githubService.remoteOnlyCommits`
 * decides which commits on the branch Jaroku wrote by looking for exactly this line — it is the
 * one signal that survives a rebase, a squash-merge or a repository whose commits are all authored
 * by one bot account. A commit written from the commit box without it would come back on the next
 * fetch as a §3.8 hollow dot: a commit the panel reports as somebody else's work, which would then
 * be counted among what a force push is about to destroy.
 *
 * REWRITTEN RATHER THAN SKIPPED WHEN ONE IS ALREADY THERE, which is a change from what this did
 * before §B.8.1. Skipping was right while the trailer was one line naming a version — the pasted
 * one said the same thing the computed one would. It is wrong now that the block also carries a
 * model, a gate list and a cost: text copied out of `git log` carries the trailer of a DIFFERENT
 * commit, and keeping it would put another version's receipt on this one. `withTrailerBlock`
 * strips every `Jaroku-*` line and writes the block whole for exactly this reason.
 */
export function withVersionTrailer(
  message: string,
  versions: AgentVersion[],
  provenance: VersionProvenance & { costs?: readonly (number | null | undefined)[] } = {},
): string {
  const body = message.trim();
  if (versions.length === 0) return body;
  return withTrailerBlock(body, squashTrailerLines(versions, provenance));
}

function firstLine(text: string): string {
  const line = text.split("\n")[0]?.trim() ?? "";
  return line.length > 72 ? `${line.slice(0, 71)}…` : line || "Agent update";
}

/** What to call a version that recorded neither an instruction nor a summary. */
function defaultSubject(version: AgentVersion): string {
  switch (version.source) {
    case "generation": return "Initial generation";
    case "edit": return "Agent edit";
    case "deploy": return "Deploy artifacts";
    default: return "Imported project";
  }
}

/**
 * The plan.
 *
 * DELETIONS ARE COMPUTED AGAINST THE PREVIOUS TREE, NOT AGAINST THE VERSION'S OWN FILE STATS.
 * `file_stats` records what CHANGED (014), and its statuses are `added` and `modified` — there is
 * no `deleted`, because the edit loop rewrites a project wholesale rather than removing files one
 * at a time. So the only honest source for "this file is gone" is the difference between what the
 * previous commit's tree held and what this version's file list holds, which is what is computed
 * here. Without it, a tool the user removed would live on in the repository forever, and the next
 * clone would import it.
 *
 * ONLY PATHS UNDER OUR SUBDIRECTORY ARE ELIGIBLE FOR DELETION. In a monorepo the base tree carries
 * every other agent's directory, and a deletion pass that considered the whole tree would remove
 * all of them in one commit — the exact failure the base-tree mechanism exists to prevent, done
 * deliberately instead of by omission.
 */
export function planPush(snapshots: VersionSnapshot[], opts: PlanOptions = {}): PushPlan {
  if (snapshots.length === 0) return { commits: [], headVersionId: null, headVersion: null };

  // Oldest first: commits are written in the order they happened, so the resulting history reads
  // the same way the version list does.
  const ordered = [...snapshots].sort((a, b) => a.version.version - b.version.version);
  const head = ordered[ordered.length - 1]!;
  const prefix = repoPath("", opts.subdirectory);
  const inScope = (path: string): boolean => (prefix ? path.startsWith(prefix) : true);
  let previous = new Set((opts.remotePaths ?? []).filter(inScope));

  const commits: PlannedCommit[] = [];

  const provenance = opts.provenance ?? {};

  if (opts.squash) {
    const files = pushableFiles(head.files, opts);
    const kept = new Set(files.map((f) => f.path));
    commits.push({
      versionIds: ordered.map((s) => s.version.id),
      version: head.version.version,
      message: squashMessageFor(ordered.map((s) => s.version), {
        ...provenance,
        ...(opts.costs ? { costs: opts.costs } : {}),
      }),
      files,
      deletions: [...previous].filter((p) => !kept.has(p)).sort(),
    });
  } else {
    for (const [i, snapshot] of ordered.entries()) {
      const files = pushableFiles(snapshot.files, opts);
      const kept = new Set(files.map((f) => f.path));
      // The cost of THIS version, by position in the oldest-first order — the same order the
      // caller built `costs` against. An absent entry omits the line; it never falls back to the
      // record's own `costUsd`, which describes a squash total and would be wrong on one commit
      // of several.
      const { costUsd: _total, ...perCommit } = provenance;
      const costUsd = opts.costs ? opts.costs[i] : undefined;
      commits.push({
        versionIds: [snapshot.version.id],
        version: snapshot.version.version,
        message: messageFor(snapshot.version, {
          ...perCommit,
          ...(costUsd === undefined ? {} : { costUsd }),
        }),
        files,
        deletions: [...previous].filter((p) => !kept.has(p)).sort(),
      });
      previous = kept;
    }
  }

  return { commits, headVersionId: head.version.id, headVersion: head.version.version };
}

/**
 * The stage list a push walks, for §2.4's progress rail.
 *
 * A DATA TABLE RATHER THAN A SWITCH, the same shape DeployPanel's STAGES is, so the list a user
 * reads and the list the code walks are the same list. The tenses mirror ActionRow's vocabulary: a
 * live row says "Building tree", a settled one says "Built tree", and nothing rewrites its own
 * sentence on the way past.
 */
export const PUSH_STAGES: { id: string; active: string; done: string; detail: string }[] = [
  { id: "read", active: "Reading versions", done: "Read versions", detail: "from the object store, at the exact bytes that were published" },
  { id: "remote", active: "Checking the branch", done: "Checked the branch", detail: "where it points now, so a concurrent push loses the race rather than the work" },
  { id: "blobs", active: "Uploading files", done: "Uploaded files", detail: "one blob per changed file" },
  { id: "tree", active: "Building tree", done: "Built tree", detail: "on the existing tree, so nothing outside the subdirectory moves" },
  { id: "commit", active: "Writing commits", done: "Wrote commits", detail: "one per version, unless you asked for a squash" },
  { id: "ref", active: "Updating ref", done: "Updated ref", detail: "fast-forward only — never a force, unless you typed the slug to say so" },
];
