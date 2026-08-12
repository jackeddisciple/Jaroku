// The one HTTP surface OAuth needs, and why it could not have been a socket command.
//
// A provider redirects a BROWSER back to us. There is no socket in that request, no bearer token
// on it, and no way to put one there — the request is made by the user agent following a
// `Location` header from somebody else's server, carrying nothing but what we put in the `state`
// we handed out ten minutes ago. So the state IS the authentication, exactly as the Stripe
// webhook's signature is: single-use, hashed at rest, and resolving to the workspace and user
// that opened the flow.
//
// WHAT THIS ROUTE ANSWERS WITH IS A REDIRECT, NOT JSON. The thing on the other end is a person
// looking at a browser tab, not a client library — so every outcome, success and failure alike,
// ends with them back in the app looking at the connections panel. A JSON error body here would
// be a white page with `{"error":{"code":"unauthorized"}}` on it, which is the worst possible
// place to end a consent flow.
//
// AND THE REDIRECT TARGET IS NEVER SOMETHING THE REQUEST CHOSE. `returnTo` is a path recorded on
// the state row at `begin` and re-joined to this deployment's own app URL — see
// oauth/provider.ts's `returnUrl`, which discards anything that could be absolute rather than
// trying to clean it. A callback that redirects wherever it is told is a phishing primitive
// hosted on our own domain, wearing our own certificate, reached by a link that genuinely came
// from Google.

import { type Handler, type HttpRequest, type HttpResponse } from "./router.ts";
import { callbackPath, returnUrl } from "../oauth/provider.ts";
import { OAuthError, type CompleteResult, type OAuthService } from "../oauth/service.ts";

export interface OAuthRoutesDeps {
  oauth: OAuthService;
  /** The providers this deployment offers. One route per provider, per the callback path. */
  providerIds: string[];
  env?: NodeJS.ProcessEnv;
  /** Tell the workspace its connection list changed, so an open panel updates itself. */
  onCompleted?: (result: CompleteResult) => void;
  /**
   * Tell somebody a flow failed.
   *
   * NO WORKSPACE, and that is not laziness. A flow that failed because its state did not resolve
   * has no workspace to report to — resolving the state is what produces one — and the failures
   * that DO have one are already recorded on the connection row by the service. So this is a log
   * hook rather than a broadcast: broadcasting to a workspace we had to guess at would be worse
   * than saying nothing, and guessing is the only option on the path that most needs reporting.
   */
  onFailed?: (message: string) => void;
}

export function oauthRoutes(deps: OAuthRoutesDeps): { path: string; method: "GET"; handler: Handler }[] {
  return deps.providerIds.map((providerId) => ({
    path: callbackPath(providerId),
    method: "GET" as const,
    handler: callbackHandler(deps),
  }));
}

/**
 * Where the browser lands, whatever happened.
 *
 * Note what is NOT here: any check of who is asking. There is deliberately no bearer token on
 * this route and no session lookup, because the person completing a flow may be on a different
 * device than the one that started it — a phone that scanned a QR code, a browser that opened
 * the consent screen in a new profile. The state row carries the workspace and the user, it is
 * single-use, it is ten minutes old at most, and it is the whole of the authorisation. Adding a
 * session check on top would break the legitimate cases and stop no attack: an attacker who could
 * present a valid state already has the thing the check would be verifying.
 */
function callbackHandler(deps: OAuthRoutesDeps): Handler {
  return async (req: HttpRequest): Promise<HttpResponse> => {
    const params = req.url.searchParams;
    try {
      const result = await deps.oauth.complete({
        state: params.get("state"),
        code: params.get("code"),
        error: params.get("error"),
        errorDescription: params.get("error_description"),
      });
      deps.onCompleted?.(result);
      // A note on the URL rather than in a body, because the body of a 302 is not read. The
      // client reads it once, shows it, and strips it from the address bar — a query parameter
      // that survives a reload would re-announce a connection every time somebody refreshes.
      const to = new URL(result.redirectTo);
      to.searchParams.set("connected", result.connection.connector_id);
      if (result.missingScopes.length) to.searchParams.set("partial", "1");
      return redirect(to.toString());
    } catch (err) {
      const failure = err instanceof OAuthError ? err : new OAuthError("error", "that authorisation failed");
      // Logged rather than broadcast — see onFailed on why there is no workspace to broadcast to
      // on the path that most needs reporting.
      deps.onFailed?.(failure.message);
      const to = new URL(returnUrl(null, deps.env ?? process.env));
      // The KIND, not the message. A message on a URL is a string an attacker chooses by
      // choosing what to send to the callback, and a page that renders it is a page that renders
      // whatever they wrote under our own domain. The client maps a kind to its own words.
      to.searchParams.set("connect_failed", failure.kind);
      return redirect(to.toString());
    }
  };
}

function redirect(location: string): HttpResponse {
  return {
    status: 302,
    // No body. A 302 with a JSON payload is a payload nothing reads, and writing one invites
    // somebody to start relying on it.
    headers: {
      location,
      // A consent outcome is not a thing to serve from a cache, on any hop, ever.
      "cache-control": "no-store",
      // The redirect target is ours and the referrer would carry the `state` to whatever the
      // user clicks next. Single-use and expired or not, it does not need to travel further.
      "referrer-policy": "no-referrer",
    },
  };
}
