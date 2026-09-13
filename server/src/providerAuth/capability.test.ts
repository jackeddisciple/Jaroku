// The capability gate, and the property that makes it a gate rather than a comment.
//
// The thing under test is not a function — it is a TABLE OF VERDICTS about what three companies
// permit, and the risk it carries is that somebody flips one without re-reading the terms. So the
// assertions here are mostly structural: every provider is decided, every "no" carries the sentence
// and the page it came from, every "yes" carries a complete mechanism, and — the one that matters —
// nothing in this module can be talked out of a verdict by the environment.
//
//   npm run test:provider-auth-capability

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { PROVIDER_IDS } from "../providers.ts";
import {
  SUBSCRIPTION_SUPPORT, availableSubscriptionProviders, localAgentFor, subscriptionAvailable,
  subscriptionSupport,
} from "./capability.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const SOURCE = readFileSync(join(HERE, "capability.ts"), "utf8");

/**
 * The source with its comments and string literals removed — i.e. the part that EXECUTES.
 *
 * Needed because this file's prose is largely about what it deliberately does not do, so a raw text
 * scan cannot tell a prohibition from a violation: the comment "never reads PROVIDER_ENV_KEY" and
 * an actual read of it are the same characters. The user-facing reasons are string literals for the
 * same reason — Meta's gated row quotes "set META_API_KEY instead", which is the provider's own
 * sentence and the most useful thing that row can say.
 */
const CODE = SOURCE
  .replace(/\/\*[\s\S]*?\*\//g, " ")
  .replace(/\/\/[^\n]*/g, " ")
  .replace(/"(?:[^"\\]|\\.)*"/g, '""')
  .replace(/'(?:[^'\\]|\\.)*'/g, "''");

let fail = 0;
const check = (name: string, ok: boolean, detail = ""): void => {
  if (ok) console.log(`  ok   ${name}`);
  else { fail++; console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ""}`); }
};

console.log("\nevery provider is decided, and decided once");
{
  for (const id of PROVIDER_IDS) {
    check(`${id} has a verdict`, id in SUBSCRIPTION_SUPPORT);
  }
  const extra = Object.keys(SUBSCRIPTION_SUPPORT).filter((k) => !(PROVIDER_IDS as string[]).includes(k));
  check("...and no verdict names a provider that does not exist", extra.length === 0, extra.join(","));
}

console.log("\na refusal carries its reason and its source");
{
  for (const id of PROVIDER_IDS) {
    const s = subscriptionSupport(id);
    if (s.available) continue;
    check(`${id} says why`, s.reason.length > 40, s.reason);
    check(`${id} cites the page it was read from`, /^https:\/\//.test(s.citation), s.citation);
    // A reason that does not name the provider's own position is a reason we invented.
    check(`${id}'s reason is about the provider, not about us`, !/jaroku/i.test(s.reason));
  }
}

console.log("\nan approval carries a complete mechanism, and it is delegation");
{
  for (const id of PROVIDER_IDS) {
    const m = localAgentFor(id);
    if (!m) continue;
    check(`${id} names the binary the user installs`, m.binary.length > 0);
    check(`${id} signs in with the PROVIDER'S command`, m.loginCommand[0] === m.binary, m.loginCommand.join(" "));
    check(`${id} drives a documented subprocess mode`, m.serve.argv[0] === m.binary, m.serve.argv.join(" "));
    check(`${id} speaks a documented protocol`, m.serve.protocol === "json-rpc-2.0/stdio");
    check(`${id} cites the page that sanctions embedding`, /^https:\/\//.test(m.citation));
    check(`${id} quotes the sanctioning sentence`, m.sanction.length > 40);
  }
}

console.log("\nthe verdicts are the ones verified on 2026-09-13");
{
  // Pinned deliberately. If a provider changes its terms, this suite should fail and force somebody
  // to re-read them — silently inheriting a new verdict is the failure mode this whole file exists
  // to prevent.
  check("Claude is gated on Anthropic's prior approval", !subscriptionAvailable("anthropic"));
  check("...and says the approval exists", (SUBSCRIPTION_SUPPORT.anthropic as { unblock: string | null }).unblock !== null);
  check("Codex is available", subscriptionAvailable("openai"));
  check("...through codex app-server", localAgentFor("openai")?.serve.argv.join(" ") === "codex app-server");
  check("...signing in with codex login", localAgentFor("openai")?.loginCommand.join(" ") === "codex login");
  check("Muse Spark is gated", !subscriptionAvailable("meta"));
  check("...with nothing to unblock it yet", (SUBSCRIPTION_SUPPORT.meta as { unblock: string | null }).unblock === null);
  check("so exactly one provider is connectable today", availableSubscriptionProviders().join(",") === "openai");
}

console.log("\nno environment can talk this module out of a verdict");
{
  // THE LOAD-BEARING ASSERTION. A gate that reads a variable is a gate somebody opens in a shell,
  // and then the shipped product's behaviour depends on how it was launched rather than on what a
  // provider permits. There is no supported way to enable a gated provider, and this is what says so.
  check("it never reads process.env", !/process\.env/.test(CODE));
  check("it holds no flag, toggle or override", !/OVERRIDE|FORCE|ALLOW_|_ENABLED/.test(CODE));
}

console.log("\nthe two credential systems do not meet here");
{
  // The product owner's line: "These credential systems MUST remain completely separate ... API
  // keys must NEVER be inferred from subscription authentication." The cheapest way for that to
  // rot is for this module to learn what an API key is, so it never does.
  // It must not USE the API-key mapping. It may QUOTE a provider that names its own variable —
  // Meta's reason quotes "set META_API_KEY instead", which is the provider's sentence and the most
  // useful thing a gated row can tell somebody. Reading one is already impossible: `process.env`
  // is asserted absent above, so naming a variable here buys no access to it.
  check("it does not use the API-key mapping", !/PROVIDER_ENV_KEY/.test(CODE));
  check("it does not import the secret store", !/secretStore|secrets\//.test(CODE));
  // It imports exactly one thing from the API-key module, and that thing is a NAME.
  const imports = SOURCE.match(/^import \{([^}]*)\} from "\.\.\/providers\.ts";$/m)?.[1] ?? "";
  check("it borrows only the provider id from providers.ts", imports.replace(/\s|type/g, "") === "PROVIDER_IDS,ProviderId", imports.trim());
}

console.log("\ncredential paths are recorded but never opened");
{
  const paths = PROVIDER_IDS.map(localAgentFor).filter((m) => m !== null).map((m) => m!.credentialPath);
  check("every mechanism names where the provider keeps its own credential", paths.every((p) => p.length > 0), paths.join(","));
  // Named for the user's benefit; reading it would be the intermediation every provider forbids.
  check("...and nothing here reads one", !/readFile|openSync|createReadStream/.test(CODE));
}

console.log(fail === 0 ? "\nALL CORRECT" : `\n${fail} FAILURES`);
process.exitCode = fail === 0 ? 0 : 1;
