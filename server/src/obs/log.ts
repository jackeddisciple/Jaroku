// Structured logs, and a filter that makes logging a secret impossible rather than discouraged.
//
// TWO HALVES, AND THE SECOND IS THE ONE THAT MATTERS.
//
// The first half is shape: a log line becomes a record with a level, a message and the three
// correlating ids this system already has — `requestId`, `workspaceId`, `runId`. Hosted, logs
// are searched rather than read, and a line that cannot be filtered to one request is a line
// nobody finds during an incident. JSON when a deployment says so, and the format this codebase
// has always printed when it does not, because a developer reading `npm run dev` is reading, not
// searching.
//
// The second half is REDACTION, and the requirement is precise: not "we are careful", but "a
// value that is a secret cannot reach a sink". The difference is the whole point. Careful means
// every `console.log` anybody ever writes is a place to be careful in, forever, including the
// ones added in a hurry during an incident by somebody who is debugging exactly the code that
// handles credentials.
//
// SO THE FILTER IS INSTALLED OVER `console` ITSELF. Every existing call in this codebase — and
// there are hundreds — goes through it without being rewritten, and so does every future one.
// That is a global mutation, which is normally a bad idea and is the right one here for the same
// reason `dup2(2,1)` is the right way to guarantee stdout carries only trace events: the
// guarantee has to hold for code that has not been written yet, and the only way to do that is
// to own the sink rather than to review the callers.
//
// THREE WAYS A VALUE IS RECOGNISED, and they are deliberately different in kind:
//
//   REGISTERED VALUES. Anything the process handled as a credential — the values loaded from
//   `runtime/.env`, a provider key on its way into a run's environment, an access token injected
//   for a connector — is registered here and matched literally. This is the only exact one, and
//   it is the reason a leak of "the actual key" is impossible rather than unlikely.
//
//   FIELD NAMES. A structured field called `token`, `authorization`, `password` or `client_secret`
//   is redacted whatever it holds. Cheap, and catches the case where a value arrived from
//   somewhere that never registered it.
//
//   SHAPES. `sk-ant-…`, `xoxb-…`, `ya29.…`, a JWT, a connection string with a password in it. The
//   weakest of the three and the only one that can be wrong in both directions — but it is what
//   catches a third party's error message quoting the credential we just sent it, which is
//   nobody's field name and nothing this process registered.
//
// WHAT IT DOES NOT DO. It does not make logs safe to publish, it does not redact the CONTENT an
// agent read — a trace deliberately contains that, and a log line quoting a mail body is a
// different problem with a different answer (see the PII option in the data-lifecycle section) —
// and it is not a substitute for not logging a credential on purpose.

/** Everything a record can carry beyond its message. Ids first, because they are what is searched. */
export interface LogFields {
  requestId?: string;
  workspaceId?: string;
  runId?: string;
  [key: string]: unknown;
}

export type LogLevel = "debug" | "info" | "warn" | "error";

const LEVEL_ORDER: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

/** Field names whose VALUE is never printed, whatever it happens to be. */
const SECRET_FIELD_NAMES = new Set([
  "token",
  "access_token",
  "refresh_token",
  "id_token",
  "runtoken",
  "authorization",
  "auth",
  "password",
  "passwd",
  "secret",
  "client_secret",
  "api_key",
  "apikey",
  "key",
  "ticket",
  "code",
  "code_verifier",
  "signature",
  "cookie",
  "set-cookie",
  "ciphertext",
  "private_key",
]);

/**
 * Shapes that are credentials wherever they appear.
 *
 * Anchored on the vendor prefixes that are unambiguous, plus two structural ones: a JWT (three
 * base64url segments separated by dots) and a URL with a password in its authority. Deliberately
 * NOT a general "long random-looking string" rule — a run id, a uuid and a sha256 are all long
 * random-looking strings, and redacting those would make the logs useless in exactly the incident
 * where they matter.
 */
const SECRET_PATTERNS: { name: string; re: RegExp }[] = [
  { name: "anthropic", re: /\bsk-ant-[A-Za-z0-9_-]{8,}/g },
  { name: "openai", re: /\bsk-(?!ant-)[A-Za-z0-9_-]{16,}/g },
  { name: "slack", re: /\bxox[abposr]-[A-Za-z0-9-]{8,}/g },
  { name: "google", re: /\bya29\.[A-Za-z0-9._-]{8,}/g },
  { name: "github", re: /\bgh[pousr]_[A-Za-z0-9]{16,}/g },
  { name: "stripe", re: /\b(?:sk|rk)_(?:live|test)_[A-Za-z0-9]{8,}/g },
  { name: "jwt", re: /\beyJ[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{6,}/g },
  // A connection string carrying a password. The user half is kept: knowing WHICH user's
  // connection string failed is most of the value of the line.
  { name: "url-credentials", re: /(\b[a-z][a-z0-9+.-]*:\/\/[^\s:/@]+):[^\s@/]+@/gi },
];

/** How short a registered value has to be before matching it literally would redact everything. */
const MIN_REGISTERED_LENGTH = 8;

/**
 * The values this process has handled as credentials.
 *
 * A module-level set, which is the one design decision here worth defending: a redactor passed
 * around as a dependency would be a redactor that some call site does not have, and the whole
 * promise is that there is no such call site. Values are never printed and never enumerated —
 * `describe()` answers a count, so a deployment can see that registration is happening without
 * the diagnostics becoming the leak.
 */
const registered = new Map<string, string>();

/**
 * Register a value as a secret. Idempotent, and safe to call with anything.
 *
 * `label` is what appears in the redacted line — `[redacted:ANTHROPIC_API_KEY]` rather than a
 * bare `[redacted]`, because during an incident "which credential was in this line" is the whole
 * question and the label answers it without the value.
 *
 * SHORT VALUES ARE IGNORED. A three-character secret would match inside every uuid, path and
 * word in every line, and the result is not a safer log but an unreadable one. Nothing in this
 * system has a credential that short; if something did, the answer would be a shorter credential
 * problem rather than a redaction one.
 */
export function protectSecret(value: unknown, label = "redacted"): void {
  if (typeof value !== "string") return;
  const trimmed = value.trim();
  if (trimmed.length < MIN_REGISTERED_LENGTH) return;
  registered.set(trimmed, label);
}

/** Register a whole environment's worth at once, by name. What the runtime env loader calls. */
export function protectEnv(env: Record<string, string | undefined>, names: readonly string[]): void {
  for (const name of names) protectSecret(env[name], name);
}

/** For a boot line and the tests. A count, never the values. */
export function describeProtection(): { registered: number; patterns: number } {
  return { registered: registered.size, patterns: SECRET_PATTERNS.length };
}

/** Forget every registered value. For tests; a running process never needs it. */
export function resetProtection(): void {
  registered.clear();
}

/**
 * One string, with every recognised secret replaced.
 *
 * Registered values first and by descending length, so a key that happens to contain another
 * registered value is redacted as itself rather than half-redacted into something that still
 * reveals its shape.
 */
export function redact(input: string): string {
  let out = input;
  const values = [...registered.entries()].sort((a, b) => b[0].length - a[0].length);
  for (const [value, label] of values) {
    if (out.includes(value)) out = out.split(value).join(`[redacted:${label}]`);
  }
  for (const { name, re } of SECRET_PATTERNS) {
    out = out.replace(re, (match, keep?: string) =>
      // The url-credentials pattern keeps its first group — the scheme and user — because that is
      // the part that identifies WHICH connection failed.
      typeof keep === "string" ? `${keep}:[redacted:${name}]@` : `[redacted:${name}]`,
    );
  }
  return out;
}

/**
 * A value on its way into a log record: redacted, and with secret-named fields removed.
 *
 * Recursive, with a depth limit, because the thing being logged is routinely an object somebody
 * spread a request into. Cycles are handled by the depth limit rather than by a seen-set: a log
 * value deep enough for that is a log value nobody reads.
 */
export function redactValue(value: unknown, depth = 0): unknown {
  if (depth > 6) return "[deep]";
  if (typeof value === "string") return redact(value);
  if (value === null || value === undefined || typeof value !== "object") return value;
  if (value instanceof Error) {
    // The message AND the stack. A stack frame can carry an argument, and an error thrown by a
    // driver routinely quotes the connection string it failed to connect with.
    return { name: value.name, message: redact(value.message), stack: value.stack ? redact(value.stack) : undefined };
  }
  if (Array.isArray(value)) return value.map((v) => redactValue(v, depth + 1));
  const out: Record<string, unknown> = {};
  for (const [key, v] of Object.entries(value as Record<string, unknown>)) {
    out[key] = SECRET_FIELD_NAMES.has(key.toLowerCase()) ? "[redacted:field]" : redactValue(v, depth + 1);
  }
  return out;
}

// --- the logger -------------------------------------------------------------------------------

export interface LoggerOptions {
  /** `json` for a hosted deployment, `text` for a person reading a terminal. */
  format?: "json" | "text";
  minLevel?: LogLevel;
  /** Where a finished line goes. The tests pass a collector; production passes console. */
  sink?: (line: string, level: LogLevel) => void;
  now?: () => number;
  /** Fields every record from this logger carries. `child()` adds to them. */
  base?: LogFields;
}

export class Logger {
  private format: "json" | "text";
  private minLevel: LogLevel;
  private sink: (line: string, level: LogLevel) => void;
  private now: () => number;
  private base: LogFields;

  constructor(opts: LoggerOptions = {}) {
    this.format = opts.format ?? (process.env["JAROKU_LOG_FORMAT"] === "json" ? "json" : "text");
    this.minLevel = opts.minLevel ?? ((process.env["JAROKU_LOG_LEVEL"] as LogLevel) || "info");
    this.sink = opts.sink ?? ((line, level) => (level === "error" ? rawError(line) : rawLog(line)));
    this.now = opts.now ?? Date.now;
    this.base = opts.base ?? {};
  }

  /** A logger that carries these fields on every record. One per request, one per run. */
  child(fields: LogFields): Logger {
    return new Logger({
      format: this.format,
      minLevel: this.minLevel,
      sink: this.sink,
      now: this.now,
      base: { ...this.base, ...fields },
    });
  }

  debug(msg: string, fields?: LogFields): void {
    this.write("debug", msg, fields);
  }
  info(msg: string, fields?: LogFields): void {
    this.write("info", msg, fields);
  }
  warn(msg: string, fields?: LogFields): void {
    this.write("warn", msg, fields);
  }
  error(msg: string, fields?: LogFields): void {
    this.write("error", msg, fields);
  }

  private write(level: LogLevel, msg: string, fields?: LogFields): void {
    if (LEVEL_ORDER[level] < LEVEL_ORDER[this.minLevel]) return;
    const merged = { ...this.base, ...(fields ?? {}) };
    const safe = redactValue(merged) as LogFields;
    const message = redact(msg);
    if (this.format === "json") {
      this.sink(JSON.stringify({ ts: new Date(this.now()).toISOString(), level, msg: message, ...safe }), level);
      return;
    }
    const ids = [safe.requestId, safe.workspaceId, safe.runId].filter(Boolean).join(" ");
    const rest = Object.entries(safe)
      .filter(([k]) => k !== "requestId" && k !== "workspaceId" && k !== "runId")
      .map(([k, v]) => `${k}=${typeof v === "string" ? v : JSON.stringify(v)}`)
      .join(" ");
    this.sink([`[${level}]`, ids, message, rest].filter(Boolean).join(" "), level);
  }
}

// --- owning the sink --------------------------------------------------------------------------

/** The real console methods, captured before anything is replaced. */
const rawLog = console.log.bind(console);
const rawError = console.error.bind(console);
const rawWarn = console.warn.bind(console);
const rawInfo = console.info.bind(console);
const rawDebug = console.debug.bind(console);

/**
 * What `console` held when the filter was installed, so uninstalling restores THAT.
 *
 * Captured at install rather than at module load, which is a small distinction with one real
 * consequence: a process that had already replaced `console.log` — a test harness collecting
 * lines, a hosting platform's log shipper — keeps its replacement, filtered, instead of having
 * the filter quietly write past it to the original. Capturing at load would mean the filter is
 * installed over a sink nobody is reading.
 */
let previous: Partial<Record<"log" | "error" | "warn" | "info" | "debug", (...args: unknown[]) => void>> = {};
let installed = false;

/**
 * Route every `console` call through the redactor.
 *
 * IDEMPOTENT, and it has to be: two installs would nest the filter, which is harmless, and would
 * make uninstalling restore a filtered console, which is not.
 *
 * The arguments are redacted individually rather than joined, so `console.log("key:", value)`
 * keeps its shape and an object argument still prints as an object — Node's formatting is what
 * makes a console line readable, and stringifying everything here to filter it would trade the
 * readability of every line for the redaction of a few.
 */
/**
 * The two sinks `console` is not.
 *
 * NODE PRINTS A FATAL ERROR ITSELF. An exception nobody caught, and — since Node 15 — a rejection
 * nobody handled, are written to stderr by the runtime's own fatal path: not through `console`,
 * not through anything this module wrapped, straight out. So the guarantee in this file's header
 * held for every line anybody writes on purpose and failed on the one class of line nobody
 * writes at all.
 *
 * IT IS NOT A THEORETICAL PATH AND IT IS NOT AN UNLIKELY MESSAGE. These are the errors that
 * quote credentials, because they come from the code that holds them: a driver reporting which
 * connection string it could not connect with, a queue client naming its URL, a fetch rejecting
 * against a presigned download link with the signature still in the query string, a provider's
 * error body repeating the key it just refused. `redactValue` already handles an Error's stack
 * for exactly this reason — it simply never saw these.
 *
 * WHAT IT MUST NOT DO IS KEEP THE PROCESS ALIVE. Registering a listener suppresses the default,
 * and a crash silently downgraded to a running process in an unknown state is far worse than the
 * leak this closes: the exit code is what a supervisor restarts on and what CI fails on. So the
 * handler prints through the filter and then dies the way Node would have — unless something
 * ELSE has also registered, in which case that code has taken responsibility for what happens
 * next and this only redacts, which is all it was ever for.
 *
 * `process.exit` truncates an in-flight write to a pipe, and stderr is a pipe under every
 * supervisor and every CI runner there is, so the exit is a tick later. That is the difference
 * between a redacted message and no message.
 */
const onFatal =
  (kind: string) =>
  (value: unknown): void => {
    console.error(`[${kind}]`, value);
    if (process.listenerCount(kind as "uncaughtException") > 1) return;
    process.exitCode = 1;
    setTimeout(() => process.exit(1), 0);
  };

const fatalException = onFatal("uncaughtException");
const fatalRejection = onFatal("unhandledRejection");

export function installLogRedaction(): void {
  if (installed) return;
  installed = true;
  previous = {
    log: console.log.bind(console),
    error: console.error.bind(console),
    warn: console.warn.bind(console),
    info: console.info.bind(console),
    debug: console.debug.bind(console),
  };
  const wrap =
    (raw: (...args: unknown[]) => void) =>
    (...args: unknown[]): void =>
      raw(...args.map((a) => redactValue(a)));
  console.log = wrap(previous.log!);
  console.error = wrap(previous.error!);
  console.warn = wrap(previous.warn!);
  console.info = wrap(previous.info!);
  console.debug = wrap(previous.debug!);
  process.on("uncaughtException", fatalException);
  process.on("unhandledRejection", fatalRejection);
}

/** Put back whatever was there. For tests, which need to assert on what a sink received. */
export function uninstallLogRedaction(): void {
  if (!installed) return;
  installed = false;
  process.off("uncaughtException", fatalException);
  process.off("unhandledRejection", fatalRejection);
  console.log = previous.log ?? rawLog;
  console.error = previous.error ?? rawError;
  console.warn = previous.warn ?? rawWarn;
  console.info = previous.info ?? rawInfo;
  console.debug = previous.debug ?? rawDebug;
  previous = {};
}

/** The process-wide logger. Everything new writes through this; everything old writes through
 *  `console`, which is now the same filter either way. */
export const log = new Logger();
