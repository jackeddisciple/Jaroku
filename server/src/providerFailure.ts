// §7 — provider failures, classified rather than swallowed.
//
// THE GAP THIS CLOSES. Without it every provider failure is a dead turn: the user sees nothing,
// learns nothing, and has no action. §7 opens by saying it "will be the most common bad experience
// in production, because rate limits and expired keys are ordinary, not exotic" — which is the
// argument for doing this at all, and it is right. A key expires on a Tuesday and the product
// stops answering with no sentence anywhere.
//
// THE PRECEDENT IS v0.2.0'S MCP CLASSIFICATION and this is deliberately the same shape as
// `classifyDiscoveryFailure`: match on known markers, name the thing a user can act on, and let the
// DEFAULT be the conservative answer. v0.2.0 also made a server requiring OAuth "say so plainly
// instead of failing as a generic unauthorized error", which is the same instinct one layer up.
//
// WHAT "CONSERVATIVE" MEANS HERE, AND IT IS NOT WHAT IT MEANT FOR MCP. There, the safe default was
// `error` rather than `unreachable`, because "unreachable" invites a retry and a server that
// answered with nonsense will do it again. Here the safe default is to SHOW THE PROVIDER'S OWN
// MESSAGE, verbatim and labelled as theirs — §7.3: "an unrecognised failure is shown, not
// swallowed… the same instinct as v0.2.0's rule that a tool nothing legible can be said about
// defaults to high impact rather than low." A generic sentence hides the one clue there was.
//
// IT IS PURE, AND THAT IS WHAT MAKES TEN CLASSES TESTABLE. §7's acceptance asks for "a fixture
// provider that can be made to return each of the ten classes; each produces its specified copy and
// its specified action" — and a pure function over an error and a provider name is a fixture
// provider that needs no network, no key and no fault injection to exercise.
//
//   npm run test:provider-failure

import { redact } from "./obs/log.ts";

/**
 * §7.2's ten, and there is no eleventh.
 *
 * THE LIST IS CLOSED ON PURPOSE. Every class below carries a sentence and an action, and a class
 * added without both is a turn that says something and offers nothing — which is the dead turn this
 * module exists to remove, wearing a name.
 */
export const FAILURE_CLASSES = [
  "rate_limited",
  "no_credential",
  "invalid_credential",
  "quota_exhausted",
  "timeout",
  "server_error",
  "unreachable",
  "context_too_long",
  "content_refused",
  "unrecognised",
] as const;

export type FailureClass = (typeof FAILURE_CLASSES)[number];

/**
 * What a classified turn offers to do about itself — §7.2's "action offered" column.
 *
 * IDS RATHER THAN LABELS, because the label belongs to whichever surface renders the control and
 * the decision belongs here. `retry` in a conversation is a button; the same id in a log line is a
 * word. A module that shipped button text would be a module the client had to agree with about
 * capitalisation.
 *
 * `open_credentials` IS A REAL LINK AND §7.2 SAYS SO in as many words — "a real link, not prose
 * telling them to go look". The client resolves it to the credential settings for the named
 * provider, which it already knows how to open.
 */
export const FAILURE_ACTIONS = [
  "retry",
  "open_credentials",
  "switch_model",
  "new_thread",
  "edit_message",
] as const;

export type FailureAction = (typeof FAILURE_ACTIONS)[number];

export interface ClassifiedFailure {
  class: FailureClass;
  /** §7.2's copy, with the provider's name in it. Scrubbed — see `classifyProviderFailure`. */
  message: string;
  /** In the order §7.2 lists them, because the first is the one the turn leads with. */
  actions: FailureAction[];
  /**
   * Seconds to wait before the automatic retry, when the provider said.
   *
   * FROM THE PROVIDER'S OWN HEADER WHERE THERE IS ONE, and a default where there is not — never an
   * invented precision. §7.2's copy is "Rate limited by <provider>. Retry in 20s", and the 20 has
   * to come from somewhere: `retry-after` when the error carries it, else this module's own
   * conservative number. Absent on every class that is not rate-limited.
   */
  retryAfterSeconds?: number;
  /**
   * Whether §7.3's ONE automatic retry applies.
   *
   * "Auto-retry is bounded and visible: at most one automatic retry, with the retry stated in the
   * turn, never a silent loop. Anything beyond that is the user's decision." So this is true only
   * for the classes where waiting is genuinely likely to help — a rate limit, a timeout, a 5xx, a
   * dropped connection — and false for every class where the same request would fail identically.
   * An expired key does not fix itself in twenty seconds.
   */
  autoRetry: boolean;
}

/** What the copy needs to name. Nothing here is a secret and nothing here is guessed. */
export interface FailureContext {
  /** "anthropic", "openai", "meta" — the word §7.2's copy puts after "Rate limited by". */
  provider: string;
  /** For §7.2's "This conversation is too long for <model>." */
  model?: string;
  /** For §7.2's "<provider> did not respond within <n>s." */
  timeoutSeconds?: number;
}

/** §7.2's default wait when the provider rate-limits us without saying for how long. */
export const DEFAULT_RETRY_AFTER_SECONDS = 20;

/** What a provider is CALLED where a person reads it. Deliberately the labels `providers.ts` owns. */
const LABEL: Record<string, string> = { anthropic: "Claude", openai: "OpenAI", meta: "Meta" };

const labelFor = (provider: string): string => LABEL[provider] ?? provider;

const lower = (s: string): string => s.toLowerCase();

/**
 * `retry-after`, in seconds, from whatever shape the provider used.
 *
 * TWO SHAPES, BECAUSE BOTH ARE REAL. The header is defined as either a number of seconds or an
 * HTTP date, and SDKs surface it as a field, as a header bag, or inside the message text. What is
 * NOT accepted is a number with no unit from somewhere arbitrary in the string: "429 error on
 * request 4821" would otherwise become a 4,821-second wait with a live countdown on it.
 */
export function retryAfterFrom(err: unknown): number | undefined {
  const bag = (err ?? {}) as Record<string, unknown>;
  const headers = (bag["headers"] ?? {}) as Record<string, unknown>;
  const raw =
    bag["retryAfter"] ?? bag["retry_after"] ?? headers["retry-after"] ?? headers["Retry-After"];
  if (typeof raw === "number" && Number.isFinite(raw) && raw >= 0) return Math.ceil(raw);
  if (typeof raw === "string") {
    const n = Number(raw.trim());
    if (Number.isFinite(n) && n >= 0) return Math.ceil(n);
    const when = Date.parse(raw);
    if (Number.isFinite(when)) {
      const secs = Math.ceil((when - Date.now()) / 1000);
      // A DATE IN THE PAST IS NOT A WAIT. Clock skew between us and a provider is ordinary, and a
      // negative countdown would render as a retry that is already overdue.
      return secs > 0 ? secs : 0;
    }
  }
  // FROM THE SENTENCE, BUT ONLY WITH ITS UNIT ATTACHED. "retry in 20 seconds" is a wait; a bare
  // number anywhere in an error body is not.
  const text = err instanceof Error ? err.message : typeof err === "string" ? err : "";
  const m = /retry (?:again )?(?:in|after) (\d+(?:\.\d+)?)\s*(?:s\b|sec|second)/i.exec(text);
  if (m?.[1]) return Math.ceil(Number(m[1]));
  return undefined;
}

/** The HTTP status a provider error carries, from the field or from its own text. */
export function statusFrom(err: unknown): number | undefined {
  const bag = (err ?? {}) as Record<string, unknown>;
  for (const key of ["status", "statusCode", "status_code"]) {
    const v = bag[key];
    if (typeof v === "number" && Number.isInteger(v) && v >= 100 && v < 600) return v;
  }
  const text = err instanceof Error ? `${err.name}: ${err.message}` : String(err ?? "");
  // ANCHORED TO A STATUS-SHAPED POSITION rather than matched anywhere: a model id like
  // `gpt-5.6-luna` and a token count of 429 are both three digits in a sentence.
  const m = /(?:^|\s|\()(\d{3})(?:\s|:|\)|$)/.exec(text);
  const n = m?.[1] ? Number(m[1]) : NaN;
  return Number.isInteger(n) && n >= 400 && n < 600 ? n : undefined;
}

/**
 * §7: turn a thrown provider error into a turn somebody can act on.
 *
 * THE ORDER OF THE TESTS IS THE DESIGN, because several markers co-occur and the FIRST match has to
 * be the most specific reading. A quota error is a 429 with "quota" in it — classified as a rate
 * limit it would offer a countdown and an automatic retry for a condition that will not clear until
 * somebody pays. A missing key is not a 401: it never reached the provider, so there is no status at
 * all, and the action is "add a key" rather than "your key was rejected".
 *
 * EVERY MESSAGE IS SCRUBBED, AND THAT IS NOT DECORATION. v0.2.1 fixed exactly this: "an error
 * message that quoted a URL containing a credential leaked it into the database, the clients and the
 * logs." Provider error bodies routinely echo the request — a URL with a key in the query, an
 * `authorization` header in a debug dump — so the body goes through the narrowed scrubber (v0.2.4)
 * before it is displayed OR stored, which §7.3 asks for in both directions.
 */
export function classifyProviderFailure(err: unknown, ctx: FailureContext): ClassifiedFailure {
  const who = labelFor(ctx.provider);
  // THE RAW TEXT, SCRUBBED ONCE, and everything below reads the scrubbed copy — so no branch can
  // reach the unscrubbed body by accident.
  const raw = redact(err instanceof Error ? err.message : String(err ?? "unknown error")).trim();
  const e = lower(raw);
  const status = statusFrom(err);

  // NO CREDENTIAL — before the 401 test, because it is not one. Nothing was sent, so there is no
  // status; §7.2's action is to add a key rather than to replace one.
  if (
    /\bno (api )?key\b|\bapi key (is )?(not set|missing|absent)\b|\bmissing (api )?key\b|\bnot configured\b/.test(e)
    || /\b(anthropic|openai|meta)_api_key\b.*\bnot\b/.test(e)
  ) {
    return {
      class: "no_credential",
      message: `No API key configured for ${who}.`,
      actions: ["open_credentials"],
      autoRetry: false,
    };
  }

  // NETWORK, SECOND, because a connection that never opened can be none of the classes below it —
  // there is no status, no quota, no context and no refusal in a socket that was not answered. It
  // was ranked after the content test and that ordering cost one: see the boundary note there.
  // The sentence is about the user's own connection as much as the provider's, which is why it
  // reads "check your connection" rather than naming a fault.
  if (/econnrefused|econnreset|enotfound|eai_again|ehostunreach|enetunreach|epipe|fetch failed|socket hang up|network|dns|offline|err_internet/.test(e)) {
    return {
      class: "unreachable",
      message: `Can't reach ${who}. Check your connection.`,
      actions: ["retry"],
      autoRetry: true,
    };
  }

  // QUOTA — before rate-limited, because it arrives AS a 429 and must not offer a countdown. A
  // quota does not clear in twenty seconds.
  if (/insufficient[_ ]quota|quota (exceeded|exhausted)|billing|credit balance|out of credits|payment required/.test(e)
    || status === 402) {
    return {
      class: "quota_exhausted",
      message: `${who} quota exhausted for this key.`,
      actions: ["switch_model", "open_credentials"],
      autoRetry: false,
    };
  }

  // CONTEXT TOO LONG — before the generic 400, and named with the model because that is the fact
  // that decides what to do about it.
  if (/context[_ ]length|context window|too many tokens|maximum context|prompt is too long|input length/.test(e)) {
    return {
      class: "context_too_long",
      message: ctx.model
        ? `This conversation is too long for ${ctx.model}.`
        : `This conversation is too long for the configured model.`,
      actions: ["new_thread", "switch_model"],
      autoRetry: false,
    };
  }

  // CONTENT REFUSED — the provider declined to answer. Not an error in the product and not one in
  // the key: §7.2's action is to change what was asked.
  // `\brefus…\b` RATHER THAN `refus…`, AND THAT BOUNDARY IS LOAD-BEARING. Unbounded, it matches
  // inside `ECONNREFUSED` — so `fetch failed: ECONNREFUSED` classified as a content refusal and
  // offered "edit the message" for a machine that was not listening. Found by this module's own
  // suite, and it is §3.1's unbounded-pattern failure one layer down: a pattern broad enough to
  // catch every phrasing catches the neighbouring word too.
  if (/content[_ ]policy|content filter|\bsafety\b|\brefus(e|ed|al)\b|declined to|moderation|flagged/.test(e)) {
    return {
      class: "content_refused",
      message: `${who} declined to answer this.`,
      actions: ["edit_message"],
      autoRetry: false,
    };
  }

  // RATE LIMITED. §7.2's copy names the wait, which comes from the provider where it said one.
  if (status === 429 || /rate[_ ]limit|too many requests|slow down/.test(e)) {
    const after = retryAfterFrom(err) ?? DEFAULT_RETRY_AFTER_SECONDS;
    return {
      class: "rate_limited",
      message: `Rate limited by ${who}. Retry in ${after}s.`,
      actions: ["retry"],
      retryAfterSeconds: after,
      // §7.3: ONE automatic retry, stated in the turn, never a silent loop.
      autoRetry: true,
    };
  }

  // INVALID CREDENTIAL. A key that exists and was rejected — which is a different sentence and a
  // different fix from having none.
  if (
    status === 401 || status === 403
    || /invalid[_ ]api[_ ]key|incorrect api key|authentication[_ ]error|unauthorized|unauthenticated|forbidden|invalid x-api-key|access denied|permission denied/.test(e)
  ) {
    return {
      class: "invalid_credential",
      message: `${who} rejected the API key.`,
      actions: ["open_credentials"],
      autoRetry: false,
    };
  }

  // TIMEOUT. Named with the number, because "did not respond" without one invites the question.
  if (/timed out|timeout|etimedout|deadline exceeded|request timeout/.test(e) || status === 408) {
    return {
      class: "timeout",
      message: ctx.timeoutSeconds
        ? `${who} did not respond within ${ctx.timeoutSeconds}s.`
        : `${who} did not respond in time.`,
      actions: ["retry"],
      autoRetry: true,
    };
  }

  // SERVER ERROR.
  if ((status !== undefined && status >= 500) || /internal server error|bad gateway|service unavailable|overloaded|api[_ ]error/.test(e)) {
    return {
      class: "server_error",
      message: `${who} returned a server error.`,
      actions: ["retry", "switch_model"],
      autoRetry: true,
    };
  }

  // §7.3: AN UNRECOGNISED FAILURE IS SHOWN, NOT SWALLOWED — the provider's own message, verbatim,
  // LABELLED as coming from them. The label is what stops a provider's sentence reading as Jaroku's
  // own opinion, which matters most for exactly the failures nobody anticipated.
  //
  // BOUNDED, because a provider error body can be a whole JSON document and this goes into a turn
  // somebody is reading. The first line is where the reason is; the rest is a request dump.
  const first = raw.split("\n")[0]?.trim() ?? "";
  const said = first.length > 300 ? `${first.slice(0, 300)}…` : first;
  return {
    class: "unrecognised",
    message: said ? `${who} said: ${said}` : `${who} failed without saying why.`,
    actions: ["retry"],
    // NO AUTOMATIC RETRY ON A FAILURE NOBODY UNDERSTANDS. §7.3 bounds auto-retry to one and this is
    // the class where "one" should be zero: an unrecognised error is as likely to be a malformed
    // request as a blip, and retrying a malformed request spends money to fail identically.
    autoRetry: false,
  };
}

// ── the fault injector §16 drives ───────────────────────────────────────────────────────────────
//
// WHY A FAULT INJECTOR AT ALL, given the classifier above is pure and fully covered. §16's attack
// list is about the HANDLER rather than the classification: "a mid-stream failure retains partial
// text", "a failure on the automatic retry", "no failure path produces an empty turn". None of those
// is a property of a function over an error — they are properties of a running conversation, and the
// only way to drive them is to make a real provider call fail on demand.
//
// SO IT IS A NAMED CLASS IN AN ENVIRONMENT VARIABLE, and it is off in production unconditionally.
// `explainFixture` argues that case at length for a recorded ANSWER and every word applies: "a
// development convenience that can be turned on in production by an environment variable is a way
// to make a deployment" fail every message for everybody. The difference is that a fixture answer is
// a paragraph nobody can tell is canned, and this is a failure — which is loud by construction, and
// is why this one needs no notice inside its own output.
//
// `mid` IS THE HALF THAT MATTERS. A failure before the first token and a failure after two hundred
// of them are different code paths and only one of them can lose somebody's partial answer.

/** What `JAROKU_CHAT_FAULT` may name: a class, optionally `:mid` to fail after some text has landed. */
export interface InjectedFault {
  class: FailureClass;
  /** Throw AFTER the first tokens rather than before the request. §7.3's partial-output rule. */
  mid: boolean;
}

/** The error each class is provoked with — the same shapes `test:provider-failure` classifies. */
const FAULT_ERRORS: Record<FailureClass, () => Error> = {
  rate_limited: () => Object.assign(new Error("429 rate_limit_error: injected"), { status: 429, headers: { "retry-after": "20" } }),
  no_credential: () => new Error("ANTHROPIC_API_KEY is not set (injected)"),
  invalid_credential: () => Object.assign(new Error("401 authentication_error: invalid x-api-key (injected)"), { status: 401 }),
  quota_exhausted: () => Object.assign(new Error("429 insufficient_quota: credit balance too low (injected)"), { status: 429 }),
  timeout: () => new Error("Request timed out after 30000ms (injected)"),
  server_error: () => Object.assign(new Error("500 api_error: internal server error (injected)"), { status: 500 }),
  unreachable: () => new Error("fetch failed: ECONNREFUSED (injected)"),
  context_too_long: () => Object.assign(new Error("400 invalid_request_error: prompt is too long (injected)"), { status: 400 }),
  content_refused: () => new Error("blocked by our content filter (injected)"),
  unrecognised: () => new Error("tachyon inversion in the flux manifold (injected)"),
};

/**
 * The fault this process has been told to inject, or null.
 *
 * OFF UNDER `NODE_ENV=production`, WHATEVER THE VARIABLE SAYS, and it says so in the log rather than
 * failing quietly — the same two properties `explainFixture` has and for the same reason.
 */
export function injectedFault(env: NodeJS.ProcessEnv = process.env): InjectedFault | null {
  const raw = env["JAROKU_CHAT_FAULT"]?.trim();
  if (!raw) return null;
  if (env["NODE_ENV"] === "production") {
    console.warn(
      "[chat] JAROKU_CHAT_FAULT is set and is being IGNORED: this is a production process, and an "
        + "injected provider failure served as a real one would fail every message in the deployment.",
    );
    return null;
  }
  const [name, where] = raw.split(":");
  const cls = (FAILURE_CLASSES as readonly string[]).includes(name ?? "")
    ? (name as FailureClass)
    : null;
  if (!cls) {
    console.warn(`[chat] JAROKU_CHAT_FAULT="${raw}" names no known failure class — ignoring.`);
    return null;
  }
  return { class: cls, mid: where === "mid" };
}

/** The error a named fault throws. Exported so a suite can assert the shapes round-trip. */
export function faultError(cls: FailureClass): Error {
  return FAULT_ERRORS[cls]();
}
