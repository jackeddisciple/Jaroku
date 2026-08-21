// `/v1/auth/oauth/google/start` and `/oauth/google/callback` — the two routes a Google sign-in is.
//
// THE CALLBACK IS THE ONE ROUTE HERE A THIRD PARTY DRIVES, exactly as the OAuth connection callback
// and the payment webhook are, and it is unauthenticated by construction: Google redirects a
// BROWSER back to us carrying no bearer token and no socket, and the single-use `state` we handed
// out ten minutes ago is the whole of the authentication.
//
// WHICH IS WHY EVERY OUTCOME IS AN HTML PAGE RATHER THAN JSON. `http/oauth.ts` makes the same
// argument for the connections flow: whatever is at the end of this is being looked at by a person
// in a browser tab, and `{"error":{"code":"bad_request"}}` on a white page is not something anybody
// can act on. The success page redirects to `jaroku://auth/complete?ticket=…` and then says "you
// can close this tab"; the failure pages say what went wrong in one sentence and stop.
//
// AND §3.2 STEP 7 IS WHY THE SUCCESS PAGE EXISTS AT ALL rather than a bare 302. "The web endpoint
// additionally shows a 'You can close this tab' confirmation page — the redirect happens
// automatically, but the confirmation is a fallback if the deep-link handler doesn't fire (browser
// blocks it, OS asks for confirmation, etc.)." Every browser handles an unknown scheme differently
// and several ask first; a page that navigated and nothing more would leave anybody who answered
// "no" to that prompt looking at a blank tab with no way back.
//
// NOTHING SENSITIVE IS EVER RENDERED OR LOGGED. §7's rule 4: never log the raw token, ticket,
// magic-link URL or authorization code. The router already redacts `code` and `ticket` from its
// access log by name; what this file adds is that no error message reaching the browser names
// which check failed — a callback that told a stranger it was the `state` rather than the `nonce`
// is a callback that helps them fix it.

import { badRequest, type Handler } from "./router.ts";
import {
  GOOGLE_CALLBACK_PATH,
  GoogleSignInError,
  completeDeepLink,
  exchangeGoogleCode,
  startGoogleSignIn,
  unpackVerifier,
  type GoogleConfig,
  type GoogleIdentity,
} from "../auth/googleSignIn.ts";
import { looksLikeSecret, type SignInProvider, type SignInStore } from "../auth/signIn.ts";
import type { JwksClient } from "../auth/jwks.ts";
import { authPage } from "./authPages.ts";

/** The route this server's own client asks to begin a flow. Under `/v1`, unlike the callback. */
export const GOOGLE_START_PATH = "/v1/auth/oauth/google/start";

export interface SignInRouteDeps {
  store: SignInStore;
  config: GoogleConfig;
  jwks: JwksClient;
  /**
   * Turn a verified identity into a user id, provisioning on first sight.
   *
   * SUPPLIED RATHER THAN REACHED FOR, like every other repository call from an HTTP module here.
   * It also keeps this file free of any opinion about what a user IS — provisioning is one
   * transaction in `identity.ts` and this route's job ends at "Google says this is ada@example.com
   * and here is the proof".
   */
  resolveUser: (
    identity: GoogleIdentity,
    context: { requestId: string; ip: string | null },
  ) => Promise<{ userId: string }>;
  /** Every auth event, per §7's rule 5. Never carries a raw secret. */
  audit: (
    action: string,
    detail: { requestId: string; ip: string | null; userId?: string | null; metadata?: Record<string, unknown> },
  ) => Promise<void>;
  /**
   * Bound how often one address may start a flow. Returns seconds to wait, or null.
   *
   * A START IS RATE-LIMITED TOO, WHICH THE SPECIFICATION ONLY ASKS FOR ON THE MAGIC LINK. The
   * reason it belongs here as well is that this route WRITES A ROW for every call and requires no
   * credential — so without a bound it is an unauthenticated way to fill a table. It is keyed by
   * IP because there is no address yet: nobody has said who they are at this point in the flow.
   */
  limitStart?: (ip: string) => Promise<number | null>;
  log?: (m: string) => void;
  fetchImpl?: typeof fetch;
  now?: () => number;
}

export function signInRoutes(
  deps: SignInRouteDeps,
): { path: string; method: "GET" | "POST"; handler: Handler }[] {
  return [
    { path: GOOGLE_START_PATH, method: "POST", handler: startHandler(deps) },
    { path: GOOGLE_CALLBACK_PATH, method: "GET", handler: callbackHandler(deps) },
  ];
}

/**
 * Begin a flow, and hand the app a URL to open in the system browser.
 *
 * UNAUTHENTICATED, because it precedes authentication by definition. What it returns is worth
 * nothing on its own: an authorization URL for our own public client id, which is a string anybody
 * could assemble from a network trace. The value that matters — the PKCE verifier — never leaves
 * this server.
 */
function startHandler(deps: SignInRouteDeps): Handler {
  const log = deps.log ?? console.log;
  return async (req) => {
    if (deps.limitStart && req.ip) {
      const wait = await deps.limitStart(req.ip);
      if (wait !== null) {
        await deps.audit("auth.rate_limited", { requestId: req.requestId, ip: req.ip, metadata: { route: "oauth_start" } });
        // 429 with the honest wait, per the router's own `tooMany`. Spelled inline rather than
        // through that helper because the client renders this one as a sentence on a sign-in
        // screen rather than as a retry.
        return {
          status: 429,
          headers: { "retry-after": String(wait) },
          body: { error: { code: "rate_limited", message: "too many sign-in attempts from here — wait a moment" } },
        };
      }
    }

    const body = await req.json<{ nonce?: unknown }>();
    const nonce = typeof body.nonce === "string" ? body.nonce.trim() : "";
    // THE APP'S OWN VALUE, AND IT IS REQUIRED. §3.2 binds the state to the app instance through
    // it, and a flow started without one would mint a ticket nothing could prove belonged to the
    // window that asked for it — which on a desktop, where any program can register `jaroku://`,
    // is the difference between an interception being refused and being a session.
    if (!looksLikeSecret(nonce)) {
      throw badRequest("give a nonce this sign-in can be bound to");
    }

    const started = await startGoogleSignIn(deps.store, deps.config, { appNonce: nonce });
    await deps.audit("auth.oauth_started", {
      requestId: req.requestId,
      ip: req.ip,
      metadata: { provider: "google" },
    });
    log(`[auth] a Google sign-in started (${req.requestId})`);
    // THE STATE IS NOT RETURNED TO THE CLIENT, only embedded in the URL it is about to open. A
    // client that held it could present it somewhere, and there is nowhere it should be presented:
    // the only thing that spends a state is Google's own redirect.
    return { body: { authorizeUrl: started.authorizeUrl, expiresAt: started.expiresAt } };
  };
}

/**
 * Finish a flow: spend the state, exchange the code, verify the token, mint a ticket, hand the
 * browser back to the app.
 *
 * EVERY FAILURE PATH ENDS IN THE SAME PAGE with the same words, and the audit row is where they
 * are told apart. §4.5 makes this rule for the ticket exchange and it is the same rule one step
 * earlier: a stranger pointing a browser at this route should learn nothing about which of six
 * checks refused them.
 */
function callbackHandler(deps: SignInRouteDeps): Handler {
  const log = deps.log ?? console.log;
  return async (req) => {
    const state = req.url.searchParams.get("state") ?? "";
    const code = req.url.searchParams.get("code") ?? "";
    // Google's own refusal — somebody pressed Cancel on the consent screen, or the account is not
    // permitted. Its own page, because it is the one failure that is not a failure: nothing went
    // wrong, somebody changed their mind, and telling them something broke would be a lie.
    const denied = req.url.searchParams.get("error");
    if (denied) {
      await deps.audit("auth.oauth_denied", {
        requestId: req.requestId,
        ip: req.ip,
        metadata: { provider: "google", error: denied.slice(0, 80) },
      });
      return page(cancelledPage());
    }

    if (!code || !looksLikeSecret(state)) {
      await deps.audit("auth.oauth_failed", {
        requestId: req.requestId,
        ip: req.ip,
        metadata: { provider: "google", reason: "malformed_callback" },
      });
      return page(failedPage(), 400);
    }

    // SPENT FIRST, BEFORE ANYTHING EXPENSIVE. A state that is not ours, is expired, or has already
    // been used must not be able to make this server call Google — otherwise the callback is an
    // unauthenticated way to make us issue outbound requests. §12's criterion 6: "State token is
    // single-use — a replayed callback returns an error."
    const claimed = await deps.store.consumeOAuthState(state);
    if (!claimed || claimed.provider !== "google") {
      await deps.audit("auth.oauth_failed", {
        requestId: req.requestId,
        ip: req.ip,
        metadata: { provider: "google", reason: "state_not_claimable" },
      });
      return page(expiredPage(), 400);
    }
    const unpacked = unpackVerifier(claimed.codeVerifier);
    if (!unpacked) {
      await deps.audit("auth.oauth_failed", {
        requestId: req.requestId,
        ip: req.ip,
        metadata: { provider: "google", reason: "unreadable_state" },
      });
      return page(failedPage(), 400);
    }

    let identity: GoogleIdentity;
    try {
      identity = await exchangeGoogleCode(
        {
          config: deps.config,
          jwks: deps.jwks,
          ...(deps.fetchImpl ? { fetchImpl: deps.fetchImpl } : {}),
          ...(deps.now ? { now: deps.now } : {}),
        },
        { code, codeVerifier: unpacked.codeVerifier, expectedNonce: unpacked.idTokenNonce },
      );
    } catch (err) {
      const reason = err instanceof GoogleSignInError ? err.reason : "exchange_failed";
      // THE REASON GOES IN THE AUDIT ROW AND NOWHERE ELSE. It names the client id in some of
      // Google's own error bodies, and the page it would otherwise be rendered on is in a browser.
      await deps.audit("auth.oauth_failed", {
        requestId: req.requestId,
        ip: req.ip,
        metadata: { provider: "google", reason: reason.slice(0, 200) },
      });
      log(`[auth] a Google sign-in failed (${req.requestId}): ${reason}`);
      return page(failedPage(), 400);
    }

    const { userId } = await deps.resolveUser(identity, { requestId: req.requestId, ip: req.ip });
    const ticket = await deps.store.issueSessionTicket({
      userId,
      provider: "google" satisfies SignInProvider,
      // FORWARDED FROM THE STATE, AS A DIGEST. The app proved which instance it was when it
      // started the flow; this is what carries that proof to the moment the ticket is spent. The
      // raw nonce never existed on this side of the round trip — it was hashed when the flow began
      // and the app is the only thing that still holds it.
      nonceHash: claimed.nonceHash,
    });
    await deps.audit("auth.oauth_completed", {
      requestId: req.requestId,
      ip: req.ip,
      userId,
      metadata: { provider: "google" },
    });
    log(`[auth] a Google sign-in completed for ${userId} (${req.requestId})`);
    return page(successPage(completeDeepLink(ticket.ticket)));
  };
}

/** An HTML response, with the headers a page rendered in a browser needs. */
function page(html: string, status = 200): { status: number; headers: Record<string, string>; body: Buffer } {
  return {
    status,
    headers: {
      "content-type": "text/html; charset=utf-8",
      // NEVER CACHED. Every one of these pages is about one sign-in attempt, and a cached success
      // page carrying a spent ticket in its markup is a page a browser would happily re-show.
      "cache-control": "no-store",
    },
    // A Buffer, because the router serialises anything else as JSON — see `HttpResponse`. The
    // content-type above is what makes it a page rather than a download.
    body: Buffer.from(html, "utf8"),
  };
}

/**
 * The four outcomes, on the shell `authPages.ts` owns.
 *
 * SHARED WITH THE MAGIC LINK rather than drawn here, because both flows end at the same four
 * places and two files that each draw a "you can close this tab" page are two pages that
 * eventually say it differently. Somebody who signs in with Google on Monday and a link on Tuesday
 * would then have met two products.
 */

/**
 * §3.2 step 7. The redirect fires from the `<meta refresh>` in the head; the footer is the
 * fallback for every browser that asks first, blocks unknown schemes, or is a webview with no
 * handler at all.
 *
 * THE LINK IS RENDERED AS WELL AS REDIRECTED TO, and it carries the ticket. That is a credential in
 * markup, which is worth stating plainly: it is single-use, it is worth sixty seconds, the page is
 * `no-store` and `noindex`, and the alternative — somebody who dismissed their browser's
 * prompt and now has no way to finish signing in — is worse. The same trade every OAuth desktop
 * flow makes.
 */
const successPage = (deepLink: string): string =>
  authPage({
    title: "Signed in",
    heading: "You're signed in",
    body: "Jaroku should be opening now. You can close this tab.",
    footer: { text: "Nothing happened?", linkText: "Open Jaroku", href: deepLink },
    redirect: deepLink,
  });

/** Somebody pressed Cancel. Nothing went wrong, and the page says so rather than apologising. */
const cancelledPage = (): string =>
  authPage({
    title: "Sign-in cancelled",
    heading: "Sign-in cancelled",
    body: "Nothing was changed. You can close this tab and try again in Jaroku whenever you like.",
  });

/**
 * §10: "User completes OAuth in browser but closes the browser before deep-link fires → State
 * token is single-use — user must restart."
 */
const expiredPage = (): string =>
  authPage({
    title: "This sign-in expired",
    heading: "This link has expired",
    body:
      "Sign-in links are good for a few minutes and can only be used once. Head back to Jaroku and " +
      "start again.",
  });

/** Everything else, in one page, on purpose. See the note on `callbackHandler`. */
const failedPage = (): string =>
  authPage({
    title: "Sign-in didn't complete",
    heading: "Sign-in didn't complete",
    body: "Something went wrong on the way back from Google. Head back to Jaroku and try again.",
  });
