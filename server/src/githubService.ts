// The panel's whole answer, assembled once.
//
// §1 gives the panel four regions — identity, verdict, changes, history — and the order is
// deliberate: the user's most common question ("am I okay?") is answered in the second region
// without scrolling. This module is what makes that possible, because all four regions are views
// of ONE reconciliation and the only way to keep them from disagreeing is to compute them
// together.
//
// A COARSE SNAPSHOT, AND THAT IS THE POINT. Everywhere else in this server a channel is a stream
// of narrow events; here one `state` event carries the link, the verdict, the version list and the
// remote commits at once. Finer events would mean a frame in which the verdict line has updated
// and the version list has not, and a panel that can show "in sync" above two unpushed versions
// has broken the one promise the whole feature makes.
//
// EVERY REMOTE READ IS OPTIONAL AND EVERY FAILURE IS A STATE, never an exception that empties the
// panel. GitHub being unreachable does not mean the user has no versions — it means the remote
// half is unknown, and §3.5 has a verdict for that. So the reads below are guarded individually
// and the worst outcome of a bad day at GitHub is a ⚠ with a reason, next to a completely accurate
// local history.

import { GithubError, type GithubApi, type GithubCommit } from "./githubApi.ts";
import type { GithubEvent, GithubLink, GithubRepository } from "./db/repositories/github.ts";
import type { GithubIdentity } from "./githubIdentity.ts";
import { badgeFor, syncVerdict, unpushedVersions, verdictLine, type SyncVerdict } from "./githubSync.ts";
import { inSubdirectory, repoPath } from "./githubPush.ts";
import type { Agent, AgentRepository, AgentVersion } from "./db/repositories/agents.ts";
import type { ProjectStore } from "./storage/projectStore.ts";
import type { TenantContext } from "./db/tenant.ts";
import { isSafeAgentId, readOnlyPaths } from "./projectFs.ts";

/** One version as the panel renders it. A projection, not the row — see the comment on `view`. */
export interface VersionRow {
  id: string;
  version: number;
  summary: string;
  createdAt: string;
  files: number;
  additions: number;
  deletions: number;
  /** The commit this version became, when it has become one. */
  sha: string | null;
  shaUrl: string | null;
}

/** A GitHub-only commit — §3.8's hollow dots. */
export interface CommitRow {
  sha: string;
  message: string;
  author: string | null;
  at: string;
  url: string;
}

/**
 * One file the unpushed versions touched — §3.3's Changes region.
 *
 * DERIVED FROM `file_stats` ACROSS THE UNPUSHED RUN rather than from a working tree, because
 * Jaroku has no working tree: an agent's files are immutable per version and the "uncommitted
 * change" a git client would show is, here, the set of paths the versions since the last push
 * touched. Merged newest-wins on status and summed on the figures, so a file edited in three
 * versions is one row saying what happened to it overall.
 */
export interface ChangeRow {
  path: string;
  status: "added" | "modified";
  additions: number;
  deletions: number;
  /** §3.3's PROTECTED group. Listed, visible, and never stageable. */
  locked: boolean;
}

export interface PullRequestRow {
  number: number;
  title: string;
  url: string;
  commits: number;
  files: number;
  additions: number;
  deletions: number;
  /** `success`, `failure`, `pending`, or null when nothing has reported. Null is not passing. */
  checks: string | null;
}

export interface BranchRow {
  name: string;
  sha: string;
  isDefault: boolean;
  current: boolean;
}

export interface GithubView {
  agentId: string;
  agentSlug: string;
  link: GithubLink;
  repoUrl: string;
  state: SyncVerdict["state"];
  reason?: SyncVerdict["reason"];
  ahead: number;
  behind: number | null;
  badge: string | null;
  verdict: string;
  unpushed: VersionRow[];
  pushed: VersionRow[];
  /** Commits on the branch that no version accounts for. §3.8's hollow dots. */
  remoteOnly: CommitRow[];
  branches: BranchRow[];
  /**
   * Paths the edit loop and the staging area may not touch, project-relative — as `changes` is.
   *
   * §3.3's PROTECTED group, and the part a generic git client gets wrong. Sent from the server
   * rather than derived in the browser because the block list is the same one `projectFs` enforces
   * — two copies of it would be two answers to "may this be edited", and the client's copy would
   * be the one an attacker can edit.
   */
  protectedPaths: string[];
  changes: ChangeRow[];
  /**
   * Paths the remote changed since our watermark — §A.4's FROM REMOTE group.
   *
   * A LIST OF PATHS AND NOT A DIFF. The panel's job here is to say WHICH files a pull would bring
   * in, so the user can see before pressing anything whether it touches something they care about;
   * the diff itself lives on GitHub, where review already works. Empty whenever nothing is behind,
   * which is most of the time, so the group simply does not render.
   */
  remoteChanges: string[];
  pr: PullRequestRow | null;
  events: GithubEvent[];
}


/**
 * One thing the composer has attached — §7.
 *
 * A REFERENCE, NOT CONTENT. The chip in the composer holds an identifier and the server resolves
 * it at send time, which matters for a reason beyond payload size: an attachment made five minutes
 * ago and sent now should describe the repository AS IT IS, not as it was when somebody clicked.
 * A client that captured the diff would quietly ground the assistant in a stale one.
 */
export type GithubAttachmentRef =
  /** §7 Phase 1: what is here that GitHub does not have. */
  | { kind: "unpushed" }
  /** §7 Phase 1: a commit by sha. */
  | { kind: "commit"; sha: string }
  /** §7 Phase 2: one file, as it stands on a ref. */
  | { kind: "file"; path: string; ref: string }
  /** §7 Phase 2: what changed on GitHub since we last looked. The sync-state question, in chat. */
  | { kind: "sinceSync" }
  /** §7 Phase 2: the open PR. */
  | { kind: "pr" };

export interface GithubServiceDeps {
  repo: GithubRepository;
  identity: GithubIdentity;
  agents: AgentRepository;
  projects: ProjectStore;
  /** Catalogue filenames, so a reviewed connector template is protected whether installed or not. */
  connectorFilesFor: (agent: Agent | undefined, slug: string) => string[];
  log?: (line: string) => void;
}

/** How many remote commits and history rows one view carries. Enough to read, not enough to scroll. */
const HISTORY_LIMIT = 30;

/**
 * How much attached GitHub context one message may carry, in characters.
 *
 * Thirty thousand: a couple of source files or a long diff, well under the model's window, and
 * small enough that attaching four things cannot turn one question into the most expensive call
 * the workspace makes that day. Shared across the whole set rather than per attachment — see
 * `resolveAttachments`.
 */
const ATTACHMENT_BUDGET = 30_000;

/**
 * A newline, named.
 *
 * Not style: the attachment block is assembled from template literals, and a literal line break
 * inside one of those is a line break in the OUTPUT — which is fine — sitting in source that then
 * has to be edited around. Naming it keeps each of those expressions on one line, where the shape
 * of what is being built stays readable.
 */
const NL = String.fromCharCode(10);

/**
 * The branch Jaroku owns for an agent.
 *
 * `jaroku/<slug>`, and §3.1 is unambiguous about why the default is not `main`: Jaroku never
 * writes to the default branch, humans edit theirs exactly as they normally would, and
 * reconciliation is always through a PR rather than a silent auto-merge. A user can point the link
 * at any branch they like — including `main`, which is their repository and their decision — but
 * nothing here proposes it.
 */
export function defaultBranchFor(slug: string): string {
  return `jaroku/${slug}`;
}

export class GithubService {
  private readonly log: (line: string) => void;

  constructor(private deps: GithubServiceDeps) {
    this.log = deps.log ?? ((line) => console.log(line));
  }

  /**
   * Everything about one agent's link, or null when it has none.
   *
   * THE VERSION ROWS ARE A PROJECTION AND NOT THE DATABASE ROWS. An `agent_versions` row carries a
   * full manifest — every path, its sha and its size — which for a fifteen-version agent is a
   * payload measured in tens of kilobytes, sent on every refresh, to render a list of one-line
   * summaries. The panel needs a sentence, a count and three numbers.
   */
  async view(ctx: TenantContext, agentId: string): Promise<GithubView | null> {
    if (!isSafeAgentId(agentId)) return null;
    const agent = await this.deps.agents.bySlug(ctx, agentId);
    if (!agent) return null;
    const link = await this.deps.repo.linkFor(ctx, agent.id);
    if (!link) return null;

    const versions = await this.deps.agents.versions(ctx, agent.id);
    const events = await this.deps.repo.events(ctx, agent.id, HISTORY_LIMIT);

    // Which version became which commit, from the append-only log. Reconstructed rather than
    // stored on the version row, because a version can be pushed to two branches over its life and
    // a single `sha` column would hold whichever push happened last.
    const shaFor = new Map<string, string>();
    for (const event of [...events].reverse()) {
      if (event.kind !== "push" || event.outcome !== "ok" || !event.commit_sha) continue;
      for (const id of event.version_ids) shaFor.set(id, event.commit_sha);
    }

    const remote = await this.readRemote(ctx, link);
    const verdict = syncVerdict(link, versions, remote.state);
    const unpushedIds = new Set(unpushedVersions(versions, link.last_pushed_version_id).map((v) => v.id));

    const rows = versions.map((v) => this.versionRow(v, link, shaFor.get(v.id) ?? null));

    return {
      agentId: agent.slug,
      agentSlug: agent.slug,
      link,
      repoUrl: `https://github.com/${link.repo_full_name}`,
      state: verdict.state,
      ...(verdict.reason ? { reason: verdict.reason } : {}),
      ahead: verdict.ahead,
      behind: verdict.behind,
      badge: badgeFor(verdict),
      verdict: verdictLine(verdict, link.branch),
      unpushed: rows.filter((r) => unpushedIds.has(r.id)),
      pushed: rows.filter((r) => !unpushedIds.has(r.id)),
      remoteOnly: remote.remoteOnly,
      branches: remote.branches.map((b) => ({ ...b, current: b.name === link.branch })),
      protectedPaths: this.protectedFor(agent, link),
      changes: this.changesFor(agent, versions, unpushedIds),
      remoteChanges: remote.remoteChanges,
      pr: remote.pr,
      events,
    };
  }

  /**
   * What the unpushed run changed, as one row per path.
   *
   * ADDED BEATS MODIFIED when a file appears in both. A file created two versions ago and edited
   * since is, from GitHub's point of view, a new file — and labelling it "modified" would point the
   * glyph at a state the remote has never seen.
   */
  private changesFor(agent: Agent, versions: AgentVersion[], unpushedIds: Set<string>): ChangeRow[] {
    const readOnly = readOnlyPaths(this.deps.connectorFilesFor(agent, agent.slug));
    const merged = new Map<string, ChangeRow>();
    // Oldest first, so a later "modified" cannot overwrite an earlier "added" — see above.
    for (const version of [...versions].reverse()) {
      if (!unpushedIds.has(version.id)) continue;
      for (const stat of version.file_stats ?? []) {
        const existing = merged.get(stat.path);
        merged.set(stat.path, {
          path: stat.path,
          status: existing?.status === "added" ? "added" : stat.status,
          additions: (existing?.additions ?? 0) + stat.additions,
          deletions: (existing?.deletions ?? 0) + stat.deletions,
          locked: readOnly.has(stat.path),
        });
      }
    }
    return [...merged.values()].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  }

  private versionRow(version: AgentVersion, link: GithubLink, sha: string | null): VersionRow {
    const stats = version.file_stats ?? [];
    return {
      id: version.id,
      version: version.version,
      // The sentence the history list already shows, so a push row and a version row read the
      // same. `instruction` first because it is what the user asked for, which is more useful than
      // what the model says it did.
      summary: version.instruction?.trim() || version.summary?.trim() || `Version ${version.version}`,
      createdAt: version.created_at,
      files: stats.length,
      additions: stats.reduce((n, f) => n + f.additions, 0),
      deletions: stats.reduce((n, f) => n + f.deletions, 0),
      sha,
      shaUrl: sha ? `https://github.com/${link.repo_full_name}/commit/${sha}` : null,
    };
  }

  /**
   * The read-only set, in the SAME path space as `changes` — project-relative, POSIX.
   *
   * IT USED TO CARRY THE LINK'S SUBDIRECTORY PREFIX, and the panel is the reason that was wrong.
   * §3.3's PROTECTED group renders these beside `changes` rows and subtracts one list from the
   * other to find the protected files nothing touched — and `file_stats` paths are project-
   * relative, so under a subdirectory link `agents/weather/tools/__init__.py` never equalled
   * `tools/__init__.py`. Nothing errored: a protected file that HAD been touched was rendered
   * twice, once from each list, in two different spellings of its own name, and the composer's
   * @-picker offered both as though they were two files.
   *
   * Still normalised rather than passed through, because `readOnlyPaths` is fed by
   * `connectorFilesFor` and a backslash arriving from a catalogue entry would make the block list
   * match nothing on one operating system — which is not a rendering glitch but a hand-staged edit
   * to `mcp_bridge.py` becoming possible on exactly one platform.
   */
  private protectedFor(agent: Agent, _link: GithubLink): string[] {
    const files = this.deps.connectorFilesFor(agent, agent.slug);
    return [...readOnlyPaths(files)].map((p) => p.replace(/\\/g, "/").replace(/^\/+/, "")).sort();
  }

  /**
   * The remote half, with every failure turned into a state.
   *
   * FIVE READS AND FOUR OF THEM ARE ALLOWED TO FAIL. Only the ref lookup decides the verdict; the
   * branch list, the commit list and the PR are context, and a panel that refused to render a
   * correct local history because a PR lookup 500'd would be trading the useful ninety percent for
   * the decorative ten.
   */
  private async readRemote(
    ctx: TenantContext,
    link: GithubLink,
  ): Promise<{
    state: { headSha: string | null; repoReachable: boolean; tokenRevoked?: boolean; behindBy?: number | null };
    remoteOnly: CommitRow[];
    remoteChanges: string[];
    branches: { name: string; sha: string; isDefault: boolean }[];
    pr: PullRequestRow | null;
  }> {
    const empty = { remoteOnly: [], remoteChanges: [], branches: [], pr: null };
    const connection = await this.deps.identity.apiFor(ctx);
    if (!connection) {
      return { state: { headSha: null, repoReachable: false, tokenRevoked: true }, ...empty };
    }
    const { api } = connection;

    let defaultBranch = "main";
    try {
      defaultBranch = (await api.repo(link.repo_full_name)).defaultBranch;
    } catch (err) {
      if (err instanceof GithubError && err.kind === "auth") {
        // Believe GitHub. Leaving the grant live would mean a stale ↑2 that no push will clear.
        await this.deps.identity.markRevoked(ctx, err.message);
        return { state: { headSha: null, repoReachable: false, tokenRevoked: true }, ...empty };
      }
      return { state: { headSha: null, repoReachable: false }, ...empty };
    }

    let headSha: string | null = null;
    try {
      headSha = await api.refSha(link.repo_full_name, link.branch);
    } catch {
      // Reachable repository, unreadable ref. Treated as absent, which the verdict reads as
      // branch_missing once something has been pushed and as "not there yet" before that.
      headSha = null;
    }

    // Only asked when the cheap answer says something changed. A `compare` per agent per poll
    // would spend the token's rate limit on a number the badge does not need.
    let behindBy: number | null = null;
    let remoteChanges: string[] = [];
    const watermark = link.last_known_remote_sha ?? link.last_pushed_sha;
    if (headSha && watermark && headSha !== watermark) {
      try {
        // ONE CALL ANSWERS BOTH. `compare` returns the count and the file list together, so
        // "how far behind" and "which files" cost the same single request — which is the whole
        // reason the FROM REMOTE group can exist without a second round trip per panel open.
        const comparison = await api.compare(link.repo_full_name, watermark, headSha);
        behindBy = comparison.aheadBy;
        // Scoped to our subdirectory, for the same reason a push's deletions are: in a monorepo
        // the other agents' files are not this agent's pending changes. Through `inSubdirectory`
        // rather than a prefix built here — the local version tested against `agents/weather//`
        // and therefore filtered the list down to nothing on exactly the links the FROM REMOTE
        // group exists for, while reading as a repository where nothing had changed.
        remoteChanges = comparison.files.filter((f) => inSubdirectory(f, link.subdirectory));
      } catch {
        behindBy = null;
      }
    }

    return {
      state: { headSha, repoReachable: true, behindBy },
      remoteOnly: await this.remoteOnlyCommits(api, link, headSha),
      remoteChanges,
      branches: await this.branchList(api, link, defaultBranch),
      pr: await this.pullRequest(api, link, defaultBranch),
    };
  }

  /**
   * Commits on the branch that Jaroku did not write.
   *
   * IDENTIFIED BY THE TRAILER, not by author or by date. `githubPush.messageFor` puts
   * `Jaroku-Version: n` on every commit it writes, and that is the only signal that survives a
   * rebase, a squash-merge by a teammate, or a repository whose commits are all authored by the
   * same bot account. §3.8's hollow dots are precisely "a commit no version accounts for", and
   * this is the one honest way to compute that from GitHub's side.
   */
  private async remoteOnlyCommits(api: GithubApi, link: GithubLink, headSha: string | null): Promise<CommitRow[]> {
    if (!headSha) return [];
    let commits: GithubCommit[];
    try {
      commits = await api.commits(link.repo_full_name, link.branch, HISTORY_LIMIT);
    } catch {
      return [];
    }
    return commits
      .filter((c) => !/^Jaroku-Versions?:/m.test(c.message))
      .map((c) => ({
        sha: c.sha,
        message: c.message.split("\n")[0] ?? "",
        author: c.authorLogin,
        at: c.authoredAt,
        url: c.htmlUrl,
      }));
  }

  private async branchList(
    api: GithubApi,
    link: GithubLink,
    defaultBranch: string,
  ): Promise<{ name: string; sha: string; isDefault: boolean }[]> {
    try {
      return await api.branches(link.repo_full_name, defaultBranch);
    } catch {
      return [];
    }
  }

  /**
   * The open PR from Jaroku's branch, with its CI verdict.
   *
   * NULL CHECKS ARE RENDERED AS NULL. §3.9 argues that CI status is a genuine gate here rather than
   * decoration, because Jaroku emits a Dockerfile and a repo with one can run real build checks —
   * and the fastest way to turn a gate back into decoration is to render "nothing has reported" as
   * a green tick.
   */
  private async pullRequest(api: GithubApi, link: GithubLink, defaultBranch: string): Promise<PullRequestRow | null> {
    try {
      const pr = await api.openPullRequest(link.repo_full_name, link.branch, defaultBranch);
      if (!pr) return null;
      let checks: string | null = null;
      try {
        const head = await api.refSha(link.repo_full_name, link.branch);
        checks = head ? ((await api.combinedStatus(link.repo_full_name, head))?.state ?? null) : null;
      } catch {
        checks = null;
      }
      return {
        number: pr.number,
        title: pr.title,
        url: pr.htmlUrl,
        commits: pr.commits,
        files: pr.changedFiles,
        additions: pr.additions,
        deletions: pr.deletions,
        checks,
      };
    } catch {
      return null;
    }
  }


  /**
   * Turn attachment references into text the assistant can be grounded in.
   *
   * ONE BUDGET ACROSS THE WHOLE SET, not per attachment. Three files at a ref is three whole
   * source files, and a context that grows with the number of chips is a context that silently
   * stops fitting — so the cap is on the total and the block says when it truncated, rather than
   * quietly ending mid-file.
   *
   * A REFERENCE THAT CANNOT BE RESOLVED BECOMES A LINE SAYING SO, never an exception. The user
   * attached something and pressed send; failing the whole message because one commit was
   * force-pushed away in the meantime would lose the question they typed.
   *
   * NOTHING HERE TRIGGERS A WRITE. §7's closing rule, enforced by there being no code path from
   * this method to a push, a pull or a ref update — attaching brings context IN, and every action
   * that reaches GitHub lives in the panel where it is confirmed.
   */
  async resolveAttachments(
    ctx: TenantContext,
    agentId: string,
    refs: GithubAttachmentRef[],
  ): Promise<string> {
    if (refs.length === 0) return "";
    const view = await this.view(ctx, agentId);
    if (!view) return "";
    const connection = await this.deps.identity.apiFor(ctx);
    const repo = view.link.repo_full_name;
    const parts: string[] = [];
    let budget = ATTACHMENT_BUDGET;

    const push = (heading: string, body: string): void => {
      if (budget <= 0) return;
      const text = body.length > budget ? `${body.slice(0, budget)}\n… (truncated)` : body;
      budget -= text.length;
      parts.push(`--- ${heading} ---\n${text}`);
    };

    for (const ref of refs) {
      try {
        if (ref.kind === "unpushed") {
          push(
            `Unpushed versions (${view.unpushed.length})`,
            view.unpushed.length === 0
              ? "nothing unpushed"
              : [
                  ...view.unpushed.map((v) => `v${v.version} ${v.summary} (+${v.additions}/-${v.deletions})`),
                  "",
                  "Files touched:",
                  ...view.changes.map((c) => `${c.status} ${c.path} (+${c.additions}/-${c.deletions})`),
                ].join("\n"),
          );
        } else if (ref.kind === "commit") {
          if (!connection) throw new Error("GitHub is not connected");
          const commits = await connection.api.commits(repo, view.link.branch, 100);
          const found = commits.find((c) => c.sha.startsWith(ref.sha));
          if (!found) throw new Error(`no commit ${ref.sha} on ${view.link.branch}`);
          const compare = await connection.api.compare(repo, `${found.sha}^`, found.sha);
          push(
            `Commit ${found.sha.slice(0, 7)}`,
            [
              found.message,
              found.authorLogin ? `by @${found.authorLogin} at ${found.authoredAt}` : found.authoredAt,
              "",
              ...compare.files.map((f) => `changed ${f}`),
            ].join("\n"),
          );
        } else if (ref.kind === "file") {
          if (!connection) throw new Error("GitHub is not connected");
          const head = await connection.api.refSha(repo, ref.ref);
          if (!head) throw new Error(`no ref ${ref.ref}`);
          const full = repoPath(ref.path, view.link.subdirectory);
          const entry = (await connection.api.tree(repo, head)).find((e) => e.path === full || e.path === ref.path);
          if (!entry) throw new Error(`${ref.path} is not on ${ref.ref}`);
          push(`${ref.path} @ ${ref.ref}`, await connection.api.blob(repo, entry.sha, entry.path));
        } else if (ref.kind === "sinceSync") {
          if (!connection) throw new Error("GitHub is not connected");
          const watermark = view.link.last_pushed_sha ?? view.link.last_known_remote_sha;
          const head = await connection.api.refSha(repo, view.link.branch);
          if (!watermark || !head) throw new Error("there is no last-sync point to compare against");
          const compare = await connection.api.compare(repo, watermark, head);
          push(
            `Changed on GitHub since Jaroku last synced (${watermark.slice(0, 7)} → ${head.slice(0, 7)})`,
            compare.files.length === 0 ? "no files changed" : compare.files.map((f) => `changed ${f}`).join(NL),
          );
        } else if (ref.kind === "pr") {
          if (!view.pr) throw new Error("there is no open pull request");
          push(
            `Pull request #${view.pr.number}`,
            [
              view.pr.title,
              `${view.pr.commits} commits, ${view.pr.files} files, +${view.pr.additions}/-${view.pr.deletions}`,
              `checks: ${view.pr.checks ?? "none reported"}`,
              view.pr.url,
            ].join("\n"),
          );
        }
      } catch (err) {
        // Named rather than dropped. An assistant told "this attachment could not be read" answers
        // better than one silently given less than the user believes it has.
        parts.push(`--- attachment unavailable ---${NL}${(err as Error)?.message ?? String(err)}`);
      }
    }
    return parts.join(NL + NL);
  }

  // --- linking ----------------------------------------------------------------

  /** §2.2's existing-repo search. Filtered client-side on a list the token can actually write to. */
  async repos(ctx: TenantContext, query?: string): Promise<unknown[]> {
    const connection = await this.deps.identity.apiFor(ctx);
    if (!connection) return [];
    const all = await connection.api.repos();
    const q = (query ?? "").trim().toLowerCase();
    return (q ? all.filter((r) => r.fullName.toLowerCase().includes(q)) : all).slice(0, 50);
  }

  /**
   * §2.2's live availability check.
   *
   * A NAME THAT IS NOT A LEGAL REPOSITORY NAME IS "UNAVAILABLE" RATHER THAN AN ERROR. The check
   * runs on every keystroke, and `weather agent` — a space, mid-typing — is not worth a red strip.
   * GitHub would refuse it at creation; saying so quietly as the user types is the same answer,
   * earlier.
   */
  async checkName(ctx: TenantContext, name: string): Promise<{ name: string; available: boolean }> {
    const clean = name.trim();
    if (!/^[A-Za-z0-9._-]{1,100}$/.test(clean)) return { name: clean, available: false };
    const connection = await this.deps.identity.apiFor(ctx);
    if (!connection) return { name: clean, available: false };
    const owner = connection.installation.account_login;
    try {
      return { name: clean, available: !(await connection.api.repoExists(`${owner}/${clean}`)) };
    } catch {
      // Unreachable is not available. Reporting a name free because we could not ask would send
      // somebody into a create that fails on the far side.
      return { name: clean, available: false };
    }
  }

  /**
   * Point an agent at a repository, creating one first if that is what was asked for.
   *
   * THE REPOSITORY IS CREATED BEFORE THE LINK ROW AND THE LINK ROW IS WRITTEN ONLY IF IT WORKED.
   * The other order — write the link, then create — leaves a link pointing at a repository that
   * does not exist whenever the create fails, and the panel's first honest act would be to show ⚠
   * on something the user just set up successfully as far as they could tell.
   */
  async link(
    ctx: TenantContext,
    input: {
      agentId: string;
      repoFullName?: string;
      createName?: string;
      createPrivate?: boolean;
      branch?: string;
      subdirectory?: string | null;
      includeArtifacts?: boolean;
    },
  ): Promise<{ ok: boolean; message?: string }> {
    if (!isSafeAgentId(input.agentId)) return { ok: false, message: "invalid agent id" };
    const agent = await this.deps.agents.bySlug(ctx, input.agentId);
    if (!agent) return { ok: false, message: "no such agent in this workspace" };
    const connection = await this.deps.identity.apiFor(ctx);
    if (!connection) return { ok: false, message: "connect GitHub first" };

    let repoFullName = input.repoFullName?.trim() ?? "";
    if (!repoFullName) {
      const name = input.createName?.trim() ?? "";
      if (!name) return { ok: false, message: "choose a repository, or name one to create" };
      const created = await connection.api.createRepo(name, {
        private: input.createPrivate ?? true,
        description: `${agent.display_name ?? agent.slug} — agent source, pushed by Jaroku.`,
      });
      repoFullName = created.fullName;
      this.log(`[github] created ${repoFullName} for ${agent.slug}`);
    }

    const link = await this.deps.repo.link(ctx, {
      agentId: agent.id,
      installationId: connection.installation.id,
      repoFullName,
      branch: input.branch?.trim() || defaultBranchFor(agent.slug),
      subdirectory: input.subdirectory ?? null,
      includeArtifacts: input.includeArtifacts ?? true,
    });
    await this.deps.repo.record(ctx, {
      agentId: agent.id,
      linkId: link.id,
      kind: "link",
      detail: `${repoFullName} · ${link.branch}`,
    });
    return { ok: true };
  }

  /** Detach. Soft, and the repository is never touched — see §6 and the repository's own note. */
  async unlink(ctx: TenantContext, agentId: string): Promise<{ ok: boolean; message?: string }> {
    if (!isSafeAgentId(agentId)) return { ok: false, message: "invalid agent id" };
    const agent = await this.deps.agents.bySlug(ctx, agentId);
    if (!agent) return { ok: false, message: "no such agent in this workspace" };
    const link = await this.deps.repo.linkFor(ctx, agent.id);
    await this.deps.repo.unlink(ctx, agent.id);
    await this.deps.repo.record(ctx, {
      agentId: agent.id,
      linkId: link?.id ?? null,
      kind: "unlink",
      detail: link ? `${link.repo_full_name} · ${link.branch}` : null,
    });
    return { ok: true };
  }

  /**
   * Re-read the remote and move the watermark to what is there now.
   *
   * THE ONLY WRITE IS THE WATERMARK, and it is what makes this safe to run on every panel open. It
   * records what we have SEEN, never what we have DONE — so a fetch can change a verdict from
   * "behind" to "diverged" as it learns more, and can never make an unpushed version look pushed.
   */
  async refresh(ctx: TenantContext, agentId: string, explicit = false): Promise<void> {
    if (!isSafeAgentId(agentId)) return;
    const agent = await this.deps.agents.bySlug(ctx, agentId);
    if (!agent) return;
    const link = await this.deps.repo.linkFor(ctx, agent.id);
    if (!link) return;
    const before = link.last_known_remote_sha;
    const remote = await this.readRemote(ctx, link);
    if (!remote.state.repoReachable) return;
    await this.deps.repo.patchLink(ctx, link.id, {
      lastKnownRemoteSha: remote.state.headSha,
      lastSyncedAt: new Date().toISOString(),
    });
    // RECORDED ONLY WHEN A PERSON ASKED. The panel refreshes on every open, and an event per
    // render would bury the rows this table exists for — the refusals and the overrides — under a
    // log of somebody having the tab in front of them.
    if (!explicit) return;
    await this.deps.repo.record(ctx, {
      agentId: agent.id,
      linkId: link.id,
      kind: "fetch",
      commitSha: remote.state.headSha,
      // WHAT CHANGED, not just that a check happened. "Nothing moved" is the answer somebody
      // fetched to get, and a row that only said "fetched" would make them compare shas by eye.
      detail:
        before === remote.state.headSha
          ? "no change"
          : `${(before ?? "—").slice(0, 7)} → ${(remote.state.headSha ?? "—").slice(0, 7)}`,
    });
  }
}
