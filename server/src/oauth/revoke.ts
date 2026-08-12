// Ending a grant, at the far end as well as at this one.
//
// THE FAILURE THIS EXISTS TO PREVENT IS A LIE THE PRODUCT WOULD OTHERWISE TELL. A user clicks
// Disconnect, the row goes grey, the panel says "disconnected" — and in Google's account
// permissions page Jaroku is still there, still holding a refresh token that still works. The
// user believes they have ended something they have not. Deleting our copy of a credential is
// housekeeping; REVOKING it is the thing the button appears to promise, and the two are not the
// same operation.
//
// It matters more than it sounds. A refresh token we have forgotten is not a token that has
// stopped existing: it is a valid grant sitting in whatever backup, log or crash dump it reached
// before we forgot it, with nothing on the provider's side to stop it being used. Revocation is
// the only thing that makes "disconnected" true rather than merely displayed.
//
// AND THE ORDER IS DELIBERATE: REVOKE FIRST, THEN FORGET. A crash between the two leaves a grant
// that is dead at the provider and still recorded here — visible, wrong in the harmless
// direction, and fixed by pressing the button again. The other order leaves a live grant nothing
// points at, which is unrecoverable: there is no token left to revoke with and no row to say one
// exists. Same reasoning the refresher's write order follows, applied to the teardown.
//
// A PROVIDER THAT REFUSES THE REVOCATION IS NOT A REASON TO KEEP THE CREDENTIAL. If the token was
// already invalid, the revocation is redundant and the disconnect should proceed; if the provider
// is down, retrying forever holds a user in a state they asked to leave. So the local teardown
// happens either way and the outcome is RECORDED — `revoked_at` says when we forgot it,
// `last_error` says whether the far end agreed — because "we could not reach Google" and "Google
// says it is gone" are different answers to a support question, and a user deserves to be told
// which one applies to their own account.

import type { TenantContext } from "../db/tenant.ts";
import type { OAuthConnectionRow, OAuthRepository } from "../db/repositories/oauth.ts";
import type { SecretStore } from "../secrets/secretStore.ts";
import type { OAuthClientConfig, OAuthProvider } from "./provider.ts";
import { stripControl } from "./service.ts";

/** How long a revocation call gets. Short: nothing waits on it and the teardown proceeds anyway. */
const REVOKE_TIMEOUT_MS = 10_000;

/** The one network call this module makes. Injected so a suite needs no provider and no network. */
export type RevokeTransport = (
  url: string,
  body: URLSearchParams,
  headers: Record<string, string>,
) => Promise<{ status: number; body: unknown }>;

export interface RevocationResult {
  /** Whether the local teardown completed. Almost always true — see the header. */
  ok: boolean;
  /**
   * What happened at the far end.
   *
   * `revoked`      the provider confirmed it, or answered in a way that means it is gone
   * `already_gone` the provider said the token was not valid, which is the same outcome
   * `unreachable`  we could not tell it. The local teardown still happened.
   * `unsupported`  the provider publishes no revocation endpoint at all
   * `no_credential` there was nothing stored to revoke with
   */
  remote: "revoked" | "already_gone" | "unreachable" | "unsupported" | "no_credential";
  /** For the panel and the audit row. Never any part of a token. */
  message: string | null;
}

export interface RevokerOptions {
  repo: OAuthRepository;
  secrets: SecretStore;
  providers: OAuthProvider[];
  config: (providerId: string) => OAuthClientConfig | null;
  transport?: RevokeTransport;
}

export class ConnectionRevoker {
  private readonly transport: RevokeTransport;

  constructor(private readonly opts: RevokerOptions) {
    this.transport = opts.transport ?? realRevokeTransport;
  }

  /**
   * End one connection: hand the grant back, then forget the credentials, then mark the row.
   *
   * Never throws. Every failure is a `remote` value and a message — a disconnect that threw would
   * leave a user looking at a connection they asked to remove, with no way to try again that is
   * different from the way that just failed.
   */
  async disconnect(ctx: TenantContext, connection: OAuthConnectionRow): Promise<RevocationResult> {
    const remote = await this.revokeRemotely(ctx, connection);

    // The local teardown, unconditionally. See the header: a provider that refused, or that we
    // could not reach, is not a reason to keep somebody's credential.
    await this.opts.secrets.delete(ctx, connection.access_secret_name);
    if (connection.refresh_secret_name) {
      await this.opts.secrets.delete(ctx, connection.refresh_secret_name);
    }
    await this.opts.repo.markRevoked(ctx, connection.id);

    // Recorded on the row so the panel can say which of the two happened. `markRevoked` clears
    // the error, so this is written after it rather than before.
    if (remote.remote === "unreachable" && remote.message) {
      await this.opts.repo.markRevokedWithNote(ctx, connection.id, remote.message);
    }
    return { ok: true, ...remote };
  }

  /**
   * Tell the provider, if it has anywhere to be told.
   *
   * THE REFRESH TOKEN IS PREFERRED OVER THE ACCESS TOKEN, and for Google that is the difference
   * between ending the grant and ending an hour of it: revoking a refresh token invalidates the
   * whole authorisation including every access token minted from it, while revoking an access
   * token leaves the refresh token free to mint another. Slack's `auth.revoke` takes the bot
   * token itself, which is the only one it has.
   */
  private async revokeRemotely(
    ctx: TenantContext,
    connection: OAuthConnectionRow,
  ): Promise<Omit<RevocationResult, "ok">> {
    const provider = this.opts.providers.find((p) => p.id === connection.provider);
    if (!provider?.revokeUrl) {
      return {
        remote: "unsupported",
        message: `${connection.provider} publishes no revocation endpoint — the credential is forgotten here`,
      };
    }

    const names = [connection.refresh_secret_name, connection.access_secret_name].filter(
      (n): n is string => Boolean(n),
    );
    const stored = await this.opts.secrets.getForPlatformCall(ctx, names);
    const token = names.map((n) => stored[n]).find((v) => Boolean(v));
    if (!token) {
      // Nothing to revoke WITH. Not a failure: a connection whose credential is already gone is
      // one whose grant we cannot end, and saying so is more useful than reporting success.
      return { remote: "no_credential", message: "there was no stored credential left to revoke" };
    }

    const config = this.opts.config(provider.id);
    try {
      const answer = await this.transport(
        provider.revokeUrl,
        new URLSearchParams({
          token,
          // Both spellings, because providers disagree and sending an ignored parameter costs
          // nothing. Google reads `token`; Slack's `auth.revoke` reads the Authorization header,
          // which the transport builds from the same value.
          token_type_hint: connection.refresh_secret_name ? "refresh_token" : "access_token",
          ...(config ? { client_id: config.clientId, client_secret: config.clientSecret } : {}),
        }),
        { "content-type": "application/x-www-form-urlencoded", authorization: `Bearer ${token}` },
      );

      // A 200 is confirmation. A 400 with `invalid_token` means it was already gone, which is the
      // same outcome and must not be reported as a failure — a user disconnecting something they
      // already revoked in Google's own settings page would otherwise be told it went wrong.
      if (answer.status < 300) return { remote: "revoked", message: null };
      const body = answer.body && typeof answer.body === "object" ? (answer.body as Record<string, unknown>) : {};
      const code = typeof body["error"] === "string" ? body["error"] : "";
      if (/invalid_token|token_revoked|invalid_auth|already/i.test(code)) {
        return { remote: "already_gone", message: null };
      }
      return {
        remote: "unreachable",
        message: stripControl(
          `${provider.label} did not confirm the revocation (${code || answer.status}) — the ` +
            `credential is forgotten here, but check your account's connected apps`,
        ).slice(0, 300),
      };
    } catch (err) {
      return {
        remote: "unreachable",
        message: stripControl(
          `could not reach ${provider.label} to revoke (${(err as Error).message}) — the credential ` +
            `is forgotten here, but check your account's connected apps`,
        ).slice(0, 300),
      };
    }
  }

  /**
   * Every connection a workspace has, ended.
   *
   * What workspace deletion calls, and what makes the deletion honest: a workspace whose rows are
   * dropped while its Gmail grant stays live at Google has not been deleted, it has been hidden.
   *
   * Continues past a failure rather than stopping at one, because the alternative is a
   * half-deleted workspace whose remaining grants depend on which provider happened to be down.
   */
  async disconnectAll(ctx: TenantContext): Promise<RevocationResult[]> {
    const out: RevocationResult[] = [];
    for (const connection of await this.opts.repo.list(ctx)) {
      if (connection.status === "revoked") continue;
      out.push(await this.disconnect(ctx, connection));
    }
    return out;
  }
}

/**
 * Every third-party grant a workspace holds, ended — OAuth connections AND MCP credentials.
 *
 * WHAT THIS IS FOR, stated plainly because it is not called from a delete button yet. Session 8
 * owns workspace and account deletion: the cascade across Postgres, the object store, the
 * checkpoints and the queue, with a receipt and a stated window. What Session 8 must NOT have to
 * invent is the provider-side half — the part that makes a deletion honest rather than merely
 * thorough, because a workspace whose rows are dropped while its Gmail grant stays live at Google
 * has been hidden rather than deleted. So the provider-side half is built here, where the
 * revocation logic already lives, and Session 8 calls it.
 *
 * BOTH KINDS, because a workspace holds two. An OAuth connection is a grant somebody made to us
 * and is revoked at the provider. An MCP credential is a token a user pasted in, belonging to a
 * server we have no revocation protocol for — so it is deleted, which is the whole of what can be
 * done with it, and counted separately so a receipt does not claim more than happened.
 *
 * CONTINUES PAST EVERY FAILURE. The alternative is a half-torn-down workspace whose remaining
 * grants depend on which provider happened to be down at the moment somebody pressed delete.
 */
export async function endAllGrants(
  ctx: TenantContext,
  deps: {
    revoker: ConnectionRevoker;
    secrets: SecretStore;
    /** The MCP servers this workspace registered, with the NAMES their credentials live under. */
    mcpAuthKeys: () => Promise<string[]>;
  },
): Promise<{
  connections: RevocationResult[];
  /** How many MCP credentials were deleted. Deleted, never revoked — see above. */
  mcpCredentialsDeleted: number;
}> {
  const connections = await deps.revoker.disconnectAll(ctx);

  let mcpCredentialsDeleted = 0;
  for (const name of await deps.mcpAuthKeys()) {
    try {
      await deps.secrets.delete(ctx, name);
      mcpCredentialsDeleted++;
    } catch {
      // Counted only when it happened. A receipt that overstates is worse than one that is short,
      // because the number is the thing somebody would cite when asked whether data is gone.
    }
  }
  return { connections, mcpCredentialsDeleted };
}

/** The real call. Bounded, and it never formats the token into anything but the body it sends. */
const realRevokeTransport: RevokeTransport = async (url, body, headers) => {
  const signal = AbortSignal.timeout(REVOKE_TIMEOUT_MS);
  const res = await fetch(url, { method: "POST", body, headers, signal });
  const text = await res.text();
  try {
    return { status: res.status, body: JSON.parse(text) as unknown };
  } catch {
    // Google's revoke endpoint answers 200 with an empty body. Not an error, and not JSON.
    return { status: res.status, body: {} };
  }
};
