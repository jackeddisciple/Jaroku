// The whole user loop for the three v0.3.6 connectors, driven through the real objects.
//
// EVERY OTHER SUITE IN THIS RELEASE TESTS ONE SEAM. `test:connector-auth` proves the catalog and
// the code agree about names; `test:connector-stripe` proves the template does the right thing
// with an environment somebody handed it; `test:egress-connectors` proves a policy refuses what it
// should. Each one passes with the seam either side of it broken, and that is exactly how the
// `HTTP_AUTH_HEADER` gap survived: the panel offered a name, the vault stored it, the template
// read it, and nothing in between carried it — three green suites over a value that did nothing.
//
// So this one starts where a user starts and ends where a run starts, through the same objects the
// server wires up: a real SQLite database, real migrations, the real vault, the real secrets
// manager with the real connector validation on it, the real catalog, and the real egress builder.
// No mocks except the resolver, which is injected so the private-range refusal is deterministic.
//
// WHAT IT DELIBERATELY DOES NOT DO is call a model. Generation needs one, and a suite that needed
// an API key is a suite that does not run. The generator's own inputs are asserted instead — which
// connector files would be copied, and which names `.env.example` is built from — because those
// are pure functions of the catalog and are the part that can silently disagree.
//
//   npm run test:connector-loop

import { randomUUID } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { migrate } from "./db/migrate.ts";
import { SqliteDb } from "./db/sqlite.ts";
import { newRequestId, systemContext, systemContextFor, type TenantContext } from "./db/tenant.ts";
import { IdentityRepository } from "./db/repositories/identity.ts";
import { SecretRefRepository } from "./db/repositories/secretRefs.ts";
import { SecretUsageRepository } from "./db/repositories/secretUsages.ts";
import { KmsSecretStore } from "./secrets/kmsSecretStore.ts";
import { LocalMasterKeyProvider } from "./secrets/masterKey.ts";
import { SecretsManager } from "./secrets/manager.ts";
import { ConnectorSecrets, parseAllowedDomains } from "./connectorSecrets.ts";
import {
  configuredUserSecretConnectors, connectionSuppliedEnv, loadConnectors, optionalEnv,
  requiredEnv, resolveSelected, templatesDir, userSuppliedEnv,
} from "./connectors.ts";
import { buildEgressPolicy, type Resolver } from "./sandbox/egressPolicy.ts";
import { isSecretName } from "./secrets/secretStore.ts";

let failures = 0;
const check = (ok: boolean, msg: string, detail = ""): void => {
  if (ok) console.log(`  ok   ${msg}`);
  else {
    failures++;
    console.log(`  FAIL ${msg}${detail ? ` — ${detail}` : ""}`);
  }
};

const ROOT = fileURLToPath(new URL("../..", import.meta.url));
const RUNTIME = join(ROOT, "runtime");
const MIGRATIONS = join(ROOT, "server", "migrations");
const MASTER = "a-master-key-with-enough-entropy-behind-it-0123456789";

// REAL-SHAPED ON PURPOSE — every refusal message below is searched for them — AND ASSEMBLED
// RATHER THAN WRITTEN OUT, which is not fussiness: the first version of this file spelled the
// restricted key contiguously and GitHub's push protection refused the push, having matched a
// Stripe Live API Restricted Key. It was right to. A scanner cannot tell an invented key from a
// real one, and the answer to a true positive on a fake is to stop putting the shape in the
// repository — not to click the button that teaches the repository to allow live Stripe keys
// through. The code under test still receives the whole string; only the source never holds it.
const LIVE = "live";
const STRIPE_KEY = `rk_${LIVE}_51NxSuiteRestrictedReadOnly`;
const FULL_ACCESS_KEY = `sk_${LIVE}_51RealAccountFullAccess`;
const AUTH_HEADER = "Bearer sk-suite-must-not-leak";
const DOMAINS = "api.example.com, HOOKS.Example.NET";

const PUBLIC: Resolver = async (host) =>
  host === "api.stripe.com" ? { v4: ["93.184.216.30"], v6: [] } : { v4: ["93.184.216.34"], v6: [] };

const dir = mkdtempSync(join(tmpdir(), "jaroku-loop-"));
const db = new SqliteDb(join(dir, "loop.db"));
await migrate(db.migrationTarget(), join(MIGRATIONS, "sqlite"), () => {});

const identity = new IdentityRepository(db);
const refs = new SecretRefRepository(db);
const usages = new SecretUsageRepository(db);
const runWorkspaces = new Map<string, string>();
const secrets = new KmsSecretStore({
  db,
  master: new LocalMasterKeyProvider(MASTER),
  refs,
  runWorkspace: async (runId) => runWorkspaces.get(runId) ?? null,
});
const connectorSecrets = new ConnectorSecrets({ secrets, resolver: PUBLIC });
const manager = new SecretsManager({
  secrets,
  refs,
  usages,
  validateConnectorValue: (name, value) => connectorSecrets.unstorableConnectorValue(name, value),
});

const ws = await identity.createWorkspaceUnowned(systemContext(newRequestId()), { name: `loop ${randomUUID().slice(0, 6)}` });
const CTX: TenantContext = systemContextFor(ws.id, newRequestId());
const runFor = (ctx: TenantContext): string => {
  const runId = randomUUID();
  runWorkspaces.set(runId, ctx.workspaceId);
  return runId;
};

const CATALOG = loadConnectors(RUNTIME);
const THREE = ["google_calendar", "stripe", "http"];
const configuredNames = async (): Promise<Set<string>> =>
  new Set((await manager.list(CTX)).filter((s) => s.configured).map((s) => s.name));

// --- 1. the catalog is what the picker and the prompt both read ---------------------------------

console.log("\n1. a user opens the composer and the three connectors are selectable");
{
  for (const id of THREE) {
    const entry = CATALOG.find((c) => c.id === id);
    check(entry !== undefined, `${id} is in the catalog the server validates against`);
    check((entry?.tools.length ?? 0) > 0, `...with tools rendered into the generation prompt`, String(entry?.tools.length));
    check(existsSync(join(templatesDir(RUNTIME), entry?.file ?? "")), `...and its template file exists to be copied`);
  }
  const selected = resolveSelected(CATALOG, [...THREE, "not-a-connector"]);
  check(selected.length === 3, "a client id nothing knows is dropped rather than trusted", String(selected.length));
}

// --- 2. nothing is configured yet, so nothing claims to be --------------------------------------

console.log("\n2. before anything is set up, the deck and the panel agree there is nothing");
{
  const present = configuredUserSecretConnectors(CATALOG, () => false);
  check(present.length === 0, "the composer deck is empty rather than a picture of the product");

  const stored = await configuredNames();
  check(stored.size === 0, "and the vault holds nothing", [...stored].join(","));
}

// --- 3. the user sets each credential, through the path the panel actually uses ------------------

console.log("\n3. the user fills the Connections tab fields, and the rules refuse what they should");
{
  const wildcard = await manager.store(CTX, { name: "HTTP_ALLOWED_DOMAINS", value: "*.example.com", kind: "custom" });
  check(!wildcard.ok, "a wildcard allowlist is refused before it is stored");
  check(/no wildcards/.test(wildcard.message ?? ""), "...with a sentence naming why", wildcard.message ?? "");
  check(!(await configuredNames()).has("HTTP_ALLOWED_DOMAINS"), "...and NOTHING was written — a refusal that stored is not a refusal");

  const fullAccess = await manager.store(CTX, { name: "STRIPE_SECRET_KEY", value: FULL_ACCESS_KEY, kind: "custom" });
  check(!fullAccess.ok, "a full-access live Stripe key is refused");
  check(/rk_live/.test(fullAccess.message ?? ""), "...naming the restricted key to make instead", fullAccess.message ?? "");
  check(!/51RealAccount/.test(fullAccess.message ?? ""), "...and never quoting the key back");
  check(!(await configuredNames()).has("STRIPE_SECRET_KEY"), "...and nothing was written");

  for (const [name, value] of [
    ["HTTP_ALLOWED_DOMAINS", DOMAINS],
    ["HTTP_AUTH_HEADER", AUTH_HEADER],
    ["STRIPE_SECRET_KEY", STRIPE_KEY],
  ] as const) {
    const saved = await manager.store(CTX, { name, value, kind: "custom" });
    check(saved.ok, `${name} is accepted`, saved.message ?? "");
  }

  const stored = await configuredNames();
  check(["HTTP_ALLOWED_DOMAINS", "HTTP_AUTH_HEADER", "STRIPE_SECRET_KEY"].every((n) => stored.has(n)), "all three are in the vault");

  // NOT A VALUE ANYWHERE IN THE METADATA. The panel renders this list, so a mask that was the
  // value would put a live key on every open tab.
  const summaries = await manager.list(CTX);
  const rendered = JSON.stringify(summaries);
  check(!rendered.includes(STRIPE_KEY), "the summary a panel renders carries no Stripe key");
  check(!rendered.includes(AUTH_HEADER), "...and no auth header");
}

// --- 4. the deck and the panel now see them ------------------------------------------------------

console.log("\n4. the composer deck sees what was set up, and says what is half-done");
{
  const configuredSnapshot = await configuredNames();
  const present = configuredUserSecretConnectors(CATALOG, (n) => configuredSnapshot.has(n));
  const ids = present.map((p) => p.connector.id);
  check(ids.includes("stripe") && ids.includes("http"), "stripe and http are in the deck", ids.join(","));
  check(!ids.includes("postgres"), "...and postgres, which nobody configured, is not");
  check(present.every((p) => p.missing.length === 0), "...neither of them carrying a warning, because both are ready");

  // Clear the required name and the connector must stay visible, saying what it lost — the case a
  // "present only when complete" rule gets wrong by making the tile vanish mid-setup.
  const half = configuredUserSecretConnectors(CATALOG, (n) => n === "HTTP_AUTH_HEADER");
  const http = half.find((p) => p.connector.id === "http");
  check(http !== undefined, "an http with only its optional value set is still in the deck");
  check(http?.missing.join(",") === "HTTP_ALLOWED_DOMAINS", "...carrying exactly what it needs", http?.missing.join(","));
}

// --- 5. generation would copy the reviewed files and build the right .env.example ----------------

console.log("\n5. generating an agent with all three copies the reviewed templates verbatim");
{
  const selected = resolveSelected(CATALOG, THREE);

  for (const c of selected) {
    const source = join(templatesDir(RUNTIME), c.file);
    check(existsSync(source), `tools/${c.file} is on disk to copy`);
    const text = readFileSync(source, "utf8");
    check(text.includes("TEMPLATE_TOOLS"), `...and declares TEMPLATE_TOOLS, which the wiring check follows`);
    const declared = c.tools.map((t) => t.name);
    check(declared.every((n) => text.includes(`def ${n}(`)), `...and defines every tool the catalog advertises`, declared.join(","));
  }

  // The two lists `.env.example` is built from, plus the third this release added.
  const toFill = userSuppliedEnv(selected);
  const documented = connectionSuppliedEnv(selected);
  const optional = optionalEnv(selected);

  check(toFill.includes("STRIPE_SECRET_KEY") && toFill.includes("HTTP_ALLOWED_DOMAINS"), "the user_secret keys are blanks to fill in", toFill.join(","));
  check(documented.includes("GCAL_REFRESH_TOKEN"), "the OAuth keys are documented rather than demanded", documented.join(","));
  check(!toFill.some((k) => k.startsWith("GCAL_")), "...and are not presented as blanks");
  check(optional.join(",") === "HTTP_AUTH_HEADER", "and the optional one is documented too, or an exported project loses it", optional.join(","));
  check(!requiredEnv(selected).includes("HTTP_AUTH_HEADER"), "...without joining the list a deploy refuses over");
}

// --- 6. THE SEAM THAT WAS BROKEN: what a run's environment actually contains ---------------------

console.log("\n6. the run receives every name the panel offered, under the name the template reads");
{
  const selected = resolveSelected(CATALOG, THREE);
  const runId = runFor(CTX);

  // Assembled exactly as index.ts assembles it: the agent's required_env, then the optional names
  // its connectors read. Both from the AGENT's own connector list, never from a client.
  const required = requiredEnv(selected).filter(isSecretName);
  const optional = optionalEnv(selected).filter(isSecretName).filter((n) => !required.includes(n));
  const env: Record<string, string> = {
    ...(await secrets.getForRun(runId, required)),
    ...(await secrets.getForRun(runId, optional)),
  };

  check(env["STRIPE_SECRET_KEY"] === STRIPE_KEY, "the Stripe key arrives, byte for byte");
  check(env["HTTP_ALLOWED_DOMAINS"] !== undefined, "the allowlist arrives");
  check(
    env["HTTP_AUTH_HEADER"] === AUTH_HEADER,
    "AND THE OPTIONAL HEADER ARRIVES — the seam that was broken, where a stored value reached no run",
    String(env["HTTP_AUTH_HEADER"]),
  );

  // STORED AS TYPED, AND NORMALISED BY EVERY READER — which is worth asserting rather than
  // assuming, because the alternative design is the one that breaks. Writing a normalised copy
  // would mean the panel showed somebody a list they did not type, and it would put the
  // normalisation on ONE of the write paths while the Secrets tab and the bulk `.env` import
  // wrote whatever they were given. So the value round-trips untouched and both readers fold
  // case and whitespace: the allowlist matches `HOOKS.Example.NET` because the reader lowercases
  // it, not because something rewrote the vault.
  check(env["HTTP_ALLOWED_DOMAINS"] === DOMAINS, "the allowlist round-trips exactly as typed", String(env["HTTP_ALLOWED_DOMAINS"]));
  const parsed = parseAllowedDomains(env["HTTP_ALLOWED_DOMAINS"] ?? "");
  check(
    parsed.domains.join(",") === "api.example.com,hooks.example.net",
    "...and the Node reader folds case and spacing, so an uppercase entry still matches",
    parsed.domains.join(","),
  );
  check(parsed.rejected.length === 0, "...with nothing rejected out of what the panel accepted");
  // The Python reader does the same fold, in its own words. Asserted from its source rather than
  // from a copy of the rule here, so a divergence fails rather than being restated.
  const template = readFileSync(join(templatesDir(RUNTIME), "http_connector.py"), "utf8");
  check(
    /d\.strip\(\)\.lower\(\)\.rstrip\("\."\)/.test(template),
    "...and so does the template, or an allowlist would work on one side of the boundary only",
  );

  // The names the Python templates actually read, from their own source rather than from a list
  // repeated here. This is the cross-language join: a rename on either side fails here.
  for (const [file, names] of [
    ["stripe_connector.py", ["STRIPE_SECRET_KEY"]],
    ["http_connector.py", ["HTTP_ALLOWED_DOMAINS", "HTTP_AUTH_HEADER"]],
  ] as const) {
    const source = readFileSync(join(templatesDir(RUNTIME), file), "utf8");
    for (const name of names) {
      check(source.includes(name), `${file} reads ${name} by that exact name`);
      check(env[name] !== undefined, `...and the run's environment has it`);
    }
  }

  // AND NOTHING ELSE. A run that received a name no selected connector declared would be a
  // widening nobody asked for — the same least-privilege rule the egress policy applies to a socket.
  check(
    Object.keys(env).sort().join(",") === "HTTP_ALLOWED_DOMAINS,HTTP_AUTH_HEADER,STRIPE_SECRET_KEY",
    "and no name beyond what these connectors declare",
    Object.keys(env).join(","),
  );
}

// --- 7. and the sandbox may reach exactly the hosts those connectors need ------------------------

console.log("\n7. the egress policy grants those three connectors and nothing adjacent");
{
  const http = await connectorSecrets.httpEgress(runFor(CTX));
  check(http.refused.length === 0, "both allowed domains resolved and pinned", JSON.stringify(http.refused));
  check(http.rules.map((r) => r.host).sort().join(",") === "api.example.com,hooks.example.net", "...as one rule each", http.rules.map((r) => r.host).join(","));

  const policy = await buildEgressPolicy(
    { runId: "loop", provider: "anthropic", connectors: THREE, httpRules: http.rules },
    async (host) => (host === "api.anthropic.com" ? { v4: ["160.79.104.10"], v6: [] } : PUBLIC(host)),
  );
  const hosts = policy.rules.map((r) => r.host).sort();
  check(
    hosts.join(",") === "api.anthropic.com,api.example.com,api.stripe.com,hooks.example.net,oauth2.googleapis.com,www.googleapis.com",
    "the provider, Calendar's two, Stripe's one and the workspace's own two",
    hosts.join(","),
  );
  check(!hosts.includes("gmail.googleapis.com"), "...and NOT the Gmail API host, which no selected connector needs");
  check(policy.rules.every((r) => r.ips.every((ip) => /^[\d.]+$/.test(ip))), "every rule is pinned to literal addresses");
}

// --- 8. a domain repointed after it was saved is refused at the run, not at the save --------------

console.log("\n8. and a domain that has since been repointed is refused per domain, not per run");
{
  const rebound: Resolver = async (host) =>
    host === "hooks.example.net" ? { v4: ["169.254.169.254"], v6: [] } : { v4: ["93.184.216.34"], v6: [] };
  const later = new ConnectorSecrets({ secrets, resolver: rebound });
  const egress = await later.httpEgress(runFor(CTX));

  check(egress.rules.map((r) => r.host).join(",") === "api.example.com", "the good domain still gets its rule", egress.rules.map((r) => r.host).join(","));
  check(egress.refused.length === 1 && egress.refused[0]?.domain === "hooks.example.net", "...and only the repointed one is refused");
  check(
    /private|link-local|reserved/.test(egress.refused[0]?.reason ?? ""),
    "...for the reason a person can act on",
    egress.refused[0]?.reason ?? "",
  );
  // The whole point of per-domain refusal: one bad entry must not take the agent down.
  check(egress.rules.length > 0, "an agent with four domains and one bad one keeps the other three");
}

// --- 9. and a connector switched off for a conversation is off everywhere ------------------------

console.log("\n9. a connector disabled for the conversation is off in all three places it could reach");
{
  // §12.10, WHICH WAS TRUE FOR ONE OF THE THREE KINDS OF ROW THE DECK OFFERS. The deck lists
  // reviewed connectors, user-secret connectors and MCP servers in one list and lets you disable
  // any of them; the run dispatch applied those decisions to MCP servers alone. Switching Gmail
  // off dimmed a tile, persisted a row, and left its tools bound, its token minted and its host on
  // the egress allowlist.
  //
  // That is a SAFETY control that reads as enforced and is not, and the deck's own care is what
  // makes the inference reasonable: a disabled connector deliberately STAYS in the deck so its
  // absence cannot be misread as a workspace disconnection.
  //
  // The narrowing itself is a one-line intersection; what this suite is for is that the narrowed
  // list reaches all three consumers. Each of them passes with the other two broken, which is
  // exactly how `HTTP_AUTH_HEADER` survived three green suites.
  const enabled = THREE.filter((id) => id !== "stripe");

  const narrowed = await buildEgressPolicy(
    { runId: "loop", provider: "anthropic", connectors: enabled, httpRules: [] },
    async (host) => (host === "api.anthropic.com" ? { v4: ["160.79.104.10"], v6: [] } : PUBLIC(host)),
  );
  const narrowedHosts = narrowed.rules.map((r) => r.host);
  check(!narrowedHosts.includes("api.stripe.com"), "the disabled connector's host is off the egress allowlist", narrowedHosts.join(","));
  check(narrowedHosts.includes("www.googleapis.com"), "...while the ones still on keep theirs");

  // AND ITS CREDENTIAL IS NOT RESOLVED. The security half: an unminted token is not injected, not
  // registered as a protected secret, and not in the environment for model-written Python to read.
  const stripeNames = requiredEnv(resolveSelected(CATALOG, ["stripe"]));
  const narrowedNames = requiredEnv(resolveSelected(CATALOG, enabled));
  check(stripeNames.length > 0, `stripe declares a credential (${stripeNames.join(",")})`);
  check(
    stripeNames.every((n) => !narrowedNames.includes(n)),
    "the disabled connector's credential names are not among those the run resolves",
    narrowedNames.join(","),
  );

  // AND THE SENTENCE THE TOOL GIVES IS THE RIGHT ONE. Without `require_enabled` the failure reads
  // "Stripe is not configured", which sends somebody to the Connections panel to repair a
  // credential that is perfectly fine. It is a different problem with a different fix, one tile
  // away — and it RAISES rather than returning, or the trace records a refusal as a green step.
  const templates = readFileSync(join(ROOT, "runtime", "tool_templates", "__init__.py"), "utf8");
  check(/def require_enabled\(/.test(templates), "the templates package has a shared enablement guard");
  check(/raise RuntimeError\(/.test(templates), "...which raises rather than returning its reason as an answer");
  check(/if allowed is None:/.test(templates), "...and an absent variable means no restriction, as the MCP sentinel does");
  check(/allowed\.strip\(\) == "-"/.test(templates), "...while the sentinel means nothing is allowed, which an empty string could not carry");
  for (const file of ["gmail", "google_calendar", "slack", "postgres", "http_connector", "stripe_connector"]) {
    const source = readFileSync(join(ROOT, "runtime", "tool_templates", file + ".py"), "utf8");
    check(/^from \. import require_enabled$/m.test(source) && /require_enabled\(/.test(source), `${file} consults it`);
  }

  // THE DISPATCH ITSELF, read as text: one narrowed list feeding all three consumers. Three call
  // sites reading `agent.connectors` again would be three chances to forget one.
  const index = readFileSync(join(ROOT, "server", "src", "index.ts"), "utf8");
  check(/const activeConnectors = conversationConnectorIds \?\? agent\?\.connectors \?\? \[\];/.test(index), "the run narrows the agent's list by the conversation's decisions");
  check(/connectors: activeConnectors,/.test(index), "...and resolves credentials from the narrowed list");
  check(/buildRunEgress\(ctx, runId, provider, activeConnectors,/.test(index), "...builds the egress allowlist from it");
  check(/env\.JAROKU_CONNECTORS =/.test(index), "...and sends it to the runtime beside JAROKU_MCP_SERVERS");
}

await db.close();
rmSync(dir, { recursive: true, force: true });

console.log(failures === 0 ? "\nALL CORRECT" : `\n${failures} FAILURES`);
process.exit(failures === 0 ? 0 : 1);
