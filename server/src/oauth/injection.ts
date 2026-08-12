// Getting a connector's credential into a run, and nowhere else.
//
// THE CONNECTOR CONTRACT DOES NOT CHANGE, AND THAT IS THE POINT. `slack.py` reads
// `SLACK_BOT_TOKEN` out of `os.environ`. `gmail.py` reads its Gmail variables out of `os.environ`.
// Neither has any idea OAuth exists, neither is rewritten by this session, and a project exported
// out of Jaroku still runs standalone against a hand-written `.env` — which the README promises
// and a test asserts. What this module does is put the right value under the right name at the
// moment a sandbox is built, so that a workspace which clicked Connect and a developer who pasted
// a token into `runtime/.env` produce byte-identical environments as far as the agent can tell.
//
// SHORT-LIVED, DELIBERATELY. What receives these values is model-written Python running against a
// stranger's prompt. A refresh token is a permanent grant to somebody's mailbox; an access token
// is an hour. Handing the sandbox the refresh token would be handing untrusted code the thing
// that regenerates credentials forever, and no amount of egress policy makes that acceptable — so
// the refresh token stays in the vault, on the control plane, and the sandbox receives the short
// half. `TokenRefresher.tokenForRun` is asked for a token with life beyond the run's own deadline,
// so a graph does not expire mid-flight, and the grace is deliberately small.
//
// ONE DEVIATION FROM THE SPEC, RECORDED RATHER THAN HIDDEN. The migration document says the
// connector Python "should not need to change". That is exactly true for Slack: an OAuth install
// yields `xoxb-…`, which is what the template already reads. It is not quite true for Gmail. The
// template builds `google.oauth2.credentials.Credentials` from a CLIENT ID, a CLIENT SECRET and a
// REFRESH TOKEN, because locally the user owned all three. Hosted, we own the first two and the
// third is the permanent grant this module exists not to hand out. Keeping the template literally
// unchanged would mean injecting a refresh token into untrusted code, which contradicts this
// session's own acceptance criterion that no long-lived token exists outside the vault. So
// `gmail.py` gains ONE additive branch: it prefers `GMAIL_ACCESS_TOKEN` when present and falls
// back to the refresh-token triple when it is not. The contract — read from `os.environ`, raise
// when unconfigured — is untouched, and the exported-project path still works exactly as before.
//
// WHAT IS NOT HERE: a decision about whether the agent may use the connector at all. That was
// made at generation, when the connector was selected and its template copied in. This resolves
// credentials for connectors the agent already has, and an agent with no connectors gets nothing.

import type { TenantContext } from "../db/tenant.ts";
import type { OAuthConnectionRow } from "../db/repositories/oauth.ts";
import type { TokenRefresher } from "./refresh.ts";
import { RUN_TOKEN_GRACE_MS } from "./refresh.ts";
import type { OAuthService } from "./service.ts";

/** What one connector's credentials came to, and why they did not when they did not. */
export interface ConnectorCredential {
  connectorId: string;
  /** The environment a run gets for this connector. Empty when nothing could be resolved. */
  env: Record<string, string>;
  /**
   * Why this connector has no credential, or null when it does.
   *
   * Surfaced rather than swallowed: an agent whose Gmail connection needs reauthorising will fail
   * at its first tool call with a message from Google, and "this workspace's Gmail connection
   * needs reconnecting" is a far better thing for the run's log to have said beforehand.
   */
  unavailable: string | null;
}

export interface ConnectorEnvOptions {
  /** The agent's declared connectors — `agents.connectors`. Never a client-supplied list. */
  connectors: string[];
  /** The run's own wall-clock limit, when it has one. Interactive runs do not. */
  runTimeoutMs?: number | null;
}

/**
 * Resolve every OAuth-backed connector an agent declares into environment variables.
 *
 * Never throws. A connector that cannot be resolved contributes nothing and a reason; the run
 * still starts, and the agent reports the failure at the point of use with the connector's own
 * message. That is the same judgement the existing credential resolution makes, and it is the
 * right one: refusing to start a run because one of four connectors needs reconnecting would
 * make an unrelated failure look like a broken product.
 */
export async function connectorRunEnv(
  ctx: TenantContext,
  refresher: TokenRefresher,
  service: Pick<OAuthService, "find">,
  opts: ConnectorEnvOptions,
): Promise<{ env: Record<string, string>; credentials: ConnectorCredential[] }> {
  const env: Record<string, string> = {};
  const credentials: ConnectorCredential[] = [];

  // A token has to outlast the run, or a graph still working after fifty-nine minutes loses its
  // Gmail access halfway through a tool call it cannot retry. The grace is on top of the run's own
  // deadline rather than instead of it, and an interactive run — which has no deadline by design
  // — gets the grace alone, because guessing a ceiling for something a person is watching would
  // be inventing the timeout the pool deliberately does not impose.
  const horizonMs = (opts.runTimeoutMs ?? 0) + RUN_TOKEN_GRACE_MS;

  for (const connectorId of opts.connectors) {
    // Only connectors this server actually offers over OAuth. `postgres` is a user_secret and
    // resolves through the ordinary `required_env` path; an unknown id contributes nothing.
    if (!service.find(connectorId)) continue;

    let resolved: { connection: OAuthConnectionRow; accessToken: string } | null = null;
    try {
      resolved = await refresher.tokenForRun(ctx, connectorId, { horizonMs });
    } catch (err) {
      // Already classified and already recorded on the row by the refresher. Caught here so one
      // connector's provider being down cannot stop the other three from being resolved.
      credentials.push({
        connectorId,
        env: {},
        unavailable: `${connectorId}: ${(err as Error).message}`,
      });
      continue;
    }

    if (!resolved) {
      credentials.push({
        connectorId,
        env: {},
        unavailable:
          `${connectorId} is not connected for this workspace, or its connection needs ` +
          `reauthorising — open Connections and reconnect it`,
      });
      continue;
    }

    const one = { [resolved.connection.access_secret_name]: resolved.accessToken };
    Object.assign(env, one);
    credentials.push({ connectorId, env: one, unavailable: null });
  }

  return { env, credentials };
}

/**
 * The names an agent's connectors will occupy, without resolving any values.
 *
 * For the two callers that need to know WHICH variables a run will see and must not be given the
 * values: the deploy path, which writes an `.env.example`, and anything rendering "what this
 * agent needs". Kept beside the resolution so the two lists cannot disagree about a name.
 */
export function connectorEnvNames(
  service: Pick<OAuthService, "find">,
  connectors: string[],
): string[] {
  const names: string[] = [];
  for (const id of connectors) {
    const found = service.find(id);
    if (found && !names.includes(found.spec.accessSecretName)) names.push(found.spec.accessSecretName);
  }
  return names;
}
