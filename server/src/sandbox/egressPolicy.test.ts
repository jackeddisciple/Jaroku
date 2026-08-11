// The egress policy's private-range refusal, exercised exhaustively and with no live network —
// a fake Resolver stands in for DNS so DNS rebinding, a mixed public/private answer, and a
// resolver failure are all deterministic rather than dependent on what a real server answers
// today. See the module comment on why the refusal is unconditional.
//
//   npm run test:egress-policy

import {
  admits,
  buildEgressPolicy,
  EgressPolicyError,
  isDeniedAddress,
  resolveAndPin,
  type Resolver,
} from "./egressPolicy.ts";

let fail = 0;
const check = (name: string, ok: boolean, detail = "") => {
  if (ok) console.log(`  ok   ${name}`);
  else { fail++; console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ""}`); }
};

// --- isDeniedAddress: every block the spec names, plus the reserved ranges beside them -----

const DENIED = [
  ["169.254.169.254", "the cloud metadata endpoint"],
  ["169.254.0.1", "link-local, low end"],
  ["169.254.255.255", "link-local, high end"],
  ["127.0.0.1", "loopback"],
  ["127.255.255.255", "loopback, high end"],
  ["10.0.0.1", "RFC1918 10/8"],
  ["10.255.255.255", "RFC1918 10/8, high end"],
  ["172.16.0.1", "RFC1918 172.16/12, low end"],
  ["172.31.255.255", "RFC1918 172.16/12, high end"],
  ["192.168.0.1", "RFC1918 192.168/16"],
  ["192.168.255.255", "RFC1918 192.168/16, high end"],
  ["0.0.0.0", "unspecified"],
  ["100.64.0.1", "carrier-grade NAT"],
  ["192.0.2.1", "TEST-NET-1"],
  ["198.51.100.1", "TEST-NET-2"],
  ["203.0.113.1", "TEST-NET-3"],
  ["224.0.0.1", "multicast"],
  ["::1", "IPv6 loopback"],
  ["::", "IPv6 unspecified"],
  ["fe80::1", "IPv6 link-local"],
  ["fc00::1", "IPv6 unique-local"],
  ["fd12:3456:789a::1", "IPv6 unique-local, another prefix"],
  ["::ffff:169.254.169.254", "IPv4-mapped metadata endpoint"],
  ["::ffff:10.0.0.1", "IPv4-mapped RFC1918"],
] as const;

for (const [ip, label] of DENIED) {
  check(`denies ${ip} (${label})`, isDeniedAddress(ip), `expected denied, got admitted`);
}

const PUBLIC = [
  ["1.1.1.1", "a real public address"],
  ["8.8.8.8", "another real public address"],
  ["172.32.0.1", "just outside the 172.16/12 RFC1918 block"],
  ["172.15.255.255", "just below the 172.16/12 RFC1918 block"],
  ["9.255.255.255", "just below 10/8"],
  ["11.0.0.0", "just above 10/8"],
  ["2606:4700:4700::1111", "a real public IPv6 address"],
] as const;

for (const [ip, label] of PUBLIC) {
  check(`admits ${ip} (${label})`, !isDeniedAddress(ip), `expected admitted, got denied`);
}

check("a bare hostname is not a parseable address and is refused", isDeniedAddress("api.anthropic.com"));
check("garbage is refused, not silently treated as public", isDeniedAddress("not-an-ip"));

// --- resolveAndPin: the "any answer denied -> whole host denied" rule ----------------------

const fakeResolver = (answers: Record<string, { v4?: string[]; v6?: string[] }>): Resolver => {
  return async (host) => {
    const a = answers[host];
    if (!a) throw new Error(`no fixture answer for ${host}`);
    return { v4: a.v4 ?? [], v6: a.v6 ?? [] };
  };
};

async function expectThrow(p: Promise<unknown>, substr: string): Promise<boolean> {
  try {
    await p;
    return false;
  } catch (e) {
    return e instanceof EgressPolicyError && (e as Error).message.includes(substr);
  }
}

await (async () => {
  const allPublic = fakeResolver({ "api.example.com": { v4: ["93.184.216.34"] } });
  const ips = await resolveAndPin("api.example.com", allPublic);
  check("an all-public answer resolves and pins", ips.length === 1 && ips[0] === "93.184.216.34");
})();

await (async () => {
  // The DNS-rebinding shape: one public answer, one that leads straight to the metadata
  // endpoint. Only ONE of the two needs to be dangerous for the whole host to be refused.
  const mixed = fakeResolver({ "evil.example.com": { v4: ["93.184.216.34", "169.254.169.254"] } });
  const denied = await expectThrow(resolveAndPin("evil.example.com", mixed), "private/link-local/reserved");
  check("a mixed public+metadata answer is refused entirely, not filtered down", denied);
})();

await (async () => {
  const allPrivate = fakeResolver({ "internal.example.com": { v4: ["10.0.0.5"] } });
  const denied = await expectThrow(resolveAndPin("internal.example.com", allPrivate), "private/link-local/reserved");
  check("an all-private answer is refused", denied);
})();

await (async () => {
  const empty = fakeResolver({ "nowhere.example.com": {} });
  const denied = await expectThrow(resolveAndPin("nowhere.example.com", empty), "did not resolve");
  check("a host with no records at all is refused, not silently granted nothing", denied);
})();

await (async () => {
  const broken: Resolver = async () => {
    throw new Error("DNS server unreachable");
  };
  const denied = await expectThrow(resolveAndPin("flaky.example.com", broken), "could not resolve");
  check("a resolver failure is refused, never treated as \"no restriction\"", denied);
})();

// --- buildEgressPolicy: provider + connectors, nothing else granted ------------------------

await (async () => {
  const resolver = fakeResolver({
    "api.anthropic.com": { v4: ["160.79.104.10"] },
    "gmail.googleapis.com": { v4: ["142.250.80.10"] },
    "oauth2.googleapis.com": { v4: ["142.250.80.11"] },
    "control.example.com": { v4: ["203.0.113.200"] }, // deliberately NOT used — see below
  });
  const policy = await buildEgressPolicy(
    { runId: "r1", provider: "anthropic", connectors: ["gmail", "postgres"] },
    resolver,
  );
  const hosts = policy.rules.map((r) => r.host).sort();
  check(
    "the policy grants exactly the provider + the connector's fixed hosts",
    hosts.join(",") === "api.anthropic.com,gmail.googleapis.com,oauth2.googleapis.com",
    hosts.join(","),
  );
  check("postgres contributes no fixed host (its host is user-supplied, validated elsewhere)", !hosts.includes("postgres"));
  check("admits() recognises a granted, pinned address", admits(policy, "160.79.104.10", 443));
  check("admits() refuses an address nothing resolved to", !admits(policy, "1.2.3.4", 443));
})();

await (async () => {
  const resolver = fakeResolver({ "api.openai.com": { v4: ["104.18.0.1"] } });
  const policy = await buildEgressPolicy({ runId: "r2", provider: "openai", connectors: [] }, resolver);
  check("openai maps to api.openai.com", policy.rules.some((r) => r.host === "api.openai.com"));
})();

await (async () => {
  const resolver = fakeResolver({});
  const policy = await buildEgressPolicy({ runId: "r3", provider: "fake", connectors: [] }, resolver);
  check("the free dry-run provider grants no network at all", policy.rules.length === 0);
})();

await (async () => {
  const resolver = fakeResolver({});
  let threw = false;
  try {
    await buildEgressPolicy({ runId: "r4", provider: "made-up", connectors: [] }, resolver);
  } catch (e) {
    threw = e instanceof EgressPolicyError;
  }
  check("an unrecognised provider is refused rather than granted no restriction", threw);
})();

console.log(fail === 0 ? "\nALL CORRECT" : `\n${fail} FAILURES`);
process.exit(fail === 0 ? 0 : 1);
