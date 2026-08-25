// The three connectors this release added, at the boundary where their hosts become a policy —
// and the one rule in Jaroku that is deliberately written twice.
//
// TWO OF THEM ARE ORDINARY. Google Calendar and Stripe have fixed hosts in `CONNECTOR_HOSTS`,
// reviewed once, and the only thing worth asserting is that selecting one grants exactly its own
// and nothing adjacent. The interesting case is the third.
//
// THE HTTP CONNECTOR'S EGRESS IS WHATEVER A WORKSPACE TYPED, which makes it the third SSRF vector
// in this system after `DATABASE_URL` and an MCP endpoint — and it is handled the way both of
// those are: validated in a module that owns that judgement, resolved fresh at policy-build time,
// pinned, and handed to `buildEgressPolicy` finished. The assertion this suite exists for is the
// one the specification names directly: an ALLOWED domain that resolves to a private address must
// be refused. Allowed is not the same as reachable, and a builder that trusted its own allowlist
// would be one where adding `metadata.example.com` to a text field is a metadata-server read.
//
// AND THE BLOCK LIST IS ASSERTED AGAINST THE PYTHON ONE. `sandbox/egressPolicy.ts` refuses private
// ranges for the policy; `runtime/tool_templates/http_connector.py` refuses them again inside the
// sandbox, because the control plane cannot make this check for a request the sandbox originates
// and the sandbox cannot call TypeScript. Two copies of a rule is normally how they drift — so the
// drift is what is tested, in both directions, by reading the other file's own list. A block added
// to one and forgotten in the other fails here rather than in whichever half was not consulted.
//
//   npm run test:egress-connectors

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { buildEgressPolicy, EgressPolicyError, isDeniedAddress, type Resolver } from "./egressPolicy.ts";
import { normaliseAllowedDomain, parseAllowedDomains } from "../connectorSecrets.ts";

let fail = 0;
const check = (name: string, ok: boolean, detail = ""): void => {
  if (ok) console.log(`  ok   ${name}`);
  else {
    fail++;
    console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ""}`);
  }
};

const fakeResolver =
  (table: Record<string, { v4?: string[]; v6?: string[] }>): Resolver =>
  async (host) => {
    const found = table[host];
    if (!found) throw new Error(`no fixture for ${host}`);
    return { v4: found.v4 ?? [], v6: found.v6 ?? [] };
  };

const PUBLIC = { v4: ["93.184.216.34"] };

// --- the two static ones -----------------------------------------------------------------------

console.log("\nthe two connectors with fixed hosts grant exactly their own");
await (async () => {
  const resolver = fakeResolver({
    "www.googleapis.com": PUBLIC,
    "oauth2.googleapis.com": PUBLIC,
    "gmail.googleapis.com": PUBLIC,
    "api.stripe.com": PUBLIC,
    "slack.com": PUBLIC,
  });

  const stripe = await buildEgressPolicy({ runId: "s1", provider: "fake", connectors: ["stripe"] }, resolver);
  check("stripe grants api.stripe.com", stripe.rules.map((r) => r.host).join(",") === "api.stripe.com");
  check(
    "...and nothing else — no files.stripe.com granted 'in case'",
    stripe.rules.length === 1,
    stripe.rules.map((r) => r.host).join(","),
  );

  const calendar = await buildEgressPolicy({ runId: "s2", provider: "fake", connectors: ["google_calendar"] }, resolver);
  check(
    "google_calendar grants the Calendar API host and the token endpoint",
    calendar.rules.map((r) => r.host).sort().join(",") === "oauth2.googleapis.com,www.googleapis.com",
  );
  check(
    "...and NOT the Gmail API host, or the two connections would be separate everywhere but the network",
    !calendar.rules.some((r) => r.host === "gmail.googleapis.com"),
  );
})();

// --- the dynamic one ----------------------------------------------------------------------------

console.log("\nthe http connector's rules come from the workspace's own list, pinned");
await (async () => {
  const resolver = fakeResolver({ "api.example.com": PUBLIC, "hooks.example.net": { v4: ["93.184.216.35"] } });
  const rules = [
    { host: "api.example.com", ips: ["93.184.216.34"], ports: [443], reason: "the http connector's allowlist" },
    { host: "hooks.example.net", ips: ["93.184.216.35"], ports: [443], reason: "the http connector's allowlist" },
  ];
  const policy = await buildEgressPolicy(
    { runId: "h1", provider: "fake", connectors: ["http"], httpRules: rules },
    resolver,
  );
  check("both allowed domains are in the policy", policy.rules.length === 2);
  check("...pinned to literal addresses", policy.rules.every((r) => r.ips.every((ip) => /^\d+\.\d+\.\d+\.\d+$/.test(ip))));
  check("...on 443 only, because the template refuses anything that is not https", policy.rules.every((r) => r.ports.join() === "443"));
})();

console.log("\nand an empty allowlist is a run that starts and a tool that refuses, not a run that will not start");
await (async () => {
  const policy = await buildEgressPolicy(
    { runId: "h2", provider: "fake", connectors: ["http"], httpRules: [] },
    fakeResolver({}),
  );
  check("no rules, no throw", policy.rules.length === 0);
  // The reasoning is worth stating: postgres THROWS in the same position, because a postgres run
  // with no host cannot work and its failure would name nothing. The HTTP template raises at its
  // first call with a sentence naming HTTP_ALLOWED_DOMAINS, which is a better place to learn it.
})();

console.log("\nand rules nothing selected are refused rather than quietly granted");
await (async () => {
  let threw = false;
  try {
    await buildEgressPolicy(
      {
        runId: "h3",
        provider: "fake",
        connectors: [],
        httpRules: [{ host: "api.example.com", ips: ["93.184.216.34"], ports: [443], reason: "x" }],
      },
      fakeResolver({}),
    );
  } catch (e) {
    threw = e instanceof EgressPolicyError;
  }
  check("granting a sandbox hosts no connector asked for is an error, not a widening", threw);
})();

// --- the assertion the specification names by name -------------------------------------------------

console.log("\nAN ALLOWED DOMAIN THAT RESOLVES TO A PRIVATE ADDRESS IS REFUSED");
await (async () => {
  // Driven through the same `resolveAndPin` the builder uses, because the point is that being on
  // the allowlist buys nothing at all against the address check. `resolveAndPin` is what
  // `ConnectorSecrets.httpEgress` calls per domain, and a refusal there is a domain that
  // contributes no rule.
  const { resolveAndPin } = await import("./egressPolicy.ts");
  for (const [ip, what] of [
    ["169.254.169.254", "the cloud metadata endpoint"],
    ["127.0.0.1", "loopback"],
    ["10.0.1.7", "RFC1918"],
    ["100.64.0.1", "carrier-grade NAT"],
  ] as const) {
    const resolver = fakeResolver({ "metadata.example.com": { v4: [ip] } });
    let refused = false;
    try {
      await resolveAndPin("metadata.example.com", resolver);
    } catch (e) {
      refused = e instanceof EgressPolicyError;
    }
    check(`an allowed domain resolving to ${what} is refused`, refused);
  }

  // And the half that a "check the first answer" implementation gets wrong.
  const mixed = fakeResolver({ "half.example.com": { v4: ["93.184.216.34", "169.254.169.254"] } });
  let refusedWhole = false;
  try {
    await resolveAndPin("half.example.com", mixed);
  } catch (e) {
    refusedWhole = e instanceof EgressPolicyError;
  }
  check("...and one good answer beside one bad one refuses the host WHOLE", refusedWhole);
})();

// --- the two block lists, held to each other ---------------------------------------------------------

console.log("\nthe Node refusal and the Python one refuse the same blocks");
{
  const templatePath = join(
    fileURLToPath(new URL("../../..", import.meta.url)),
    "runtime",
    "tool_templates",
    "http_connector.py",
  );
  const template = readFileSync(templatePath, "utf8");
  const block = template.slice(template.indexOf("DENIED_BLOCKS"), template.indexOf("class HttpRefused"));
  const pythonCidrs = [...block.matchAll(/"([0-9a-fA-F.:]+\/\d+)"/g)].map((m) => m[1]!);
  check(`the template's list was found and parsed (${pythonCidrs.length} blocks)`, pythonCidrs.length >= 20, String(pythonCidrs.length));

  // Direction one: everything Python refuses, Node refuses. A representative address per block —
  // the network address plus one, which is inside every prefix here.
  const sampleOf = (cidr: string): string => {
    const [base = "", bits = "0"] = cidr.split("/");
    if (base.includes(":")) {
      // A v6 sample: the prefix with a 1 in the last group, which stays inside every prefix used.
      return base === "::" && bits === "128" ? "::" : `${base.replace(/::$/, "::")}1`.replace(/^::1$/, "::1");
    }
    const parts = base.split(".").map(Number);
    parts[3] = (parts[3]! + 1) & 0xff;
    return parts.join(".");
  };

  const missedByNode = pythonCidrs.filter((cidr) => !isDeniedAddress(sampleOf(cidr)));
  check("every block the template refuses, the egress policy refuses too", missedByNode.length === 0, missedByNode.join(", "));

  // Direction two: everything Node refuses, Python refuses — read off Node's own source, so a
  // block added there and forgotten in the template fails here.
  const policyPath = join(fileURLToPath(new URL(".", import.meta.url)), "egressPolicy.ts");
  const policySource = readFileSync(policyPath, "utf8");
  const v4Block = policySource.slice(
    policySource.indexOf("const DENIED_IPV4_BLOCKS"),
    policySource.indexOf("function ipv4ToInt"),
  );
  const nodeCidrs = [...v4Block.matchAll(/\["([\d.]+)",\s*(\d+)\]/g)].map((m) => `${m[1]}/${m[2]}`);
  check(`the policy's own list was found and parsed (${nodeCidrs.length} blocks)`, nodeCidrs.length >= 14, String(nodeCidrs.length));
  const missedByPython = nodeCidrs.filter((cidr) => !pythonCidrs.includes(cidr));
  check(
    "every IPv4 block the egress policy refuses is named in the template too",
    missedByPython.length === 0,
    missedByPython.join(", "),
  );

  // The one that started this: it is not is_private in Python 3.12 and it is in neither list by
  // accident. Named on its own so a failure says which block, not "the lists differ".
  check("100.64.0.0/10 is in both, having been in neither by default", pythonCidrs.includes("100.64.0.0/10") && isDeniedAddress("100.64.0.1"));
}

// --- the allowlist parser ------------------------------------------------------------------------------

console.log("\nthe allowlist parser agrees with the template's, which is why both lists live in one comment");
// The same examples the Python suite asserts, deliberately: two parsers that disagree about what a
// user typed produce a workspace that configured the connector and cannot use it, or a request the
// policy never granted and whose failure names nothing.
for (const good of ["api.example.com", "HOOKS.Example.NET", "a.b.c.example.com", "xn--80ak6aa92e.com"]) {
  check(`${JSON.stringify(good)} is a domain`, normaliseAllowedDomain(good) !== null);
}
for (const bad of ["*.example.com", "https://api.example.com", "api.example.com/path", "api.example.com:443", "localhost", "", "  ", "a..b.com", "user@example.com"]) {
  check(`${JSON.stringify(bad)} is not`, normaliseAllowedDomain(bad) === null, String(normaliseAllowedDomain(bad)));
}
check("case and a trailing dot normalise away", normaliseAllowedDomain("API.Example.COM.") === "api.example.com");

{
  const parsed = parseAllowedDomains("api.example.com, HOOKS.example.net ,api.example.com, *.bad.com");
  check("duplicates collapse", parsed.domains.length === 2, parsed.domains.join(","));
  check("...normalised", parsed.domains.join(",") === "api.example.com,hooks.example.net", parsed.domains.join(","));
  check("...and the wildcard is reported rather than dropped in silence", parsed.rejected.join(",") === "*.bad.com");
}
check("an empty value yields nothing and no complaint about nothing", parseAllowedDomains("").domains.length === 0);

console.log(fail === 0 ? "\nALL CORRECT" : `\n${fail} FAILURES`);
process.exit(fail === 0 ? 0 : 1);
