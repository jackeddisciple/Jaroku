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
 * The pages.
 *
 * SELF-CONTAINED, WITH NO EXTERNAL ANYTHING. No font, no stylesheet, no script from another
 * origin, and no image. These are served from the auth domain, which is the one origin in this
 * product that must have the smallest possible attack surface — §3.2's own reasoning for a
 * stateless callback — and a page that pulls a font from a CDN is a page whose appearance depends
 * on somebody else's uptime at the exact moment somebody is signing in.
 *
 * The look is the app's own: near-black, one card, the display serif for the line that matters.
 * Somebody arrives here mid-sign-in and goes back to the app a second later, and a white page with
 * Times New Roman on it in between reads as having been redirected somewhere unrelated.
 */
const SHELL = (title: string, body: string, redirect?: string): string => `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${title} · Jaroku</title>
<style>
  :root { color-scheme: dark }
  body { margin:0; min-height:100vh; display:flex; align-items:center; justify-content:center;
         background:#08080a; color:#e4e4e7; font:400 14px/1.6 ui-sans-serif,system-ui,-apple-system,"Segoe UI",sans-serif;
         background-image:radial-gradient(rgba(228,228,231,0.05) 1px,transparent 1px); background-size:24px 24px }
  main { max-width:420px; padding:36px 32px; text-align:center; border:1px solid #2a2a30; border-radius:14px;
         background:rgba(13,13,15,0.9); box-shadow:0 4px 12px rgba(0,0,0,.4),0 28px 64px -16px rgba(0,0,0,.7) }
  h1 { margin:0 0 12px; font:400 26px/1.2 ui-serif,Georgia,Cambria,serif; letter-spacing:-.005em }
  p { margin:0 0 8px; color:#a1a1aa }
  .quiet { color:#71717a; font-size:12px; margin-top:20px }
  a { color:#e08a5c }
  svg { display:block; margin:0 auto 18px }
</style>
${redirect ? `<meta http-equiv="refresh" content="0;url=${escapeAttr(redirect)}">` : ""}
</head><body><main>
<svg width="26" height="26" viewBox="0 0 24 24" fill="#e4e4e7" aria-hidden="true"><path d="M11 1.04C11.6.98 12.2.97 12.79 1.03c2.05.15 4.02.86 5.72 2.05.37.4-.04 1.28-.95 2.77-1.5 1.83-3.72 2.9-6.31 3.44-2.6.55-5.02 1.78-7.06 3.6-.6.48-1.15.99-1.36.76-.38-.14-.63-.98-.72-1.54C.94 8.7 3.1 4.2 7.59 2.04A13.4 13.4 0 0 1 11 1.04Z"/><path d="M20.99 7.72c.32-.07.85.49 1.09.89 1.02 3.9-.2 8.15-3.24 11.02-1.6 1.5-3.63 2.5-5.43 2.32-.9-.09-1.68-.6-1.9-1.4-.2-.75.14-1.53.83-2.02 3.15-2.2 5.6-5.32 7.06-9.02.25-.47.51-1.25.83-1.31l-1.24-.48Z"/><path d="M10.31 11.35c1.5-.2 3.13.15 3.84 1.13.52.72.3 1.75-.53 2.6-1.42 1.45-3.4 2.4-4.44 4.32-.4.75-.5 1.63-.42 2.26-.13.39-.43.85-.77.98-1.9-.4-3.6-2.06-4.24-4.12-.9-2.9.62-6.1 3.5-7.36.98-.43 2-.68 3.06-.81Z"/></svg>
${body}
</main></body></html>`;

const escapeAttr = (v: string): string =>
  v.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/**
 * §3.2 step 7. The redirect fires from the `<meta refresh>` in the head; this is the fallback for
 * every browser that asks first, blocks unknown schemes, or is a webview with no handler at all.
 *
 * THE LINK IS RENDERED AS WELL AS REDIRECTED TO, and it carries the ticket. That is a credential in
 * markup, which is worth stating plainly: it is single-use, it is worth sixty seconds, the page is
 * `no-store`, and the alternative — a person who answered "no" to their browser's prompt and now
 * has no way to finish signing in — is worse. The same trade every OAuth desktop flow makes.
 */
const successPage = (deepLink: string): string =>
  SHELL(
    "Signed in",
    `<h1>You're signed in</h1>
     <p>Jaroku should be opening now. You can close this tab.</p>
     <p class="quiet">Nothing happened? <a href="${escapeAttr(deepLink)}">Open Jaroku</a></p>`,
    deepLink,
  );

/** Somebody pressed Cancel. Nothing went wrong, and the page says so rather than apologising. */
const cancelledPage = (): string =>
  SHELL(
    "Sign-in cancelled",
    `<h1>Sign-in cancelled</h1>
     <p>Nothing was changed. You can close this tab and try again in Jaroku whenever you like.</p>`,
  );

/**
 * §10: "User completes OAuth in browser but closes the browser before deep-link fires → State token
 * is single-use — user must restart."
 */
const expiredPage = (): string =>
  SHELL(
    "This sign-in expired",
    `<h1>This link has expired</h1>
     <p>Sign-in links are good for a few minutes and can only be used once.
        Head back to Jaroku and start again.</p>`,
  );

/** Everything else, in one page, on purpose. See the note on `callbackHandler`. */
const failedPage = (): string =>
  SHELL(
    "Sign-in didn't complete",
    `<h1>Sign-in didn't complete</h1>
     <p>Something went wrong on the way back from Google. Head back to Jaroku and try again.</p>`,
  );
