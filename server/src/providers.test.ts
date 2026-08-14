// Model-provider credentials: the mapping, the presence check, and the write.
//
// The write itself is envWriter's, and envWriter.test.ts already proves it does not damage a
// file it did not author. What is tested here is the layer above it: that a provider resolves
// to the variable name the Python runtime actually reads, that `configured` is a presence
// check and never a value, and that connecting a provider adds exactly one line to a .env
// that already had a life of its own.
//
// verifyProviderKey is deliberately NOT exercised against the network — it is a live call to
// somebody else's API, and a test that fails when Anthropic is slow is a test people learn to
// ignore. Its input validation is covered; the call is covered by using the feature.
//
//   npm run test:providers

import { randomUUID } from "node:crypto";
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setEnvVar } from "./envWriter.ts";
import { loadRuntimeEnv } from "./env.ts";
import {
  PROVIDER_ENV_KEY, PROVIDER_IDS, isProviderId, providerStatus, verifyProviderKey,
} from "./providers.ts";

let fail = 0;
const check = (name: string, ok: boolean, detail = "") => {
  if (ok) console.log(`  ok   ${name}`);
  else { fail++; console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ""}`); }
};

const paths: string[] = [];
const tmpEnv = (contents: string): string => {
  const p = join(tmpdir(), `jaroku-providers-${randomUUID()}`);
  writeFileSync(p, contents);
  paths.push(p);
  return p;
};

// A .env with a life of its own: comments, a blank line, a quoted value, unrelated keys.
const ORIGINAL = `# The support agent needs this
DATABASE_URL="postgres://user:pw@host:5432/db"

SLACK_BOT_TOKEN=xoxb-123
`;

// --- 1. the mapping ---------------------------------------------------------------------
//
// These names are not ours. They are what langchain_anthropic / langchain_openai read in the
// Python runtime and what the README tells people to set by hand — a "nicer" name here would
// produce a .env that looks right and works for nothing.
{
  check("anthropic maps to the name the runtime reads",
    PROVIDER_ENV_KEY.anthropic === "ANTHROPIC_API_KEY");
  check("openai maps to the name the runtime reads",
    PROVIDER_ENV_KEY.openai === "OPENAI_API_KEY");
  // GOOGLE_API_KEY, not GEMINI_API_KEY: the first is what `langchain_google_genai` reads, and the
  // Python runtime finding the key is the only thing that decides which name is correct.
  check("google maps to the name the runtime reads",
    PROVIDER_ENV_KEY.google === "GOOGLE_API_KEY");
  check("only real providers are connectable", PROVIDER_IDS.join(",") === "anthropic,openai,google");
  // `fake` is the free dry-run path, not a credential — offering it as something to connect
  // would ask a user for a key that does not exist.
  check("fake is not a provider you connect", !isProviderId("fake"));
  check("an unknown provider id is refused", !isProviderId("acme"));
  check("a non-string provider id is refused", !isProviderId(undefined));
}

/**
 * The set a hosted deployment builds from `SecretStore.listNames(ctx)`, and which locally is
 * exactly what the process environment holds — the local store IS the process environment.
 * Written as a helper so these assertions keep testing the same rule they always did rather
 * than testing that a Set literal contains what was just put in it.
 */
const namesFromEnv = (): ReadonlySet<string> =>
  new Set(["ANTHROPIC_API_KEY", "OPENAI_API_KEY"].filter((n) => Boolean(process.env[n])));

// --- 2. configured is a presence check, by name ------------------------------------------
{
  const before = process.env.OPENAI_API_KEY;
  delete process.env.OPENAI_API_KEY;
  const unset = providerStatus(namesFromEnv()).find((p) => p.id === "openai");
  check("an unset provider reports configured: false", unset?.configured === false);
  check("...and still reports the NAME of the variable it wants",
    unset?.env_key === "OPENAI_API_KEY");

  process.env.OPENAI_API_KEY = "sk-test-presence";
  const set = providerStatus(namesFromEnv()).find((p) => p.id === "openai");
  check("a set provider reports configured: true", set?.configured === true);

  // The whole point of the shape: a snapshot can go to a browser as-is.
  check("a status snapshot carries no key material",
    !JSON.stringify(providerStatus(namesFromEnv())).includes("sk-test-presence"),
    JSON.stringify(providerStatus(namesFromEnv())));

  // Which provider Jaroku itself thinks with. Reported rather than hardcoded in the UI,
  // because connecting OpenAI alone lets an AGENT run on GPT and does not make planning or
  // generation work — a user told that up front does not go looking for the bug.
  check("anthropic is flagged as the one that powers Jaroku itself",
    providerStatus(namesFromEnv()).find((p) => p.id === "anthropic")?.powers_jaroku === true);
  check("openai is not", providerStatus(namesFromEnv()).find((p) => p.id === "openai")?.powers_jaroku === false);

  if (before === undefined) delete process.env.OPENAI_API_KEY;
  else process.env.OPENAI_API_KEY = before;
}

// --- 3. an empty key never reaches the network -------------------------------------------
//
// Not politeness: "Test connection" with an empty field must answer instantly and locally
// rather than spending a round trip to be told what we already knew.
{
  const blank = await verifyProviderKey("openai", "   ");
  check("a blank key is refused without a call", !blank.ok && blank.message === "no key was entered");
}

// --- 4. connecting a provider writes exactly one correctly named line ---------------------
//
// The verification the brief asks for, made mechanical: after connecting, the file should be
// hand-readable and every pre-existing line untouched.
{
  const p = tmpEnv(ORIGINAL);
  const key = "sk-ant-onboarding-test";
  const res = setEnvVar(p, PROVIDER_ENV_KEY.anthropic, key);
  check("the write succeeds", res.ok);

  const after = readFileSync(p, "utf8");
  const lines = after.split("\n").filter((l) => l.trim().startsWith("ANTHROPIC_API_KEY"));
  check("exactly one ANTHROPIC_API_KEY line exists", lines.length === 1, String(lines.length));
  check("...and it is the one a human would have typed",
    lines[0] === `ANTHROPIC_API_KEY=${key}`, lines[0]);

  // Every original line survives byte-for-byte — comment, blank line, quoting and all.
  for (const original of ORIGINAL.split("\n").filter((l) => l.length)) {
    check(`untouched: ${original.slice(0, 32)}`, after.includes(original));
  }

  // It has to read back through the REAL loader, or the key is on disk and inert.
  delete process.env.ANTHROPIC_API_KEY;
  loadRuntimeEnv(p);
  check("the key round-trips through the real loader",
    process.env.ANTHROPIC_API_KEY === key);
  check("...so providerStatus now says configured",
    providerStatus(namesFromEnv()).find((x) => x.id === "anthropic")?.configured === true);

  check("the write result hands nothing back", !JSON.stringify(res).includes(key), JSON.stringify(res));
  delete process.env.ANTHROPIC_API_KEY;
}

// --- 5. re-connecting replaces rather than appends ----------------------------------------
//
// A user who mistypes a key and fixes it should end up with one key, not a file where the
// dead one shadows the live one depending on which the loader reaches first.
{
  const p = tmpEnv(ORIGINAL);
  setEnvVar(p, PROVIDER_ENV_KEY.openai, "sk-first");
  setEnvVar(p, PROVIDER_ENV_KEY.openai, "sk-second");
  const after = readFileSync(p, "utf8");
  const lines = after.split("\n").filter((l) => l.trim().startsWith("OPENAI_API_KEY"));
  check("replacing a key leaves one line", lines.length === 1, String(lines.length));
  check("...holding the new value", lines[0] === "OPENAI_API_KEY=sk-second", lines[0]);
  check("the old key is gone from the file entirely", !after.includes("sk-first"));
  delete process.env.OPENAI_API_KEY;
}

for (const p of paths) rmSync(p, { force: true });
console.log(fail === 0 ? "\nALL CORRECT" : `\n${fail} FAILURES`);
process.exit(fail === 0 ? 0 : 1);
