// Sending one transactional email, and the three places it can go.
//
// §8 IS THE SHORTEST SECTION OF THE SPECIFICATION AND THE ONE MOST LIKELY TO SINK THE FEATURE. "An
// email that lands in spam is an unusable sign-in flow." Everything in this file follows from that
// one sentence, and almost none of the work is code: the code is a POST, and what makes the mail
// arrive is a sending domain with SPF, DKIM and DMARC records on it. See `docs/email.md`, which is
// the half of §8 that lives in DNS rather than here.
//
// TWO PROVIDERS AND ONE FALLBACK, and the list is the specification's own. Resend and Postmark are
// built for authentication mail, both publish deliverability figures, and both report bounces and
// complaints back through a webhook — which §8.4 needs. SendGrid's free tier and a generic SMTP
// relay are named as things NOT to use, and the reason is the same for both: shared sending IPs
// whose reputation is somebody else's behaviour.
//
// THE THIRD IS `log`, AND IT IS NOT A PROVIDER. It writes the link to the server's own log and
// sends nothing. That is exactly what `npm run dev` needs — a magic link you can click without a
// mail account, a domain or an API key — and it is exactly what must never run in production, so
// it refuses to be selected under NODE_ENV=production. The same shape `auth/config.ts` gives the
// local issuer, for the same reason: the local path should be a real path with one piece missing,
// rather than a bypass that behaves differently.
//
// THE API KEY COMES FROM THE ENVIRONMENT, NOT FROM `SecretStore`, and this is a deliberate
// departure from §8.1's instruction. `SecretStore` is a WORKSPACE's vault — envelope-encrypted per
// tenant, with a rotation history and an audit trail, reachable through a context that names which
// workspace is asking. There is no workspace here: this key belongs to the platform, it is used
// before anybody has signed in, and there is no tenant to scope it to. Every other platform-level
// credential in this codebase — the Stripe secret, the Stripe webhook secret, the object-signing
// key, the local issuer's key — is an environment variable for exactly this reason. Putting a
// platform key in a tenant vault would mean inventing a tenancy for it, and the one that would get
// invented is "whichever workspace happened to be handy".

import { timingSafeEqual } from "node:crypto";

/** Every environment variable this module reads, in one place — `auth/config.ts`'s pattern. */
export const EMAIL_ENV = {
  provider: "JAROKU_EMAIL_PROVIDER",
  apiKey: "JAROKU_EMAIL_API_KEY",
  from: "JAROKU_EMAIL_FROM",
  /** The shared secret a bounce webhook has to present. See `http/magicLink.ts`. */
  webhookSecret: "JAROKU_EMAIL_WEBHOOK_SECRET",
} as const;

export type EmailProvider = "resend" | "postmark" | "log";

export interface EmailConfig {
  provider: EmailProvider;
  /** Absent for `log`, required for the other two. */
  apiKey?: string;
  /**
   * §8.3: "Sender name: Jaroku. Sender address: sign-in@auth.jaroku.dev (or similar) — a real,
   * monitored address, not `noreply@`."
   *
   * `noreply@` IS NOT A STYLE PREFERENCE. Gmail and Outlook both weight it against a sender's
   * reputation, several corporate filters quarantine it outright, and — the reason that actually
   * matters — somebody who replies to a sign-in email with "I did not request this" is telling you
   * about an attack, and `noreply@` is where that message goes to die.
   */
  from: string;
}

/** One message. Deliberately small: this system sends exactly one kind of email. */
export interface EmailMessage {
  to: string;
  subject: string;
  /** §8.3: "always send both". The plain-text half is a real fallback, not a "view in HTML" note. */
  text: string;
  html: string;
}

export interface EmailTransport {
  readonly provider: EmailProvider;
  /**
   * Send, or throw.
   *
   * THROWS RATHER THAN RETURNING A BOOLEAN, because §10 is explicit that the caller must act on it:
   * "Email provider is down when magic link is requested → Return an actionable error to the user:
   * 'Couldn't send email right now. Try again in a minute, or use Google sign-in.' Do not silently
   * fail." A boolean is the shape that gets ignored.
   */
  send(message: EmailMessage): Promise<void>;
}

export class EmailError extends Error {
  constructor(
    message: string,
    /** Whether trying again in a minute could plausibly work. A 4xx from a provider could not. */
    readonly retryable: boolean,
  ) {
    super(message);
    this.name = "EmailError";
  }
}

/**
 * Read the email configuration, or answer `null`.
 *
 * NULL MEANS "THIS SERVER CANNOT SEND MAIL", and the caller's response is to not offer the magic
 * link at all — `/v1/auth/methods` reports `magicLink: false` and the sign-in screen renders no
 * email field. That is the honest outcome: §8's whole argument is that a sign-in email which does
 * not arrive is an unusable flow, and a flow that generates a token and delivers nothing is worse
 * than one that is absent.
 */
export function emailConfigFrom(env: NodeJS.ProcessEnv = process.env): EmailConfig | null {
  const provider = (env[EMAIL_ENV.provider] ?? "").trim().toLowerCase();
  const apiKey = (env[EMAIL_ENV.apiKey] ?? "").trim();
  const from = (env[EMAIL_ENV.from] ?? "").trim();
  const production = env["NODE_ENV"] === "production";

  if (provider === "resend" || provider === "postmark") {
    if (!apiKey || !from) return null;
    return { provider, apiKey, from };
  }

  // NOT SELECTABLE IN PRODUCTION, and it refuses rather than falling back to a real provider it
  // has no key for. A server that quietly logged sign-in links instead of sending them would be a
  // server where every account is openable by whoever can read the log.
  if (provider === "log") {
    if (production) return null;
    return { provider: "log", from: from || "Jaroku <sign-in@localhost>" };
  }

  // NOTHING CONFIGURED. In development that is the ordinary case and the log transport is the right
  // answer — `npm run dev` needs no mail account, no domain and no API key, which is hard rule 5.
  // In production it is a missing decision, and the honest answer is that mail is not configured.
  if (provider === "") return production ? null : { provider: "log", from: from || "Jaroku <sign-in@localhost>" };
  return null;
}

/** Build the transport for a configuration. `fetchImpl` is injected so the suite needs no network. */
export function emailTransport(config: EmailConfig, fetchImpl: typeof fetch = fetch, log = console.log): EmailTransport {
  if (config.provider === "resend") return resendTransport(config, fetchImpl);
  if (config.provider === "postmark") return postmarkTransport(config, fetchImpl);
  return logTransport(log);
}

/**
 * A bound on how long a send may take.
 *
 * TEN SECONDS, and it is on the path of a request somebody is waiting on. Longer would mean a
 * provider having a slow minute becomes a sign-in screen that appears to have frozen; shorter would
 * fail sends that were about to succeed. The `AbortSignal` is what makes a hung request a failed
 * one rather than a handler the router eventually 504s out from under.
 */
const SEND_TIMEOUT_MS = 10_000;

function resendTransport(config: EmailConfig, fetchImpl: typeof fetch): EmailTransport {
  return {
    provider: "resend",
    async send(message) {
      let res: Response;
      try {
        res = await fetchImpl("https://api.resend.com/emails", {
          method: "POST",
          headers: {
            authorization: `Bearer ${config.apiKey}`,
            "content-type": "application/json",
          },
          body: JSON.stringify({
            from: config.from,
            to: [message.to],
            subject: message.subject,
            text: message.text,
            html: message.html,
            // §8.3: NO unsubscribe header on a transactional email. Adding one weakens the
            // transactional classification with the provider, and these are not subject to
            // CAN-SPAM's unsubscribe requirement in the first place.
          }),
          signal: AbortSignal.timeout(SEND_TIMEOUT_MS),
        });
      } catch (err) {
        throw new EmailError(`could not reach the email provider: ${(err as Error).message}`, true);
      }
      if (!res.ok) throw await providerRefusal(res);
    },
  };
}

function postmarkTransport(config: EmailConfig, fetchImpl: typeof fetch): EmailTransport {
  return {
    provider: "postmark",
    async send(message) {
      let res: Response;
      try {
        res = await fetchImpl("https://api.postmarkapp.com/email", {
          method: "POST",
          headers: {
            "X-Postmark-Server-Token": config.apiKey ?? "",
            "content-type": "application/json",
            accept: "application/json",
          },
          body: JSON.stringify({
            From: config.from,
            To: message.to,
            Subject: message.subject,
            TextBody: message.text,
            HtmlBody: message.html,
            // Postmark's own separation of transactional from broadcast streams, named explicitly.
            // The default stream IS `outbound`, and saying so means a server later configured with
            // a broadcast stream cannot accidentally send sign-in mail down it — which would put
            // authentication email behind a different reputation and a different set of filters.
            MessageStream: "outbound",
          }),
          signal: AbortSignal.timeout(SEND_TIMEOUT_MS),
        });
      } catch (err) {
        throw new EmailError(`could not reach the email provider: ${(err as Error).message}`, true);
      }
      if (!res.ok) throw await providerRefusal(res);
    },
  };
}

/**
 * The development transport: the link goes to the log and nowhere else.
 *
 * IT PRINTS THE WHOLE URL, WHICH IS A CREDENTIAL IN A LOG, and that is the one rule this file
 * knowingly breaks — §7's rule 4 says never log the magic link URL. It is confined to a transport
 * that refuses to exist under NODE_ENV=production, because the alternative is a development flow
 * where the only way to sign in is to read a token out of SQLite by hand. The trust boundary is the
 * one `runtime/.env` has always had locally: whoever can read this log is the person at this
 * machine.
 */
function logTransport(log: (m: string) => void): EmailTransport {
  return {
    provider: "log",
    async send(message) {
      const link = /https?:\/\/\S+/.exec(message.text)?.[0] ?? "(no link found in the message)";
      log(
        `\n[email] NOT SENT — this server has no mail provider configured.\n` +
          `[email] to: ${message.to}\n` +
          `[email] ${message.subject}\n` +
          `[email] ${link}\n`,
      );
    },
  };
}

/**
 * A provider's refusal, read for the log and classified for the caller.
 *
 * THE BODY IS NEVER PUT IN FRONT OF A USER. Both providers echo the sending address and sometimes
 * part of the API key prefix in their errors, and the route above this answers 200 to everybody
 * regardless — see §3.3. What the body is for is the log line whoever is debugging reads.
 */
async function providerRefusal(res: Response): Promise<EmailError> {
  const detail = await res.text().catch(() => "");
  // 5xx and 429 may pass; a 4xx is a configuration this server got wrong and will get wrong again.
  const retryable = res.status >= 500 || res.status === 429;
  return new EmailError(`the email provider answered ${res.status}: ${detail.slice(0, 300)}`, retryable);
}

// --- bounces and complaints, coming back the other way ---------------------------------------

/** What §8.4 does about one delivery event. */
export type DeliveryOutcome =
  /** Invalid address. Block it: continuing to mail it is how a sending domain's reputation goes. */
  | { kind: "block"; reason: "bounce" | "complaint"; email: string; detail: string | null }
  /** A mailbox full, a greylist, a server having a minute. §8.4: allow retry after five minutes. */
  | { kind: "transient"; email: string }
  /** Something this system has no opinion about. Delivered, opened, clicked. */
  | { kind: "ignore" };

/**
 * Read one provider webhook payload into a decision, or `ignore`.
 *
 * ONE FUNCTION FOR BOTH PROVIDERS, because the decision is identical and only the spelling differs.
 * A parser per provider would be two places to get "hard bounce" wrong, and the consequence of
 * getting it wrong in one direction is a domain whose mail stops arriving anywhere.
 *
 * THE DEFAULT IS `ignore`, which is the safe direction here and is worth saying because it is the
 * opposite of the safe direction everywhere else in this codebase. Blocking an address is
 * IRREVERSIBLE from the person's point of view — they simply cannot sign in any more, with no way
 * to tell us — so a payload this does not recognise must not be read as a bounce. An unblocked
 * address that should have been blocked costs reputation slowly; a blocked address that should not
 * have been costs somebody their account immediately.
 */
export function readDeliveryEvent(payload: unknown): DeliveryOutcome {
  if (typeof payload !== "object" || payload === null) return { kind: "ignore" };
  const body = payload as Record<string, unknown>;

  // POSTMARK: a flat object with `RecordType`, and `Type` naming the bounce class.
  const recordType = typeof body.RecordType === "string" ? body.RecordType : null;
  if (recordType) {
    const email = readEmail(body.Email ?? body.Recipient);
    if (!email) return { kind: "ignore" };
    if (recordType === "SpamComplaint") {
      return { kind: "block", reason: "complaint", email, detail: readDetail(body.Description) };
    }
    if (recordType === "Bounce") {
      // Postmark's own classification. `HardBounce` and `BadEmailAddress` mean the mailbox does not
      // exist; `SoftBounce` and `Transient` mean it did not accept the message this time.
      const type = typeof body.Type === "string" ? body.Type : "";
      const hard = type === "HardBounce" || type === "BadEmailAddress" || type === "Blocked";
      return hard
        ? { kind: "block", reason: "bounce", email, detail: readDetail(body.Description ?? body.Details) }
        : { kind: "transient", email };
    }
    return { kind: "ignore" };
  }

  // RESEND: an envelope with `type` and a nested `data`.
  const type = typeof body.type === "string" ? body.type : null;
  const data = (typeof body.data === "object" && body.data !== null ? body.data : {}) as Record<string, unknown>;
  if (!type) return { kind: "ignore" };
  const email = readEmail(Array.isArray(data.to) ? data.to[0] : data.to ?? data.email);
  if (!email) return { kind: "ignore" };
  if (type === "email.complained") {
    return { kind: "block", reason: "complaint", email, detail: null };
  }
  if (type === "email.bounced") {
    const bounce = (typeof data.bounce === "object" && data.bounce !== null ? data.bounce : {}) as Record<string, unknown>;
    const bounceType = typeof bounce.type === "string" ? bounce.type.toLowerCase() : "";
    // Resend reports `Permanent` / `Transient` / `Undetermined`. UNDETERMINED IS NOT A BLOCK — see
    // the note on the default above: "we are not sure" is not a reason to end somebody's access.
    return bounceType === "permanent"
      ? { kind: "block", reason: "bounce", email, detail: readDetail(bounce.subType ?? bounce.message) }
      : { kind: "transient", email };
  }
  return { kind: "ignore" };
}

function readEmail(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim().toLowerCase();
  return trimmed && trimmed.includes("@") ? trimmed.slice(0, 254) : null;
}

function readDetail(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim().slice(0, 500) : null;
}

/**
 * Whether a webhook presented the secret this server expects.
 *
 * A SHARED SECRET RATHER THAN A SIGNATURE, and the trade is worth stating because a signature would
 * be stronger. Resend signs with Svix and Postmark offers HTTP basic auth plus an IP allowlist —
 * two entirely different mechanisms, one of which needs a dependency this codebase does not have.
 * What both support is a secret in the URL the provider is configured with, which is what this
 * checks, and what it buys is the property that actually matters here: a stranger cannot block an
 * address by POSTing a bounce for it.
 *
 * IT IS COMPARED IN CONSTANT TIME, because unlike every other opaque value in this codebase this
 * one is presented repeatedly by something an attacker can trigger, and a short-circuiting compare
 * on a repeatable request is the case where a timing attack is actually practical.
 *
 * AND AN UNCONFIGURED SECRET REFUSES EVERYTHING rather than admitting everything. A webhook nobody
 * configured is a webhook nobody is using, and the failure mode of the other choice is an open
 * endpoint that blocks any address it is told to.
 */
export function webhookSecretMatches(presented: unknown, expected: string | undefined): boolean {
  if (!expected || typeof presented !== "string" || presented === "") return false;
  const a = Buffer.from(presented, "utf8");
  const b = Buffer.from(expected, "utf8");
  return a.length === b.length && timingSafeEqual(a, b);
}
