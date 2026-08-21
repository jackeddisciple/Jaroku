// `POST /v1/auth/magic-link` and `GET /magic`, driven as routes rather than as functions.
//
// THROUGH A REAL `Router`, WITH A REAL STORE ON A REAL SQLITE, and the reason is that the two
// properties this feature is judged on are both properties of the ROUTE rather than of anything
// under it:
//
//   §12's criterion 10: "POST /v1/auth/magic-link returns 200 regardless of whether the email
//   exists — verified by comparing responses for a known and unknown email." A comparison of two
//   responses is not something a unit test of a handler function can make; it needs both to have
//   actually been produced, headers and all.
//
//   §12's criterion 13: "Consumed token cannot be re-used — atomic consumption verified with a
//   concurrent double-click test." Which needs two requests in flight at once against one database.
//
// AND THE MAIL IS CAPTURED RATHER THAN SENT. The transport is a recorder, so the LINK the email
// actually contains is what gets clicked in the second half of every case below — which is the only
// way to catch the class of bug where the URL is built one way and parsed another.
//
//   npm run test:magic-link

import { openTestSqlite } from "../db/testDb.ts";
import { DbSignInStore } from "../db/repositories/signIn.ts";
import { MAGIC_LINK_LIMITS } from "../auth/signIn.ts";
import { Router } from "./router.ts";
import { magicLinkRoutes, MAGIC_LINK_PATH, MAGIC_PATH, EMAIL_WEBHOOK_PREFIX } from "./magicLink.ts";
import type { EmailMessage, EmailTransport } from "../email/transport.ts";
import { EmailError } from "../email/transport.ts";
import { createServer, type Server } from "node:http";
import { randomUUID } from "node:crypto";

let failures = 0;
const check = (ok: boolean, msg: string): void => {
  if (ok) console.log(`  ok   ${msg}`);
  else {
    failures++;
    console.log(`  FAIL ${msg}`);
  }
};

const db = await openTestSqlite();
const store = new DbSignInStore(db);

/** Every message the routes tried to send, and whether the next attempt should fail. */
const sent: EmailMessage[] = [];
let sendFails: EmailError | null = null;
const transport: EmailTransport = {
  provider: "resend",
  async send(message) {
    if (sendFails) throw sendFails;
    sent.push(message);
  },
};

const audited: { action: string; metadata: Record<string, unknown> }[] = [];
/** Which addresses were provisioned, so the "created at consumption, never at request" rule is visible. */
const provisioned = new Set<string>();

const ORIGIN = "https://auth.jaroku.dev";
const WEBHOOK_SECRET = "webhook-secret-value";

const router = new Router({ log: () => {} });
for (const route of magicLinkRoutes({
  store,
  transport,
  authOrigin: ORIGIN,
  resolveUser: async (email) => {
    provisioned.add(email);
    return { userId: `user-for-${email}` };
  },
  audit: async (action, detail) => {
    audited.push({ action, metadata: detail.metadata ?? {} });
  },
  webhookSecret: WEBHOOK_SECRET,
  log: () => {},
})) {
  if (route.prefix) router.prefixRoute(route.method, route.path, route.handler);
  else if (route.method === "GET") router.get(route.path, route.handler);
  else router.post(route.path, route.handler);
}

// A real HTTP server, so a request is a request: headers, a status line, a body read off a socket.
const server: Server = createServer((req, res) => {
  void router.handle(req, res).then((handled) => {
    if (!handled) res.writeHead(404).end();
  });
});
await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
const port = (server.address() as { port: number }).port;
const base = `http://127.0.0.1:${port}`;

interface Answer {
  status: number;
  body: string;
  headers: Record<string, string>;
}

async function request(path: string, init: RequestInit = {}): Promise<Answer> {
  const res = await fetch(`${base}${path}`, init);
  const headers: Record<string, string> = {};
  res.headers.forEach((v, k) => {
    headers[k] = v;
  });
  return { status: res.status, body: await res.text(), headers };
}

const ask = (email: string): Promise<Answer> =>
  request(MAGIC_LINK_PATH, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email }),
  });

/**
 * Forget how many attempts have come from this machine.
 *
 * EVERY REQUEST IN THIS SUITE ARRIVES FROM 127.0.0.1, so they all share one per-IP bucket — and
 * §3.3 caps that at ten an hour. That is the limit working exactly as specified: without this the
 * suite exhausts its own quota partway through and every assertion after it fails for the right
 * reason and the wrong one. It is cleared between sections rather than raised, so the number under
 * test stays the number that ships, and the per-IP limit gets a section of its own below where it
 * is the thing being asserted rather than an obstacle.
 *
 * Only the `ip:` keys go. The per-address counters are what several sections are about.
 */
async function forgetThisMachine(): Promise<void> {
  await db.run(`DELETE FROM magic_link_rate_limits WHERE key LIKE 'ip:%'`, []);
}

/** The link out of the most recent captured message, which is what a person would actually click. */
function lastLink(): string {
  const message = sent[sent.length - 1];
  const found = /https?:\/\/\S+/.exec(message?.text ?? "");
  if (!found) throw new Error("no link in the last message");
  return found[0];
}

/** The path-and-query of that link, for driving it against this server rather than the real origin. */
const asLocalPath = (link: string): string => {
  const url = new URL(link);
  return `${url.pathname}${url.search}`;
};

// --- asking for a link ----------------------------------------------------------------------------

await forgetThisMachine();
console.log("\nasking for a sign-in link");
{
  sent.length = 0;
  const answer = await ask("Ada@Example.com");
  check(answer.status === 200, "an ordinary request is accepted");
  check(JSON.parse(answer.body).sent === true, "...and says a link was sent");
  check(JSON.parse(answer.body).expiresInMinutes === 15, "...and how long it lasts, so the screen and the token agree");
  check(sent.length === 1, "one message was actually handed to the transport");
  check(sent[0]!.to === "ada@example.com", "...to the address, lowercased for delivery");
  check(sent[0]!.text.includes(`${ORIGIN}/magic?token=`), "...carrying a link at the configured origin");
  check(sent[0]!.text.includes("email=ada%40example.com"), "...with the address alongside the token, for §10's binding");

  // PROVISIONED AT CONSUMPTION, NEVER AT REQUEST. A link is sent to any address anybody types, so
  // creating the account here would create one for every address somebody probing had typed.
  check(!provisioned.has("ada@example.com"), "NO ACCOUNT was created by merely asking for a link");
  check(audited.some((a) => a.action === "auth.magic_link_sent"), "the send is audited (§7 rule 5)");
  check(
    !JSON.stringify(audited).includes(lastLink()),
    "...and neither the link nor the raw token is anywhere in the audit metadata (§7 rule 4)",
  );
}
{
  // §12's CRITERION 10, and it is asserted the way the criterion asks: by comparing two responses.
  // A route that answered differently for a known address would be a way for anybody to test
  // whether a given person has an account — one request per address, no credential.
  sent.length = 0;
  const known = await ask("ada@example.com");
  const unknown = await ask(`nobody-${randomUUID()}@example.com`);
  check(known.status === unknown.status, "a known and an unknown address get the same status");
  check(known.body === unknown.body, "...and byte-for-byte the same body");
  check(
    (known.headers["content-type"] ?? "") === (unknown.headers["content-type"] ?? ""),
    "...and the same content type, so nothing distinguishes them at all",
  );
}
{
  // A malformed address is a 400 and reveals nothing: it is a fact about the string in the box,
  // which the person can already see.
  const bad = await ask("not-an-address");
  check(bad.status === 400, "a malformed address is refused");
  check(!JSON.parse(bad.body).error.message.includes("exist"), "...without saying anything about accounts");

  const empty = await request(MAGIC_LINK_PATH, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({}),
  });
  check(empty.status === 400, "so is no address at all");
}
{
  // §10: "Email provider is down when magic link is requested → Return an actionable error to the
  // user. Do not silently fail." The one place this route does not answer 200, and it is not an
  // enumeration leak: it is a fact about OUR provider, identical for every address.
  sendFails = new EmailError("the email provider answered 500", true);
  const down = await ask("ada@example.com");
  sendFails = null;
  check(down.status === 502, "a provider that is down is reported rather than swallowed");
  const message = JSON.parse(down.body).error.message as string;
  check(message.includes("try again"), "...with something a person can do");
  check(message.includes("Google"), "...including the other path, which is still working");
}

await forgetThisMachine();
console.log("\nthe two rate limits, both of which apply");
{
  // §12's criterion 11: "Rate limit blocks a 4th request from the same email in an hour."
  sent.length = 0;
  const email = `limits-${randomUUID()}@example.com`;
  const answers: number[] = [];
  for (let i = 0; i < 4; i++) answers.push((await ask(email)).status);
  check(answers.slice(0, 3).every((s) => s === 200), "three requests for one address are accepted");
  check(answers[3] === 429, "...and the fourth is refused");
  check(sent.length === 3, "...having sent exactly three messages");

  const refused = await ask(email);
  check(refused.status === 429, "...and it stays refused");
  check(Number(refused.headers["retry-after"] ?? 0) > 0, "the refusal says how long to wait, rather than making them guess");
  check(
    audited.some((a) => a.action === "auth.rate_limited"),
    "a rate limit is audited — §7 calls it one of the two highest-signal rows",
  );
  check(
    !JSON.stringify(audited.filter((a) => a.action === "auth.rate_limited")).includes(email),
    "...without the address in it, so the log is not a list of addresses somebody probed",
  );
}

await forgetThisMachine();
console.log("\nclicking the link");
{
  sent.length = 0;
  const email = `clicker-${randomUUID()}@example.com`;
  await ask(email);
  const link = lastLink();

  const first = await request(asLocalPath(link));
  check(first.status === 200, "clicking a fresh link works");
  check(first.body.includes("jaroku://auth/complete?ticket="), "...and the page hands the ticket to the app");
  check(first.headers["cache-control"] === "no-store", "...and is never cached, because it carries a credential");
  check(first.headers["content-type"]?.startsWith("text/html") === true, "...as a page, because a person is looking at it");
  // NOW the account exists. See `resolveUser`.
  check(provisioned.has(email), "the account is created at consumption, which is when somebody proved they read the mailbox");
  check(audited.some((a) => a.action === "auth.magic_link_consumed"), "...and the consumption is audited");

  const second = await request(asLocalPath(link));
  check(second.status === 400, "SINGLE USE — clicking the same link again is refused");
  check(second.body.includes("expired"), "...with the same words an expired link gets, for §4.5's reason");
  check(!second.body.includes("already"), "...which never says 'already used', because that is a fingerprint");
}
{
  // §12's CRITERION 13, asserted the way the criterion asks: concurrently. §10 lists the three
  // clicks that produce it — Gmail's proxy prefetching, Outlook previewing, and then the person.
  sent.length = 0;
  await ask(`race-${randomUUID()}@example.com`);
  const path = asLocalPath(lastLink());
  const answers = await Promise.all([request(path), request(path), request(path)]);
  const ok = answers.filter((a) => a.status === 200);
  check(ok.length === 1, "three simultaneous clicks: EXACTLY ONE succeeds");
  check(answers.filter((a) => a.status === 400).length === 2, "...and the other two are refused rather than erroring");
}
{
  // §10's last property: "a token for alice@example.com cannot sign someone in as bob@example.com
  // even if leaked". Editing the address in the URL is the whole of the attack.
  sent.length = 0;
  const email = `bound-${randomUUID()}@example.com`;
  await ask(email);
  const tampered = asLocalPath(lastLink()).replace(encodeURIComponent(email), encodeURIComponent("attacker@example.com"));
  const answer = await request(tampered);
  check(answer.status === 400, "a link whose address was edited is refused");
  check(!provisioned.has("attacker@example.com"), "...and no account was created for the address somebody swapped in");
  // AND THE REFUSAL DID NOT SPEND THE TOKEN, so the real owner can still use their link.
  check((await request(asLocalPath(lastLink()))).status === 200, "...while the real owner's link still works");
}
{
  const invented = await request(`${MAGIC_PATH}?token=${"a".repeat(43)}&email=ada%40example.com`);
  check(invented.status === 400, "an invented token is refused");
  const malformed = await request(`${MAGIC_PATH}?token=x&email=nope`);
  check(malformed.status === 400, "...and so is a malformed one, before it reaches a query");
  const bare = await request(MAGIC_PATH);
  check(bare.status === 400, "...and a link with nothing on it at all");
}

await forgetThisMachine();
console.log("\nthe per-IP limit, which is the other half of §7's rule 3");
{
  // "Rate-limit POST /v1/auth/magic-link at the IP and email level; both must apply." The two
  // protect DIFFERENT people — the address limit protects whoever's inbox would be filled, the IP
  // limit protects everybody from one machine enumerating — so this is asserted separately rather
  // than assumed to follow from the other one.
  //
  // EVERY REQUEST USES A DIFFERENT ADDRESS, which is exactly the attack the IP limit exists for:
  // somebody cycling through addresses to see which ones have accounts. Each one is under its own
  // per-address limit and all of them share this machine's bucket.
  sent.length = 0;
  const statuses: number[] = [];
  for (let i = 0; i < MAGIC_LINK_LIMITS.perIp + 1; i++) {
    statuses.push((await ask(`enumerate-${i}-${randomUUID()}@example.com`)).status);
  }
  check(
    statuses.slice(0, MAGIC_LINK_LIMITS.perIp).every((s) => s === 200),
    `${MAGIC_LINK_LIMITS.perIp} requests for ${MAGIC_LINK_LIMITS.perIp} different addresses are accepted`,
  );
  // §12's criterion 11's second half: "and an 11th from the same IP in an hour".
  check(statuses[MAGIC_LINK_LIMITS.perIp] === 429, `...and the ${MAGIC_LINK_LIMITS.perIp + 1}th from the same machine is refused`);
  check(sent.length === MAGIC_LINK_LIMITS.perIp, "...having sent one message per accepted request and no more");
  check(
    audited.some((a) => a.action === "auth.rate_limited" && a.metadata.scope === "ip"),
    "...and the row says which of the two limits it was",
  );
}

await forgetThisMachine();
console.log("\nwhen a message does not arrive");
{
  const bounced = `bounced-${randomUUID()}@example.com`;
  const post = (path: string, body: unknown): Promise<Answer> =>
    request(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

  const wrong = await post(`${EMAIL_WEBHOOK_PREFIX}not-the-secret`, { RecordType: "Bounce", Type: "HardBounce", Email: bounced });
  // A 404 rather than a 401, and it is the one place this file hides rather than refuses: a 401
  // would confirm the path exists, which tells whoever is probing to keep guessing.
  check(wrong.status === 404, "a webhook with the wrong secret is refused, and told nothing");

  const right = await post(`${EMAIL_WEBHOOK_PREFIX}${WEBHOOK_SECRET}`, {
    RecordType: "Bounce",
    Type: "HardBounce",
    Email: bounced,
    Description: "550 user unknown",
  });
  check(right.status === 204, "a webhook with the right secret is accepted");
  check(await store.isBlocked(bounced), "...and the address is blocked (§8.4)");

  // §8.4 blocks future links to that address, AND THE CALLER IS NOT TOLD. Telling them would answer
  // "does this address exist and has it bounced", which is two facts about somebody else.
  sent.length = 0;
  const after = await ask(bounced);
  check(after.status === 200, "asking for a link to a blocked address still answers 200");
  check(sent.length === 0, "...and sends nothing");
  check(audited.some((a) => a.action === "auth.magic_link_suppressed"), "...leaving a row that says why");

  // An event type this server has no opinion about is a 204 rather than a 400: every provider
  // retries a non-2xx, some for days.
  const noise = await post(`${EMAIL_WEBHOOK_PREFIX}${WEBHOOK_SECRET}`, { RecordType: "Open", Email: "x@y.co" });
  check(noise.status === 204, "an event this server has no opinion about is accepted and ignored");
  const soft = `soft-${randomUUID()}@example.com`;
  await post(`${EMAIL_WEBHOOK_PREFIX}${WEBHOOK_SECRET}`, { RecordType: "Bounce", Type: "SoftBounce", Email: soft });
  check(!(await store.isBlocked(soft)), "a soft bounce does not block — the mailbox is full, not absent");
}

console.log(`\nthe limits this suite exercised: ${MAGIC_LINK_LIMITS.perEmail} per address, ${MAGIC_LINK_LIMITS.perIp} per IP`);

server.close();
await db.close();
console.log(failures === 0 ? "\nALL CORRECT" : `\n${failures} FAILURES`);
process.exit(failures === 0 ? 0 : 1);
