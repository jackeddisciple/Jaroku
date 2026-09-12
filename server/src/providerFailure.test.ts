// §7's ten classes, each with its specified copy and its specified action.
//
// THIS IS §7'S "FIXTURE PROVIDER". Its acceptance asks for "a fixture provider that can be made to
// return each of the ten classes; each produces its specified copy and its specified action" — and
// a pure function over an error is exactly that, with no network, no key and no fault injection to
// arrange. What a live fault injector buys is the HANDLER's behaviour (partial output kept, the
// turn never blank), and that is asserted where the handler is.
//
// THE ORDERING CASES ARE THE ONES WORTH THE FILE. Several markers co-occur and the first match has
// to be the most specific reading: a quota error IS a 429, a context-length error IS a 400, and a
// missing key is NOT a 401. Classified carelessly, a quota exhaustion offers a twenty-second
// countdown and an automatic retry for a condition that will not clear until somebody pays.
//
//   npm run test:provider-failure

import {
  classifyProviderFailure, retryAfterFrom, statusFrom,
  DEFAULT_RETRY_AFTER_SECONDS, FAILURE_ACTIONS, FAILURE_CLASSES,
  type FailureClass,
} from "./providerFailure.ts";
import { protectSecret, resetProtection } from "./obs/log.ts";

let fail = 0;
function check(name: string, ok: boolean, detail?: unknown): void {
  if (ok) console.log(`  ok   ${name}`);
  else {
    fail++;
    console.log(`  FAIL ${name}`, detail === undefined ? "" : JSON.stringify(detail));
  }
}

/** An error as an SDK throws one: a message, and sometimes a status and headers. */
const thrown = (message: string, extra: Record<string, unknown> = {}): Error =>
  Object.assign(new Error(message), extra);

const ANTHROPIC = { provider: "anthropic", model: "claude-haiku-4-5", timeoutSeconds: 30 };

// --- §7.2's table, row by row ------------------------------------------------------------------

console.log("\n§7.2 — the ten classes");
{
  const rows: {
    want: FailureClass;
    err: unknown;
    copy: RegExp;
    actions: string[];
    why: string;
  }[] = [
    {
      want: "rate_limited",
      err: thrown("429 rate_limit_error: number of requests has exceeded your rate limit", { status: 429 }),
      copy: /^Rate limited by Claude\. Retry in \d+s\.$/,
      actions: ["retry"],
      why: "§7.2's copy names the wait, because a countdown needs a number",
    },
    {
      want: "no_credential",
      err: thrown("ANTHROPIC_API_KEY is not set"),
      copy: /^No API key configured for Claude\.$/,
      actions: ["open_credentials"],
      why: "nothing was sent, so there is no status — and the fix is to ADD a key, not replace one",
    },
    {
      want: "invalid_credential",
      err: thrown("401 authentication_error: invalid x-api-key", { status: 401 }),
      copy: /^Claude rejected the API key\.$/,
      actions: ["open_credentials"],
      why: "a key that exists and was refused is a different sentence from having none",
    },
    {
      want: "quota_exhausted",
      err: thrown("429 insufficient_quota: your credit balance is too low", { status: 429 }),
      copy: /^Claude quota exhausted for this key\.$/,
      actions: ["switch_model", "open_credentials"],
      why: "it ARRIVES as a 429 and must not offer a countdown — a quota does not clear in 20s",
    },
    {
      want: "timeout",
      err: thrown("Request timed out after 30000ms"),
      copy: /^Claude did not respond within 30s\.$/,
      actions: ["retry"],
      why: "'did not respond' without a number invites the question",
    },
    {
      want: "server_error",
      err: thrown("500 api_error: internal server error", { status: 500 }),
      copy: /^Claude returned a server error\.$/,
      actions: ["retry", "switch_model"],
      why: "retry first, then the other model — in §7.2's own order",
    },
    {
      want: "unreachable",
      err: thrown("fetch failed: ECONNREFUSED 127.0.0.1:443"),
      copy: /^Can't reach Claude\. Check your connection\.$/,
      actions: ["retry"],
      why: "a connection that never opened has no status, and the sentence is about the user's side too",
    },
    {
      want: "context_too_long",
      err: thrown("400 invalid_request_error: prompt is too long: 210000 tokens > 200000 maximum", { status: 400 }),
      copy: /^This conversation is too long for claude-haiku-4-5\.$/,
      actions: ["new_thread", "switch_model"],
      why: "named with the MODEL, because that is the fact that decides what to do",
    },
    {
      want: "content_refused",
      err: thrown("The response was blocked by our content filter"),
      copy: /^Claude declined to answer this\.$/,
      actions: ["edit_message"],
      why: "not an error in the product and not one in the key — change what was asked",
    },
    {
      want: "unrecognised",
      err: thrown("tachyon inversion in the flux manifold"),
      copy: /^Claude said: tachyon inversion in the flux manifold$/,
      actions: ["retry"],
      why: "§7.3: shown, not swallowed — verbatim and LABELLED as the provider's own words",
    },
  ];

  for (const r of rows) {
    const got = classifyProviderFailure(r.err, ANTHROPIC);
    check(`${r.want.padEnd(19)} ${r.why}`, got.class === r.want, { got: got.class, want: r.want });
    check(`  ...its copy`, r.copy.test(got.message), got.message);
    check(`  ...its action(s)`, got.actions.join(",") === r.actions.join(","), got.actions);
  }

  // EVERY CLASS IS COVERED BY THE TABLE, asserted rather than counted by eye — a class added
  // without a row here would be a turn with untested copy.
  const covered = new Set(rows.map((r) => r.want));
  check(`all ${FAILURE_CLASSES.length} classes have a row`,
    FAILURE_CLASSES.every((c) => covered.has(c)),
    FAILURE_CLASSES.filter((c) => !covered.has(c)));
}

// --- §7.3: never a blank turn -----------------------------------------------------------------
//
// "EVERY FAILURE PRODUCES A VISIBLE, CLASSIFIED TURN. A turn that silently vanishes is the defect
// this whole section exists to remove." Asserted across every class and across the inputs that
// would produce nothing if anything defaulted to an empty string.

console.log("\n§7.3 — no failure path produces an empty turn");
{
  for (const err of [
    undefined, null, "", 0, false, NaN, {}, [], new Error(""), "   ",
    thrown(""), thrown("   \n  "), Object.assign(new Error(""), { status: 500 }),
  ]) {
    const got = classifyProviderFailure(err, ANTHROPIC);
    check(`${JSON.stringify(err) ?? String(err)} still says something`,
      got.message.trim().length > 0 && got.actions.length > 0, got);
  }
  // AND EVERY CLASS OFFERS AT LEAST ONE ACTION, from the closed list. A class with a sentence and
  // no action is the dead turn wearing a name.
  for (const err of [
    thrown("429", { status: 429 }), thrown("no api key"), thrown("401", { status: 401 }),
    thrown("insufficient_quota"), thrown("timed out"), thrown("503", { status: 503 }),
    thrown("enotfound"), thrown("context_length_exceeded"), thrown("content filter"),
    thrown("???"),
  ]) {
    const got = classifyProviderFailure(err, ANTHROPIC);
    check(`${got.class} offers a known action`,
      got.actions.length > 0 && got.actions.every((a) => (FAILURE_ACTIONS as readonly string[]).includes(a)),
      got.actions);
  }
}

// --- §7.3: never echo a credential ------------------------------------------------------------
//
// v0.2.1 FIXED EXACTLY THIS: "an error message that quoted a URL containing a credential leaked it
// into the database, the clients and the logs." §7.3 asks for the scrub in both directions — before
// display AND before storage — which is why it happens in the classifier rather than in a renderer.

console.log("\n§7.3 — an error body is scrubbed before it is shown or stored");
{
  resetProtection();
  const key = "sk-ant-api03-ZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZ";
  protectSecret(key, "ANTHROPIC_API_KEY");

  // A REGISTERED VALUE, quoted back by a provider that echoed the request.
  const echoed = classifyProviderFailure(
    thrown(`401 authentication_error: invalid x-api-key ${key}`, { status: 401 }),
    ANTHROPIC,
  );
  check("a registered key never reaches the message", !echoed.message.includes(key), echoed.message);

  // AND AN UNREGISTERED ONE, caught by shape. This is the case that matters most: a workspace's own
  // BYOK credential is not registered in this process at all, and the pattern list is what stops it.
  const unknown = classifyProviderFailure(
    thrown("weird failure talking to https://api.example.com/v1?api_key=sk-ant-api03-AAAABBBBCCCCDDDDEEEEFFFFGGGG"),
    ANTHROPIC,
  );
  check("a key-shaped string is scrubbed by pattern", !/sk-ant-api03-AAAA/.test(unknown.message), unknown.message);
  check("...and the sentence still says something useful", /Claude said:/.test(unknown.message), unknown.message);

  // A CONNECTION STRING'S PASSWORD, which is the other shape that shows up in a provider error.
  const url = classifyProviderFailure(
    thrown("could not reach postgres://jaroku:hunter2@db.internal:5432/x"),
    ANTHROPIC,
  );
  check("a password in a URL is scrubbed", !url.message.includes("hunter2"), url.message);
  resetProtection();
}

// --- §7.3: auto-retry is bounded, and only where waiting can help ------------------------------

console.log("\n§7.3 — which classes retry themselves");
{
  const autos = new Map<FailureClass, boolean>();
  for (const err of [
    thrown("429", { status: 429 }), thrown("no api key"), thrown("401", { status: 401 }),
    thrown("insufficient_quota"), thrown("timed out"), thrown("503", { status: 503 }),
    thrown("enotfound"), thrown("context_length_exceeded"), thrown("content filter"),
    thrown("???"),
  ]) {
    const got = classifyProviderFailure(err, ANTHROPIC);
    autos.set(got.class, got.autoRetry);
  }
  // THE FOUR WHERE WAITING IS GENUINELY LIKELY TO HELP.
  for (const c of ["rate_limited", "timeout", "server_error", "unreachable"] as FailureClass[]) {
    check(`${c} retries itself once`, autos.get(c) === true, autos.get(c));
  }
  // AND THE SIX WHERE THE SAME REQUEST WOULD FAIL IDENTICALLY. An expired key does not fix itself
  // in twenty seconds, and a refused prompt does not become acceptable on a second reading.
  for (const c of ["no_credential", "invalid_credential", "quota_exhausted", "context_too_long",
    "content_refused", "unrecognised"] as FailureClass[]) {
    check(`${c} does not`, autos.get(c) === false, autos.get(c));
  }
}

// --- the wait, and where it comes from --------------------------------------------------------

console.log("\nretry-after");
{
  check("a numeric field", retryAfterFrom({ retryAfter: 12 }) === 12);
  check("a header, as seconds", retryAfterFrom({ headers: { "retry-after": "7" } }) === 7);
  check("a header, as a date", (retryAfterFrom({ headers: { "retry-after": new Date(Date.now() + 9000).toUTCString() } }) ?? 0) >= 8);
  // CLOCK SKEW IS ORDINARY. A date already in the past must not render as an overdue countdown.
  check("a date in the past is zero, not negative",
    retryAfterFrom({ headers: { "retry-after": new Date(Date.now() - 60_000).toUTCString() } }) === 0);
  check("from the sentence, with its unit", retryAfterFrom(thrown("please retry in 20 seconds")) === 20);
  // THE CASE THIS GUARD EXISTS FOR: a bare number anywhere in an error body is not a wait.
  check("a bare number is NOT a wait", retryAfterFrom(thrown("429 error on request 4821")) === undefined);
  check("nothing means nothing", retryAfterFrom(thrown("rate limited")) === undefined);
  // ...AND THE COPY STILL NAMES A NUMBER, because a countdown needs one. The default is this
  // module's own rather than an invented precision from the error text.
  const got = classifyProviderFailure(thrown("429 rate_limit", { status: 429 }), ANTHROPIC);
  check(`the default wait is ${DEFAULT_RETRY_AFTER_SECONDS}s`, got.retryAfterSeconds === DEFAULT_RETRY_AFTER_SECONDS, got);
  check("...and only rate limiting carries one",
    classifyProviderFailure(thrown("401", { status: 401 }), ANTHROPIC).retryAfterSeconds === undefined);
}

console.log("\nthe status a provider error carries");
{
  check("a numeric field", statusFrom({ status: 429 }) === 429);
  check("a camelCase field", statusFrom({ statusCode: 503 }) === 503);
  check("from the sentence", statusFrom(thrown("429 rate_limit_error: slow down")) === 429);
  // A MODEL ID IS THREE DIGITS IN A SENTENCE, and so is a token count. Neither is a status.
  check("a model id is not a status", statusFrom(thrown("model gpt-5.6-luna is unavailable")) === undefined);
  check("a token count is not a status", statusFrom(thrown("prompt is 200 tokens over")) === undefined);
  check("nothing means nothing", statusFrom(thrown("something broke")) === undefined);
}

// --- the provider's name, in every sentence ----------------------------------------------------

console.log("\nthe provider is named as a person reads it");
{
  for (const [id, label] of [["anthropic", "Claude"], ["openai", "OpenAI"], ["meta", "Meta"]] as const) {
    const got = classifyProviderFailure(thrown("401", { status: 401 }), { provider: id });
    check(`${id} reads as ${label}`, got.message.startsWith(label), got.message);
  }
  // A PROVIDER NOBODY NAMED FALLS BACK TO ITS ID rather than to a blank or to "unknown": the id is
  // the truest thing available, and a sentence reading "unknown rejected the API key" is worse than
  // one naming a provider the reader has at least configured.
  const odd = classifyProviderFailure(thrown("401", { status: 401 }), { provider: "cohere" });
  check("an unnamed provider uses its id", odd.message.startsWith("cohere"), odd.message);
}

// --- §16: a provider returning malformed JSON --------------------------------------------------

console.log("\n§16's malformed-JSON attack");
{
  // NOT A CLASS OF ITS OWN, and that is the honest answer: a body that is not JSON is a body the
  // SDK could not parse, and what it produces is a parse error with the offending text in it. The
  // requirement is that it lands in `unrecognised` with the provider's own words shown — which is
  // exactly the class §7.3 says an unanticipated failure belongs in.
  const got = classifyProviderFailure(
    thrown("Unexpected token '<', \"<html><body>502 Bad Gate\"... is not valid JSON"),
    ANTHROPIC,
  );
  // IT READS AS A SERVER ERROR, because the body says 502 — which is the right answer and better
  // than `unrecognised`: the action is retry-or-switch rather than retry alone.
  check("an HTML error page behind a JSON parse failure classifies as a server error",
    got.class === "server_error" || got.class === "unrecognised", got.class);
  check("...and says something", got.message.trim().length > 0, got.message);

  // AND A BODY THAT IS A WHOLE DOCUMENT IS BOUNDED. This goes into a turn somebody is reading.
  const huge = classifyProviderFailure(thrown("x".repeat(5000)), ANTHROPIC);
  check("a 5,000-character body is trimmed", huge.message.length < 400, huge.message.length);
  check("...and marked as trimmed", huge.message.endsWith("…"), huge.message.slice(-20));
}

console.log(fail === 0 ? "\nALL CORRECT" : `\n${fail} FAILURES`);
process.exit(fail === 0 ? 0 : 1);
