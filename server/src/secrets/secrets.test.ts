// The secret store, and the local implementation of it.
//
// The conformance suite carries most of the assertions, because they are the ones every
// implementation must satisfy. What is here on top of it is the part that is specific to
// wrapping `runtime/.env`: that it really is a wrapper — the one writer, unchanged, with its
// round-trip refusal intact — and that it is honest about the workspace it cannot represent.
//
//   npm run test:secrets

import { randomUUID } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { fileCredentialWriter } from "../envWriter.ts";
import { parseLine } from "../env.ts";
import { DotEnvSecretStore } from "./dotEnvSecretStore.ts";
import { assertSecretName, isSecretName } from "./secretStore.ts";
import { conformanceContext, runSecretConformance } from "./conformance.ts";

let failures = 0;
const check = (ok: boolean, msg: string, detail = ""): void => {
  if (ok) console.log(`  ok   ${msg}`);
  else {
    failures++;
    console.log(`  FAIL ${msg}${detail ? ` — ${detail}` : ""}`);
  }
};

const scratch: string[] = [];
const tmpDir = (): string => {
  const d = mkdtempSync(join(tmpdir(), "jaroku-secrets-"));
  scratch.push(d);
  return d;
};

/** A realistic file: comments, a blank line, a quoted value, keys that matter. */
const ORIGINAL = `# Provider keys
ANTHROPIC_API_KEY=sk-ant-realkey

# The support agent needs this
DATABASE_URL="postgres://user:pw@host:5432/db"
`;

function newStore(): { store: DotEnvSecretStore; envPath: string } {
  const envPath = join(tmpDir(), ".env");
  writeFileSync(envPath, ORIGINAL);
  // The REAL writer, not a stub. A test that wrapped a fake would prove this store talks to
  // something with the right shape and nothing about whether the file survives.
  const store = new DotEnvSecretStore({
    writer: fileCredentialWriter(envPath),
    envPath,
    providerFor: (name) => (name.startsWith("ANTHROPIC") ? "anthropic" : null),
  });
  return { store, envPath };
}

// --- 1. names ------------------------------------------------------------------------------
console.log("\nwhat may be a credential name");
{
  check(isSecretName("ANTHROPIC_API_KEY"), "an ordinary env var name is fine");
  check(isSecretName("JAROKU_MCP_LINEAR_TOKEN"), "and so is a derived MCP one");
  check(!isSecretName("lowercase"), "lowercase is refused");
  check(!isSecretName("1_LEADING_DIGIT"), "a leading digit is refused");
  check(!isSecretName("HAS SPACE"), "a space is refused");
  check(!isSecretName("HAS=EQUALS"), "an equals sign is refused — the .env format has no escape for one");
  check(!isSecretName("HAS\nNEWLINE"), "a newline is refused, which would write a second variable");
  check(!isSecretName(undefined), "and so is a non-string, rather than being stringified");
  check(!isSecretName("A".repeat(200)), "an absurd length is refused");

  let threw = false;
  try {
    assertSecretName("nope");
  } catch (err) {
    threw = (err as Error).message.includes("UPPER_SNAKE_CASE");
  }
  check(threw, "the assertion says what a usable name looks like");
}

// --- 2. the conformance suite -----------------------------------------------------------
{
  const { store } = newStore();
  const ctx = conformanceContext(randomUUID());
  failures += (await runSecretConformance("conformance: DotEnvSecretStore", store, ctx, randomUUID())).failures;
}

// --- 3. it is a wrapper, and the file survives -------------------------------------------
console.log("\nwrapping envWriter rather than replacing it");
{
  const { store, envPath } = newStore();
  const ctx = conformanceContext(randomUUID());

  await store.set(ctx, "JAROKU_MCP_LINEAR_TOKEN", "lin_api_secret");
  const after = readFileSync(envPath, "utf8");
  check(after.includes("ANTHROPIC_API_KEY=sk-ant-realkey"), "an unrelated key survives byte for byte");
  check(after.includes('DATABASE_URL="postgres://user:pw@host:5432/db"'), "...including a quoted one");
  check(after.includes("# Provider keys"), "...and the comments");
  check(after.includes("JAROKU_MCP_LINEAR_TOKEN=lin_api_secret"), "...with the new key appended");

  // Read back with the REAL parser, which is the only definition of "stored correctly" that
  // matters: what a run receives is what this reads. `loadRuntimeEnv` is deliberately not used
  // for the assertion — it reports only the names it SET, and `set` has already put this one
  // into the process environment, where it wins by design.
  const parsedBack = readFileSync(envPath, "utf8")
    .split("\n")
    .map((l) => parseLine(l))
    .find((kv) => kv?.[0] === "JAROKU_MCP_LINEAR_TOKEN");
  check(parsedBack?.[1] === "lin_api_secret", "the parser reads the new key back byte for byte");

  await store.set(ctx, "ANTHROPIC_API_KEY", "sk-ant-replaced");
  const replaced = readFileSync(envPath, "utf8");
  check(replaced.includes("sk-ant-replaced"), "an existing key is rewritten in place");
  check(!replaced.includes("sk-ant-realkey"), "...with the old value gone");
  check(replaced.indexOf("ANTHROPIC_API_KEY") < replaced.indexOf("DATABASE_URL"), "...and the ordering unchanged");

  // THE ROUND-TRIP GUARANTEE, which is envWriter's and must not have been lost in the
  // wrapping. Stated the way envWriter's own suite states it, because the point is not which
  // values happen to be refused — that is a property of the format — but that whatever is
  // ACCEPTED comes back byte-identical and whatever is REFUSED is not written at all. A
  // credential silently altered on the way to disk produces a 401 with no explanation anywhere.
  const awkward: Record<string, string> = {
    AWKWARD_1: `contains " a double quote`,
    AWKWARD_2: "contains ' a single quote",
    AWKWARD_3: `both ' and " quotes`,
    AWKWARD_4: "back\\slash",
    AWKWARD_5: "  leading and trailing spaces  ",
    AWKWARD_6: "# starts with a hash",
    AWKWARD_7: "=equals=everywhere=",
    AWKWARD_8: "unicode ✓ ünïcödé",
  };
  let mangled = 0;
  let silentlyWritten = 0;
  for (const [name, value] of Object.entries(awkward)) {
    const written = await store.set(ctx, name, value);
    const back = readFileSync(envPath, "utf8")
      .split("\n")
      .map((l) => parseLine(l))
      .find((kv) => kv?.[0] === name);
    if (written.ok) {
      if (back?.[1] !== value) mangled++;
    } else if (back) {
      silentlyWritten++;
    }
  }
  check(mangled === 0, `every accepted value round-trips byte for byte (${mangled} mangled)`);
  check(silentlyWritten === 0, `and every refused one is not written at all (${silentlyWritten} written)`);
  for (const name of Object.keys(awkward)) await store.delete(ctx, name);

  await store.delete(ctx, "JAROKU_MCP_LINEAR_TOKEN");
  const deleted = readFileSync(envPath, "utf8");
  check(!deleted.includes("JAROKU_MCP_LINEAR_TOKEN"), "delete removes the line");
  check(deleted.includes("ANTHROPIC_API_KEY"), "...and leaves the rest");
}

// --- 4. what it will not report -----------------------------------------------------------
console.log("\nnames only, and not every name");
{
  const { store, envPath } = newStore();
  const ctx = conformanceContext(randomUUID());
  writeFileSync(
    envPath,
    [
      "ANTHROPIC_API_KEY=sk-ant-realkey",
      "PLACEHOLDER_KEY=",
      "# a comment",
      "not a line at all",
      "JAROKU_NO_AUTORUN=1",
      "SLACK_BOT_TOKEN=xoxb-123",
    ].join("\n"),
  );

  const listed = await store.listNames(ctx);
  const names = listed.map((s) => s.name);
  check(names.includes("ANTHROPIC_API_KEY"), "a configured key is listed");
  check(names.includes("SLACK_BOT_TOKEN"), "...and so is a connector's");
  check(!names.includes("PLACEHOLDER_KEY"), "a name with an empty value is a placeholder, not a credential");
  check(!names.includes("JAROKU_NO_AUTORUN"), "Jaroku's own plumbing is not a user's credential");
  check(
    !JSON.stringify(listed).includes("sk-ant-realkey"),
    "and no value appears anywhere in what is returned",
  );
  check(
    listed.find((s) => s.name === "ANTHROPIC_API_KEY")?.provider === "anthropic",
    "a name can carry what it is for, which is display and nothing more",
  );

  // A line the real parser cannot read is a line a run would never receive, so reporting it as
  // configured would be a lie the user acts on.
  check(!names.includes("not a line at all"), "an unparseable line is not reported as a key");
}

// --- 5. what it is honest about not having --------------------------------------------------
console.log("\nthe workspace it cannot represent");
{
  const { store } = newStore();
  const a = conformanceContext(randomUUID());
  const b = conformanceContext(randomUUID());

  await store.set(a, "SHARED_LOCAL_TOKEN", "one-machine-one-user");
  // Deliberately asserted, because it is the LIMIT of the local path rather than a bug: there
  // is nowhere in the .env format to put a workspace, so on this store two workspaces share a
  // file. That is exactly the trust boundary this product has always had locally, and it is
  // why storage/open.ts and db/open.ts refuse their development implementations under
  // NODE_ENV=production and why the KMS store exists.
  const fromB = await store.listNames(b);
  check(
    fromB.some((s) => s.name === "SHARED_LOCAL_TOKEN"),
    "the local store shares one file between workspaces, and this suite says so out loud",
  );
  check(
    (await store.getForRun(randomUUID(), ["SHARED_LOCAL_TOKEN"]))["SHARED_LOCAL_TOKEN"] === "one-machine-one-user",
    "...and a run gets it whatever run it is, because the file has no notion of one",
  );
  await store.delete(a, "SHARED_LOCAL_TOKEN");
}

for (const d of scratch) rmSync(d, { recursive: true, force: true });
check(scratch.every((d) => !existsSync(d)), "the scratch files are cleaned up");

console.log(failures === 0 ? "\nALL CORRECT" : `\n${failures} FAILURES`);
process.exit(failures === 0 ? 0 : 1);
