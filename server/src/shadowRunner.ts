// Getting a git ref onto disk so it can be run once, and never anywhere near a version.
//
// `shadowRuns.ts` holds the row and the sweep policy; this holds the sequence. The split is the
// same one `githubPush.ts` and `githubPushRunner.ts` already keep, and for the same reason: what is
// interesting about the sequence is only interesting when something goes wrong, and what is
// interesting about the policy is testable without a network.
//
// THE SEQUENCE, AND WHERE IT STOPS. Resolve the ref. Read its tree. Stage the files into the object
// store under a staging id. Materialise them to a scratch directory. Check the contract. Hand the
// directory back. That is all — the caller dispatches an ordinary run against it, because a shadow
// run IS an ordinary run, and the one thing this module is careful never to do is the step after
// it: there is no `publishStaging` here, no `promoteVersion`, and no reference to `agent_versions`
// at all. §B.2.2's guarantee is structural rather than checked.
//
// AND WHY IT REUSES THE PULL RUNNER'S SHAPE WITHOUT REUSING ITS CODE. A pull reads the same tree
// through the same API and stages it the same way — and then diverges completely: it runs the full
// validator, it refuses on failure, it publishes, it moves the pointer and it moves the watermark.
// Five of those six are exactly what a shadow run must not do. Sharing a function with five
// parameters that turn off five behaviours would be a function whose default is dangerous.
//
// THE CONTRACT CHECK AND NOT THE VALIDATOR. §B.2.2: the contract has to run, because `build_graph`
// is what builds the graph and without it there is nothing to run at all. The rest of the validator
// does not, because a shadow run is disposable by definition and a rule-3 `print()` in a branch
// somebody is INSPECTING is not a reason to refuse to show them what the branch does. A contract
// failure comes back as a message the caller turns into a run with `status: "error"`.

import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { GithubError, MAX_BLOB_BYTES, type GithubApi } from "./githubApi.ts";
import { inSubdirectory, repoPrefix } from "./githubPush.ts";
import { shadowStagingId, type ShadowRun, type ShadowRunRepository } from "./shadowRuns.ts";
import { CONTRACT_CHECKS } from "./validator.ts";
import type { GithubLink } from "./db/repositories/github.ts";
import type { ProjectStore, StoredFile } from "./storage/projectStore.ts";
import type { TenantContext } from "./db/tenant.ts";

/**
 * How many files a ref's tree may contribute before this refuses.
 *
 * An agent project is a handful of Python files. This is not a performance ceiling — it is the
 * answer to somebody linking a repository whose subdirectory field is wrong and whose tree is a
 * node_modules: without it, a shadow run would download a few thousand blobs one at a time before
 * anybody could cancel it, on the repository owner's rate limit.
 */
const MAX_FILES = 200;

export interface ShadowPrepared {
  run: ShadowRun;
  /** Where the ref's tree was materialised. What `JAROKU_AGENT_DIR` points at. */
  projectDir: string;
  /** The commit the ref resolved to when this started. */
  headSha: string;
  /**
   * Why it cannot run, when it cannot.
   *
   * NOT AN EXCEPTION, because the answer to "what does this branch do?" for a branch that does not
   * satisfy the contract is "it does not run, and here is why" — which is an answer. The caller
   * finishes the row as `error` and the panel shows it as a run that failed, which is the graceful
   * failure v0.0.1's runner already guarantees for any broken agent.
   */
  contractProblem: string | null;
}

export interface ShadowRunnerDeps {
  shadows: ShadowRunRepository;
  projects: ProjectStore;
  /** Where scratch directories are made. `runtime/agents/.staging/` — see `stagingRoot`. */
  stagingRoot: string;
  log?: (line: string) => void;
}

export class ShadowRunner {
  private readonly log: (line: string) => void;

  constructor(private deps: ShadowRunnerDeps) {
    this.log = deps.log ?? ((line) => console.log(line));
  }

  /**
   * Everything up to the moment a run could start.
   *
   * THE ROW IS WRITTEN BEFORE THE DOWNLOAD, not after it. A process that dies mid-materialisation
   * leaves a `staging` row somebody can see and the sweep can reason about; the other order leaves a
   * directory on disk that nothing points at and nothing will ever reclaim.
   *
   * A FAILURE FINISHES THE ROW RATHER THAN THROWING PAST IT. Every exit from this method after the
   * row exists writes an outcome to it, because a row stuck in `staging` forever is the one state
   * `shouldSweep` deliberately refuses to reclaim — see its comment on why that conservatism is
   * right, and why it makes leaving one behind expensive.
   */
  async prepare(
    ctx: TenantContext,
    input: { api: GithubApi; agentUuid: string; agentSlug: string; link: GithubLink; ref: string },
  ): Promise<ShadowPrepared | { error: string }> {
    const { api, link } = input;
    const repo = link.repo_full_name;

    let headSha: string | null;
    try {
      headSha = await api.refSha(repo, input.ref);
    } catch (err) {
      return { error: err instanceof GithubError ? err.message : String(err) };
    }
    if (!headSha) return { error: `there is no ref called ${input.ref} on ${repo}` };

    const stagingId = shadowStagingId(headSha);
    const run = await this.deps.shadows.start(ctx, {
      agentId: input.agentUuid,
      linkId: link.id,
      ref: input.ref,
      headSha,
      stagingKey: stagingId,
    });

    const projectDir = join(this.deps.stagingRoot, stagingId);
    try {
      const files = await this.readTree(api, repo, headSha, link);
      if (files.length === 0) {
        await this.deps.shadows.finish(ctx, run.id, {
          status: "error",
          error: `${input.ref} has no files under the linked path`,
        });
        return { error: `${input.ref} has no files under the linked path` };
      }

      // STAGED INTO THE OBJECT STORE FIRST, exactly like a generation, and then materialised —
      // rather than written straight to disk. That is not ceremony: the object store is what a
      // second replica can read, and a shadow run whose files only exist on the machine that
      // fetched them would be a run nothing else could ever inspect the inputs of.
      for (const file of files) {
        await this.deps.projects.putStaging(ctx, input.agentUuid, stagingId, file);
      }
      mkdirSync(projectDir, { recursive: true });
      for (const file of files) {
        const target = join(projectDir, file.path);
        mkdirSync(dirname(target), { recursive: true });
        writeFileSync(target, file.content, "utf8");
      }

      return { run, projectDir, headSha, contractProblem: contractProblem(files) };
    } catch (err) {
      const message = err instanceof GithubError ? err.message : ((err as Error)?.message ?? String(err));
      await this.deps.shadows.finish(ctx, run.id, { status: "error", error: message });
      rmSync(projectDir, { recursive: true, force: true });
      await this.deps.projects.discardStaging(ctx, input.agentUuid, stagingId).catch(() => {});
      return { error: message };
    }
  }

  /**
   * The ref's tree, as project-relative files.
   *
   * SCOPED TO THE LINK'S SUBDIRECTORY and stripped of its prefix, so the staged project looks
   * exactly like the agent's own — which is what makes `JAROKU_AGENT_DIR` work at all. The same
   * `inSubdirectory` the push and the pull use, rather than a prefix assembled here: the version
   * that assembled its own tested for `agents/weather//` and matched nothing, which is the bug
   * `repoPrefix` exists to have fixed once.
   */
  private async readTree(
    api: GithubApi,
    repo: string,
    headSha: string,
    link: GithubLink,
  ): Promise<StoredFile[]> {
    const prefix = repoPrefix(link.subdirectory);
    const entries = (await api.tree(repo, headSha))
      .filter((e) => inSubdirectory(e.path, link.subdirectory))
      // A tree carries whatever the repository holds. Skipping what a project cannot contain keeps
      // a stray asset from spending a blob request and a megabyte of memory to be ignored.
      .filter((e) => (e.size ?? 0) <= MAX_BLOB_BYTES);

    if (entries.length > MAX_FILES) {
      throw new Error(
        `${entries.length} files under that path — an agent project is a handful. Check the subdirectory on this link.`,
      );
    }

    const files: StoredFile[] = [];
    for (const entry of entries) {
      const path = prefix ? entry.path.slice(prefix.length + 1) : entry.path;
      files.push({ path, content: await api.blob(repo, entry.sha, entry.path) });
    }
    return files;
  }

  /**
   * Reclaim what finished shadow runs left on disk.
   *
   * BEST-EFFORT AND NEVER THROWING. A sweep that failed loudly would turn a permissions problem on
   * one directory into an unhandled rejection on a timer, and the thing it is cleaning up is disk
   * space rather than correctness. The row is marked only after the directory is gone, so a failure
   * simply means the next sweep tries again.
   *
   * THE TRACE IS NOT TOUCHED. `runs` and `steps` are ordinary rows on retention's own schedule, and
   * `hasReadableTrace` stays true for a swept run — which is exactly what makes a fifteen-minute
   * window safe: somebody comparing two refs an hour later still has both traces.
   */
  async sweep(ctx: TenantContext, sweepable: readonly ShadowRun[]): Promise<number> {
    let reclaimed = 0;
    for (const run of sweepable) {
      if (!run.staging_key) continue;
      try {
        rmSync(join(this.deps.stagingRoot, run.staging_key), { recursive: true, force: true });
        await this.deps.projects.discardStaging(ctx, run.agent_id, run.staging_key).catch(() => {});
        await this.deps.shadows.markSwept(ctx, run.id);
        reclaimed++;
      } catch (err) {
        this.log(`[shadow] could not sweep ${run.staging_key}: ${(err as Error)?.message ?? String(err)}`);
      }
    }
    return reclaimed;
  }
}

/**
 * Whether this tree satisfies the contract, and what is missing if not.
 *
 * THE SAME `CONTRACT_CHECKS` THE VALIDATOR RUNS, imported rather than restated, for the reason
 * `liveDiagnostics.ts` gives at length one feature over: two definitions of what the contract is
 * would eventually disagree, and the disagreement would surface as a shadow run that refuses to
 * start for a project the real gate is perfectly happy with.
 *
 * ONE PROBLEM AND NOT A LIST. This is a sentence on a run that failed, not a validation report —
 * somebody asked what a branch does and the answer is that it does not import. The full list is
 * what the pull path produces, on the path where a list is actionable.
 */
function contractProblem(files: readonly StoredFile[]): string | null {
  const agent = files.find((f) => f.path === "agent.py");
  if (!agent) return "there is no agent.py under the linked path";
  for (const { re, missing } of CONTRACT_CHECKS) {
    if (!re.test(agent.content)) return `agent.py is missing ${missing}`;
  }
  if (!/\bTOOLS\b/.test(agent.content)) return "agent.py never references TOOLS";
  return null;
}
