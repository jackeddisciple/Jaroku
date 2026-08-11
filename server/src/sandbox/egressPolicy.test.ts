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

  // ONE ADDRESS, MANY SPELLINGS. Every entry below is one of the addresses already denied above,
  // written another legal way. A rule that matches the TEXT of an address rather than the address
  // admits all of these, which is what an earlier version of this module did — a DNS answer of
  // `::ffff:a9fe:a9fe` got pinned into a run's egress allowlist as a permitted destination, and it
  // is the cloud metadata endpoint.
  ["::ffff:a9fe:a9fe", "the metadata endpoint, IPv4-mapped in hex rather than dotted"],
  ["::ffff:7f00:1", "loopback, IPv4-mapped in hex"],
  ["::ffff:0a00:1", "RFC1918, IPv4-mapped in hex"],
  ["0:0:0:0:0:ffff:169.254.169.254", "the metadata endpoint, IPv4-mapped and fully expanded"],
  ["::FFFF:169.254.169.254", "the metadata endpoint, IPv4-mapped in upper case"],
  ["::169.254.169.254", "the metadata endpoint, deprecated IPv4-compatible form"],
  ["::7f00:1", "loopback, IPv4-compatible in hex"],
  ["fea0::1", "link-local — fe80::/10 is a ten-bit prefix, not the four characters \"fe80\""],
  ["febf::1", "link-local, the top of fe80::/10"],
  ["fe80::1%eth0", "link-local carrying a zone id"],
  ["64:ff9b::a9fe:a9fe", "the metadata endpoint behind the NAT64 well-known prefix"],
  ["2002:a9fe:a9fe::1", "the metadata endpoint as a 6to4 gateway"],
  ["ff02::1", "IPv6 multicast"],
  ["2001:db8::1", "documentation range"],
  ["2001::1", "Teredo"],
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
  ["::ffff:1.1.1.1", "a public address in IPv4-mapped form is still public"],
  ["::ffff:101:101", "the same one in hex — unwrapping must not deny by default either"],
  ["2003::1", "just past the Teredo prefix"],
  ["2002:0101:0101::1", "6to4 over a public gateway"],
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

// --- a host that IS an address ------------------------------------------------------------
//
// A control-plane URL, an object-store endpoint and a DATABASE_URL are all written by an
// operator or a user, and any of them may legitimately be a bare IP. Sending one to a DNS
// resolver asks a question with no answer — dns.resolve4("52.1.2.3") refuses it as "not a
// hostname" — and the refusal used to come back as "did not resolve to any address", which is
// a policy denial. The denial check still applies; only the lookup is skipped.

await (async () => {
  // The resolver throws for anything it is asked, so reaching it at all is itself the failure.
  const neverAsked: Resolver = async (host) => {
    throw new Error(`resolver was asked about ${host}, which is already an address`);
  };
  const ips = await resolveAndPin("52.1.2.3", neverAsked);
  check("a literal public IPv4 host pins to itself without a lookup", ips.length === 1 && ips[0] === "52.1.2.3");

  const v6 = await resolveAndPin("2606:4700:4700::1111", neverAsked);
  check("a literal public IPv6 host does too", v6.length === 1 && v6[0] === "2606:4700:4700::1111");

  const bracketed = await resolveAndPin("[2606:4700:4700::1111]", neverAsked);
  check("...including the bracketed form a URL's hostname carries", bracketed[0] === "2606:4700:4700::1111");

  check(
    "a literal PRIVATE host is still refused, by the same rule as a resolved one",
    await expectThrow(resolveAndPin("169.254.169.254", neverAsked), "private/link-local/reserved"),
  );
  check(
    "...and so is its IPv6 spelling",
    await expectThrow(resolveAndPin("::ffff:a9fe:a9fe", neverAsked), "private/link-local/reserved"),
  );
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
    "control.example.com": { v4: ["93.184.216.41"] }, // deliberately NOT used — see below
  });
  const policy = await buildEgressPolicy(
    { runId: "r1", provider: "anthropic", connectors: ["gmail"] },
    resolver,
  );
  const hosts = policy.rules.map((r) => r.host).sort();
  check(
    "the policy grants exactly the provider + the connector's fixed hosts",
    hosts.join(",") === "api.anthropic.com,gmail.googleapis.com,oauth2.googleapis.com",
    hosts.join(","),
  );
  check("admits() recognises a granted, pinned address", admits(policy, "160.79.104.10", 443));
  check("admits() refuses an address nothing resolved to", !admits(policy, "1.2.3.4", 443));
})();

await (async () => {
  // Postgres is the one connector without a fixed host — its host is whatever the workspace's
  // own DATABASE_URL validated to (databaseUrl.ts), threaded through as an already-pinned value.
  const resolver = fakeResolver({});
  let threwWithoutOne = false;
  try {
    await buildEgressPolicy({ runId: "r5", provider: "fake", connectors: ["postgres"] }, resolver);
  } catch (e) {
    threwWithoutOne = e instanceof EgressPolicyError;
  }
  check("selecting postgres without a validated DATABASE_URL is refused", threwWithoutOne);

  const policy = await buildEgressPolicy(
    {
      runId: "r6",
      provider: "fake",
      connectors: ["postgres"],
      databaseUrl: { host: "db.example.com", port: 5432, ips: ["93.184.216.40"] },
    },
    resolver,
  );
  check(
    "a validated DATABASE_URL becomes exactly one rule for its own pinned address",
    policy.rules.length === 1 && admits(policy, "93.184.216.40", 5432),
  );

  let threwUnselected = false;
  try {
    await buildEgressPolicy(
      { runId: "r7", provider: "fake", connectors: [], databaseUrl: { host: "db.example.com", port: 5432, ips: ["93.184.216.40"] } },
      resolver,
    );
  } catch (e) {
    threwUnselected = e instanceof EgressPolicyError;
  }
  check("a databaseUrl with postgres not selected is refused rather than silently granted", threwUnselected);
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
