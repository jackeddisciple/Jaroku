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
  /**
   * The token is missing, wrong, or revoked — a 401, and nothing else.
   *
   * NARROWED TO 401 ON PURPOSE, because this kind is what `markRevoked` fires on: the grant is
   * marked dead, `apiFor` starts returning null and the panel falls back to §2.1's empty state
   * asking for a token. That is the right answer to "GitHub no longer recognises this credential"
   * and the wrong one to everything else — see `forbidden`.
   */
  | "auth"
  /**
   * Reached GitHub with a credential it recognises; it refused this operation.
   *
   * ITS OWN KIND BECAUSE THE TOKEN IS FINE. A fine-grained token scoped to three repositories
   * answers 403 on the fourth, and a token with `Contents: read` answers 403 on every write —
   * in both cases it is working perfectly everywhere else. Folded into `auth`, as it was, one
   * refused push disconnected the whole workspace's GitHub account: the panel dropped back to
   * "Connect GitHub", every OTHER agent's link went dark with it, and the only way back was
   * pasting the credential that had never stopped working. Observed by pushing to a repository
   * Jaroku had itself just created, which is the most ordinary thing this feature does.
   */
  | "forbidden"
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
    /**
     * GitHub's own sentence, on a refusal, kept beside the one this codebase wrote.
     *
     * KEPT RATHER THAN DISCARDED because two 403s that need completely different things from the
     * user are otherwise indistinguishable: "the token does not have write access" and "you must
     * authenticate via a GitHub App" arrive with the same status, no distinguishing header, and
     * only this string between them. It is never rendered raw — it is matched on, and the message
     * the user reads is still one written here.
     */
    readonly detail?: string,
  ) {
    super(message);
    this.name = "GithubError";
  }
}

/**
 * Whether a refusal was "this endpoint is only for GitHub Apps".
 *
 * THE CHECKS API IS APP-ONLY, and that is a fact about GitHub rather than about a token's
 * permissions. `POST /check-runs` answers 403 "You must authenticate via a GitHub App." to every
 * personal access token — classic or fine-grained, `repo` scope or not, `checks: write` ticked or
 * not. Jaroku authenticates as a user with a PAT (see GITHUB_ENV_KEY), so §B.1's check run cannot
 * be posted by this product as it is built, on any repository, ever.
 */
export function needsGithubApp(err: unknown): boolean {
  return err instanceof GithubError && err.kind === "forbidden" && /GitHub App/i.test(err.detail ?? "");
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
  /**
   * A repository with no commits at all — §6's "empty repo" state.
   *
   * NULL MEANS NOT ASKED, and that is most of the time. The repository object carries no field
   * that answers this: `pushed_at` is set to the moment of CREATION on a repository with nothing
   * in it, and `size` is computed asynchronously and reads 0 for minutes after a real push. Both
   * were tried here, and both said "empty" about repositories that were not and "not empty" about
   * repositories that were. The only exact answer costs a request — `isEmpty` — so the list this
   * flag renders in leaves it null rather than guessing a hundred times per keystroke, and the one
   * caller that has to be right asks.
   */
  empty: boolean | null;
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
      // READ, NOT QUOTED. It rides on the error as `detail` so a caller can tell an app-only
      // endpoint from a missing permission; nothing renders it, and it is truncated either way.
      const detail = truncate(await response.text());
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
        "forbidden",
        "GitHub refused: this token cannot write to that repository. A fine-grained token reaches only the repositories it was scoped to, and only with the permissions that were ticked — Contents: read and write is the one a push needs.",
        operation,
        undefined,
        detail,
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
      // NOT ASKED. See the field's own comment: neither `pushed_at` nor `size` answers this, and a
      // repository list is the wrong place to spend a request per row finding out.
      empty: null,
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
   * `main` that Jaroku did not write and did not choose the contents of. An empty repo is §6's
   * first row and is handled — but not by the Git Data API, which refuses to write into a
   * repository with no commits at all; see `initialCommit`, which the push path reaches for.
   */
  async createRepo(name: string, opts: { private?: boolean; description?: string } = {}): Promise<GithubRepo> {
    const created = this.hydrateRepo(
      await this.call<Record<string, unknown>>("createRepo", "POST", "/user/repos", {
        name,
        private: opts.private ?? true,
        description: opts.description ?? "Agent source, pushed by Jaroku.",
        auto_init: false,
      }),
    );
    // The one place emptiness is known without asking: we just made it, and asked for no commit.
    return { ...created, empty: true };
  }

  /**
   * Whether this repository has any commits at all.
   *
   * ASKED RATHER THAN READ OFF THE REPOSITORY OBJECT, for the reason `GithubRepo.empty` gives: the
   * two fields that look like they answer this do not. `/git/refs/heads` does, exactly — GitHub
   * answers 409 "Git Repository is empty" for a repository with nothing in it, and an empty array
   * for one whose every branch has been deleted, which is the same fact by a different road.
   *
   * UNREACHABLE IS "NOT EMPTY". The one caller uses this to decide whether to write an initial
   * commit, and the cheap answer to a question we could not ask is the one that writes nothing.
   */
  async isEmpty(fullName: string): Promise<boolean> {
    try {
      const refs = await this.call<Array<unknown>>("isEmpty", "GET", `/repos/${fullName}/git/refs/heads`);
      return Array.isArray(refs) && refs.length === 0;
    } catch (err) {
      return err instanceof GithubError && err.kind === "conflict";
    }
  }

  /**
   * Give a repository with no commits its first one — the one write here that is not the Git Data
   * API, because the Git Data API cannot do it.
   *
   * THIS IS NOT A STYLE PREFERENCE. `POST /git/blobs`, `/git/trees` and `/git/commits` all answer
   * 409 "Git Repository is empty" against a repository that has never been pushed to, so the whole
   * mechanism §2.4's push is built on is unavailable at exactly the moment §6's first row says it
   * has to work: "empty repo — the first push creates the initial commit". `PUT /contents/{path}`
   * is the one endpoint GitHub accepts there, it creates the branch it is given, and after it the
   * ordinary path works for every commit that follows.
   *
   * WRITTEN TO THE REPOSITORY'S DECLARED DEFAULT BRANCH AND NOT TO `jaroku/<slug>`, and the caller
   * is the one that decides that — see `githubPushRunner`. Seeding Jaroku's own branch in a
   * repository that has no others makes it the default branch, which is a thing to have done to
   * somebody's repository without asking.
   */
  async initialCommit(
    fullName: string,
    branch: string,
    input: { path: string; content: string; message: string },
  ): Promise<string> {
    const data = await this.call<{ commit: { sha: string } }>(
      "initialCommit",
      "PUT",
      `/repos/${fullName}/contents/${input.path.split("/").map(encodeURIComponent).join("/")}`,
      {
        message: input.message,
        content: Buffer.from(input.content, "utf8").toString("base64"),
        branch,
      },
    );
    return data.commit.sha;
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

  // --- review comments -------------------------------------------------------

  /**
   * The REVIEW comments on a pull request — §B.5.1.
   *
   * `/pulls/{n}/comments` AND NOT `/issues/{n}/comments`, and the distinction is the whole feature.
   * The issues endpoint returns the conversation: general remarks with no file and no line. The
   * pulls endpoint returns comments pinned to a path and a position, which is what makes §B.5.2's
   * routing signal unambiguous — "a comment pinned to a specific file and line" is the same class
   * of decision v0.1.7's table already makes for "a failed step is selected → fix". A general
   * comment saying "this looks wrong" is not that, and pulling it in would send the edit loop at a
   * file nobody named.
   *
   * `line` IS THE ONE ON THE CURRENT DIFF, and `original_line` is where it was when the comment was
   * written. Preferring the first means a comment on a line the branch has since moved still points
   * at the right place; falling back to the second means a comment on a line the branch has since
   * DELETED still says where it was, rather than reporting null and losing the pin altogether.
   */
  async reviewComments(fullName: string, prNumber: number, limit = 100): Promise<{
    id: string;
    inReplyToId: string | null;
    authorLogin: string | null;
    path: string | null;
    line: number | null;
    body: string;
    commitSha: string | null;
    createdAt: string;
  }[]> {
    const data = await this.call<Array<Record<string, unknown>>>(
      "reviewComments",
      "GET",
      `/repos/${fullName}/pulls/${prNumber}/comments?per_page=${Math.min(limit, 100)}`,
    );
    return data.map((c) => ({
      id: String(c["id"]),
      inReplyToId: c["in_reply_to_id"] === undefined || c["in_reply_to_id"] === null
        ? null
        : String(c["in_reply_to_id"]),
      authorLogin: ((c["user"] as { login?: string } | null)?.login) ?? null,
      path: typeof c["path"] === "string" ? c["path"] : null,
      line: typeof c["line"] === "number"
        ? c["line"]
        : typeof c["original_line"] === "number"
          ? c["original_line"]
          : null,
      body: String(c["body"] ?? ""),
      commitSha: typeof c["commit_id"] === "string" ? c["commit_id"] : null,
      createdAt: String(c["created_at"] ?? new Date(0).toISOString()),
    }));
  }

  /**
   * Reply to one review comment, in its own thread — §B.5.3.
   *
   * A THREADED REPLY AND NOT A GENERAL PULL REQUEST COMMENT, which is §B.5.3's requirement and the
   * whole point of the loop closing: a teammate who never opens Jaroku still sees the conversation
   * resolve IN PLACE, under the line they commented on, rather than as a new remark at the bottom
   * of a thread they have to go and correlate by hand.
   *
   * `/replies` RATHER THAN A NEW COMMENT WITH `in_reply_to`. Both exist; the second requires
   * re-supplying the path, the position and the commit, which are three chances to pin the reply
   * one line away from what it answers.
   */
  async replyToReviewComment(
    fullName: string,
    prNumber: number,
    commentId: string,
    body: string,
  ): Promise<{ id: string }> {
    const data = await this.call<{ id: number }>(
      "replyToReviewComment",
      "POST",
      `/repos/${fullName}/pulls/${prNumber}/comments/${commentId}/replies`,
      { body },
    );
    return { id: String(data.id) };
  }

  // --- checks ----------------------------------------------------------------
  //
  // THE CHECKS API AND NOT THE STATUSES API, and the difference is the whole of §B.1.1. A commit
  // status is a coloured dot with a link: it carries a state, a context and a target URL, and the
  // pass-rate table would have to live on a page somewhere else. A check run carries a TITLE and a
  // SUMMARY that GitHub renders inline, which is where "pass-rate 92% → 96%" belongs — on the pull
  // request, next to the build check, without a click.
  //
  // AND IT NEEDS A KIND OF TOKEN JAROKU DOES NOT HAVE, which is not what the comment here used to
  // say. It said the Checks API "requires `checks: write`, which a classic PAT with `repo` has" —
  // and that is wrong in the way that matters. `POST /check-runs` answers 403 "You must
  // authenticate via a GitHub App." to EVERY personal access token: classic, fine-grained, scope
  // ticked or not. Jaroku authenticates as a user with a PAT (`GITHUB_ENV_KEY`), so §B.1's check
  // could never appear on anybody's pull request, and the error the user got sent them to re-issue
  // a token that would have failed identically.
  //
  // SO THERE IS A FALLBACK, AND IT IS THE STATUSES API — the thing this section opens by explaining
  // why it is not good enough. It is not: a commit status is a state, a context, a 140-character
  // description and a link, so §B.1.1's three-row table becomes one line. But a one-line gate that
  // exists beats a rendered table that cannot be posted, the numbers still reach the pull request,
  // and `checksFor` reads both mechanisms so the panel's own verdict line counts it either way.
  // The check run is still tried first, so a deployment that ever does authenticate as an App gets
  // the better rendering with nothing to change.

  /**
   * Open a check run on a commit, or update one that exists.
   *
   * ONE METHOD FOR BOTH, because the shape is identical and the only difference is whether GitHub
   * already has an id — and a caller that had to choose would be a caller that gets it wrong on the
   * retry path, where a check was created and the row that records its id was not written.
   *
   * `status` AND `conclusion` ARE GITHUB'S OWN VOCABULARY, passed through as stored. `check_runs`
   * keeps them in that spelling deliberately (see migration 037) so there is no translation table
   * between what is recorded and what is sent.
   */
  async putCheckRun(
    fullName: string,
    input: {
      /** Present to update, absent to create. */
      checkRunId?: string | null;
      /**
       * The check's name, as it renders on the pull request.
       *
       * OPTIONAL ON AN UPDATE, AND OMITTING IT IS HOW A CHECK KEEPS THE NAME IT HAS. GitHub takes
       * `name` on a PATCH and RENAMES the run when it is given one — so a caller that does not know
       * the original must send nothing rather than send its best guess. `supersede` is that caller:
       * it works from a stored row, which carries a check run id and not the dataset the title was
       * built from, and passing a generic "Jaroku eval" there renamed the cancelled check away from
       * the one somebody had been watching.
       */
      name?: string;
      headSha: string;
      status: "queued" | "in_progress" | "completed";
      conclusion?: string | null;
      title: string;
      summary: string;
      detailsUrl?: string | null;
    },
  ): Promise<{ id: string }> {
    if (!input.checkRunId && !input.name) {
      throw new GithubError("api", "a check run cannot be created without a name.", "createCheckRun");
    }
    // Already on the fallback. The id a commit status has is its CONTEXT — posting the same context
    // again replaces it, which is exactly the update semantics a check run's id provides — so the
    // context travels in the same field the check run id does and no schema had to learn about this.
    const context = input.checkRunId?.startsWith(STATUS_PREFIX)
      ? input.checkRunId.slice(STATUS_PREFIX.length)
      : null;
    if (context !== null) return { id: await this.putCommitStatus(fullName, context, input) };

    const body: Record<string, unknown> = {
      ...(input.name ? { name: input.name } : {}),
      head_sha: input.headSha,
      status: input.status,
      output: { title: input.title, summary: input.summary },
      ...(input.conclusion ? { conclusion: input.conclusion } : {}),
      ...(input.detailsUrl ? { details_url: input.detailsUrl } : {}),
    };
    // GitHub refuses a `completed` check with no conclusion, and refuses a conclusion on one that
    // is not completed. Both are 422s that arrive as `conflict` and read as a mysterious refusal,
    // so the shape is corrected here rather than left to every call site.
    if (input.status !== "completed") delete body["conclusion"];

    try {
      const data = input.checkRunId
        ? await this.call<{ id: number }>(
            "updateCheckRun", "PATCH", `/repos/${fullName}/check-runs/${input.checkRunId}`, body,
          )
        : await this.call<{ id: number }>("createCheckRun", "POST", `/repos/${fullName}/check-runs`, body);
      return { id: String(data.id) };
    } catch (err) {
      // APP-ONLY IS NOT A PERMISSION PROBLEM AND MUST NOT BE REPORTED AS ONE. Every personal access
      // token gets this refusal, so telling somebody to tick `checks: write` sends them to re-issue
      // a token that will fail identically. The check goes out as a commit status instead — see the
      // section header — and the caller never learns the difference, because the id it gets back
      // updates the same way a check run's does.
      if (needsGithubApp(err) && input.name) {
        this.log(`[github] check runs are App-only for this token; posting a commit status instead`);
        return { id: await this.putCommitStatus(fullName, input.name, input) };
      }
      if (err instanceof GithubError && err.kind === "forbidden") {
        throw new GithubError(
          "forbidden",
          "GitHub refused to write a check on this commit. The token needs write access to the repository.",
          err.operation,
        );
      }
      throw err;
    }
  }

  /**
   * §B.1's check, as much of it as a commit status can carry.
   *
   * THE CONTEXT IS THE IDENTITY. GitHub keeps one status per context per commit and the newest wins,
   * so "post pending, then post the result" needs no id and no second endpoint — which is why this
   * fits behind `putCheckRun` without a column anywhere learning that it happened.
   *
   * THE DESCRIPTION IS 140 CHARACTERS AND THE TITLE IS WHERE THE NUMBERS ARE. §B.1.1's summary is a
   * three-row table that does not fit, and the title is the line that does: "pass-rate 92% → 96%
   * (+4)". Truncated rather than dropped if somebody's dataset name makes even that too long — a
   * cut-off number still says which direction it went.
   *
   * FIVE CONCLUSIONS INTO FOUR STATES, and `cancelled` is the one that has to be decided rather than
   * mapped. It becomes `error` and says why: a superseded check that reported `success` would be a
   * green tick claiming a run that never finished, and the commit it sits on is not the pull
   * request's head any more in the first place.
   */
  private async putCommitStatus(
    fullName: string,
    context: string,
    input: {
      headSha: string;
      status: "queued" | "in_progress" | "completed";
      conclusion?: string | null;
      title: string;
      detailsUrl?: string | null;
    },
  ): Promise<string> {
    const state = input.status !== "completed"
      ? "pending"
      : input.conclusion === "failure" || input.conclusion === "timed_out"
        ? "failure"
        : input.conclusion === "cancelled"
          ? "error"
          : "success";
    await this.call<unknown>("createStatus", "POST", `/repos/${fullName}/statuses/${input.headSha}`, {
      state,
      context,
      description: truncate(input.title, 140),
      ...(input.detailsUrl ? { target_url: input.detailsUrl } : {}),
    });
    return `${STATUS_PREFIX}${context}`;
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
   * The CI verdict for a commit, across BOTH of the two things GitHub calls a check.
   *
   * THE STATUSES API ALONE WAS THE BUG, and it was invisible because it fails by saying "nothing".
   * `GET /commits/{sha}/status` returns COMMIT STATUSES — the older mechanism, written by external
   * services through `POST /statuses`. It does not include CHECK RUNS, which is what GitHub Actions
   * writes and what this file's own `putCheckRun` writes. So on any repository whose CI is Actions
   * — including every repository §B.6.2 generates `jaroku-build.yml` into, and every pull request
   * carrying §B.1's eval check — this endpoint answered `total_count: 0` and §3.9's card rendered
   * "no checks reported" over a build that had failed. Measured against this repository's own
   * latest commit: the statuses API said 0, the check-runs API said two, both failing.
   *
   * BOTH ARE ASKED AND THE ANSWER IS THE PESSIMISTIC ONE. A commit can carry some of each, and a
   * card that reported whichever mechanism it happened to look at first would be the same defect
   * with a different shape. Failure outranks pending outranks success, because §3.9's claim is that
   * the pull request is a genuine gate — and a gate reports the reason it is shut.
   *
   * NULL IS NOT "PASSING". Nothing has reported is its own answer and the panel renders it as one:
   * a repository with no CI configured has no checks to pass, and a green tick there would turn the
   * one honest signal on that card into the decoration §3.9 says it is not.
   *
   * NEUTRAL AND SKIPPED COUNT AS PASSING, because that is what they mean — a check that decided it
   * had nothing to say. §B.1.3's dry-run check concludes `neutral` on a stranger's pull request,
   * and reading that as a failure would make the boundary look like a refusal of the code.
   */
  async checksFor(fullName: string, sha: string): Promise<{ state: string; total: number } | null> {
    let failed = 0;
    let pending = 0;
    let total = 0;
    /**
     * Whether a read was REFUSED rather than empty — see the return below.
     *
     * The distinction this variable exists for was observed on a real pull request: a fine-grained
     * token without `Checks: read` gets 403 from the check-runs endpoint, so the build check that
     * had just gone red was reported as "no checks reported" — the same words a repository with no
     * CI at all gets. That is the decoration §3.9 says this line must not be.
     */
    let unreadable = false;

    try {
      const runs = await this.call<{ total_count: number; check_runs?: { status: string; conclusion: string | null }[] }>(
        "checkRuns", "GET", `/repos/${fullName}/commits/${sha}/check-runs?per_page=100`,
      );
      for (const run of runs.check_runs ?? []) {
        total++;
        if (run.status !== "completed") pending++;
        else if (run.conclusion !== null && !PASSING_CONCLUSIONS.has(run.conclusion)) failed++;
      }
    } catch (err) {
      // Reading one half is better than reading neither. A repository whose checks this token
      // cannot list still has its statuses counted below — but the fact that we could not look is
      // carried out of here rather than dropped.
      unreadable = err instanceof GithubError && (err.kind === "forbidden" || err.kind === "auth");
    }

    try {
      const data = await this.call<{ state: string; total_count: number }>(
        "combinedStatus", "GET", `/repos/${fullName}/commits/${sha}/status`,
      );
      if (data.total_count) {
        total += data.total_count;
        if (data.state === "failure" || data.state === "error") failed++;
        else if (data.state === "pending") pending++;
      }
    } catch (err) {
      unreadable = unreadable || (err instanceof GithubError && (err.kind === "forbidden" || err.kind === "auth"));
    }

    // SAW SOMETHING: report it, even if the other half was refused. A failing build is a failing
    // build whether or not the statuses endpoint also answered.
    if (total > 0) return { state: failed > 0 ? "failure" : pending > 0 ? "pending" : "success", total };
    // SAW NOTHING BECAUSE WE WERE NOT ALLOWED TO LOOK. Its own state, because "there is no gate
    // here" and "there may be a gate and this token cannot see it" are different sentences, and
    // the second one names a permission somebody can go and grant.
    if (unreadable) return { state: "unreadable", total: 0 };
    return null;
  }
}

/** Conclusions that are not a reason to hold a pull request. See `checksFor`. */
const PASSING_CONCLUSIONS = new Set(["success", "neutral", "skipped"]);

/**
 * What a stored check run id looks like when the check is really a commit status.
 *
 * A PREFIX RATHER THAN A COLUMN, so `check_runs` did not need a migration to record which of the
 * two mechanisms a check went out on. GitHub's own check run ids are decimal, so nothing it issues
 * can collide with this, and a row carrying one reads as what it is: where the check lives.
 */
const STATUS_PREFIX = "status:";
