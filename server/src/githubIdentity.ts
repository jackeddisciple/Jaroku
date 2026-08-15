// Linking a GitHub account, and everything downstream that needs the token back.
//
// Two jobs, and they are the same job seen from both ends:
//
//   CONNECT takes a token from a person, proves it works, puts it in the vault and writes the
//   installation row. That is the only place in this codebase a GitHub token is ever handled as a
//   value, and it is reached through the secrets group's `guarded()` — capability, tenancy and a
//   live elevation — because it is a credential write like any other.
//
//   `apiFor` hands a caller a configured client without ever handing them the token. Every GitHub
//   operation in the server goes through it, so the number of places that can see a plaintext
//   GitHub credential is one, and it is here.
//
// WHY THE TOKEN IS PROVED BEFORE IT IS STORED. A stored-but-invalid credential is the worst
// available outcome: the panel says connected, the link succeeds, and the first push fails with an
// authentication error long after the moment somebody could have noticed they pasted the wrong
// thing. `viewer()` costs one request, writes nothing, and turns that into a refusal at the point
// of entry — the same reason the provider form has a Test button separate from Save.
//
// WHY `getForPlatformCall` AND NOT `getForRun`. The vault has exactly three plaintext exits and
// each says what it is for. A push is not a run: there is no run id to resolve a workspace from,
// and attributing `last_used_at` to a run that does not exist would put a lie in the one column
// that answers "is this credential still in use". `getForPlatformCall` is the exit for work the
// platform does on a workspace's behalf, which is exactly what a push is.

import { GithubApi, GITHUB_ENV_KEY, GithubError } from "./githubApi.ts";
import type { GithubInstallation, GithubRepository } from "./db/repositories/github.ts";
import type { TenantContext } from "./db/tenant.ts";
import type { SecretStore } from "./secrets/secretStore.ts";

export interface GithubIdentityDeps {
  repo: GithubRepository;
  secrets: SecretStore;
  /**
   * Store a credential the way the Secrets tab does — with its kind, its provider and its mask.
   *
   * Routed through the manager rather than written straight to the store, so a GitHub token
   * appears in the Secrets tab beside every other credential, with a rotation history and a blast
   * radius. A token written directly to the vault would be invisible there, which is the one place
   * somebody goes to answer "what does this workspace hold".
   */
  store: (
    ctx: TenantContext,
    input: { name: string; value: string; provider: string; actorUserId: string | null },
  ) => Promise<{ ok: boolean; message: string | null }>;
  /** Forget it. Idempotent, like every delete on the store. */
  forget: (ctx: TenantContext, name: string) => Promise<void>;
  log?: (line: string) => void;
}

export interface ConnectOutcome {
  ok: boolean;
  accountLogin: string | null;
  message: string | null;
}

export class GithubIdentity {
  private readonly log: (line: string) => void;

  constructor(private deps: GithubIdentityDeps) {
    this.log = deps.log ?? ((line) => console.log(line));
  }

  /**
   * Prove a token, store it, and record the grant.
   *
   * THE ORDER IS THE DESIGN, and each step only happens because the one before it succeeded:
   *
   *   1. ASK GITHUB WHO THIS IS. A token that cannot answer is not stored, so there is no path to
   *      a row claiming an account we never reached.
   *   2. WRITE THE VALUE. If the vault refuses — an unstorable character, a KMS that is down — the
   *      installation row is not written either, so `token_secret_name` can never point at nothing.
   *   3. RECORD THE GRANT, naming the login GitHub gave us rather than anything the user typed.
   *      A login is the one field here somebody could otherwise get wrong, and it is the field the
   *      panel renders as proof of who is connected.
   *
   * THE TOKEN IS NEVER LOGGED, never returned, and is not held in any structure that outlives this
   * call. The log line names the account, which is a fact GitHub prints on a public profile page.
   */
  async connect(ctx: TenantContext, token: string): Promise<ConnectOutcome> {
    let account: { login: string };
    try {
      account = await new GithubApi({ token }).viewer();
    } catch (err) {
      const message =
        err instanceof GithubError
          ? err.message
          : `could not reach GitHub: ${(err as Error)?.message ?? String(err)}`;
      // Deliberately not logging which token failed, in any form — not a prefix, not a length.
      this.log(`[github] a token was refused in ${ctx.workspaceId}`);
      return { ok: false, accountLogin: null, message };
    }

    const written = await this.deps.store(ctx, {
      name: GITHUB_ENV_KEY,
      value: token,
      provider: "github",
      actorUserId: ctx.actorUserId,
    });
    if (!written.ok) {
      return { ok: false, accountLogin: account.login, message: written.message ?? "could not store that token" };
    }

    await this.deps.repo.linkAccount(ctx, {
      accountLogin: account.login,
      tokenSecretName: GITHUB_ENV_KEY,
      // WHAT WE ASKED FOR RATHER THAN WHAT WE ASSUME. A classic PAT does not report its scopes
      // through this endpoint, so an empty list is the honest answer for one — and the day a push
      // 403s, "we do not know what this token was granted" is a better row to read than a list we
      // made up. A fine-grained token or an App installation fills this in.
      scopes: [],
    });
    this.log(`[github] ${ctx.workspaceId} linked @${account.login}`);
    return { ok: true, accountLogin: account.login, message: null };
  }

  /**
   * Hand the credential back and mark the grants dead.
   *
   * THE LINKS SURVIVE. Disconnecting is usually a rotation, and wiping every agent's repository
   * pointer would turn one reconnect into fifteen relinks — see §6 and the route's own note.
   */
  async disconnect(ctx: TenantContext, reason = "disconnected by the user"): Promise<void> {
    for (const installation of await this.deps.repo.installations(ctx)) {
      await this.deps.repo.revokeAccount(ctx, installation.id, reason);
    }
    await this.deps.forget(ctx, GITHUB_ENV_KEY);
    this.log(`[github] ${ctx.workspaceId} disconnected`);
  }

  /** The workspace's live grant, or undefined. What "connected" means everywhere else. */
  async current(ctx: TenantContext): Promise<GithubInstallation | undefined> {
    return (await this.deps.repo.installations(ctx))[0];
  }

  /**
   * A client for this workspace, or null when there is no usable grant.
   *
   * NULL RATHER THAN A THROW, because "this workspace has not connected GitHub" is the ordinary
   * state of most workspaces and every caller has a sensible thing to render for it — §2.1's empty
   * state. Reserving exceptions for things that actually went wrong is what keeps a `catch` in a
   * handler meaningful.
   *
   * THE VALUE IS FETCHED PER CALL AND NOT CACHED. A cached token is a token that keeps working for
   * as long as the cache lives after somebody revoked it in the Secrets tab, and the whole point of
   * `revoke` is that the next operation stops.
   */
  async apiFor(ctx: TenantContext): Promise<{ api: GithubApi; installation: GithubInstallation } | null> {
    const installation = await this.current(ctx);
    if (!installation) return null;
    const values = await this.deps.secrets.getForPlatformCall(ctx, [installation.token_secret_name]);
    const token = values[installation.token_secret_name];
    if (!token) {
      // A grant whose credential has gone — revoked in the Secrets tab, or swept. The row is marked
      // rather than left to fail on the next call, so the panel shows ⚠ with a reason instead of an
      // authentication error on whatever the user tried next.
      await this.deps.repo.revokeAccount(ctx, installation.id, "the stored token is no longer in the vault");
      return null;
    }
    return { api: new GithubApi({ token, log: this.log }), installation };
  }

  /**
   * Believe GitHub when it says a token is dead.
   *
   * Called from the one place that can know — a caught `auth` failure — so the badge goes to ⚠ with
   * "GitHub access was revoked" rather than showing a stale ↑2 that no push will ever clear. It is
   * idempotent: `revokeAccount` only touches rows that are still live.
   */
  async markRevoked(ctx: TenantContext, reason: string): Promise<void> {
    const installation = await this.current(ctx);
    if (!installation) return;
    await this.deps.repo.revokeAccount(ctx, installation.id, reason);
    this.log(`[github] ${ctx.workspaceId} grant revoked — ${reason}`);
  }
}
