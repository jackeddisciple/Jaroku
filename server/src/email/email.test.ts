// Sending a sign-in email, and reading what comes back when one does not arrive.
//
// NOTHING HERE TOUCHES A NETWORK. Both providers are driven through an injected `fetch`, so the
// request each one actually builds is asserted against — which is the half that cannot be checked
// any other way: a header spelled `X-Postmark-Server-Token` in the docs and `X-Postmark-Token` in
// the code compiles, typechecks, and fails with a 401 the first time anybody tries to sign in.
//
// AND THE WEBHOOK HALF IS MOSTLY ABOUT REFUSING TO BLOCK. §8.4 blocks an address after a hard
// bounce or a complaint, and blocking is irreversible from the person's point of view — they simply
// cannot sign in any more, with no way to tell us. So the default for anything unrecognised is to
// do nothing, and the assertions that matter are the ones proving a soft bounce, an undetermined
// bounce, a delivery receipt and a malformed payload all leave the address alone.
//
//   npm run test:email

import {
  emailConfigFrom,
  emailTransport,
  readDeliveryEvent,
  webhookSecretMatches,
  EmailError,
  type EmailConfig,
} from "./transport.ts";
import { SIGN_IN_SUBJECT, signInEmail } from "./signInEmail.ts";

let failures = 0;
const check = (ok: boolean, msg: string): void => {
  if (ok) console.log(`  ok   ${msg}`);
  else {
    failures++;
    console.log(`  FAIL ${msg}`);
  }
};

// --- configuration ------------------------------------------------------------------------------

console.log("\nwhich provider this server sends through, if any");
{
  const resend = emailConfigFrom({
    JAROKU_EMAIL_PROVIDER: "resend",
    JAROKU_EMAIL_API_KEY: "re_abc",
    JAROKU_EMAIL_FROM: "Jaroku <sign-in@auth.jaroku.dev>",
  });
  check(resend?.provider === "resend", "a configured Resend is selected");
  check(resend?.apiKey === "re_abc", "...with its key");

  const postmark = emailConfigFrom({
    JAROKU_EMAIL_PROVIDER: "Postmark",
    JAROKU_EMAIL_API_KEY: "pm_abc",
    JAROKU_EMAIL_FROM: "Jaroku <sign-in@auth.jaroku.dev>",
  });
  check(postmark?.provider === "postmark", "...and the name is read case-insensitively");
}
{
  // HALF-CONFIGURED IS NOT CONFIGURED. The caller's response to null is to not offer the path at
  // all, which is right: §8's whole argument is that a link which does not arrive is unusable, and
  // a provider with no key delivers nothing while looking configured.
  const base = { JAROKU_EMAIL_PROVIDER: "resend", JAROKU_EMAIL_API_KEY: "k", JAROKU_EMAIL_FROM: "a@b.co" };
  check(emailConfigFrom({ ...base, JAROKU_EMAIL_API_KEY: "" }) === null, "a provider with no key configures nothing");
  check(emailConfigFrom({ ...base, JAROKU_EMAIL_FROM: "" }) === null, "...and one with no from address");
  // §8.1 names SendGrid Free and a generic SMTP relay as things NOT to use, for the same reason:
  // shared sending IPs whose reputation is somebody else's behaviour. Naming one here configures
  // nothing rather than falling through to a default.
  check(emailConfigFrom({ ...base, JAROKU_EMAIL_PROVIDER: "sendgrid" }) === null, "a provider this server does not speak configures nothing");
  check(emailConfigFrom({ ...base, JAROKU_EMAIL_PROVIDER: "smtp" }) === null, "...and neither does a bare SMTP relay");
}
{
  // THE DEVELOPMENT PATH. `npm run dev` needs no mail account, no domain and no API key — hard
  // rule 5 — so an unconfigured non-production server gets the log transport.
  const dev = emailConfigFrom({});
  check(dev?.provider === "log", "an unconfigured development server writes links to its log");

  // AND IT REFUSES IN PRODUCTION, both ways round. A server that quietly logged sign-in links
  // instead of sending them would be a server where every account is openable by whoever reads
  // the log.
  check(emailConfigFrom({ NODE_ENV: "production" }) === null, "an unconfigured production server sends nothing at all");
  check(
    emailConfigFrom({ NODE_ENV: "production", JAROKU_EMAIL_PROVIDER: "log" }) === null,
    "...and cannot be asked for the log transport on purpose either",
  );
}

// --- the message ---------------------------------------------------------------------------------

console.log("\nwhat the email says, and what §8.3 says it must not");
{
  const link = "https://auth.jaroku.dev/magic?token=abc123&email=ada%40example.com";
  const mail = signInEmail(link, 15);

  check(mail.subject === SIGN_IN_SUBJECT, "the subject is §8.3's, verbatim");
  check(mail.subject === "Sign in to Jaroku", "...which is four words and says what it is");
  // §8.3: "always send both". A multipart message whose text half says "your client does not
  // support HTML" reads as broken on a terminal client and as suspicious to a filter.
  check(mail.text.includes(link), "the plain-text half carries the link");
  check(mail.html.includes("abc123"), "...and so does the HTML half");
  check(mail.text.includes("15 minutes"), "both say how long it lasts");
  check(mail.html.includes("15 minutes"), "...in the same number, passed in rather than hardcoded twice");
  check(mail.text.includes("safely ignore"), "and both say what to do if you did not ask for it");

  // THE OMISSIONS ARE THE SPECIFICATION. Every one of these is a thing somebody would add while
  // being helpful, and every one of them moves a transactional message towards the Promotions tab.
  check(!/unsubscribe/i.test(mail.text + mail.html), "NO unsubscribe link — this is transactional (§8.3)");
  check(!/<img/i.test(mail.html), "no image, so no tracking pixel and no remote request from an inbox");
  check(!/https?:\/\/(?!auth\.jaroku\.dev)/.test(mail.html.replace(/https?:\/\/www\.w3\.org[^"']*/g, "")), "no link to anywhere but the sign-in URL");
  check(!/fonts\.googleapis|cdn\./i.test(mail.html), "no webfont and no CDN, which mail clients strip anyway");
  check(!/<script/i.test(mail.html), "no script, which every client strips and every filter counts against");
}
{
  // THE URL IS OURS AND IT IS ESCAPED ANYWAY. `magicUrl` builds it with `URLSearchParams`, which
  // percent-encodes the address — so the raw string below is not one this system produces today.
  // It is passed in RAW on purpose: "no dangerous character reaches this template" is a property of
  // today's caller rather than of the template, and the day somebody builds the link by
  // concatenation instead is a day nobody will remember to check.
  const raw = 'https://auth.jaroku.dev/magic?token=t&email=a"><script>alert(1)</script>';
  const mail = signInEmail(raw, 15);
  check(!mail.html.includes('"><script'), "a quote in the URL cannot break out of the href attribute");
  check(mail.html.includes("&quot;") && mail.html.includes("&lt;script"), "...both the quote and the tag are escaped");
  // And the ampersand that legitimately separates the parameters is escaped as an entity too,
  // which is what makes the href a valid attribute rather than merely a safe one.
  check(mail.html.includes("&amp;email="), "the parameter separator is a proper entity in the markup");
}

// --- the two providers ---------------------------------------------------------------------------

/** Captures one request and answers with whatever the test wants. */
function recorder(status = 200, body = "{}") {
  const seen: { url: string; init: RequestInit }[] = [];
  const impl = (async (url: unknown, init: unknown) => {
    seen.push({ url: String(url), init: (init ?? {}) as RequestInit });
    return new Response(body, { status });
  }) as unknown as typeof fetch;
  return { seen, impl };
}

console.log("\nthe request each provider actually gets");
{
  const config: EmailConfig = { provider: "resend", apiKey: "re_key", from: "Jaroku <sign-in@auth.jaroku.dev>" };
  const { seen, impl } = recorder();
  await emailTransport(config, impl).send({ to: "ada@example.com", subject: "s", text: "t", html: "<p>h</p>" });

  check(seen.length === 1, "one request per message");
  check(seen[0]!.url === "https://api.resend.com/emails", "...to Resend's own endpoint");
  const headers = seen[0]!.init.headers as Record<string, string>;
  // A header spelled one way in the docs and another in the code compiles, typechecks, and 401s the
  // first time anybody tries to sign in.
  check(headers.authorization === "Bearer re_key", "...authenticated with the key as a bearer token");
  const body = JSON.parse(String(seen[0]!.init.body)) as Record<string, unknown>;
  check(Array.isArray(body.to) && body.to[0] === "ada@example.com", "...to the address, as the array Resend expects");
  check(body.from === config.from, "...from the configured sender");
  check(typeof body.text === "string" && typeof body.html === "string", "...carrying both halves");
}
{
  const config: EmailConfig = { provider: "postmark", apiKey: "pm_key", from: "Jaroku <sign-in@auth.jaroku.dev>" };
  const { seen, impl } = recorder();
  await emailTransport(config, impl).send({ to: "ada@example.com", subject: "s", text: "t", html: "<p>h</p>" });

  check(seen[0]!.url === "https://api.postmarkapp.com/email", "Postmark gets its own endpoint");
  const headers = seen[0]!.init.headers as Record<string, string>;
  check(headers["X-Postmark-Server-Token"] === "pm_key", "...authenticated with the header it actually reads");
  const body = JSON.parse(String(seen[0]!.init.body)) as Record<string, unknown>;
  check(body.To === "ada@example.com" && body.From === config.from, "...with Postmark's own capitalised field names");
  // Saying so means a server later configured with a broadcast stream cannot accidentally send
  // sign-in mail down it, behind a different reputation and a different set of filters.
  check(body.MessageStream === "outbound", "...on the transactional stream, named rather than defaulted");
}
{
  // §10: "Email provider is down when magic link is requested → Return an actionable error to the
  // user. Do not silently fail." A thrown error is the shape that cannot be ignored.
  const config: EmailConfig = { provider: "resend", apiKey: "k", from: "a@b.co" };
  const fail = recorder(500, '{"message":"upstream"}');
  let caught: unknown = null;
  try {
    await emailTransport(config, fail.impl).send({ to: "a@b.co", subject: "s", text: "t", html: "h" });
  } catch (err) {
    caught = err;
  }
  check(caught instanceof EmailError, "a provider that errors throws rather than resolving");
  check((caught as EmailError).retryable, "...and a 5xx is worth trying again in a minute");

  const refused = recorder(422, '{"message":"domain not verified"}');
  try {
    await emailTransport(config, refused.impl).send({ to: "a@b.co", subject: "s", text: "t", html: "h" });
  } catch (err) {
    caught = err;
  }
  // A 4xx is a configuration this server got wrong and will get wrong again. Telling somebody to
  // try again in a minute would be telling them to wait for something that cannot change.
  check(!(caught as EmailError).retryable, "...while a 4xx is a configuration problem, not a blip");
}
{
  const lines: string[] = [];
  const transport = emailTransport({ provider: "log", from: "a@b.co" }, fetch, (m) => lines.push(m));
  await transport.send({
    to: "ada@example.com",
    subject: "s",
    text: "open https://auth.jaroku.dev/magic?token=xyz to sign in",
    html: "<p>h</p>",
  });
  check(lines.join("\n").includes("https://auth.jaroku.dev/magic?token=xyz"), "the log transport prints the link, which is the point of it");
  check(lines.join("\n").includes("NOT SENT"), "...and says out loud that nothing was sent");
}

// --- what comes back when a message does not arrive ----------------------------------------------

console.log("\nreading a delivery webhook, and mostly refusing to act on one");
{
  // POSTMARK. Its own classification: HardBounce and BadEmailAddress mean the mailbox does not
  // exist; SoftBounce and Transient mean it did not accept the message this time.
  const hard = readDeliveryEvent({ RecordType: "Bounce", Type: "HardBounce", Email: "Gone@Example.com", Description: "550 user unknown" });
  check(hard.kind === "block" && hard.reason === "bounce", "a hard bounce blocks the address");
  check(hard.kind === "block" && hard.email === "gone@example.com", "...lowercased, like every other comparison");
  check(hard.kind === "block" && hard.detail === "550 user unknown", "...keeping the provider's own reason for the log");

  const complaint = readDeliveryEvent({ RecordType: "SpamComplaint", Email: "cross@example.com" });
  check(complaint.kind === "block" && complaint.reason === "complaint", "a spam complaint blocks it too (§8.4)");

  const soft = readDeliveryEvent({ RecordType: "Bounce", Type: "SoftBounce", Email: "full@example.com" });
  check(soft.kind === "transient", "a soft bounce does NOT block — the mailbox is full, not absent");
}
{
  // RESEND. A different envelope for the same three decisions.
  const bounced = readDeliveryEvent({
    type: "email.bounced",
    data: { to: ["gone@example.com"], bounce: { type: "Permanent", subType: "NoEmail" } },
  });
  check(bounced.kind === "block" && bounced.email === "gone@example.com", "a permanent bounce blocks the address");

  const complained = readDeliveryEvent({ type: "email.complained", data: { to: ["cross@example.com"] } });
  check(complained.kind === "block" && complained.reason === "complaint", "a complaint blocks it");

  const transient = readDeliveryEvent({ type: "email.bounced", data: { to: ["x@y.co"], bounce: { type: "Transient" } } });
  check(transient.kind === "transient", "a transient bounce does not");

  // THE ONE THAT MATTERS MOST. "We are not sure" is not a reason to end somebody's access: an
  // unblocked address that should have been blocked costs reputation slowly, and a blocked address
  // that should not have been costs somebody their account immediately.
  const unsure = readDeliveryEvent({ type: "email.bounced", data: { to: ["x@y.co"], bounce: { type: "Undetermined" } } });
  check(unsure.kind === "transient", "an UNDETERMINED bounce does not block — being unsure is not a reason");
}
{
  // Everything unrecognised is ignored, in both directions.
  check(readDeliveryEvent({ type: "email.delivered", data: { to: ["a@b.co"] } }).kind === "ignore", "a delivery receipt is not a bounce");
  check(readDeliveryEvent({ RecordType: "Open", Email: "a@b.co" }).kind === "ignore", "neither is an open");
  check(readDeliveryEvent({ type: "email.bounced", data: {} }).kind === "ignore", "a bounce naming no address is ignored");
  check(readDeliveryEvent({}).kind === "ignore", "an empty payload is ignored");
  check(readDeliveryEvent(null).kind === "ignore", "and so is nothing at all");
  check(readDeliveryEvent("email.bounced").kind === "ignore", "...and a string that merely mentions one");
}

console.log("\nwho may tell this server that a message bounced");
{
  check(webhookSecretMatches("s3cret", "s3cret"), "the configured secret is accepted");
  check(!webhookSecretMatches("s3crev", "s3cret"), "a near miss is not");
  check(!webhookSecretMatches("s3cre", "s3cret"), "...nor a prefix of it");
  check(!webhookSecretMatches("", "s3cret"), "...nor an empty one");
  check(!webhookSecretMatches(null, "s3cret"), "...nor nothing at all");
  // AN UNCONFIGURED SECRET REFUSES EVERYTHING rather than admitting it. A webhook nobody configured
  // is a webhook nobody is using, and the other choice is an open endpoint that blocks any address
  // it is told to.
  check(!webhookSecretMatches("anything", undefined), "an unconfigured webhook refuses everything");
  check(!webhookSecretMatches("", undefined), "...including an empty presentation");
}

console.log(failures === 0 ? "\nALL CORRECT" : `\n${failures} FAILURES`);
process.exit(failures === 0 ? 0 : 1);
