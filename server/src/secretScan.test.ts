// The last look before a tree becomes commits.
//
// TWO FAILURE DIRECTIONS, AND THE SECOND ONE IS THE ONE THAT KILLS THE FEATURE. Missing a
// credential is the obvious failure. Refusing a push over a lockfile hash is the quiet one: a gate
// that fires on ordinary source teaches people to reach for the override on every push, after
// which it is not a gate. v0.2.4 learned exactly this when the scrubber blanked "anthropic" out of
// every build log, and the narrowing it produced is what this file reuses rather than re-derives.
//
// So the suite is arranged in pairs: for every shape that must be caught, a near-miss that must
// not be. A base64 fixture, a sha256 in a lockfile, a UUID, a connection string with no password,
// `.env.example` — all of them are the shape of thing a general "looks random" heuristic would
// refuse, and all of them appear in real agent projects.
//
// AND ONE PROPERTY THAT IS ABOUT THE OUTPUT RATHER THAN THE DETECTION: no finding may contain the
// matched text. Migration 040 makes the argument — a record of where the credentials are and a bit
// of each one is a worse leak than the push it prevented — and it is only true if this holds.
//
//   npm run test:secret-scan

import { refusalLine, scanTree } from "./secretScan.ts";
import type { StoredFile } from "./storage/projectStore.ts";

let failures = 0;
const check = (ok: boolean, msg: string, detail = ""): void => {
  if (ok) console.log(`  ok   ${msg}`);
  else {
    failures++;
    console.log(`  FAIL ${msg}${detail ? ` — ${detail}` : ""}`);
  }
};

const f = (path: string, content: string): StoredFile => ({ path, content });
const rules = (files: StoredFile[], opts = {}): string =>
  scanTree(files, opts).map((x) => `${x.path}:${x.rule}`).join(" ");

// Deliberately not real, and deliberately ASSEMBLED RATHER THAN WRITTEN OUT.
//
// The first version of this file spelled each fixture as a literal, and GitHub's own push
// protection refused the commit — which is the same feature this file is testing, working
// correctly, on a repository that happens to contain its test suite. That is not an inconvenience
// to route around: a scanner's fixtures ARE the shapes scanners look for, and a file full of them
// is indistinguishable from a leak to anything reading the bytes.
//
// So each one is joined from parts at run time. The value the test sees is identical; the file on
// disk contains no string that matches anything, which is the property that lets a suite about
// credentials live in a repository that scans for them. Our own `scanTree` sees the joined value
// and is unaffected, because it is given the runtime string rather than the source.
const join = (...parts: string[]): string => parts.join("");

const FAKE = {
  anthropic: join("sk", "-ant-", "api03-", "EXAMPLE".repeat(4)),
  github: join("ghp", "_", "EXAMPLE".repeat(4), "1234"),
  aws: join("AKIA", "EXAMPLEEXAMPLE12"),
  slack: join("xox", "b-", "000000000000-", "EXAMPLEEXAMPLE"),
  google: join("AIza", "EXAMPLE".repeat(5)),
  stripe: join("sk", "_", "live", "_", "EXAMPLE".repeat(3), "1234"),
};

console.log("\npublished token shapes are caught, by their own formats");
{
  const found = (content: string): string => scanTree([f("agent.py", content)]).map((x) => x.rule).join(",");
  check(found(`KEY = "${FAKE.anthropic}"`) === "anthropic_key", "an Anthropic key");
  check(found(`TOKEN = "${FAKE.github}"`) === "github_token", "a GitHub token");
  check(found(`ID = "${FAKE.aws}"`) === "aws_access_key_id", "an AWS access key id");
  check(found(`T = "${FAKE.slack}"`) === "slack_token", "a Slack token");
  check(found(`K = "${FAKE.google}"`) === "google_key", "a Google API key");
  check(found(`K = "${FAKE.stripe}"`) === "stripe_key", "a Stripe secret key");
  check(found("-----BEGIN RSA PRIVATE KEY-----\nMIIE\n") === "private_key", "a private key block");
  check(
    found('DB = "postgres://app:hunter2@db.internal:5432/prod"') === "connection_string",
    "a connection string that carries a password",
  );

  const at = scanTree([f("agent.py", `x = 1\ny = 2\nKEY = "${FAKE.anthropic}"\n`)])[0]!;
  check(at.line === 3, "the finding lands on the line the key is on", String(at.line));
  check(at.kind === "secret", "and is classified as a secret rather than an artifact");
}

console.log("\nand the near-misses that would make people override on every push");
{
  const clean = (content: string): boolean => scanTree([f("agent.py", content)]).length === 0;
  // A general "this looks random" heuristic refuses every one of these, and every one appears in
  // a real project.
  check(clean('SHA = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"'), "a sha256 in a lockfile is not a key");
  check(clean('ID = "3f2504e0-4f89-11d3-9a0c-0305e82c3301"'), "a UUID is not a key");
  check(clean('BLOB = "aGVsbG8gd29ybGQgdGhpcyBpcyBhIHRlc3QgZml4dHVyZQ=="'), "a base64 fixture is not a key");
  check(clean('URL = "postgres://db.internal:5432/prod"'), "a connection string with NO password is a host, not a credential");
  check(clean('MODEL = "claude-haiku-4-5"\nPROVIDER = "anthropic"'), "the host values v0.2.4 was narrowed to stop flagging");
  check(clean('KEY = os.environ["ANTHROPIC_API_KEY"]'), "reading a key from the environment is the CORRECT pattern, not a leak");
  check(clean(`# see ${join("sk", "-ant-")}... in the docs\n`), "an ellipsis is not twenty characters of key");
}

console.log("\na .env file is a finding because it is there");
{
  check(rules([f(".env", "X=1\n")]) === ".env:env_file", "a bare .env, whatever is in it");
  check(rules([f("runtime/.env.local", "X=1\n")]) === "runtime/.env.local:env_file", "and .env.local, nested");
  // Rule 4 REQUIRES .env.example — a key read from the environment and missing from it fails
  // validation — so refusing to push it would make the two gates contradict each other.
  check(rules([f(".env.example", "ANTHROPIC_API_KEY=\n")]) === "", ".env.example is exempt, because rule 4 demands it");
  check(rules([f("docs/.env.sample", "X=\n")]) === "", "and so are the other names people use for it");

  // Worth saying twice: the file's presence is one problem and a recognisable key inside it is a
  // second, more urgent one — it names the credential to rotate.
  const both = scanTree([f(".env", `ANTHROPIC_API_KEY=${FAKE.anthropic}\n`)]);
  check(both.length === 2, "a .env carrying a real key reports both", JSON.stringify(both.map((x) => x.rule)));
  check(both.some((x) => x.rule === "env_file") && both.some((x) => x.rule === "anthropic_key"),
    "the file and the key, so somebody knows what to rotate as well as what to remove");
}

console.log("\nthe workspace's own stored values, matched literally");
{
  const secret = "a-password-nobody-could-pattern-match";
  const files = [f("tools/db.py", `PASSWORD = "${secret}"\n`)];
  check(rules(files, { knownValues: [secret] }) === "tools/db.py:known_value",
    "a stored credential's exact bytes are that credential, whatever it looks like");
  check(rules(files) === "", "…and with nothing known, a chosen password is just a word — which is why shapes are not enough");

  // makeScrubber's own floor, and it is right here too: a two-letter value would match half the
  // source and shred every file in the tree.
  check(rules([f("agent.py", "x = 1\n")], { knownValues: ["x"] }) === "", "a value under eight characters is not scanned for");
}

console.log("\nthe MCP manifest holds names, and a value in one is a hand edit");
{
  const named = JSON.stringify({ servers: [{ id: "linear", auth_env_key: "LINEAR_TOKEN", tools: [] }] }, null, 2);
  check(rules([f("mcp_tools.json", named)]) === "", "a variable NAME is what belongs there");

  const pasted = JSON.stringify({ servers: [{ id: "linear", auth_env_key: "hunter2-not-a-name", tools: [] }] }, null, 2);
  check(rules([f("mcp_tools.json", pasted)]) === "mcp_tools.json:manifest_credential",
    "and anything that is not a variable name is a value somebody pasted");
  // Structural rather than shape-based, which is the point: a chosen password looks like a word,
  // and no regex over its contents would ever have flagged it.
  check(scanTree([f("mcp_tools.json", pasted)])[0]!.message.includes("never its value"),
    "the message says what the field is FOR, which is the fix");

  check(rules([f("mcp_tools.json", "{ not json")]) === "", "a manifest that does not parse is a broken file, not a leak");
  check(rules([f("agents/weather/mcp_tools.json", pasted)]).endsWith(":manifest_credential"), "found under a subdirectory too");
}

console.log("\noversized and binary get their own sentence");
{
  const big = scanTree([f("assets/model.bin", "x".repeat(2000))], { maxFileBytes: 1000 })[0]!;
  check(big.kind === "artifact", "an oversized file is an artifact finding, not a secret one");
  check(big.message.includes("Git LFS"), "…and points at Git LFS rather than at a rotation", big.message);
  check(big.rule === "oversized" && big.line === null, "with no line, because the file's size is not on a line");

  const bin = scanTree([f("assets/logo.png", "PNG\u0000\u0000rest")])[0]!;
  check(bin.rule === "binary" && bin.kind === "artifact", "a binary file is caught by its NUL bytes");

  // The two sentences are genuinely different, which is what §B.6.1 asks for: "this repo isn't
  // meant for binary assets" and "this file might be a credential" send somebody to different
  // places.
  const key = scanTree([f("agent.py", `K = "${FAKE.anthropic}"`)])[0]!;
  check(!key.message.includes("Git LFS") && key.message.includes("Rotate"), "a secret says rotate, an artifact says LFS");
}

console.log("\nwhat a finding may never contain");
{
  const secret = "a-password-nobody-could-pattern-match";
  const findings = scanTree(
    [
      f(".env", `ANTHROPIC_API_KEY=${FAKE.anthropic}\n`),
      f("tools/db.py", `PASSWORD = "${secret}"\n`),
      f("mcp_tools.json", JSON.stringify({ servers: [{ id: "x", auth_env_key: "hunter2-value", tools: [] }] })),
    ],
    { knownValues: [secret] },
  );
  const serialised = JSON.stringify(findings);
  // Migration 040's rule, asserted rather than trusted: no value, no prefix of one, nothing.
  check(!serialised.includes(FAKE.anthropic), "no matched token shape appears in any finding");
  check(!serialised.includes(secret), "no known value does either");
  check(!serialised.includes("hunter2-value"), "and neither does a pasted manifest credential");
  check(!serialised.includes(FAKE.anthropic.slice(0, 16)), "not even a prefix long enough to be useful");
}

console.log("\nordering, deduplication and the sentence at the top");
{
  const many = scanTree([
    f("tools/z.py", `K = "${FAKE.anthropic}"`),
    f("agent.py", `A = "${FAKE.github}"\nB = "${FAKE.github}"`),
  ]);
  check(many.map((x) => x.path).join(",") === "agent.py,tools/z.py", "sorted by path, so a rescan does not churn");
  check(many.filter((x) => x.path === "agent.py").length === 1,
    "one finding per file per rule — the same key twice is one problem with one fix");

  check(refusalLine(many).startsWith("Push refused — possible secret: agent.py"),
    "the line names the first file rather than counting", refusalLine(many));
  check(refusalLine(many).includes("and 1 more"), "with the rest accounted for, not hidden");
  check(
    refusalLine(scanTree([f("big.bin", "x".repeat(2000))], { maxFileBytes: 1000 })).includes("oversized file"),
    "and an artifact-only refusal does not say the word secret",
  );
  check(refusalLine([]) === "", "nothing found is nothing said");
}

console.log("\na clean tree is silent");
{
  const project = [
    f("agent.py", 'from tools import TOOLS\n\ndef build_graph(llm):\n    return llm\n'),
    f("tools/__init__.py", "TOOLS = []\n"),
    f(".env.example", "ANTHROPIC_API_KEY=\nOPENWEATHER_API_KEY=\n"),
    f("pyproject.toml", '[project]\nname = "weather-agent"\n'),
    f("Dockerfile", "FROM python:3.12-slim\nRUN uv pip install langchain-anthropic>=0.3.0\n"),
  ];
  check(scanTree(project).length === 0, "an ordinary agent project produces nothing", rules(project));
}

console.log(failures === 0 ? "\nALL CORRECT" : `\n${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
