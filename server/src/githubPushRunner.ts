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
  PUSH_STAGES, planPush, planStaged, repoPath, sameFiles, stageId, withVersionTrailer,
  type PlannedCommit, type VersionSnapshot,
} from "./githubPush.ts";
import { refusalLine, scanTree, type Finding } from "./secretScan.ts";
import type { ValidationGate } from "./githubTrailers.ts";
import { unpushedVersions } from "./githubSync.ts";
import { everything, stagedFiles, stagedTree } from "./githubStaging.ts";
import {
  checkSteps, deltasFor, firstBrokenState, replay, type StackEntry,
} from "./unpushedStack.ts";
import type { AgentRepository } from "./db/repositories/agents.ts";
import type { ProjectStore, StoredFile } from "./storage/projectStore.ts";
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
   * §B.4.1's hand-staged subset: which hunks of which files go into this push.
   *
   * ABSENT MEANS THE ORDINARY PUSH, and that is not the same as an empty array — an empty array is
   * "somebody unticked everything", which is a push with nothing in it and is refused as such. The
   * two are told apart here rather than defaulted, because the difference between "no opinion" and
   * "the opinion is nothing" is the difference between pushing the work and pushing a no-op.
   *
   * A SELECTION MAKES THE PUSH HAND-STAGED, whatever it contains. Even a selection that happens to
   * cover every hunk of every file arrives having been assembled by a person, and §3.4's answer for
   * a hand-staged commit — one commit, no filled version dot, a message that is not a version's
   * stored instruction — is the honest rendering of that. Silently promoting a complete selection
   * back to a version-mapped push would make the HISTORY dot depend on whether a checkbox happened
   * to be ticked, which nobody could predict.
   */
  stage?: { path: string; hunks: number[] }[];
  /**
   * §B.4.4's restacked order: which unpushed versions become which commits, in what order.
   *
   * A STEP WITH MORE THAN ONE VERSION IS A SQUASH, AN OMITTED VERSION IS A DROP, AND AN AMEND IS
   * NEITHER A THIRD OPERATION NOR A COMMAND OF ITS OWN — it is a squash of the tip with the version
   * before it. That is not a shortcut: §B.4.3 requires an amend to re-run validation on the
   * resulting file set before it may replace the previous local commit, which is exactly what
   * `firstBrokenState` does to every step of a restack. A separate amend path would be the same
   * operation reached without the check.
   *
   * MUTUALLY EXCLUSIVE WITH `stage`, and refused rather than resolved. A staged subset does not
   * correspond to a version, and a restack is a rearrangement OF versions — combining them would
   * ask which half of a hand-staged file belongs to which reordered commit, a question with no
   * answer that is not invented.
   */
  steps?: { versionIds: string[] }[];
  /**
   * §B.6.1's "Ignore & push anyway".
   *
   * A FIELD RATHER THAN ITS OWN COMMAND, for the reason `force` is one: the ordinary path and the
   * escape hatch go through one handler, one scan and one recorded outcome. A separate
   * `pushGithubAnyway` would be a second code path that could drift out of writing the finding
   * rows — which are the only evidence that anybody ever pushed over a credential.
   */
  ignoreSecrets?: boolean;
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
  /**
   * Which restacked position failed to validate, zero-based — §B.4.4's "naming which reordered
   * position fails".
   *
   * Its own field rather than a sentence inside `message`, because the panel highlights the row
   * rather than only quoting the reason, and parsing a number back out of prose is how a UI ends up
   * highlighting the wrong one.
   */
  failedPosition?: number;
  /** What the validator said about that position. Rendered under the row, not in the error strip. */
  problems?: string[];
  /**
   * §B.6.1's findings, when the scan is what refused.
   *
   * CARRIED SO THE PANEL CAN NAME THE FILE AND THE RULE, which is the whole difference between a
   * refusal somebody can act on and an error strip. None of them contains a matched value — see
   * `secretScan.Finding`, which has no field one would fit in.
   */
  findings?: Finding[];
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
  /**
   * §B.4.4's bar for an intermediate state: the real validator, on a file set.
   *
   * INJECTED FOR THE SAME REASON THE PROVENANCE RESOLVER IS — this module writes git objects, and
   * running the validator means materialising a project and starting a Python interpreter, which is
   * `validator.ts`'s business and needs a runtime directory this file has no reason to know about.
   *
   * OPTIONAL, AND ITS ABSENCE REFUSES A RESTACK RATHER THAN WAIVING ONE. A pusher constructed
   * without it can still do every ordinary push; what it cannot do is rearrange history, because
   * the check that makes rearranging safe is the thing that is missing. Defaulting to "valid" would
   * make the one dependency that enforces §B.4.4's guarantee optional in practice.
   */
  validateFiles?: (
    ctx: TenantContext,
    agentUuid: string,
    files: StoredFile[],
  ) => Promise<{ ok: boolean; problems: string[] }>;
  /**
   * §3.3's PROTECTED group, so a hand-staged selection cannot reach a file the rest of the product
   * has already decided nobody may edit.
   *
   * THE SAME RESOLVER THE SERVICE AND THE PULLER TAKE, threaded here for the third time rather than
   * re-derived, because three answers to "which files are read-only" is three chances for the
   * staging column, the pull refusal and the push filter to disagree — and the one that would be
   * wrong is whichever an attacker had a hand in.
   *
   * Takes the agent by its uuid and slug because that is what this module has; the catalogue
   * lookup that needs an `Agent` row happens at the wiring site, which already has one.
   */
  connectorFilesFor?: (agentUuid: string, slug: string) => string[];
  /**
   * The workspace's own stored credential VALUES, for §B.6.1's literal pass.
   *
   * INJECTED AND NEVER HELD. This module asks for them at the moment of the scan, hands them
   * straight to `scanTree`, and keeps no reference — the same rule `deploySecrets.resolveSecretValues`
   * states for the deploy path, which is the only other place in this codebase that reads a
   * credential to compare against rather than to send.
   *
   * OPTIONAL, AND ITS ABSENCE NARROWS THE SCAN RATHER THAN DISABLING IT. Without it the shape
   * checks, the .env rule and the manifest check all still run; what is lost is the pass that
   * catches a chosen password, which no pattern could recognise anyway.
   */
  knownSecretValues?: (ctx: TenantContext) => Promise<string[]>;
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

    // BEFORE THE CONNECTION, FOR THE SAME REASON THE SLUG IS. Neither of these needs GitHub to
    // decide, and a request that cannot be honoured should say so without having spent a round trip
    // learning what a branch points at.
    if (req.stage && req.steps) {
      return {
        ok: false,
        shas: [],
        message:
          "a hand-staged subset and a reordered history are two different pushes — a staged subset does not belong to any version, so there is nothing to reorder it as.",
      };
    }
    if (req.steps && !this.deps.validateFiles) {
      // §B.4.4's guarantee is the per-position validation. Without it this would be a rearrangement
      // with no check, which is the one shape the feature must not have.
      return { ok: false, shas: [], message: "reordering is unavailable on this server" };
    }

    if (this.inFlight.has(agent.id)) return { ok: false, shas: [], message: "a push is already running for this agent" };
    this.inFlight.add(agent.id);
    try {
      return await this.run(ctx, agent.id, agent.slug, link, req, report);
    } finally {
      this.inFlight.delete(agent.id);
    }
  }

  /**
   * §B.4.4: replay a new order, check every state, and hand back the snapshots to plan commits from.
   *
   * THE SNAPSHOTS THAT COME BACK ARE SYNTHETIC, and that is the whole trick. A `VersionSnapshot`
   * pairs a version row with the files it published; a restacked step pairs the row of its LAST
   * member with the files the replay produced. So `planPush` — which knows nothing about any of
   * this — writes one commit per step with the message and trailer of the version that ends it,
   * exactly as it does for an ordinary push. There is no second commit-planning path.
   *
   * A SQUASH KEEPS THE LAST VERSION'S ROW AND NOT THE FIRST'S, because a commit describes the state
   * it leaves behind. The versions it collapsed are still named in `versionIds`, so the event log
   * records what went into it and the trailer's range form still renders.
   */
  private async restack(
    ctx: TenantContext,
    agentUuid: string,
    pushedFiles: StoredFile[],
    snapshots: VersionSnapshot[],
    steps: { versionIds: string[] }[],
  ): Promise<{ refusal: { reason: string; position: number | null; problems?: string[] } | null; snapshots: VersionSnapshot[] }> {
    const entries: StackEntry[] = snapshots.map((s) => ({
      versionId: s.version.id,
      version: s.version.version,
      summary: s.version.instruction?.trim() || s.version.summary?.trim() || `Version ${s.version.version}`,
      files: s.files,
    }));

    const shapeProblem = checkSteps(entries, steps);
    if (shapeProblem) return { refusal: shapeProblem, snapshots: [] };

    const states = replay(pushedFiles, deltasFor(pushedFiles, entries), steps);
    const broken = await firstBrokenState(states, async (state) =>
      // Guarded by the constructor check above: `req.steps` is refused outright when this dep is
      // absent, so reaching here without it is impossible rather than defaulted to "valid".
      this.deps.validateFiles!(ctx, agentUuid, state.files),
    );
    if (broken) return { refusal: broken, snapshots: [] };

    const byId = new Map(snapshots.map((s) => [s.version.id, s]));
    const restacked: VersionSnapshot[] = [];
    for (const state of states) {
      const last = state.versionIds[state.versionIds.length - 1];
      const anchor = last ? byId.get(last) : undefined;
      if (!anchor) continue;
      restacked.push({ version: anchor.version, files: state.files });
    }
    return { refusal: null, snapshots: restacked };
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

    let stage = stageId("read");
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
      stage = stageId("remote");
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

      // THE PUSHED STATE, needed by both of the two paths below and by neither of the ordinary one.
      // Read once here rather than inside each, so a restack and a staged subset cannot disagree
      // about what GitHub already has.
      const pushedRow = link.last_pushed_version_id
        ? versions.find((v) => v.id === link.last_pushed_version_id)
        : undefined;
      const pushedFiles = pushedRow
        ? await this.deps.projects.readVersion(ctx, agentUuid, pushedRow.version)
        : [];

      // §B.4.4'S RESTACK, REPLAYED AND CHECKED AT EVERY POSITION.
      //
      // Reordering, squashing and dropping happen HERE and never against `agent_versions`. The
      // version rows are untouched: what a restack rearranges is which commits this push writes, so
      // nothing that was published stops being published, and cancelling the push leaves the agent
      // exactly as it was. That is also why §B.9 needs no table for it — a restack has no lifetime
      // beyond the push it is part of.
      const restack = req.steps
        ? await this.restack(ctx, agentUuid, pushedFiles, snapshots, req.steps)
        : null;
      if (restack?.refusal) {
        report(stage, "error");
        await this.deps.repo.record(ctx, {
          agentId: agentUuid,
          linkId: link.id,
          kind: "push",
          outcome: "refused",
          detail: `restack: ${restack.refusal.reason}`,
        });
        return {
          ok: false,
          shas: [],
          message: restack.refusal.reason,
          failedStage: stage,
          ...(restack.refusal.position === null ? {} : { failedPosition: restack.refusal.position }),
          ...(restack.refusal.problems ? { problems: restack.refusal.problems } : {}),
        };
      }

      // §B.4.1'S HAND-STAGED SUBSET.
      //
      // ONE COMMIT, NO VERSION IDS, AND THAT IS §3.4'S EXISTING ANSWER RATHER THAN A NEW ONE: a
      // staged subset does not correspond to a version, so the event carries no version and HISTORY
      // renders it without a filled dot, exactly like every other hand-staged commit since the base
      // spec. Hunk staging is a finer knife for reaching that case, not a new category.
      const staged = req.stage
        ? stagedTree(
            pushedFiles,
            snapshots[snapshots.length - 1]?.files ?? [],
            req.stage,
            this.deps.connectorFilesFor?.(agentUuid, slug) ?? [],
          )
        : null;
      if (staged && staged.length === 0 && pushedFiles.length > 0) {
        return await fail("nothing is staged — tick at least one hunk.", "refused");
      }
      if (staged && sameFiles(staged, pushedFiles)) {
        return await fail("that selection is what GitHub already has — nothing would change.", "refused");
      }

      // §B.8.1'S GATE LIST GAINS `secret-scan`, AND WHETHER IT MAY IS DECIDED HERE RATHER THAN
      // AFTER THE SCAN. The plan is built before the scan runs — the scan needs the planned files —
      // so the trailer has to be composed without knowing what was found. What IS known now is
      // whether this push is ALLOWED to proceed over findings: with `ignoreSecrets` unset, the only
      // way a commit gets written at all is a scan that cleared, so the claim is true by
      // construction. With it set, the push may go ahead over a finding, and claiming the gate
      // would put a false receipt on the one commit where the receipt matters most. So the gate is
      // added in the first case and withheld in the second, and the override is recorded in
      // secret_scan_findings and audit_log where it belongs.
      const extraGates: ValidationGate[] = req.ignoreSecrets === true ? [] : ["secret-scan"];

      // WHICH OF THESE VERSIONS A VALIDATED PULL PRODUCED — the fact `agent_versions.source` cannot
      // carry, because a pull publishes as `import` and so does a disk import.
      //
      // READ FROM `github_events`, WHICH ALREADY HOLDS IT. The pull runner writes a row naming the
      // version it published, and the KIND on that row draws the distinction the source column
      // could not: `pull` with `outcome: "ok"` cleared the same validator a generation does, and
      // `force_override` is precisely the pull that FAILED it and was published anyway. Only the
      // first may claim the gates — a receipt on the second would say the code was validated by the
      // one commit where it demonstrably was not.
      //
      // A READ FAILURE LEAVES THE SET EMPTY, which puts a pulled version back to under-claiming.
      // That is the safe direction and was the behaviour before this: a reader learns less than the
      // truth rather than something false.
      const validatedByPull = new Set<string>();
      try {
        for (const event of await this.deps.repo.events(ctx, agentUuid, 200)) {
          if (event.kind !== "pull" || event.outcome !== "ok") continue;
          for (const id of event.version_ids) validatedByPull.add(id);
        }
      } catch (err) {
        this.log(`[github] ${slug} could not read the event log for trailers: ${(err as Error)?.message}`);
      }

      const plan = staged
        ? planStaged(staged, snapshots, {
            subdirectory: link.subdirectory,
            includeArtifacts: link.include_artifacts,
            remotePaths: baseTree,
            message: req.message,
            provenance: { agentSlug: slug, extraGates, validatedByPull, ...(resolved?.model ? { model: resolved.model } : {}) },
          })
        : planPush(restack ? restack.snapshots : snapshots, {
            subdirectory: link.subdirectory,
            includeArtifacts: link.include_artifacts,
            squash: req.squash === true,
            remotePaths: baseTree,
            provenance: { agentSlug: slug, extraGates, validatedByPull, ...(resolved?.model ? { model: resolved.model } : {}) },
            ...(resolved && !restack ? { costs: resolved.costs } : {}),
          });

      // THE MESSAGE SOMEBODY TYPED WINS OVER THE ONE THIS CODE COMPOSED. The commit box pre-fills
      // from the version's own instruction and summary, so the two are usually the same sentence —
      // which is exactly why dropping an edited one was invisible: the commit that landed read
      // plausibly, and only somebody comparing it against what they had written would notice that
      // the box was decorative. The trailer is re-attached rather than left to the user, because
      // the panel identifies its own commits by it.
      //
      // SKIPPED FOR A STAGED SUBSET, which has already applied it. `planStaged` puts the typed
      // message on its one commit with a trailer naming the newest version the tree was built from;
      // re-attaching here would rebuild the same trailer from EVERY unpushed version's range, which
      // would claim a hand-picked subset of one file's hunks was v11 through v14.
      const typed = staged ? undefined : req.message?.trim();
      const onlyCommit = plan.commits.length === 1 ? plan.commits[0] : undefined;
      if (typed && onlyCommit) {
        onlyCommit.message = withVersionTrailer(
          typed,
          snapshots.map((s) => s.version),
          {
            agentSlug: slug,
            extraGates,
            validatedByPull,
            ...(resolved?.model ? { model: resolved.model } : {}),
            ...(resolved ? { costs: resolved.costs } : {}),
          },
        );
      }

      // 3. THE BLOBS. Deduplicated by content across the whole push: an unchanged file in six
      // consecutive versions is one upload, not six, and git would store one object either way.
      stage = stageId("blobs");
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
      stage = stageId("tree");
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

      // 5. §B.6.1'S SCAN, BETWEEN THE TREE AND THE COMMITS.
      //
      // Everything above this line is content-addressed and invisible: blobs and trees exist in
      // GitHub's object store and nothing points at them, so refusing here leaves the branch exactly
      // where it was and costs a garbage collection. One stage later would be the same refusal with
      // a commit object somebody could still fetch by sha.
      //
      // SCANNED OVER WHAT THE COMMITS WOULD CONTAIN, not over the versions. A hand-staged subset, a
      // restacked history and an ordinary push all arrive here as `plan.commits[].files`, so there
      // is one place a credential can be caught rather than three that have to agree.
      stage = stageId("scan");
      report(stage, "active");
      const scanned = new Map<string, string>();
      for (const commit of plan.commits) {
        for (const file of commit.files) scanned.set(file.path, file.content);
      }
      const findings = scanTree(
        [...scanned.entries()].map(([path, content]) => ({ path, content })),
        { knownValues: (await this.deps.knownSecretValues?.(ctx)) ?? [] },
      );
      if (findings.length > 0) {
        // RECORDED WHETHER OR NOT IT IS OVERRIDDEN, and before the outcome is decided. §B.6's rows
        // are mostly refusals nobody overrode, and the interesting minority is only meaningful
        // because the majority is written down too.
        await this.deps.repo.recordFindings(ctx, {
          agentId: agentUuid,
          linkId: link.id,
          findings,
          overridden: req.ignoreSecrets === true,
        });
        if (req.ignoreSecrets !== true) {
          // A REFUSAL, NOT A WARNING — the same posture as every other refusal in this product. The
          // override exists, it is one field, and §B.6.1 puts it under a kebab so that it is
          // available without being the path of least resistance.
          report(stage, "error");
          await this.deps.repo.record(ctx, {
            agentId: agentUuid,
            linkId: link.id,
            kind: "push",
            outcome: "refused",
            detail: `${stage}: ${refusalLine(findings)}`,
          });
          return {
            ok: false,
            shas: [],
            message: refusalLine(findings),
            failedStage: stage,
            findings,
          };
        }
        this.log(`[github] ${slug} pushed over ${findings.length} scan finding(s)`);
      }
      report(stage, "done");

      stage = stageId("commit");
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
      stage = stageId("ref");
      report(stage, "active");
      if (!parent) return await fail("nothing was written");
      if (head === null) await api.createRef(repo, link.branch, parent);
      else await api.updateRef(repo, link.branch, parent, req.force === true);
      report(stage, "done");

      // AND ONLY NOW THE POINTERS. See the header: a watermark written before the ref move is a
      // watermark that can be permanently wrong.
      //
      // THE VERSION POINTER IS OMITTED RATHER THAN SET TO NULL WHEN THERE IS NO VERSION TO POINT AT.
      // `planStaged` returns a null `headVersionId` because a hand-staged subset is not a version
      // having been pushed — and `patchLink` distinguishes "set this to null" from "leave this
      // alone" precisely so a caller can say which it means. Passing the null through would CLEAR
      // the pointer, which would report every version the agent has ever had as unpushed and offer
      // a push that writes the whole history onto the branch a second time. The sha watermarks do
      // move, because a commit genuinely landed and the next push has to build on it.
      await this.deps.repo.patchLink(ctx, link.id, {
        ...(plan.headVersionId === null ? {} : { lastPushedVersionId: plan.headVersionId }),
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
