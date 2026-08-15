// Pulling, which is not a file copy.
//
// This is the most important design decision in the whole GitHub feature, and it is one sentence:
// EXTERNAL CODE IS HELD TO THE IDENTICAL BAR AS GENERATED CODE. A pull stages the remote tree as a
// candidate version and runs it through the same validate-before-promote path every generation
// passes — it parses, it imports in a sandboxed subprocess, the contract symbols are present, no
// tracing imports, no stdout writes.
//
// The alternative is what every other git client does: write the files and let the user find out.
// That is defensible when the files are a website. It is not defensible here, because Jaroku's
// pitch is that an agent which exists is an agent that runs, and a repository is a door into the
// project that anybody with push access can walk through. A "pull" that skipped validation would
// mean the one guarantee the product makes has an exception, and the exception is the path that
// arrives from outside.
//
// SO A FAILED VALIDATION IS A REFUSAL, NOT A WARNING. §3.6's mock is exact about the words: the
// file, the missing symbol, "this would have unwired a reviewed tool", and — the part that matters
// most — "your agent is unchanged". The candidate is discarded, the pointer never moves, and the
// live version is the one it was a second ago.
//
// TWO CHECKS RUN BEFORE THE VALIDATOR, and both are refusals the validator could not produce:
//
//   PROTECTED PATHS. §3.3's read-only guarantees — reviewed connectors, `tools/__init__.py`, the
//   MCP bridge and manifest — are enforced against the edit loop and against the object store's
//   block list. A pull is a third door into the same files, and it is the one that comes from
//   outside the product entirely. A remote change touching those paths is surfaced as a refusal
//   rather than applied silently, because quietly accepting a hand-edited `mcp_bridge.py` from a
//   repository would hand back exactly the capability the trust model removes.
//
//   SIZE AND SHAPE. §6's "huge file / binary in remote tree" row, refused with the path named. A
//   repository somebody pointed at by mistake should fail on the first oversized blob with a
//   sentence, not by streaming a video into this process's heap.

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { GithubError, MAX_BLOB_BYTES } from "./githubApi.ts";
import type { GithubLink, GithubRepository } from "./db/repositories/github.ts";
import type { GithubIdentity } from "./githubIdentity.ts";
import { inSubdirectory, repoPrefix } from "./githubPush.ts";
import type { Agent, AgentRepository } from "./db/repositories/agents.ts";
import type { ProjectStore } from "./storage/projectStore.ts";
import { newStagingId } from "./storage/keys.ts";
import type { TenantContext } from "./db/tenant.ts";
import { isSafeAgentId, readOnlyPaths } from "./projectFs.ts";
import { validateProject, type ValidationResult } from "./validator.ts";
import type { StageReport } from "./githubPushRunner.ts";

/**
 * The stages of a pull, in order, with the words used for each tense.
 *
 * Four rather than the push's six, and the shape of the list is the argument: fetch, stage,
 * VALIDATE, publish. The validate row sits between staging and publishing precisely because that
 * is where it sits in the code — a rail that showed it after publishing would be describing a
 * different product.
 */
export const PULL_STAGES: { id: string; active: string; done: string; detail: string }[] = [
  { id: "fetch", active: "Fetching tree", done: "Fetched tree", detail: "every file on the linked branch, at the current head" },
  { id: "stage", active: "Staging candidate", done: "Staged candidate", detail: "into the object store, unpublished and pointing at nothing" },
  { id: "validate", active: "Validating", done: "Validated", detail: "parse · import · contract — the same bar every generation passes" },
  { id: "publish", active: "Publishing", done: "Published", detail: "the pointer moves, and only now" },
];

export interface PullRequestInput {
  agentId: string;
  /** Publish a candidate the validator refused. Requires the typed slug, and is audited. */
  force?: boolean;
  confirmSlug?: string;
}

export interface PullRefusal {
  /** Which bar it failed: `parse`, `import`, `contract`, `protected`, `size`, `empty`. */
  check: string;
  path: string | null;
  message: string;
  /** The candidate version number that was staged and discarded, for the "View diff" link. */
  candidate: number | null;
}

export interface PullResult {
  ok: boolean;
  version?: number;
  message?: string;
  refusal?: PullRefusal;
  failedStage?: string;
}

export interface GithubPullerDeps {
  repo: GithubRepository;
  identity: GithubIdentity;
  agents: AgentRepository;
  projects: ProjectStore;
  runtimeDir: string;
  connectorFilesFor: (agent: Agent | undefined, slug: string) => string[];
  log?: (line: string) => void;
}

export class GithubPuller {
  private readonly log: (line: string) => void;
  /** Agents with a validation running. §A.2's "a pull is already validating" reason reads this. */
  private readonly inFlight = new Set<string>();

  constructor(private deps: GithubPullerDeps) {
    this.log = deps.log ?? ((line) => console.log(line));
  }

  busy(agentUuid: string): boolean {
    return this.inFlight.has(agentUuid);
  }

  async pull(ctx: TenantContext, req: PullRequestInput, report: StageReport): Promise<PullResult> {
    if (!isSafeAgentId(req.agentId)) return { ok: false, message: "invalid agent id" };
    const agent = await this.deps.agents.bySlug(ctx, req.agentId);
    if (!agent) return { ok: false, message: "no such agent in this workspace" };
    const link = await this.deps.repo.linkFor(ctx, agent.id);
    if (!link) return { ok: false, message: "link a repository first" };

    // Checked before anything else, exactly as the push's is: a mistyped confirmation must not
    // reach the network, and an override that costs a round trip before refusing is an override
    // whose bar is lower than it looks.
    if (req.force && req.confirmSlug?.trim() !== agent.slug) {
      return { ok: false, message: `type ${agent.slug} to publish a refused candidate` };
    }

    if (this.inFlight.has(agent.id)) return { ok: false, message: "a pull is already validating for this agent" };
    this.inFlight.add(agent.id);
    try {
      return await this.run(ctx, agent, link, req, report);
    } finally {
      this.inFlight.delete(agent.id);
    }
  }

  private async run(
    ctx: TenantContext,
    agent: Agent,
    link: GithubLink,
    req: PullRequestInput,
    report: StageReport,
  ): Promise<PullResult> {
    const connection = await this.deps.identity.apiFor(ctx);
    if (!connection) return { ok: false, message: "connect GitHub first" };
    const { api } = connection;
    const repo = link.repo_full_name;
    const stagingId = newStagingId();
    const scratch = mkdtempSync(join(tmpdir(), `jaroku-pull-${stagingId.slice(0, 8)}-`));
    let stage = PULL_STAGES[0]!.id;

    const refuse = async (refusal: PullRefusal): Promise<PullResult> => {
      report(stage, "error");
      await this.deps.projects.discardStaging(ctx, agent.id, stagingId).catch(() => {});
      await this.deps.repo.record(ctx, {
        agentId: agent.id,
        linkId: link.id,
        kind: "pull",
        outcome: "refused",
        detail: `${refusal.check}${refusal.path ? ` ${refusal.path}` : ""}: ${refusal.message}`,
      });
      this.log(`[github] ${agent.slug} pull refused — ${refusal.check}`);
      return { ok: false, refusal, failedStage: stage };
    };

    try {
      // 1. THE TREE, at the head as it is now.
      report(stage, "active");
      const head = await api.refSha(repo, link.branch);
      if (!head) return { ok: false, message: `${link.branch} does not exist on GitHub` };
      const prefix = repoPrefix(link.subdirectory);
      const entries = (await api.tree(repo, head)).filter((e) => inSubdirectory(e.path, link.subdirectory));

      // §6's row, refused with the path named — before the download rather than after it.
      const oversized = entries.find((e) => (e.size ?? 0) > MAX_BLOB_BYTES);
      if (oversized) {
        return await refuse({
          check: "size",
          path: oversized.path,
          message: `${oversized.size} bytes is over the ${MAX_BLOB_BYTES}-byte limit for a file Jaroku will read.`,
          candidate: null,
        });
      }

      const files: { path: string; content: string }[] = [];
      for (const entry of entries) {
        // `+ 1` for the separator `repoPrefix` deliberately does not carry. With the old prefix —
        // which ended in one already — this ate the first character of every filename, so a pull
        // that somehow got this far would have staged `gent.py` and failed the contract check on
        // a file the repository does not contain.
        const projectPath = prefix ? entry.path.slice(prefix.length + 1) : entry.path;
        files.push({ path: projectPath, content: await api.blob(repo, entry.sha, entry.path) });
      }
      if (files.length === 0) {
        return await refuse({
          check: "empty",
          path: prefix || null,
          message: "there is nothing on that branch to pull — no files under the linked path.",
          candidate: null,
        });
      }
      report(stage, "done");

      // THE PROTECTED CHECK, before the candidate is staged. A change arriving from GitHub that
      // touches a reviewed connector, the package marker, the MCP bridge or its manifest is a
      // refusal — see the header. Compared against the CURRENT version's bytes, so a repository
      // that merely CONTAINS these files (every clone does) is fine and one that has EDITED them
      // is not.
      const current = await this.deps.projects.readCurrent(ctx, agent.id, agent.current_version);
      const currentByPath = new Map(current.map((f) => [f.path, f.content]));
      const readOnly = readOnlyPaths(this.deps.connectorFilesFor(agent, agent.slug));
      const tampered = files.find(
        (f) => readOnly.has(f.path) && currentByPath.has(f.path) && currentByPath.get(f.path) !== f.content,
      );
      if (tampered) {
        return await refuse({
          check: "protected",
          path: tampered.path,
          message:
            "that file is reviewed code Jaroku keeps read-only. Applying a hand-edit to it from GitHub would hand back the capability the review exists to remove.",
          candidate: null,
        });
      }

      // 2. STAGE IT. Into the object store, unpublished, pointing at nothing — so what is
      // validated is exactly what would be published, which is why the editor stages first too.
      stage = PULL_STAGES[1]!.id;
      report(stage, "active");
      for (const file of [...files].sort((a, b) => (a.path < b.path ? -1 : 1))) {
        await this.deps.projects.putStaging(ctx, agent.id, stagingId, file);
      }
      await this.deps.projects.materialiseStaging(ctx, agent.id, stagingId, scratch);
      const candidate = await this.deps.agents.plannedNextVersion(ctx, agent.id);
      report(stage, "done");

      // 3. THE BAR. Identical to a generation's — see the header.
      stage = PULL_STAGES[2]!.id;
      report(stage, "active");
      const result: ValidationResult = await validateProject(scratch, {
        runtimeDir: this.deps.runtimeDir,
        connectorFiles: [...readOnly],
        // DON'T-REGRESS, exactly as the edit loop reads it: demanded only of an agent that already
        // had it. An agent generated before the templates started raising is internally consistent
        // and must stay pullable.
        requireToolErrorHandling: current.some((f) => /handle_tool_errors\s*=\s*True/.test(f.content)),
      });
      if (!result.ok && !req.force) {
        const first = result.problems[0] ?? "validation failed";
        return await refuse({
          check: classify(first),
          path: pathIn(first, files.map((f) => f.path)),
          message: first,
          candidate,
        });
      }
      report(stage, "done");

      // 4. AND ONLY NOW THE POINTER.
      stage = PULL_STAGES[3]!.id;
      report(stage, "active");
      const published = await this.deps.projects.publishStaging(ctx, agent.id, stagingId, {
        source: "import",
        instruction: `Pull from ${repo}:${link.branch}`,
        summary: `${files.length} file${files.length === 1 ? "" : "s"} at ${head.slice(0, 7)}`,
      });
      await this.deps.agents.promoteVersion(ctx, agent.id, published.version);
      await this.deps.repo.patchLink(ctx, link.id, {
        lastKnownRemoteSha: head,
        lastSyncedAt: new Date().toISOString(),
      });
      // THE PULLED VERSION IS NOW BOTH SIDES' NEWEST, so it is marked as pushed. Leaving the
      // pointer behind would show ↑1 immediately after a successful pull — an agent reporting it
      // is ahead of the commit it was just built from.
      const versions = await this.deps.agents.versions(ctx, agent.id);
      const row = versions.find((v) => v.version === published.version);
      if (row) {
        await this.deps.repo.patchLink(ctx, link.id, { lastPushedVersionId: row.id, lastPushedSha: head });
      }
      report(stage, "done");

      await this.deps.repo.record(ctx, {
        agentId: agent.id,
        linkId: link.id,
        kind: req.force && !result.ok ? "force_override" : "pull",
        versionIds: row ? [row.id] : [],
        commitSha: head,
        detail: req.force && !result.ok
          ? `published a candidate that failed validation: ${result.problems[0] ?? "unknown"}`
          : `v${published.version} from ${head.slice(0, 7)}`,
      });
      this.log(`[github] ${agent.slug} pulled ${head.slice(0, 7)} as v${published.version}`);
      return { ok: true, version: published.version };
    } catch (err) {
      if (err instanceof GithubError && err.kind === "auth") {
        await this.deps.identity.markRevoked(ctx, err.message);
      }
      report(stage, "error");
      await this.deps.projects.discardStaging(ctx, agent.id, stagingId).catch(() => {});
      const message = (err as Error)?.message ?? String(err);
      await this.deps.repo.record(ctx, {
        agentId: agent.id,
        linkId: link.id,
        kind: "pull",
        outcome: "failed",
        detail: `${stage}: ${message}`,
      });
      return { ok: false, message, failedStage: stage };
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
  }
}

/**
 * Which bar a validator problem failed.
 *
 * A CLASSIFICATION RATHER THAN THE RAW STRING, because §3.6's refusal card renders the check as a
 * category and the message as prose, and the panel should not be parsing English to decide which
 * heading to put above it. The validator's problems are strings this codebase writes, so matching
 * on them is matching on our own vocabulary rather than on a third party's.
 */
function classify(problem: string): string {
  if (/syntax|could not parse|invalid syntax/i.test(problem)) return "parse";
  if (/import|module|cannot be imported/i.test(problem)) return "import";
  if (/missing|required symbol|build_graph|build_initial_state|TOOLS/i.test(problem)) return "contract";
  if (/stdout|print\(/i.test(problem)) return "stdout";
  return "validation";
}

/**
 * The file a problem is about, when the problem names one.
 *
 * Matched against the paths we actually pulled rather than by extracting anything that looks like a
 * filename — a message mentioning `agent.py` in passing should not make the card point at a file
 * that is not the subject. Longest match wins, so `tools/weather.py` beats `weather.py`.
 */
function pathIn(problem: string, paths: string[]): string | null {
  let best: string | null = null;
  for (const path of paths) {
    if (problem.includes(path) && (best === null || path.length > best.length)) best = path;
  }
  return best;
}
