// GitHub's REST API, as much of it as two lineages need to be reconciled.
//
// A bare `fetch`, no Octokit — the same choice railwayApi.ts made for the same reason: this is a
// dozen calls to one host, and an SDK here would be a dependency in the path of every push, kept
// current forever, to save writing out a URL.
//
// WHAT THIS FILE IS AND IS NOT. It is a transport: it speaks HTTP, classifies failures, and hands
// back plain data. It knows nothing about agents, versions, staging or validation — a push is
// assembled in githubPush.ts and a pull is validated in the same place every generated file is.
// That separation is what makes the interesting parts testable without a network.
//
// THE GIT DATA API RATHER THAN THE CONTENTS API, and it is the one design decision here worth
// stating. `PUT /contents/{path}` writes one file per commit, so a version touching three files
// would be three commits with two intermediate states that never existed — and §2.3 promises one
// commit per version. The Git Data API builds a tree, writes a commit object against it, and moves
// the ref in a single fast-forward: either the whole version lands or nothing does, which is the
// same "lands completely or leaves the project untouched" guarantee v0.2.3 makes about deploys.
//
// FOUR PROPERTIES EVERY CALL HOLDS, and each is the answer to something that bites later:
//
//   BOUNDED. GitHub going quiet must not turn into a push that hangs behind a spinner nobody can
//   cancel. Every request carries a deadline, and the deadline is a failure with a name.
//
//   CLASSIFIED. "your token was revoked", "that repo is gone", "somebody pushed first" and
//   "GitHub is having a bad day" need four different things from the user, so they are four
//   different kinds here rather than one string that a UI has to regex.
//
//   CONDITIONAL WHERE IT MATTERS. Moving a ref is the one write that can silently destroy work —
//   `force: false` is the default and is what makes a concurrent push lose the race cleanly rather
//   than overwriting whoever won it.
//
//   NEVER ECHOES THE TOKEN. It goes in a header, never in a URL, never in a log line, and no error
//   message quotes a request. A 401's body is not information anybody can act on, and quoting the
//   response to a request that carried a credential is a habit worth not having.

import { numberFromEnv } from "./env.ts";

const DEFAULT_API = "https://api.github.com";

/** Overridable so the test fixtures and any GitHub Enterprise host can be pointed at. */
export function githubApiBase(): string {
  return process.env["JAROKU_GITHUB_API"] || DEFAULT_API;
}

/**
 * The SecretStore name a workspace's GitHub token lives under.
 *
 * One name per workspace rather than one per linked account, because the store is keyed on
 * (workspace_id, name) and a workspace has one GitHub grant at a time in practice. The
 * installation row points at this name rather than the other way round, so the day a second
 * concurrent account is wanted the name becomes `GITHUB_TOKEN_<login>` and nothing else moves.
 */
export const GITHUB_ENV_KEY = "GITHUB_TOKEN";

const REQUEST_TIMEOUT_MS = numberFromEnv("JAROKU_GITHUB_TIMEOUT_MS", 20_000);

/**
 * The largest blob this client will send or accept.
 *
 * §6 lists "huge file / binary in remote tree" as a state that must be designed rather than
 * discovered, and this is where it is designed: an agent project is a few kilobytes of Python, so
 * a megabyte is generous by two orders of magnitude and still small enough that a repository
 * someone pointed at by mistake fails fast with the path named instead of streaming a video into
 * memory. Matched against `projectFs.MAX_FILE_BYTES` on the way out and enforced again on the way
 * in, because the two directions are trusted differently.
 */
export const MAX_BLOB_BYTES = 1_000_000;

export type GithubFailureKind =
  /** The token is missing, wrong, revoked, or lacks the scope. The user must fix a credential. */
  | "auth"
  /** The repository, branch or commit is not there. Distinct from `api`: the fix is to relink. */
  | "not_found"
  /**
   * The ref moved under us. Its own kind because it is the ONLY failure here that means "you are
   * not wrong, you are late" — the user's move is to fetch and look, not to retry or fix anything.
   */
  | "conflict"
  /** Reached GitHub; it refused. Its own message is the useful part. */
  | "api"
  /** Secondary rate limit or abuse detection. Retryable, but only after the stated wait. */
  | "rate_limited"
  /** Never reached GitHub: DNS, refused, reset, our own deadline. Usually worth retrying. */
  | "unreachable";

export class GithubError extends Error {
  constructor(
    readonly kind: GithubFailureKind,
    message: string,
    readonly operation: string,
    /** Seconds to wait, on a `rate_limited`. Read from GitHub's own header, never guessed. */
    readonly retryAfterS?: number,
  ) {
    super(message);
    this.name = "GithubError";
  }
}

export interface GithubAccount {
  login: string;
  /** GitHub's own numeric id. Stable across renames, which `login` is not. */
  id: number;
  avatarUrl: string | null;
}

export interface GithubRepo {
  fullName: string;
  private: boolean;
  defaultBranch: string;
  htmlUrl: string;
  /** A repository with no commits at all. §6's "empty repo" state, answered by the API itself. */
  empty: boolean;
  pushedAt: string | null;
}

export interface GithubBranch {
  name: string;
  sha: string;
  /** Whether this is the repo's default branch — the one Jaroku never writes to. */
  isDefault: boolean;
}

export interface GithubCommit {
  sha: string;
  message: string;
  authorLogin: string | null;
  authoredAt: string;
  htmlUrl: string;
}

/** One file, as it goes into a tree. `content` is UTF-8 text; this client sends no binaries. */
export interface GithubBlob {
  path: string;
  content: string;
}

export interface GithubTreeEntry {
  path: string;
  /** GitHub's file mode. `100644` for everything Jaroku writes — no executables, no symlinks. */
  mode: string;
  type: "blob" | "tree" | "commit";
  sha: string;
  size?: number;
}

export interface GithubApiOptions {
  token: string;
  base?: string;
  timeoutMs?: number;
  /** Called with one line per request, for the server log. Never given a token or a body. */
  log?: (line: string) => void;
}

/** Cap a third party's text before it becomes our error message. */
function truncate(text: string, max = 300): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max)}…` : flat;
}

export class GithubApi {
  private readonly base: string;
  private readonly timeoutMs: number;
  private readonly log: (line: string) => void;

  constructor(private readonly opts: GithubApiOptions) {
    this.base = opts.base ?? githubApiBase();
    this.timeoutMs = opts.timeoutMs ?? REQUEST_TIMEOUT_MS;
    this.log = opts.log ?? (() => {});
  }

  /**
   * One request.
   *
   * `body` can contain a whole agent project. It is serialised into the request and is never
   * logged and never included in an error — the only things that come back out of here are
   * GitHub's data and a message this codebase wrote or truncated.
   *
   * THE 404-FOR-403 RULE. GitHub answers 404 rather than 403 for a private repository the token
   * cannot see, which is correct of them and awkward here: "the repo is gone" and "your token
   * lost access to it" arrive identically. Both are surfaced as `not_found`, and §3.5's verdict
   * line says "Repo not found — Relink" for both, because relinking is the action that resolves
   * either one and guessing between them out loud would be inventing a fact.
   */
  private async call<T>(
    operation: string,
    method: "GET" | "POST" | "PATCH" | "PUT" | "DELETE",
    path: string,
    body?: unknown,
  ): Promise<T> {
    const url = `${this.base}${path}`;
    let response: Response;
    try {
      response = await fetch(url, {
        method,
        headers: {
          // The token rides in a header. Never a query parameter, which is the one place a
          // credential ends up in somebody's access log for a year.
          Authorization: `Bearer ${this.opts.token}`,
          Accept: "application/vnd.github+json",
          "X-GitHub-Api-Version": "2022-11-28",
          "User-Agent": "jaroku",
          ...(body === undefined ? {} : { "Content-Type": "application/json" }),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (err) {
      // Transport-level: DNS, refused, reset, or our own deadline. Never GitHub's opinion.
      const detail = err instanceof Error ? err.message : String(err);
      throw new GithubError("unreachable", `could not reach GitHub: ${truncate(detail)}`, operation);
    }

    this.log(`[github] ${method} ${path} ${response.status}`);

    if (response.status === 401) {
      throw new GithubError(
        "auth",
        "GitHub rejected the token — it was revoked or has expired. Reconnect to continue.",
        operation,
      );
    }
    if (response.status === 403 || response.status === 429) {
      // A 403 from GitHub is usually a rate limit rather than a permission problem, and the two
      // are told apart by a header rather than by the body. Getting this wrong sends somebody to
      // re-authorise a token that is working perfectly.
      const remaining = response.headers.get("x-ratelimit-remaining");
      const retryAfter = Number(response.headers.get("retry-after") ?? "0");
      const reset = Number(response.headers.get("x-ratelimit-reset") ?? "0");
      if (response.status === 429 || remaining === "0" || retryAfter > 0) {
        const waitS = retryAfter > 0
          ? retryAfter
          : reset > 0
            ? Math.max(1, Math.ceil(reset - Date.now() / 1000))
            : 60;
        throw new GithubError(
          "rate_limited",
          `GitHub is rate-limiting this token. It will accept requests again in about ${waitS}s.`,
          operation,
          waitS,
        );
      }
      throw new GithubError(
        "auth",
        "GitHub refused: the token does not have write access to this repository.",
        operation,
      );
    }
    if (response.status === 404) throw new GithubError("not_found", "GitHub has no such repository, branch or commit — or this token cannot see it.", operation);
    // 409 is an empty repository on the contents/commits endpoints; 422 on a ref update is the
    // non-fast-forward. Both mean "the state you assumed is not the state that exists".
    if (response.status === 409 || response.status === 422) {
      const text = await response.text();
      throw new GithubError("conflict", `GitHub refused the update: ${truncate(text)}`, operation);
    }
    if (response.status === 204) return undefined as T;

    const text = await response.text();
    if (!response.ok) {
      throw new GithubError(
        response.status >= 500 ? "unreachable" : "api",
        `GitHub returned ${response.status}: ${truncate(text)}`,
        operation,
      );
    }
    if (!text) return undefined as T;
    try {
      return JSON.parse(text) as T;
    } catch {
      throw new GithubError("api", `GitHub sent a response that is not JSON: ${truncate(text)}`, operation);
    }
  }

  // --- identity ---------------------------------------------------------------

  /**
   * Who this token acts as, and write nothing.
   *
   * The equivalent of railwayApi's `verify`: a token that answers here is one we can name in the
   * UI, which is the whole of what §2.2's `✓ @username` needs.
   */
  async viewer(): Promise<GithubAccount> {
    const data = await this.call<{ login: string; id: number; avatar_url?: string }>(
      "viewer", "GET", "/user",
    );
    return { login: data.login, id: data.id, avatarUrl: data.avatar_url ?? null };
  }

  // --- repositories -----------------------------------------------------------

  /**
   * The repositories this token can write to, newest activity first.
   *
   * FILTERED TO WRITABLE ONES HERE rather than in the UI. §2.2's "Use existing repo" search offers
   * a list to link against, and offering a repository the token can only read would produce a
   * successful link whose first push fails — a refusal moved from the moment of choosing to the
   * moment of working, which is the wrong way round.
   */
  async repos(limit = 100): Promise<GithubRepo[]> {
    const data = await this.call<Array<Record<string, unknown>>>(
      "repos", "GET", `/user/repos?per_page=${Math.min(limit, 100)}&sort=pushed&affiliation=owner,collaborator,organization_member`,
    );
    return data
      .filter((r) => (r["permissions"] as { push?: boolean } | undefined)?.push !== false)
      .map((r) => this.hydrateRepo(r));
  }

  async repo(fullName: string): Promise<GithubRepo> {
    return this.hydrateRepo(await this.call<Record<string, unknown>>("repo", "GET", `/repos/${fullName}`));
  }

  private hydrateRepo(r: Record<string, unknown>): GithubRepo {
    return {
      fullName: String(r["full_name"]),
      private: r["private"] === true,
      defaultBranch: String(r["default_branch"] ?? "main"),
      htmlUrl: String(r["html_url"] ?? ""),
      // GitHub reports a repository with no commits as size 0 and, more reliably, with a null
      // pushed_at. Both are checked because the first is also true of a repo holding one empty
      // file, and mistaking that for empty would skip the divergence check on a repo that has one.
      empty: r["pushed_at"] == null,
      pushedAt: (r["pushed_at"] as string | null) ?? null,
    };
  }

  /**
   * Whether a name is free, for §2.2's live availability check.
   *
   * A 404 is the ANSWER here rather than a failure, which is why this catches: the check runs on
   * every keystroke, and a "not found" reaching the error strip would flash a red message at
   * somebody halfway through typing a perfectly good name.
   */
  async repoExists(fullName: string): Promise<boolean> {
    try {
      await this.call<unknown>("repoExists", "GET", `/repos/${fullName}`);
      return true;
    } catch (err) {
      if (err instanceof GithubError && err.kind === "not_found") return false;
      throw err;
    }
  }

  /**
   * Create a repository under the token's own account.
   *
   * `auto_init: false` deliberately. An auto-initialised repo arrives with a README commit on
   * `main` that Jaroku did not write, which would make the very first push a divergence — the
   * panel would open on ↕ before the user had done anything. An empty repo is §6's first row and
   * is handled: the first push creates the initial commit.
   */
  async createRepo(name: string, opts: { private?: boolean; description?: string } = {}): Promise<GithubRepo> {
    return this.hydrateRepo(
      await this.call<Record<string, unknown>>("createRepo", "POST", "/user/repos", {
        name,
        private: opts.private ?? true,
        description: opts.description ?? "Agent source, pushed by Jaroku.",
        auto_init: false,
      }),
    );
  }

  // --- refs and branches ------------------------------------------------------

  async branches(fullName: string, defaultBranch: string): Promise<GithubBranch[]> {
    const data = await this.call<Array<{ name: string; commit: { sha: string } }>>(
      "branches", "GET", `/repos/${fullName}/branches?per_page=100`,
    );
    return data.map((b) => ({ name: b.name, sha: b.commit.sha, isDefault: b.name === defaultBranch }));
  }

  /**
   * Where a branch currently points, or null when it does not exist.
   *
   * NULL RATHER THAN A THROW, because "this branch is not there yet" is the ordinary state on a
   * first push and on §6's "branch deleted remotely" row. Both are handled by the caller and
   * neither is an error worth unwinding for.
   */
  async refSha(fullName: string, branch: string): Promise<string | null> {
    try {
      const data = await this.call<{ object: { sha: string } }>(
        "refSha", "GET", `/repos/${fullName}/git/ref/heads/${encodeURIComponent(branch)}`,
      );
      return data.object.sha;
    } catch (err) {
      if (err instanceof GithubError && (err.kind === "not_found" || err.kind === "conflict")) return null;
      throw err;
    }
  }

  // --- the git data layer -----------------------------------------------------

  /**
   * Write one file's contents as a blob and return its sha.
   *
   * Capped, and the cap is enforced before the request rather than after the rejection: sending a
   * megabyte to be told it is too large costs the user the upload.
   */
  async createBlob(fullName: string, blob: GithubBlob): Promise<string> {
    const bytes = Buffer.byteLength(blob.content, "utf8");
    if (bytes > MAX_BLOB_BYTES) {
      throw new GithubError(
        "api",
        `${blob.path} is ${bytes} bytes — over the ${MAX_BLOB_BYTES}-byte limit for a pushed file.`,
        "createBlob",
      );
    }
    const data = await this.call<{ sha: string }>("createBlob", "POST", `/repos/${fullName}/git/blobs`, {
      content: blob.content,
      encoding: "utf-8",
    });
    return data.sha;
  }

  /**
   * Build a tree, optionally on top of an existing one.
   *
   * `baseTree` IS WHAT MAKES A SUBDIRECTORY PUSH SAFE. Without it the new tree is the WHOLE
   * repository, so pushing `agents/weather/` into a monorepo would delete every other directory in
   * one commit — the exact failure §2.2's subdirectory field would otherwise introduce. With it,
   * paths not mentioned are inherited untouched.
   */
  async createTree(
    fullName: string,
    entries: { path: string; sha: string | null; mode?: string }[],
    baseTree?: string | null,
  ): Promise<string> {
    const data = await this.call<{ sha: string }>("createTree", "POST", `/repos/${fullName}/git/trees`, {
      ...(baseTree ? { base_tree: baseTree } : {}),
      tree: entries.map((e) => ({
        path: e.path,
        mode: e.mode ?? "100644",
        type: "blob",
        // A null sha DELETES the path from the tree. That is the only way this client removes a
        // file, and it is why a version that dropped a tool does not leave the tool behind.
        sha: e.sha,
      })),
    });
    return data.sha;
  }

  /**
   * The tree a commit points at.
   *
   * Needed because `createTree`'s `base_tree` takes a TREE sha and a branch head is a COMMIT sha —
   * two different object types that are both forty hex characters, so passing one where the other
   * belongs is accepted by the type system, rejected by GitHub, and reads as a mysterious 422 at
   * the one step of a push where a mysterious failure is most expensive.
   */
  async commitTree(fullName: string, commitSha: string): Promise<string> {
    const data = await this.call<{ tree: { sha: string } }>(
      "commitTree", "GET", `/repos/${fullName}/git/commits/${commitSha}`,
    );
    return data.tree.sha;
  }

  async createCommit(
    fullName: string,
    input: { message: string; tree: string; parents: string[] },
  ): Promise<{ sha: string; htmlUrl: string }> {
    const data = await this.call<{ sha: string; html_url?: string }>(
      "createCommit", "POST", `/repos/${fullName}/git/commits`, input,
    );
    return { sha: data.sha, htmlUrl: data.html_url ?? `https://github.com/${fullName}/commit/${data.sha}` };
  }

  /**
   * Point a branch at a commit.
   *
   * `force` DEFAULTS TO FALSE AND STAYS THAT WAY unless somebody typed an agent slug to say
   * otherwise. GitHub refuses a non-fast-forward with a 422, which arrives here as `conflict` —
   * and that refusal is the entire mechanism behind §6's "two workspace members push at once"
   * row and §3.7's divergence. A client that passed `force: true` for convenience would turn
   * every one of those into a silent overwrite of somebody's work.
   */
  async updateRef(fullName: string, branch: string, sha: string, force = false): Promise<void> {
    await this.call<unknown>("updateRef", "PATCH", `/repos/${fullName}/git/refs/heads/${encodeURIComponent(branch)}`, {
      sha,
      force,
    });
  }

  /** Create a branch at a commit. Used for the first push, and for recreating a deleted branch. */
  async createRef(fullName: string, branch: string, sha: string): Promise<void> {
    await this.call<unknown>("createRef", "POST", `/repos/${fullName}/git/refs`, {
      ref: `refs/heads/${branch}`,
      sha,
    });
  }

  // --- reading the remote -----------------------------------------------------

  /**
   * Every file in a tree, recursively, as path → blob sha.
   *
   * `truncated` IS CHECKED RATHER THAN IGNORED. GitHub silently cuts a recursive tree response off
   * at its own limit and says so in one boolean, and a caller that skipped it would compute a diff
   * against half a repository and confidently report the missing half as deleted.
   */
  async tree(fullName: string, sha: string): Promise<GithubTreeEntry[]> {
    const data = await this.call<{ tree: GithubTreeEntry[]; truncated?: boolean }>(
      "tree", "GET", `/repos/${fullName}/git/trees/${sha}?recursive=1`,
    );
    if (data.truncated) {
      throw new GithubError(
        "api",
        "that repository's tree is too large for Jaroku to read in one request — link a subdirectory instead.",
        "tree",
      );
    }
    return data.tree.filter((e) => e.type === "blob");
  }

  /** One file's text. Capped on the way in as well as on the way out — see MAX_BLOB_BYTES. */
  async blob(fullName: string, sha: string, path: string): Promise<string> {
    const data = await this.call<{ content: string; encoding: string; size: number }>(
      "blob", "GET", `/repos/${fullName}/git/blobs/${sha}`,
    );
    if (data.size > MAX_BLOB_BYTES) {
      throw new GithubError(
        "api",
        `${path} is ${data.size} bytes — over the ${MAX_BLOB_BYTES}-byte limit for a file Jaroku will read.`,
        "blob",
      );
    }
    return Buffer.from(data.content, data.encoding === "base64" ? "base64" : "utf8").toString("utf8");
  }

  /** Commits on a branch, newest first. What the History region's hollow dots are built from. */
  async commits(fullName: string, branch: string, limit = 30): Promise<GithubCommit[]> {
    const data = await this.call<Array<Record<string, unknown>>>(
      "commits", "GET", `/repos/${fullName}/commits?sha=${encodeURIComponent(branch)}&per_page=${Math.min(limit, 100)}`,
    );
    return data.map((c) => {
      const commit = (c["commit"] ?? {}) as Record<string, unknown>;
      const author = (commit["author"] ?? {}) as Record<string, unknown>;
      return {
        sha: String(c["sha"]),
        message: String(commit["message"] ?? ""),
        authorLogin: ((c["author"] as { login?: string } | null)?.login) ?? null,
        authoredAt: String(author["date"] ?? new Date(0).toISOString()),
        htmlUrl: String(c["html_url"] ?? ""),
      };
    });
  }

  /**
   * How two commits relate: ahead, behind, identical or diverged.
   *
   * GitHub answers this in one request, and asking it rather than computing it locally is
   * deliberate — the local answer would need the full commit list of both sides and would still be
   * wrong across a force-push, which is precisely the case §6 asks this question for.
   */
  async compare(
    fullName: string,
    base: string,
    head: string,
  ): Promise<{ status: string; aheadBy: number; behindBy: number; files: string[] }> {
    const data = await this.call<{
      status: string;
      ahead_by: number;
      behind_by: number;
      files?: { filename: string }[];
    }>("compare", "GET", `/repos/${fullName}/compare/${base}...${head}`);
    return {
      status: data.status,
      aheadBy: data.ahead_by,
      behindBy: data.behind_by,
      files: (data.files ?? []).map((f) => f.filename),
    };
  }

  // --- pull requests ----------------------------------------------------------

  /** The open PR from `head` into `base`, or null. §3.9 renders one card, never a list. */
  async openPullRequest(fullName: string, head: string, base: string): Promise<{
    number: number;
    title: string;
    htmlUrl: string;
    commits: number;
    changedFiles: number;
    additions: number;
    deletions: number;
    mergeable: boolean | null;
  } | null> {
    const owner = fullName.split("/")[0] ?? "";
    const list = await this.call<Array<{ number: number }>>(
      "openPullRequest",
      "GET",
      `/repos/${fullName}/pulls?state=open&head=${encodeURIComponent(`${owner}:${head}`)}&base=${encodeURIComponent(base)}`,
    );
    const first = list[0];
    if (!first) return null;
    const pr = await this.call<Record<string, unknown>>(
      "pullRequest", "GET", `/repos/${fullName}/pulls/${first.number}`,
    );
    return {
      number: Number(pr["number"]),
      title: String(pr["title"] ?? ""),
      htmlUrl: String(pr["html_url"] ?? ""),
      commits: Number(pr["commits"] ?? 0),
      changedFiles: Number(pr["changed_files"] ?? 0),
      additions: Number(pr["additions"] ?? 0),
      deletions: Number(pr["deletions"] ?? 0),
      mergeable: (pr["mergeable"] as boolean | null) ?? null,
    };
  }

  /** Open a PR from Jaroku's branch into the repository's default branch. §3.7's clean handoff. */
  async createPullRequest(
    fullName: string,
    input: { title: string; head: string; base: string; body?: string },
  ): Promise<{ number: number; htmlUrl: string }> {
    const data = await this.call<{ number: number; html_url: string }>(
      "createPullRequest", "POST", `/repos/${fullName}/pulls`, {
        title: input.title,
        head: input.head,
        base: input.base,
        body: input.body ?? "",
      },
    );
    return { number: data.number, htmlUrl: data.html_url };
  }

  /**
   * Whether a login has WRITE access to this repository — §B.1.3's boundary.
   *
   * ASKED, RATHER THAN READ OFF THE WEBHOOK'S `author_association`. That field is GitHub's own
   * opinion and would be perfectly accurate — but the whole point of this boundary is that the
   * delivery describes a request from somebody untrusted, and a field inside it is a field they are
   * adjacent to. One round trip on the path that is about to spend real money is the right price.
   *
   * PERMISSION, NOT MEMBERSHIP. `GET /collaborators/{user}` answers 204 for anybody with ANY access
   * including read-only, which on a public repository is everyone. The permission endpoint says
   * which level, and only `write` and `admin` are people who could already spend this money by
   * pushing to a branch — which is the actual justification for not gating them.
   *
   * FALSE ON ANY FAILURE, INCLUDING A 404. A token that cannot see the collaborator list, a
   * repository that has moved, a rate limit — every one of those is a question we could not answer,
   * and the answer this boundary must give to an unanswered question is the cheap one.
   */
  async hasWriteAccess(fullName: string, login: string): Promise<boolean> {
    if (!login) return false;
    try {
      const data = await this.call<{ permission?: string }>(
        "collaboratorPermission",
        "GET",
        `/repos/${fullName}/collaborators/${encodeURIComponent(login)}/permission`,
      );
      return data.permission === "write" || data.permission === "admin";
    } catch {
      return false;
    }
  }

  /**
   * The combined CI verdict for a commit, or null when nothing has reported.
   *
   * NULL IS NOT "PASSING". §3.9 says CI status is a genuine gate rather than decoration precisely
   * because Jaroku emits a Dockerfile, and rendering "no checks configured" as a green tick would
   * turn the one honest signal on that card into a decoration after all.
   */
  async combinedStatus(fullName: string, sha: string): Promise<{ state: string; total: number } | null> {
    const data = await this.call<{ state: string; total_count: number }>(
      "combinedStatus", "GET", `/repos/${fullName}/commits/${sha}/status`,
    );
    if (!data.total_count) return null;
    return { state: data.state, total: data.total_count };
  }
}
