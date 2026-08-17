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
import { APP_GRANT, type GithubInstallation, type GithubRepository } from "./db/repositories/github.ts";
import {
  InstallationTokens, githubAppConfig, refreshUserToken, type GithubAppConfig,
} from "./githubApp.ts";
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
  /**
   * The App this deployment is, or null.
   *
   * READ THROUGH A FUNCTION rather than captured at construction, because registration writes it
   * into the live process (see `convertManifest`) and a value captured at boot would leave the
   * server thinking it has no App until somebody restarts it — on the one request that just
   * finished registering one.
   */
  app?: () => GithubAppConfig | null;
  /** Minted installation tokens, cached against GitHub's own expiry. Injected so a test can drive it. */
  tokens?: InstallationTokens;
  log?: (line: string) => void;
}

export interface ConnectOutcome {
  ok: boolean;
  accountLogin: string | null;
  message: string | null;
}

export class GithubIdentity {
  private readonly log: (line: string) => void;
  private readonly tokens: InstallationTokens;
  private readonly app: () => GithubAppConfig | null;

  constructor(private deps: GithubIdentityDeps) {
    this.log = deps.log ?? ((line) => console.log(line));
    this.tokens = deps.tokens ?? new InstallationTokens();
    this.app = deps.app ?? (() => githubAppConfig());
  }

  /**
   * Record a GitHub App installation as this workspace's grant.
   *
   * NO TOKEN IS STORED FOR THE INSTALLATION, and that is the whole point of the row's new shape:
   * what is durable is GitHub's installation id, and the credential is minted per hour from the
   * App's private key. A database dump of `github_installations` after this contains no
   * repository credential at all.
   *
   * THE USER TOKEN IS STORED, because it cannot be minted — it is the product of a person having
   * authorised, and the only way to get another is to send them back through GitHub. It goes into
   * the SecretStore under a name, exactly as the PAT did, so the same "no plaintext-return path
   * reachable from a request handler" rule covers it.
   */
  async installApp(
    ctx: TenantContext,
    input: {
      installationId: string;
      accountLogin: string;
      accountType?: "user" | "org";
      user?: { token: string; expiresAt: string | null; refreshToken: string | null } | null;
    },
  ): Promise<{ ok: boolean; message: string | null }> {
    const userName = `${GITHUB_ENV_KEY}_USER`;
    const refreshName = `${GITHUB_ENV_KEY}_REFRESH`;
    if (input.user) {
      const written = await this.deps.store(ctx, {
        name: userName, value: input.user.token, provider: "github", actorUserId: ctx.actorUserId,
      });
      if (!written.ok) {
        return { ok: false, message: written.message ?? "could not store the user token" };
      }
      if (input.user.refreshToken) {
        await this.deps.store(ctx, {
          name: refreshName, value: input.user.refreshToken, provider: "github",
          actorUserId: ctx.actorUserId,
        });
      }
    }

    await this.deps.repo.linkAccount(ctx, {
      accountLogin: input.accountLogin,
      accountType: input.accountType ?? "user",
      // See `APP_GRANT`: a sentence rather than a null, naming no secret because there is none.
      tokenSecretName: APP_GRANT,
      githubInstallationId: input.installationId,
      ...(input.user
        ? {
            userTokenSecretName: userName,
            userTokenExpiresAt: input.user.expiresAt,
            ...(input.user.refreshToken ? { userRefreshSecretName: refreshName } : {}),
          }
        : {}),
      scopes: [],
    });
    this.log(`[github] ${ctx.workspaceId} installed the app for @${input.accountLogin}`);
    return { ok: true, message: null };
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

    // THE APP PATH. The grant is an installation id and the credential is minted from the
    // deployment's private key, so there is nothing in the vault to read and nothing to revoke
    // when a token dies — it dies on a clock and the next call mints another.
    if (installation.github_installation_id) {
      const app = this.app();
      if (!app) {
        // A row that names an installation on a server that has forgotten which App it is. Marked
        // rather than left to 401 on whatever the user does next, and the reason says what to do.
        await this.deps.repo.revokeAccount(ctx, installation.id, "this server has no GitHub App registered");
        return null;
      }
      try {
        const token = await this.tokens.get(app, installation.github_installation_id);
        return { api: new GithubApi({ token, log: this.log }), installation };
      } catch (err) {
        // An installation somebody uninstalled on GitHub's side answers 404 here, which is the
        // App-era shape of "your access was revoked". Believed, for the reason `markRevoked` gives.
        this.tokens.forget(installation.github_installation_id);
        await this.deps.repo.revokeAccount(
          ctx, installation.id, `GitHub would not issue a token for this installation: ${(err as Error)?.message}`,
        );
        return null;
      }
    }

    // THE PERSONAL-ACCESS-TOKEN PATH, unchanged and unreachable from the UI. It is what a
    // GitHub Enterprise Server deployment and a self-hosted install with no callback URL use, and
    // deleting it would be deleting the only answer for both — see the connect route's own note.
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
   * A client for the three calls an installation token is refused by — §2.2's whole connect screen.
   *
   * `GET /user`, `GET /user/repos` AND `POST /user/repos`. GitHub's documentation lists OAuth and
   * personal access tokens for the last of those and not App installations, and the first two are
   * the same class: they are about a PERSON, and an installation is about repositories. So the
   * account line, the repository picker and "Create new repo" travel on a user-to-server token,
   * and every call that touches a repository travels on the installation's.
   *
   * FALLS BACK TO `apiFor` ON THE PAT PATH, where one token does everything and the distinction
   * this method exists for does not apply.
   *
   * REFRESHED IN PLACE WHEN IT HAS EXPIRED. A user token can be configured to last eight hours;
   * the refresh token that comes with it is what keeps "Create new repo" working on hour nine, and
   * a caller that got null instead would send somebody to reconnect an installation that is fine.
   */
  async userApiFor(ctx: TenantContext): Promise<{ api: GithubApi; installation: GithubInstallation } | null> {
    const installation = await this.current(ctx);
    if (!installation) return null;
    if (!installation.github_installation_id) return await this.apiFor(ctx);
    if (!installation.user_token_secret_name) return null;

    const app = this.app();
    if (!app) return null;
    const fresh = await this.liveUserToken(ctx, installation, app);
    if (!fresh) return null;
    return { api: new GithubApi({ token: fresh, log: this.log }), installation };
  }

  /** The user token, refreshed first if GitHub's own expiry says it will not survive the call. */
  private async liveUserToken(
    ctx: TenantContext,
    installation: GithubInstallation,
    app: GithubAppConfig,
  ): Promise<string | null> {
    const names = [installation.user_token_secret_name!];
    if (installation.user_refresh_secret_name) names.push(installation.user_refresh_secret_name);
    const values = await this.deps.secrets.getForPlatformCall(ctx, names);
    const token = values[installation.user_token_secret_name!];

    // A MINUTE OF SKEW, the same allowance the installation cache makes and for the same reason: a
    // token that expires between the check and the request is a 401 on the one screen where the
    // user has just clicked something.
    const alive = installation.user_token_expires_at === null
      || Date.parse(installation.user_token_expires_at) - 60_000 > Date.now();
    if (token && alive) return token;

    const refresh = installation.user_refresh_secret_name
      ? values[installation.user_refresh_secret_name]
      : undefined;
    if (!refresh) return token ?? null;
    try {
      const next = await refreshUserToken(app, refresh);
      await this.deps.store(ctx, {
        name: installation.user_token_secret_name!, value: next.token,
        provider: "github", actorUserId: ctx.actorUserId,
      });
      if (next.refreshToken && installation.user_refresh_secret_name) {
        await this.deps.store(ctx, {
          name: installation.user_refresh_secret_name, value: next.refreshToken,
          provider: "github", actorUserId: ctx.actorUserId,
        });
      }
      await this.deps.repo.linkAccount(ctx, {
        accountLogin: installation.account_login,
        accountType: installation.account_type,
        tokenSecretName: installation.token_secret_name,
        githubInstallationId: installation.github_installation_id,
        userTokenSecretName: installation.user_token_secret_name,
        userTokenExpiresAt: next.expiresAt,
        userRefreshSecretName: installation.user_refresh_secret_name,
      });
      return next.token;
    } catch (err) {
      this.log(`[github] could not refresh the user token: ${(err as Error)?.message}`);
      return token ?? null;
    }
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
