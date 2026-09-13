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
  PROVIDER_CAPABILITY, availableSubscriptionProviders, capabilityOf, localAgentFor, mapEffort,
  reasoningLevels, runtimeApiProviders, subscriptionAvailable, supportedSubscriptionProviders,
} from "./capability.ts";
import { EFFORT_LEVELS } from "../effort.ts";

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
    check(`${id} has a verdict`, id in PROVIDER_CAPABILITY);
    check(`...keyed by its own id`, capabilityOf(id).id === id);
  }
  const extra = Object.keys(PROVIDER_CAPABILITY).filter((k) => !(PROVIDER_IDS as string[]).includes(k));
  check("...and no verdict names a provider that does not exist", extra.length === 0, extra.join(","));
}

console.log("\nthe four booleans cannot contradict each other");
{
  for (const id of PROVIDER_IDS) {
    const c = capabilityOf(id);
    // Available without supported would be a provider we permit ourselves to use through a
    // mechanism we have not established exists.
    check(`${id}: available implies supported`, !c.subscriptionChatAvailable || c.subscriptionChatSupported);
    // Approval is the NAME of the gap between supported and available. Claiming one while already
    // available would mean the product asks for permission it is not waiting on.
    check(`${id}: approval is only pending while gated`, !c.requiresProviderApproval || !c.subscriptionChatAvailable);
    // A usable mechanism has to exist for a provider we say is usable.
    check(`${id}: available implies a mechanism`, !c.subscriptionChatAvailable || c.mechanism !== null);
    // Every gated or unsupported provider owes the user a sentence.
    check(`${id}: unavailable implies a reason`, c.subscriptionChatAvailable || (c.reason ?? "").length > 40);
    check(`${id}: cites the page it was read from`, /^https:\/\//.test(c.citation), c.citation);
  }
}

console.log("\nagent runtime is independent of every one of them");
{
  // The product owner's rule: Muse Spark stays a first-class runtime provider while having no
  // subscription path at all. If these two sets were ever forced to agree, gating a provider for
  // Chat would silently remove it from Test — which is the two credential systems leaking.
  check("all three providers run agents on an API key", runtimeApiProviders().join(",") === PROVIDER_IDS.join(","));
  check("...including the one with no subscription path", capabilityOf("meta").runtimeApiSupported);
  check("...and the one still awaiting approval", capabilityOf("anthropic").runtimeApiSupported);
}

console.log("\nan approval carries a complete mechanism, and it is delegation");
{
  for (const id of PROVIDER_IDS) {
    const m = localAgentFor(id);
    if (!m) continue;
    check(`${id} names the binary the user installs`, m.binary.length > 0);
    check(`${id} signs in with the PROVIDER'S command`, m.loginCommand[0] === m.binary, m.loginCommand.join(" "));
    check(`${id} drives a documented subprocess mode`, m.serve.argv[0] === m.binary, m.serve.argv.join(" "));
    check(`${id} cites the page that sanctions embedding`, /^https:\/\//.test(m.citation));
    check(`${id} quotes the sanctioning sentence`, m.sanction.length > 40);
  }
  // THE ONE FLAG THAT WOULD SILENTLY MOVE CLAUDE ONTO API BILLING. `--bare` "never reads OAuth
  // credentials or the system keychain" and wants ANTHROPIC_API_KEY instead, so a subscription
  // chat that passed it would spend the wrong pool with nothing appearing to go wrong.
  const claude = localAgentFor("anthropic")!;
  check("Claude is never driven with --bare", !claude.serve.argv.includes("--bare"), claude.serve.argv.join(" "));
  check("...and is driven with -p, the documented programmatic mode", claude.serve.argv.includes("-p"));
}

console.log("\nthe verdicts are the ones verified on 2026-09-13");
{
  // Pinned deliberately. If a provider changes its terms, this suite should fail and force somebody
  // to re-read them — silently inheriting a new verdict is the failure this whole file prevents.
  const claude = capabilityOf("anthropic");
  check("Claude's mechanism is supported", claude.subscriptionChatSupported);
  // Permitted by the legal page's "Can customers offer Claude Code in their products?", whose four
  // conditions this integration meets. The remaining obligation — accepting Anthropic's Commercial
  // Terms — is the product owner's to accept once, and is not something code can assert.
  check("...and available, under that section's conditions", claude.subscriptionChatAvailable);
  check("...needing no per-integration approval", !claude.requiresProviderApproval);
  check("...so it offers no unblock, having nothing to unblock", claude.unblock === null && claude.reason === null);
  check("...citing the page that permits it", claude.citation.endsWith("/legal-and-compliance"), claude.citation);
  check("...and signing in with Anthropic's own command", claude.mechanism?.loginCommand.join(" ") === "claude auth login");

  check("Codex is available", subscriptionAvailable("openai"));
  check("...through codex app-server", localAgentFor("openai")?.serve.argv.join(" ") === "codex app-server");
  check("...signing in with codex login", localAgentFor("openai")?.loginCommand.join(" ") === "codex login");
  check("...needing no approval", !capabilityOf("openai").requiresProviderApproval);

  const meta = capabilityOf("meta");
  check("Muse Spark has no subscription mechanism at all", !meta.subscriptionChatSupported && meta.mechanism === null);
  check("...so there is nothing to approve", !meta.requiresProviderApproval && meta.unblock === null);

  check("both providers with a mechanism are connectable", availableSubscriptionProviders().join(",") === "anthropic,openai");
  check("...which is exactly the set that has one", supportedSubscriptionProviders().join(",") === "anthropic,openai");
  // The gate still exists and still has something behind it — Muse Spark. If this ever passes
  // because every provider became available, the mechanism this file guards has stopped being
  // exercised by anything.
  check("...and a provider without one is still refused", !subscriptionAvailable("meta"));
}

console.log("\neffort maps to each provider's real parameter, never a shared invention");
{
  // The three do not agree, and the table must not pretend they do.
  check("Claude's parameter is its slash command", capabilityOf("anthropic").reasoning?.param === "/effort");
  check("Codex's parameter is model_reasoning_effort", capabilityOf("openai").reasoning?.param === "model_reasoning_effort");
  check("Muse Spark has no reasoning control", capabilityOf("meta").reasoning === null);
  check("...so it offers no levels", reasoningLevels("meta").length === 0);

  // Codex stops at xhigh. Max must CLAMP to a value the CLI accepts rather than be sent through.
  const maxOnCodex = mapEffort("openai", "max");
  check("Max clamps to xhigh on Codex", maxOnCodex.value === "xhigh", String(maxOnCodex.value));
  check("...and reports xhigh as the level actually applied", maxOnCodex.applied === "xhigh", String(maxOnCodex.applied));
  check("Max is unclamped on Claude", mapEffort("anthropic", "max").value === "max");
  check("Muse Spark is sent nothing at all", mapEffort("meta", "high").value === null);

  // Every level a provider OFFERS must map to a value it accepts — an offered stop that sends
  // nothing is a control that silently does nothing when a user moves it.
  for (const id of PROVIDER_IDS) {
    const levels = reasoningLevels(id);
    check(`${id}: every offered level maps to a real value`,
      levels.every((l) => mapEffort(id, l).value !== null), levels.join(","));
    const accepted = capabilityOf(id).reasoning?.levels ?? [];
    check(`${id}: never offers a level outside Jaroku's five`,
      accepted.every((l) => (EFFORT_LEVELS as readonly string[]).includes(l)));
  }
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
