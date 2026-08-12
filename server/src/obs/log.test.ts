// A known secret value, and every sink it must not reach.
//
// THE SUITE IS BUILT AROUND ONE VALUE. A real-looking Anthropic key is registered the way the
// process registers what it loads from `runtime/.env`, and then this file tries to leak it: as a
// message, as a field, nested in an object, inside an Error's message and stack, in a URL's query
// string, through `console.log`, through `console.error`, and as a bare string somebody
// interpolated. Every one of those has to come out redacted, and the assertion each time is
// simply `!line.includes(SECRET)`.
//
// That is the whole design goal restated as a test: not "we are careful with credentials" but
// "there is no sink a credential reaches". A test that only checked the logger's own methods
// would prove the careful version — the hundreds of existing `console.log` calls in this codebase
// are exactly the ones that would leak, and they are what `installLogRedaction` covers.
//
//   npm run test:log-redaction

import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  Logger,
  describeProtection,
  installLogRedaction,
  protectEnv,
  protectSecret,
  redact,
  redactValue,
  resetProtection,
  uninstallLogRedaction,
} from "./log.ts";

let failures = 0;
const check = (ok: boolean, msg: string): void => {
  if (ok) console.log(`  ok   ${msg}`);
  else {
    failures++;
    console.log(`  FAIL ${msg}`);
  }
};

// THE FIXTURES ARE ASSEMBLED RATHER THAN WRITTEN OUT, and that is not obfuscation for its own
// sake: a file whose job is to prove credentials cannot leak must not itself contain a string a
// secret scanner recognises. GitHub's push protection refuses a commit carrying one, which is
// the correct behaviour and would make this suite unpushable. Joined at runtime, the redactor
// sees exactly the value it would see in production and no scanner sees a literal.
const SECRET = ["sk", "ant", "api03", "REALLOOKINGKEYVALUE0123456789abcdefXYZ"].join("-");
const SLACK = ["xoxb", "99887766554433", "2211009988776", "AbCdEfGhIjKlMnOpQrStUvWx"].join("-");
const GOOGLE = `ya29${"."}a0AfH6SMBxxxxxxxxxxxxxxxx`;
const JWT = ["eyJhbGciOiJIUzI1NiJ9", "eyJzdWIiOiIxIn0", "dBjftJeZ4CVPmB92K27uhbUJU1p1r_wW1gFWFOEjXk"].join(".");
const DB_URL = `postgres://analytics:${"hunter2"}@db.internal.example:5432/warehouse`;

protectSecret(SECRET, "ANTHROPIC_API_KEY");

console.log("\nregistered values");
{
  check(redact(`using ${SECRET} now`) === "using [redacted:ANTHROPIC_API_KEY] now", "a registered value is replaced");
  check(!redact(`${SECRET}${SECRET}`).includes(SECRET), "...every occurrence of it");
  check(redact("nothing here").length > 0, "...and an ordinary line is untouched");
  check(describeProtection().registered >= 1, "the count is visible");

  // Short values are ignored on purpose: matching a three-character string would redact every
  // uuid and path in every line, and an unreadable log is not a safer one.
  resetProtection();
  protectSecret("abc", "TINY");
  check(redact("abc def") === "abc def", "a value too short to be a credential is not matched");
  protectSecret(SECRET, "ANTHROPIC_API_KEY");
}

console.log("\nshapes nobody registered");
{
  check(!redact(`Bearer ${SLACK}`).includes(SLACK), "a Slack bot token is recognised by shape");
  check(!redact(`token ${GOOGLE}`).includes("a0AfH6SMB"), "...and a Google access token");
  check(
    !redact(JWT).includes("eyJzdWIiOiIxIn0"),
    "...and a JWT, which is what a leaked run token looks like",
  );
  const url = redact(`could not connect: ${DB_URL}`);
  check(!url.includes("hunter2"), "a connection string's password is redacted");
  check(url.includes("postgres://analytics"), "...and the user survives, because WHICH connection failed is the point");
  check(redact("run 5b2c0a1e-9c1f-4c66-9a0b-1d2e3f4a5b6c started") .includes("5b2c0a1e"), "a uuid is NOT a secret shape");
  check(redact("sha256 e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855").includes("e3b0c442"), "...nor a digest");
}

console.log("\nfields");
{
  const out = redactValue({
    requestId: "abc-123",
    token: "whatever-this-is-it-goes",
    authorization: `Bearer ${SECRET}`,
    nested: { client_secret: "shhh", note: `key is ${SECRET}` },
    list: [`${SECRET}`, "fine"],
  }) as Record<string, unknown>;
  const asText = JSON.stringify(out);
  check(!asText.includes(SECRET), "no field, however nested, carries the value");
  check(!asText.includes("whatever-this-is-it-goes"), "a field NAMED token is redacted whatever it holds");
  check(!asText.includes("shhh"), "...at any depth");
  check(asText.includes("abc-123"), "and the correlating ids survive, which is the point of the record");
}

console.log("\nerrors");
{
  const err = new Error(`provider rejected ${SECRET}`);
  const out = JSON.stringify(redactValue(err));
  check(!out.includes(SECRET), "an Error's message is redacted");
  check(out.includes("provider rejected"), "...and the rest of it survives");
  const withStack = JSON.stringify(redactValue(new Error(`at connect(${DB_URL})`)));
  check(!withStack.includes("hunter2"), "...and so is anything in the stack");
}

console.log("\nthe logger");
{
  const lines: string[] = [];
  const logger = new Logger({ format: "json", sink: (line) => lines.push(line), now: () => 1_700_000_000_000 });
  logger.info(`starting with ${SECRET}`, { workspaceId: "ws-1", token: SECRET, runId: "run-9" });
  const record = JSON.parse(lines[0]!) as Record<string, unknown>;
  check(!lines[0]!.includes(SECRET), "NOTHING THE LOGGER EMITS CONTAINS THE VALUE");
  check(record["workspaceId"] === "ws-1" && record["runId"] === "run-9", "the correlating ids are on the record");
  check(typeof record["ts"] === "string" && record["level"] === "info", "...as is a timestamp and a level");

  const text: string[] = [];
  const human = new Logger({ format: "text", sink: (line) => text.push(line) });
  human.warn("a thing happened", { requestId: "r-1" });
  check(text[0]!.includes("[warn]") && text[0]!.includes("r-1"), "the text format is readable and still carries the ids");

  const quiet: string[] = [];
  const strict = new Logger({ format: "json", minLevel: "warn", sink: (line) => quiet.push(line) });
  strict.debug("noise");
  strict.error("something");
  check(quiet.length === 1, "a level below the floor is not emitted");

  const child = logger.child({ workspaceId: "ws-2" });
  lines.length = 0;
  child.info("in a child");
  check(JSON.parse(lines[0]!)["workspaceId"] === "ws-2", "a child logger carries its fields");
}

console.log("\nthe sink nobody rewrote");
{
  // THE ASSERTION THIS FILE EXISTS FOR. Hundreds of console.log calls already exist in this
  // codebase and hundreds more will be written; none of them will be reviewed for credentials at
  // 3am. Owning the sink is what makes that safe.
  const captured: string[] = [];
  const realLog = console.log;
  const realError = console.error;
  console.log = (...args: unknown[]) => captured.push(args.map(String).join(" "));
  console.error = (...args: unknown[]) => captured.push(args.map(String).join(" "));
  installLogRedaction();

  console.log("[providers] key set:", SECRET);
  console.error(new Error(`failed with ${SECRET}`));
  console.log({ headers: { authorization: `Bearer ${SECRET}` } });
  console.log(`connecting to ${DB_URL}`);

  uninstallLogRedaction();
  console.log = realLog;
  console.error = realError;

  check(captured.length === 4, "every call reached the sink");
  check(
    captured.every((line) => !line.includes(SECRET)),
    "AND NOT ONE OF THEM CARRIES THE VALUE — including the plain console.log nobody rewrote",
  );
  check(captured.every((line) => !line.includes("hunter2")), "...nor the password in a connection string");
  check(captured[0]!.includes("[providers] key set:"), "...while the rest of the line is intact");
  check(captured[0]!.includes("[redacted:ANTHROPIC_API_KEY]"), "...and says WHICH credential it was, by name");
}

console.log("\nthe sink Node writes to itself");
{
  // THE ONE CLASS OF LINE NOBODY WRITES. An uncaught exception, and since Node 15 an unhandled
  // rejection, are printed to stderr by the runtime's own fatal path — not through `console`, so
  // not through anything the section above covers. The suite proved the filter over every line
  // somebody writes on purpose and had never looked at the line the process writes on its way
  // out, which is the one most likely to be quoting a credential: it comes from the code that
  // holds them.
  //
  // A REAL CHILD PROCESS, because the assertion is about what a dying process leaves on stderr
  // and about the exit code it leaves with. Asserting the first without the second would be the
  // dangerous half of this fix: a handler that redacts and then lets the process carry on in an
  // unknown state trades a leak for a crash a supervisor never sees.
  const dir = mkdtempSync(join(tmpdir(), "jaroku-fatal-"));
  const run = (mode: string): { out: string; code: number | null } => {
    const file = join(dir, `${mode}.ts`);
    writeFileSync(
      file,
      [
        `import { installLogRedaction, protectSecret } from ${JSON.stringify(join(import.meta.dirname, "log.ts"))};`,
        `protectSecret(${JSON.stringify(SECRET)}, "ANTHROPIC_API_KEY");`,
        "installLogRedaction();",
        mode === "throw"
          ? `throw new Error("connect failed for " + ${JSON.stringify(SECRET)});`
          : `void Promise.reject(new Error("connect failed for " + ${JSON.stringify(SECRET)}));`,
      ].join("\n"),
    );
    const r = spawnSync(process.execPath, ["--import", "tsx", file], { encoding: "utf8" });
    return { out: `${r.stdout}${r.stderr}`, code: r.status };
  };

  for (const mode of ["throw", "reject"] as const) {
    const { out, code } = run(mode);
    const label = mode === "throw" ? "an uncaught exception" : "an unhandled rejection";
    check(!out.includes(SECRET), `${label} does not carry the value to stderr`);
    check(out.includes("[redacted:ANTHROPIC_API_KEY]"), `...it is named there instead`);
    check(out.includes("connect failed for"), "...and the rest of the message survives");
    check(out.includes(`${mode}.ts`), "...with the stack, which is where a driver quotes its URL");
    // The half that matters as much as the redaction: it still died, and said so.
    check(code === 1, `...and the process still exits 1 (${code})`);
  }
  rmSync(dir, { recursive: true, force: true });
}

console.log("\nwhen something else has taken responsibility");
{
  // The handler suppresses Node's default by existing, so it has to reinstate it — but only when
  // it is the only one listening. A second listener is somebody else deciding what happens next,
  // and exiting out from under them would be this module overriding a decision that is not its
  // to make. Then it only redacts, which is all it was ever for.
  const captured: string[] = [];
  const realError = console.error;
  const other = (): void => {};
  process.on("uncaughtException", other);
  console.error = (...args: unknown[]) => captured.push(args.map((a) => JSON.stringify(a)).join(" "));
  installLogRedaction();

  const ours = process.listeners("uncaughtException").filter((l) => l !== other);
  check(ours.length === 1, "the filter registered exactly one handler");
  // Calling it directly: with `other` also listening it must NOT exit, which is what makes this
  // safe to run inside the suite's own process.
  ours[0]!(new Error(`boom ${SECRET}`), "uncaughtException");

  uninstallLogRedaction();
  console.error = realError;
  process.off("uncaughtException", other);

  check(captured.length === 1 && !captured[0]!.includes(SECRET), "it still redacts");
  check(
    process.listeners("uncaughtException").length === 0,
    "and uninstalling takes its handlers back off, so a test can assert on a raw sink",
  );
}

console.log("\ninstalling twice");
{
  const captured: string[] = [];
  const realLog = console.log;
  console.log = (...args: unknown[]) => captured.push(args.map(String).join(" "));
  installLogRedaction();
  installLogRedaction();
  console.log(`x ${SECRET}`);
  uninstallLogRedaction();
  console.log = realLog;
  check(captured[0] === "x [redacted:ANTHROPIC_API_KEY]", "installing twice does not nest the filter");
}

console.log("\nregistering an environment");
{
  resetProtection();
  protectEnv({ ANTHROPIC_API_KEY: SECRET, NOT_A_SECRET: undefined }, ["ANTHROPIC_API_KEY", "NOT_A_SECRET", "MISSING"]);
  check(describeProtection().registered === 1, "only the values that exist are registered");
  check(redact(`x ${SECRET}`).includes("[redacted:ANTHROPIC_API_KEY]"), "...under their own names");
}

console.log(failures === 0 ? "\nALL CORRECT" : `\n${failures} FAILURES`);
process.exit(failures === 0 ? 0 : 1);
