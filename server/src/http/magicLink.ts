// `POST /v1/auth/magic-link`, `GET /magic`, and the webhook that tells us a message bounced.
//
// THE FIRST ROUTE ALWAYS ANSWERS 200, AND THAT IS THE WHOLE DESIGN. §3.3: "Always returns 200 to
// the client, regardless of whether the email exists in the database or not. Do not distinguish
// 'sent' vs 'user not found' — this prevents email enumeration attacks. The user always sees 'Check
// your email for a link.'"
//
// It is worth being precise about what that costs, because the rule is easy to state and easy to
// break by accident. A route that answered 404 for an unknown address would be a way for anybody to
// test whether a given person has a Jaroku account — one request per address, no credential, no
// rate limit that matters, and the answer is a fact about somebody who never consented to it being
// public. So EVERY refusal below that could reveal existence answers 200 with the same body:
// a blocked address, an address with no account, an address with an account. The refusals that
// remain visible are the ones that say something about the REQUEST rather than about a person — a
// malformed address, and a rate limit, both of which the caller already knows.
//
// AND THE RATE LIMIT IS THE ONE EXCEPTION, ON PURPOSE. §12's criterion 11 asks for a 4th request
// from one address in an hour to be blocked, which is only observable if it is visible. It reveals
// nothing: it says this ADDRESS has been asked about recently, which is a fact about the asker.
//
// `GET /magic` IS A ROUTE A MAIL CLIENT DRIVES, which is a stranger class all of its own. It is
// prefetched by Gmail's proxy, previewed by Outlook, scanned by corporate link-rewriters, and then
// eventually clicked by a person — §10 lists that as three clicks in quick succession and asks for
// exactly one to succeed. Atomic consumption is what makes that true; everything else here is about
// what the other two see, which is the same page as an expired link, for §4.5's reason.

import { badRequest, tooMany, type Handler } from "./router.ts";
import {
  MAGIC_LINK_LIMITS,
  MAGIC_LINK_TTL_S,
  isEmailAddress,
  looksLikeSecret,
  normaliseEmail,
  rateKeyForEmail,
  rateKeyForIp,
  type SignInStore,
} from "../auth/signIn.ts";
import { completeDeepLink } from "../auth/googleSignIn.ts";
import { SIGN_IN_SUBJECT, signInEmail } from "../email/signInEmail.ts";
import { EmailError, readDeliveryEvent, webhookSecretMatches, type EmailTransport } from "../email/transport.ts";

export const MAGIC_LINK_PATH = "/v1/auth/magic-link";
/** Where the link in the email points. Not under `/v1`, for `GOOGLE_CALLBACK_PATH`'s reason: this
 *  URL is inside messages already sitting in people's inboxes and can never move. */
export const MAGIC_PATH = "/magic";
/** The bounce webhook. The secret is a path segment, so a provider needs no custom header. */
export const EMAIL_WEBHOOK_PREFIX = "/webhooks/email/";

export interface MagicLinkDeps {
  store: SignInStore;
  transport: EmailTransport;
  /** The public origin the link points at. Same value Google's callback is built from. */
  authOrigin: string;
  /**
   * Find or create the account for a verified address, and answer with its id.
   *
   * CALLED AT CONSUMPTION, NEVER AT REQUEST. §3.3 step 3 sends a link to an address whether or not
   * anybody owns it — that is what makes the route non-enumerable — so provisioning at that point
   * would create an account for every address anybody typed, including the ones typed by somebody
   * probing. The account is created in step 7, when a person has proved they can read that mailbox.
   */
  resolveUser: (email: string, context: { requestId: string; ip: string | null }) => Promise<{ userId: string }>;
  audit: (
    action: string,
    detail: { requestId: string; ip: string | null; userId?: string | null; metadata?: Record<string, unknown> },
  ) => Promise<void>;
  /** The shared secret a delivery webhook must present. Absent means the webhook refuses everything. */
  webhookSecret?: string | undefined;
  log?: (m: string) => void;
}

export function magicLinkRoutes(
  deps: MagicLinkDeps,
): { path: string; method: "GET" | "POST"; prefix?: boolean; handler: Handler }[] {
  return [
    { path: MAGIC_LINK_PATH, method: "POST", handler: requestHandler(deps) },
    { path: MAGIC_PATH, method: "GET", handler: consumeHandler(deps) },
    { path: EMAIL_WEBHOOK_PREFIX, method: "POST", prefix: true, handler: webhookHandler(deps) },
  ];
}

/** The body every non-revealing outcome answers with. One object, so they cannot drift apart. */
const SENT = { sent: true, expiresInMinutes: Math.round(MAGIC_LINK_TTL_S / 60) } as const;

/**
 * §3.3 steps 2 and 3. Rate-limit, mint, send, and answer 200 whatever happened.
 */
function requestHandler(deps: MagicLinkDeps): Handler {
  const log = deps.log ?? console.log;
  return async (req) => {
    const body = await req.json<{ email?: unknown }>();
    const raw = typeof body.email === "string" ? body.email.trim() : "";

    // A MALFORMED ADDRESS IS A 400, AND IT REVEALS NOTHING. "That is not an email address" is a
    // fact about the string in the box, which the person can see; it says nothing about whether
    // anybody with any address has an account here.
    if (!isEmailAddress(raw)) throw badRequest("that does not look like an email address");
    const email = normaliseEmail(raw);

    // BOTH LIMITS, AND BOTH ARE COUNTED BEFORE EITHER IS CHECKED. §7's rule 3 says both must apply;
    // counting both means a request refused on the address limit still costs its origin an attempt,
    // which is what stops one machine cycling through addresses for free.
    const perEmail = await deps.store.countAttempt(rateKeyForEmail(email), MAGIC_LINK_LIMITS.windowS);
    const perIp = req.ip ? await deps.store.countAttempt(rateKeyForIp(req.ip), MAGIC_LINK_LIMITS.windowS) : null;
    const over =
      perEmail.count > MAGIC_LINK_LIMITS.perEmail || (perIp !== null && perIp.count > MAGIC_LINK_LIMITS.perIp);
    if (over) {
      // §7's rule 5 names this as one of the two highest-signal audit rows, and says not to sample it.
      await deps.audit("auth.rate_limited", {
        requestId: req.requestId,
        ip: req.ip,
        // THE ADDRESS IS NOT IN THE METADATA, only its digest. This row is read by whoever is
        // investigating abuse, and an audit log full of the addresses somebody probed is a list of
        // people's email addresses assembled by an attacker and stored by us.
        metadata: { route: "magic_link", scope: perEmail.count > MAGIC_LINK_LIMITS.perEmail ? "email" : "ip" },
      });
      const window = perEmail.count > MAGIC_LINK_LIMITS.perEmail ? perEmail : perIp!;
      const wait = Math.max(1, Math.ceil((window.windowStart + MAGIC_LINK_LIMITS.windowS * 1000 - Date.now()) / 1000));
      throw tooMany("too many sign-in links have been requested for this address — try again later", wait);
    }

    // §8.4: a blocked address is not mailed, AND THE CALLER IS NOT TOLD. Telling them would answer
    // "does this address exist and has it bounced", which is two facts about somebody else. The
    // person who owns a bounced address finds out on the next attempt through the account they can
    // actually reach — or through support, which is what §8.4's "surface in-app on next attempt"
    // means once enumeration is accounted for.
    if (await deps.store.isBlocked(email)) {
      await deps.audit("auth.magic_link_suppressed", {
        requestId: req.requestId,
        ip: req.ip,
        metadata: { reason: "blocked" },
      });
      log(`[auth] a sign-in link was requested for a blocked address (${req.requestId})`);
      return { body: SENT };
    }

    const issued = await deps.store.issueMagicLink({
      email,
      ip: req.ip,
      userAgent: req.header("user-agent") ?? null,
    });
    const link = magicUrl(deps.authOrigin, issued.token, email);
    const message = signInEmail(link, Math.round(MAGIC_LINK_TTL_S / 60));

    try {
      await deps.transport.send({ to: email, subject: message.subject, text: message.text, html: message.html });
    } catch (err) {
      // §10: "Email provider is down when magic link is requested → Return an actionable error to
      // the user. Do not silently fail." THE ONE PLACE THIS ROUTE DOES NOT ANSWER 200, and it is
      // not an enumeration leak: it is a fact about OUR provider, identical for every address.
      const detail = err instanceof EmailError ? err.message : String(err);
      log(`[auth] could not send a sign-in link (${req.requestId}): ${detail}`);
      await deps.audit("auth.magic_link_failed", {
        requestId: req.requestId,
        ip: req.ip,
        metadata: { retryable: err instanceof EmailError ? err.retryable : true },
      });
      return {
        status: 502,
        body: {
          error: {
            code: "email_unavailable",
            message: "couldn't send that email right now — try again in a minute, or sign in with Google",
          },
        },
      };
    }

    // §7's rule 5. NO RAW TOKEN AND NO LINK IN THE ROW — only that one was sent, and to a digest.
    await deps.audit("auth.magic_link_sent", {
      requestId: req.requestId,
      ip: req.ip,
      metadata: { provider: deps.transport.provider },
    });
    log(`[auth] a sign-in link was sent (${req.requestId})`);
    return { body: SENT };
  };
}

/**
 * The URL that goes in the email.
 *
 * THE ADDRESS RIDES ALONGSIDE THE TOKEN, and it is not redundant. §10's last property — a token for
 * one address cannot sign somebody in as another — is enforced by the store comparing the two in
 * the same statement that spends the token, and it has nothing to compare against unless the
 * address travels with the link. It is not a secret: whoever has the link has the mailbox.
 */
export function magicUrl(authOrigin: string, token: string, email: string): string {
  const url = new URL(`${authOrigin.replace(/\/+$/, "")}${MAGIC_PATH}`);
  url.searchParams.set("token", token);
  url.searchParams.set("email", email);
  return url.toString();
}

/**
 * §3.3 steps 6 and 7. Spend the token, provision if this is a first sight, hand the browser back.
 *
 * THE PAGES ARE THE SAME THREE `http/signIn.ts` SERVES, and they are imported rather than copied for
 * the reason every shared refusal in this codebase is shared: two pages that say "this link expired"
 * are two pages that eventually say it differently, and a person who sees one after a Google flow
 * and the other after an email flow learns that one of them is a different product.
 */
function consumeHandler(deps: MagicLinkDeps): Handler {
  const log = deps.log ?? console.log;
  return async (req) => {
    const token = req.url.searchParams.get("token") ?? "";
    const email = req.url.searchParams.get("email") ?? "";

    if (!looksLikeSecret(token) || !isEmailAddress(email)) {
      await deps.audit("auth.magic_link_invalid", {
        requestId: req.requestId,
        ip: req.ip,
        metadata: { reason: "malformed" },
      });
      return htmlPage(EXPIRED_PAGE, 400);
    }

    // ATOMIC, AND THE EMAIL IS INSIDE THE SAME STATEMENT. §10: Gmail's proxy prefetches, Outlook
    // previews, and then a person clicks — three attempts in a second, and exactly one may win.
    const claimed = await deps.store.consumeMagicLink(token, normaliseEmail(email));
    if (!claimed) {
      // Expired, already spent, forged, or bound to a different address. ONE PAGE for all four, for
      // §4.5's reason: a used-link message distinguishable from an invalid-link message is a
      // fingerprinting signal.
      await deps.audit("auth.magic_link_invalid", {
        requestId: req.requestId,
        ip: req.ip,
        metadata: { reason: "not_claimable" },
      });
      return htmlPage(EXPIRED_PAGE, 400);
    }

    // NOW the account is created, if there was not one. See `resolveUser` on why not earlier.
    const { userId } = await deps.resolveUser(claimed.email, { requestId: req.requestId, ip: req.ip });
    const ticket = await deps.store.issueSessionTicket({
      userId,
      provider: "magic_link",
      // NO NONCE, DELIBERATELY. §10: "User clicks magic link on a different device than they
      // started on → Works. This is a feature, not a bug." There is no app instance on that device
      // to bind to, and binding would break the one cross-device path the specification asks for.
    });
    await deps.audit("auth.magic_link_consumed", {
      requestId: req.requestId,
      ip: req.ip,
      userId,
      metadata: {},
    });
    log(`[auth] a sign-in link was used by ${userId} (${req.requestId})`);
    return htmlPage(successPage(completeDeepLink(ticket.ticket)));
  };
}

/**
 * §8.4, coming back from the provider.
 *
 * THE SECRET IS A PATH SEGMENT rather than a header, because the two providers authenticate their
 * webhooks in two entirely different ways — Svix signatures for one, HTTP basic auth plus an IP
 * allowlist for the other — and what BOTH support is a URL you configure them with. See
 * `webhookSecretMatches` on why an unconfigured secret refuses everything rather than admitting it.
 *
 * IT ALWAYS ANSWERS 200 ONCE THE SECRET MATCHES, including for payloads it does not understand.
 * Every provider retries a non-2xx, some for days, and a webhook that 400s on an event type it has
 * no opinion about is one that generates its own traffic forever.
 */
function webhookHandler(deps: MagicLinkDeps): Handler {
  const log = deps.log ?? console.log;
  return async (req) => {
    const presented = req.path.slice(EMAIL_WEBHOOK_PREFIX.length);
    if (!webhookSecretMatches(presented, deps.webhookSecret)) {
      // 404 rather than 401, and it is the one place in this file that hides rather than refuses:
      // a 401 would confirm the path exists, which tells whoever is probing to keep guessing.
      await deps.audit("auth.email_webhook_refused", { requestId: req.requestId, ip: req.ip, metadata: {} });
      return { status: 404, body: { error: { code: "not_found", message: "no such endpoint" } } };
    }

    const outcome = readDeliveryEvent(await req.json());
    if (outcome.kind === "block") {
      await deps.store.block(outcome.email, outcome.reason, outcome.detail);
      await deps.audit("auth.email_blocked", {
        requestId: req.requestId,
        ip: req.ip,
        // The reason, never the address. See the note on the rate-limit row above.
        metadata: { reason: outcome.reason },
      });
      log(`[email] an address was blocked after a ${outcome.reason} (${req.requestId})`);
    } else if (outcome.kind === "transient") {
      // §8.4: "Soft bounces (temporary): allow retry after 5 minutes." Which is to say: do nothing.
      // The address is not blocked and the ordinary rate limit already bounds how often somebody
      // may try again — a second, shorter cooldown would be a rule with no way to observe it.
      log(`[email] a message soft-bounced; the address is not blocked (${req.requestId})`);
    }
    return { status: 204 };
  };
}

// --- the pages ------------------------------------------------------------------------------

function htmlPage(html: string, status = 200): { status: number; headers: Record<string, string>; body: Buffer } {
  return {
    status,
    headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" },
    body: Buffer.from(html, "utf8"),
  };
}

/**
 * The same shell `http/signIn.ts` renders, imported rather than copied.
 *
 * Two files that each draw a "you can close this tab" page are two pages that drift, and the person
 * who sees one after Google and the other after email learns that one of them is a different
 * product. The functions are exported from there because that is where the OAuth callback needed
 * them first; this is the second caller, which is the moment the sharing became worth arranging.
 */
import { authPage } from "./authPages.ts";

const successPage = (deepLink: string): string =>
  authPage({
    title: "Signed in",
    heading: "You're signed in",
    body: "Jaroku should be opening now. You can close this tab.",
    footer: { text: "Nothing happened?", linkText: "Open Jaroku", href: deepLink },
    redirect: deepLink,
  });

/** §3.3's expiry, §10's already-used, and a forged link. One page, for §4.5's reason. */
const EXPIRED_PAGE = authPage({
  title: "This link expired",
  heading: "This link has expired",
  body:
    "Sign-in links are good for fifteen minutes and can only be used once. Head back to Jaroku and " +
    "ask for a new one — it takes a couple of seconds.",
});

export { SIGN_IN_SUBJECT };
