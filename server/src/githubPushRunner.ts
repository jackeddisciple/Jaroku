// Executing a push, and leaving the repository untouched when it fails.
//
// `githubPush.ts` decides WHAT to write; this writes it. The split matters because the interesting
// decisions — which files, which deletions, which message — are testable without a network, and
// what is left here is the part that is only interesting when something goes wrong.
//
// THE GUARANTEE THIS FILE EXISTS TO HOLD, in the words v0.2.3 used for deploy artifacts: a push
// either lands completely or leaves the project untouched. Git makes that unusually achievable —
// blobs, trees and commit objects are all content-addressed and INVISIBLE until a ref points at
// them, so everything up to the last step is writing into a space nobody is looking at. A failure
// at stage four leaves some unreferenced objects that GitHub garbage-collects and a branch exactly
// where it was. There is exactly one destructive instant, and it is one API call.
//
// AND THE REF MOVE IS NOT FORCED. GitHub refuses a non-fast-forward with a 422, which arrives as
// `conflict`, which is what makes §6's "two workspace members push at once" resolve as "the second
// one loses the race" rather than "the second one silently destroys the first one's commits". The
// escape hatch exists, it is one field on the command, and it costs the user typing the agent slug
// and an `audit_log` row naming them.
//
// WHY THE POINTER MOVES LAST, AFTER THE REF. `last_pushed_version_id` is half the ahead/behind
// computation. Written before the ref move, a failed push would leave Jaroku believing it had
// pushed work that is not there — the badge would read in-sync over two versions GitHub has never
// seen, and no amount of refreshing would fix it, because a watermark is not re-derivable.

import { GithubError, type GithubApi } from "./githubApi.ts";
import type { GithubLink, GithubRepository } from "./db/repositories/github.ts";
import type { GithubIdentity } from "./githubIdentity.ts";
import {
  PUSH_STAGES, planPush, repoPath, withVersionTrailer,
  type PlannedCommit, type VersionSnapshot,
} from "./githubPush.ts";
import { unpushedVersions } from "./githubSync.ts";
import type { AgentRepository } from "./db/repositories/agents.ts";
import type { ProjectStore } from "./storage/projectStore.ts";
import type { TenantContext } from "./db/tenant.ts";
import { isSafeAgentId } from "./projectFs.ts";

export type StageReport = (stage: string, status: "active" | "done" | "error") => void;

export interface PushRequest {
  agentId: string;
  squash?: boolean;
  force?: boolean;
  /** The agent slug, typed by the user. Required whenever `force` is set. */
  confirmSlug?: string;
  /**
   * §3.4's commit box, when somebody wrote in it.
   *
   * ONLY MEANINGFUL WITH `squash`, and that is a property of the surface rather than a limitation
   * here: one typed sentence describes one commit, and applying it to each of six would put the
   * same message on six commits that did different things. The commit box squashes for exactly
   * this reason, so a message arriving without one is ignored rather than smeared.
   */
  message?: string;
}

export interface PushResult {
  ok: boolean;
  /** The commits written, newest last. Empty on a refusal. */
  shas: string[];
  message?: string;
  /** Which stage it stopped at, so the rail can render a red row rather than just stopping. */
  failedStage?: string;
}

export interface GithubPusherDeps {
  repo: GithubRepository;
  identity: GithubIdentity;
  agents: AgentRepository;
  projects: ProjectStore;
  /**
   * §B.8.1's two facts nothing on the version row carries: which model authored it, and what it
   * cost.
   *
   * INJECTED RATHER THAN READ HERE, and the reason is the same one that keeps `githubApi.ts` a
   * transport: this module writes git objects, and the answer lives in the billing layer. It is
   * also the reason it is OPTIONAL — the pure-function tests construct a pusher without a
   * database, and a trailer that omits two lines is exactly what the omit-rather-than-guess rule
   * says an unanswerable question produces.
   *
   * A REJECTION IS AN OMISSION, NOT A FAILED PUSH. Nothing about a commit's receipt is worth
   * refusing to write the commit over, so this is called inside a catch and its failure costs two
   * lines rather than the work.
   */
  provenanceFor?: (
    ctx: TenantContext,
    agentUuid: string,
    versions: { id: string; version: number; created_at: string }[],
  ) => Promise<{ model: string | null; costs: (number | null)[] }>;
  log?: (line: string) => void;
}

export class GithubPusher {
  private readonly log: (line: string) => void;
  /**
   * Which agents have a push in flight, by uuid.
   *
   * IN MEMORY AND PER PROCESS, which is honest about what it defends against: two clicks from one
   * user, or two tabs. The real defence against two REPLICAS pushing at once is the non-forced ref
   * move — one of them gets a 422 and reports a clean conflict — and this only exists so the
   * common case produces "a push is already running" instead of two racing requests that both cost
   * a round trip before one loses.
   */
  private readonly inFlight = new Set<string>();

  constructor(private deps: GithubPusherDeps) {
    this.log = deps.log ?? ((line) => console.log(line));
  }

  /** Whether this agent has a push running, for the verdict's `syncing` state. */
  busy(agentUuid: string): boolean {
    return this.inFlight.has(agentUuid);
  }

  async push(ctx: TenantContext, req: PushRequest, report: StageReport): Promise<PushResult> {
    if (!isSafeAgentId(req.agentId)) return { ok: false, shas: [], message: "invalid agent id" };
    const agent = await this.deps.agents.bySlug(ctx, req.agentId);
    if (!agent) return { ok: false, shas: [], message: "no such agent in this workspace" };
    const link = await this.deps.repo.linkFor(ctx, agent.id);
    if (!link) return { ok: false, shas: [], message: "link a repository first" };

    // THE SLUG IS CHECKED BEFORE ANYTHING ELSE, including before the connection. A force push is
    // the one operation here that can destroy somebody else's commits, and the confirmation for it
    // must not be reachable past a typo — comparing after the work would mean a mistyped
    // confirmation still spent the blobs and the tree before refusing.
    if (req.force && req.confirmSlug?.trim() !== agent.slug) {
      return { ok: false, shas: [], message: `type ${agent.slug} to confirm a force push` };
    }

    if (this.inFlight.has(agent.id)) return { ok: false, shas: [], message: "a push is already running for this agent" };
    this.inFlight.add(agent.id);
    try {
      return await this.run(ctx, agent.id, agent.slug, link, req, report);
    } finally {
      this.inFlight.delete(agent.id);
    }
  }

  private async run(
    ctx: TenantContext,
    agentUuid: string,
    slug: string,
    link: GithubLink,
    req: PushRequest,
    report: StageReport,
  ): Promise<PushResult> {
    const connection = await this.deps.identity.apiFor(ctx);
    if (!connection) return { ok: false, shas: [], message: "connect GitHub first" };
    const { api } = connection;
    const repo = link.repo_full_name;

    let stage = PUSH_STAGES[0]!.id;
    const fail = async (message: string, kind: "failed" | "refused" = "failed"): Promise<PushResult> => {
      report(stage, "error");
      await this.deps.repo.record(ctx, {
        agentId: agentUuid,
        linkId: link.id,
        kind: "push",
        outcome: kind,
        // The STAGE is in the detail, not only the message. §2.4 promises a failure names the
        // stage it failed at, and a log row that recorded only "push failed" would make the panel
        // the only place that ever knew.
        detail: `${stage}: ${message}`,
      });
      return { ok: false, shas: [], message, failedStage: stage };
    };

    try {
      // 1. READ THE VERSIONS, at the exact bytes that were published.
      report(stage, "active");
      const versions = await this.deps.agents.versions(ctx, agentUuid);
      const pending = unpushedVersions(versions, link.last_pushed_version_id);
      if (pending.length === 0) return { ok: true, shas: [], message: "nothing to push" };
      const snapshots: VersionSnapshot[] = [];
      // Oldest first, so the commits are written in the order the work happened.
      for (const summary of [...pending].reverse()) {
        const version = versions.find((v) => v.id === summary.id);
        if (!version) continue;
        snapshots.push({
          version,
          files: await this.deps.projects.readVersion(ctx, agentUuid, version.version),
        });
      }
      report(stage, "done");

      // 2. WHERE THE BRANCH IS NOW. Read here rather than trusted from the link, because the
      // watermark can be minutes old and the whole point of the next few steps is to build on top
      // of what is actually there.
      stage = PUSH_STAGES[1]!.id;
      report(stage, "active");
      const head = await api.refSha(repo, link.branch);
      // A CONCURRENT PUSH IS CAUGHT HERE AS WELL AS BY THE REF MOVE. Catching it now saves
      // uploading a tree that is about to be refused, and — more usefully — turns a 422 at the
      // last step into a sentence at the first.
      const watermark = link.last_known_remote_sha ?? link.last_pushed_sha;
      if (!req.force && head && watermark && head !== watermark) {
        return await fail(
          `${link.branch} moved on GitHub since Jaroku last looked. Fetch and review before pushing.`,
          "refused",
        );
      }
      const baseTree = head ? (await api.tree(repo, head)).map((e) => e.path) : [];
      report(stage, "done");

      // §B.8.1'S RECEIPT, RESOLVED ONCE FOR THE WHOLE PUSH AND NEVER ALLOWED TO FAIL IT. The agent
      // slug and the gate list come free — one from the row we already have, the other derived
      // from each version's own source — and the model and the costs are asked for. A resolver
      // that throws leaves both lines off, which is what the trailer's own rule says an
      // unanswerable question produces.
      let resolved: { model: string | null; costs: (number | null)[] } | null = null;
      if (this.deps.provenanceFor) {
        try {
          resolved = await this.deps.provenanceFor(
            ctx,
            agentUuid,
            snapshots.map((s) => ({
              id: s.version.id,
              version: s.version.version,
              created_at: s.version.created_at,
            })),
          );
        } catch (err) {
          this.log(`[github] ${slug} provenance unavailable, trailer will omit it: ${(err as Error)?.message}`);
        }
      }

      const plan = planPush(snapshots, {
        subdirectory: link.subdirectory,
        includeArtifacts: link.include_artifacts,
        squash: req.squash === true,
        remotePaths: baseTree,
        provenance: { agentSlug: slug, ...(resolved?.model ? { model: resolved.model } : {}) },
        ...(resolved ? { costs: resolved.costs } : {}),
      });

      // THE MESSAGE SOMEBODY TYPED WINS OVER THE ONE THIS CODE COMPOSED. The commit box pre-fills
      // from the version's own instruction and summary, so the two are usually the same sentence —
      // which is exactly why dropping an edited one was invisible: the commit that landed read
      // plausibly, and only somebody comparing it against what they had written would notice that
      // the box was decorative. The trailer is re-attached rather than left to the user, because
      // the panel identifies its own commits by it.
      const typed = req.message?.trim();
      const onlyCommit = plan.commits.length === 1 ? plan.commits[0] : undefined;
      if (typed && onlyCommit) {
        onlyCommit.message = withVersionTrailer(
          typed,
          snapshots.map((s) => s.version),
          {
            agentSlug: slug,
            ...(resolved?.model ? { model: resolved.model } : {}),
            ...(resolved ? { costs: resolved.costs } : {}),
          },
        );
      }

      // 3. THE BLOBS. Deduplicated by content across the whole push: an unchanged file in six
      // consecutive versions is one upload, not six, and git would store one object either way.
      stage = PUSH_STAGES[2]!.id;
      report(stage, "active");
      const blobShas = new Map<string, string>();
      for (const commit of plan.commits) {
        for (const file of commit.files) {
          if (blobShas.has(file.content)) continue;
          blobShas.set(file.content, await api.createBlob(repo, { path: file.path, content: file.content }));
        }
      }
      report(stage, "done");

      // 4 & 5. TREES AND COMMITS, chained. Each commit's tree is built on the previous commit's,
      // so a subdirectory push inherits everything outside it untouched — see createTree.
      stage = PUSH_STAGES[3]!.id;
      report(stage, "active");
      let parent = head;
      // A COMMIT SHA IS NOT A TREE SHA. Both are forty hex characters, so the mistake typechecks;
      // GitHub answers 422 at the one step of a push where a mysterious failure costs the most.
      let treeBase: string | null = head ? await api.commitTree(repo, head) : null;
      const written: { sha: string; commit: PlannedCommit }[] = [];
      const trees: { tree: string; commit: PlannedCommit }[] = [];
      for (const commit of plan.commits) {
        const entries = [
          ...commit.files.map((f) => ({ path: f.path, sha: blobShas.get(f.content) ?? null })),
          ...commit.deletions.map((path) => ({ path, sha: null })),
        ];
        treeBase = await api.createTree(repo, entries, treeBase);
        trees.push({ tree: treeBase, commit });
      }
      report(stage, "done");

      stage = PUSH_STAGES[4]!.id;
      report(stage, "active");
      for (const { tree, commit } of trees) {
        const created = await api.createCommit(repo, {
          message: commit.message,
          tree,
          parents: parent ? [parent] : [],
        });
        parent = created.sha;
        written.push({ sha: created.sha, commit });
      }
      report(stage, "done");

      // 6. THE ONE DESTRUCTIVE INSTANT.
      stage = PUSH_STAGES[5]!.id;
      report(stage, "active");
      if (!parent) return await fail("nothing was written");
      if (head === null) await api.createRef(repo, link.branch, parent);
      else await api.updateRef(repo, link.branch, parent, req.force === true);
      report(stage, "done");

      // AND ONLY NOW THE POINTERS. See the header: a watermark written before the ref move is a
      // watermark that can be permanently wrong.
      await this.deps.repo.patchLink(ctx, link.id, {
        lastPushedVersionId: plan.headVersionId,
        lastPushedSha: parent,
        lastKnownRemoteSha: parent,
        lastSyncedAt: new Date().toISOString(),
      });
      for (const entry of written) {
        await this.deps.repo.record(ctx, {
          agentId: agentUuid,
          linkId: link.id,
          kind: req.force ? "force_override" : "push",
          versionIds: entry.commit.versionIds,
          commitSha: entry.sha,
          detail: entry.commit.message.split("\n")[0] ?? null,
        });
      }
      this.log(
        `[github] ${slug} pushed ${written.length} commit${written.length === 1 ? "" : "s"} to ${repo}:${link.branch}` +
          (req.force ? " (forced)" : ""),
      );
      return { ok: true, shas: written.map((w) => w.sha) };
    } catch (err) {
      if (err instanceof GithubError) {
        if (err.kind === "auth") await this.deps.identity.markRevoked(ctx, err.message);
        // A conflict is a REFUSAL rather than a failure: nothing is wrong, somebody was faster.
        return await fail(err.message, err.kind === "conflict" ? "refused" : "failed");
      }
      return await fail((err as Error)?.message ?? String(err));
    }
  }
}

/** Repository-relative path of a project file under this link. Re-exported for the handler. */
export { repoPath };
