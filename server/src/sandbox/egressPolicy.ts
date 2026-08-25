// What a sandboxed run may talk to, computed fresh for every run rather than granted once and
// assumed. The nice property this falls out of: Jaroku already knows exactly what an agent
// needs to reach, because it is all declared — the one provider it runs on, the connectors it
// was generated with, the MCP servers it was granted. Nothing else is on the list, and the
// list is denied by default rather than built as an exception on top of "everything".
//
// PRIVATE RANGES ARE REFUSED UNCONDITIONALLY, even when something legitimate resolves to one.
// The cloud metadata endpoint (169.254.169.254) is the first thing a sandbox escape reaches
// for — it is how a compromised container steals the credentials of the machine running it —
// and it lives in the same link-local block a misconfigured DNS answer could otherwise hand a
// run by accident. There is no connector, no MCP server and no provider that legitimately needs
// this policy to admit a private address, so the refusal has no override.
//
// DNS IS RESOLVED HERE, AT POLICY-BUILD TIME, AND THE RESULT IS PINNED. A policy that allowed
// "whatever api.example.com resolves to, whenever the sandbox asks" is defeated by DNS
// rebinding: a hostname that answers with a public IP the moment this function checks it and
// with 169.254.169.254 the moment the sandboxed process actually connects. Pinning closes that
// window — the sandbox's network layer is handed literal IPs, never a hostname to re-resolve.

import { promises as dns } from "node:dns";
import { isIP } from "node:net";

export interface EgressRule {
  /** For logging and for the sandbox's own outbound TLS SNI/Host header — never for routing. */
  host: string;
  /** The literal, resolved, pinned addresses this rule admits. Routing decisions read this. */
  ips: string[];
  ports: number[];
  /** Why this rule exists, surfaced in denial messages and audit rows. */
  reason: string;
}

export interface EgressPolicy {
  runId: string;
  rules: EgressRule[];
}

export class EgressPolicyError extends Error {}

const HTTPS_PORT = 443;

/** The one provider a run executes against. Never both — see the module comment on why an
 *  agent's declared provider is the whole of what it may reach for model calls. */
const PROVIDER_HOSTS: Record<string, string> = {
  anthropic: "api.anthropic.com",
  openai: "api.openai.com",
};

/** Fixed hosts a reviewed connector template calls. Postgres has none here — its host comes
 *  from the workspace's own DATABASE_URL and is validated separately (databaseUrl.ts), because
 *  unlike these three it is user-supplied and is exactly the SSRF vector the spec calls out. */
const CONNECTOR_HOSTS: Record<string, string[]> = {
  gmail: ["gmail.googleapis.com", "oauth2.googleapis.com"],
  // Calendar answers on `www.googleapis.com` rather than on a per-API subdomain the way Gmail
  // does, so the two connectors' lists overlap at the token endpoint and nowhere else. That
  // overlap is fine and is not deduplicated here: a run with both selected gets two rules for
  // one host, pinned to the same addresses, and each carries the reason it was granted — which
  // is what a denial message and an audit row are read for. Collapsing them would save a row and
  // lose the ability to say WHICH connector needed it.
  google_calendar: ["www.googleapis.com", "oauth2.googleapis.com"],
  slack: ["slack.com"],
  // One host, and no OAuth endpoint beside it: Stripe authenticates with a bearer token on the
  // API host itself, so there is no second exchange to reach. `files.stripe.com` is deliberately
  // absent — nothing in the template downloads a file, and a host granted "in case" is a host
  // model-written code can reach for reasons nobody reviewed.
  stripe: ["api.stripe.com"],
};

/**
 * IPv4 blocks refused unconditionally, regardless of what a connector or a DNS answer claims.
 * Named rather than computed from a library, for the same reason the migration runner has no
 * dependency: this list is short, load-bearing, and worth being able to read in one screen.
 */
const DENIED_IPV4_BLOCKS: Array<[string, number]> = [
  ["0.0.0.0", 8], // "this network" / unspecified
  ["10.0.0.0", 8], // RFC1918
  ["100.64.0.0", 10], // carrier-grade NAT
  ["127.0.0.0", 8], // loopback
  ["169.254.0.0", 16], // link-local — THE CLOUD METADATA ENDPOINT LIVES HERE
  ["172.16.0.0", 12], // RFC1918
  ["192.0.0.0", 24], // IETF protocol assignments
  ["192.0.2.0", 24], // TEST-NET-1
  ["192.168.0.0", 16], // RFC1918
  ["198.18.0.0", 15], // benchmarking
  ["198.51.100.0", 24], // TEST-NET-2
  ["203.0.113.0", 24], // TEST-NET-3
  ["224.0.0.0", 4], // multicast
  ["240.0.0.0", 4], // reserved
];

function ipv4ToInt(ip: string): number {
  const parts = ip.split(".").map(Number);
  return parts.reduce((acc, part) => (acc << 8) + part, 0) >>> 0;
}

function inIpv4Block(ip: string, block: string, prefix: number): boolean {
  const mask = prefix === 0 ? 0 : (0xffffffff << (32 - prefix)) >>> 0;
  return (ipv4ToInt(ip) & mask) === (ipv4ToInt(block) & mask);
}

/**
 * An IPv6 address as its sixteen bytes, or null if it is not one.
 *
 * TEXT MATCHING IS NOT ENOUGH, and this function exists because the previous version of this
 * module tried it. `::ffff:169.254.169.254` and `::ffff:a9fe:a9fe` are the SAME ADDRESS — the
 * metadata endpoint — written two ways, and a rule that pattern-matches the dotted spelling
 * admits the hex one. Likewise `fe80::/10` is not "starts with fe80:": `febf::1` is link-local
 * too. Normalising to bytes first means every rule below is a prefix comparison against the
 * address itself rather than against one of its spellings.
 */
function ipv6ToBytes(ip: string): Uint8Array | null {
  let text = ip.toLowerCase();
  const zone = text.indexOf("%"); // fe80::1%eth0 — the scope id is not part of the address
  if (zone >= 0) text = text.slice(0, zone);

  // A trailing dotted quad (::ffff:1.2.3.4) is rewritten as the two hex groups it stands for,
  // so the group parser below sees one uniform notation rather than two.
  const dotted = text.lastIndexOf(":");
  if (dotted >= 0 && text.slice(dotted + 1).includes(".")) {
    const quad = text.slice(dotted + 1);
    if (isIP(quad) !== 4) return null;
    const [a, b, c, d] = quad.split(".").map(Number) as [number, number, number, number];
    text = `${text.slice(0, dotted + 1)}${((a << 8) | b).toString(16)}:${((c << 8) | d).toString(16)}`;
  }

  const halves = text.split("::");
  if (halves.length > 2) return null;
  const parse = (part: string): number[] | null => {
    if (part === "") return [];
    const out: number[] = [];
    for (const group of part.split(":")) {
      if (!/^[0-9a-f]{1,4}$/.test(group)) return null;
      const v = parseInt(group, 16);
      out.push((v >> 8) & 0xff, v & 0xff);
    }
    return out;
  };
  const head = parse(halves[0] ?? "");
  const rest = halves.length === 2 ? parse(halves[1] ?? "") : [];
  if (head === null || rest === null) return null;

  const fixed = head.length + rest.length;
  if (fixed > 16) return null;
  if (halves.length === 1 && fixed !== 16) return null;
  const gap = halves.length === 2 ? 16 - fixed : 0;
  return Uint8Array.from([...head, ...new Array(gap).fill(0), ...rest]);
}

/** Does `bytes` start with `prefix` for the first `bits`? The one comparison every v6 rule below
 *  is expressed as. */
function hasPrefix(bytes: Uint8Array, prefix: number[], bits: number): boolean {
  for (let i = 0; i < Math.floor(bits / 8); i++) if (bytes[i] !== prefix[i]) return false;
  const spare = bits % 8;
  if (spare === 0) return true;
  const mask = (0xff << (8 - spare)) & 0xff;
  const i = Math.floor(bits / 8);
  return ((bytes[i]! ^ (prefix[i] ?? 0)) & mask) === 0;
}

/** IPv6 blocks refused outright, by prefix — the v6 counterpart of DENIED_IPV4_BLOCKS. */
const DENIED_IPV6_PREFIXES: Array<[number[], number, string]> = [
  [[0xfe, 0x80], 10, "fe80::/10 link-local"],
  [[0xfc], 7, "fc00::/7 unique local"],
  [[0xff], 8, "ff00::/8 multicast"],
  [[0x20, 0x01, 0x0d, 0xb8], 32, "2001:db8::/32 documentation"],
  // Teredo tunnels an IPv4 destination inside the address, obfuscated by a bitwise complement.
  // Rather than unwrap it, refuse the whole block: nothing a sandbox legitimately needs is
  // reachable only over Teredo.
  [[0x20, 0x01, 0x00, 0x00], 32, "2001::/32 Teredo"],
  // NAT64 translates an IPv4 destination into this prefix, at an offset that depends on the
  // prefix length (RFC 6052). Refusing the whole well-known block is both simpler and safer than
  // unwrapping four different offsets — nothing a sandbox needs is reachable only over NAT64.
  [[0x00, 0x64, 0xff, 0x9b], 32, "64:ff9b::/32 NAT64 well-known prefix"],
];

/**
 * Prefixes that CARRY AN IPv4 ADDRESS in their last four bytes. Each is unwrapped and re-checked
 * against the IPv4 block list, so the v4 rules cannot be walked around by wearing a v6 suit —
 * which is exactly what `::ffff:a9fe:a9fe` is.
 */
const IPV4_BEARING_PREFIXES: Array<[number[], number]> = [
  [[0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0xff, 0xff], 96], // ::ffff:0:0/96 — IPv4-mapped
  [[0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0], 96], // ::/96 — the deprecated IPv4-compatible form
];

function embeddedIpv4(bytes: Uint8Array, at: number): string {
  return `${bytes[at]}.${bytes[at + 1]}.${bytes[at + 2]}.${bytes[at + 3]}`;
}

/** True for loopback, link-local, unique-local, and any denied IPv4 smuggled inside a v6 form. */
function isDeniedIpv6(ip: string): boolean {
  const bytes = ipv6ToBytes(ip);
  if (!bytes) return true; // unparseable — refuse rather than guess

  const allZero = bytes.every((b) => b === 0);
  if (allZero) return true; // ::
  if (hasPrefix(bytes, [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1], 128)) return true; // ::1

  for (const [prefix, bits] of DENIED_IPV6_PREFIXES) {
    if (hasPrefix(bytes, prefix, bits)) return true;
  }

  for (const [prefix, bits] of IPV4_BEARING_PREFIXES) {
    if (hasPrefix(bytes, prefix, bits) && isDeniedIpv4(embeddedIpv4(bytes, 12))) return true;
  }
  // 6to4: 2002:V4ADDR::/48 carries its gateway's IPv4 in bytes 2-5 rather than the last four.
  if (hasPrefix(bytes, [0x20, 0x02], 16) && isDeniedIpv4(embeddedIpv4(bytes, 2))) return true;

  return false;
}

function isDeniedIpv4(ip: string): boolean {
  return DENIED_IPV4_BLOCKS.some(([block, prefix]) => inIpv4Block(ip, block, prefix));
}

/** The one predicate everything else in this module exists to feed. */
export function isDeniedAddress(ip: string): boolean {
  const version = isIP(ip);
  if (version === 4) return isDeniedIpv4(ip);
  if (version === 6) return isDeniedIpv6(ip);
  return true; // not even a parseable IP — refuse rather than guess what it might resolve to
}

/** What resolves a hostname to addresses. The real DNS module by default; tests inject a fake
 *  one so the private-range refusal is exercised deterministically, with no live network and
 *  no flakiness from whatever a real resolver happens to answer on a given day. */
export type Resolver = (host: string) => Promise<{ v4: string[]; v6: string[] }>;

export const realResolver: Resolver = async (host) => {
  const [v4, v6] = await Promise.all([
    dns.resolve4(host).catch(() => [] as string[]),
    dns.resolve6(host).catch(() => [] as string[]),
  ]);
  return { v4, v6 };
};

/**
 * Resolve `host` and pin the result, refusing the whole host if ANY answer lands in a denied
 * range. "Any", not "the first" — a hostname that answers with one public and one link-local
 * address is a hostname a round-robin resolver could route to the dangerous one on the very
 * next lookup, and pinning is supposed to remove exactly that non-determinism.
 */
export async function resolveAndPin(host: string, resolver: Resolver = realResolver): Promise<string[]> {
  // A host that IS an address needs no lookup, and must not be sent to one: dns.resolve4() on a
  // literal refuses it as "not a hostname", which the catch below turns into "did not resolve to
  // any address". That read as a policy refusal, so a control-plane URL, an object-store
  // endpoint or a DATABASE_URL written as a bare public IP — all ordinary — could not be granted
  // to a sandbox at all. It is still put through the same denial check; it just skips the step
  // that had nothing to answer.
  const literal = isIP(host) ? host : isIP(host.replace(/^\[|\]$/g, "")) ? host.replace(/^\[|\]$/g, "") : null;
  if (literal) {
    if (isDeniedAddress(literal)) {
      throw new EgressPolicyError(
        `${JSON.stringify(host)} is a private/link-local/reserved address and cannot be granted to a sandbox`,
      );
    }
    return [literal];
  }

  let records: string[];
  try {
    const { v4, v6 } = await resolver(host);
    records = [...v4, ...v6];
  } catch (err) {
    throw new EgressPolicyError(`could not resolve ${JSON.stringify(host)}: ${(err as Error).message}`);
  }
  if (records.length === 0) {
    throw new EgressPolicyError(`${JSON.stringify(host)} did not resolve to any address`);
  }
  const denied = records.filter(isDeniedAddress);
  if (denied.length > 0) {
    throw new EgressPolicyError(
      `${JSON.stringify(host)} resolves to a private/link-local/reserved address ` +
        `(${denied.join(", ")}) and cannot be granted to a sandbox`,
    );
  }
  return records;
}

async function rule(host: string, reason: string, resolver: Resolver, port = HTTPS_PORT): Promise<EgressRule> {
  const ips = await resolveAndPin(host, resolver);
  return { host, ips, ports: [port], reason };
}

export interface EgressPolicyInput {
  runId: string;
  provider: string;
  connectors: string[];
  /** The control plane's own host — a run must always be able to reach it, long-poll and all. */
  controlPlaneHost?: string;
  controlPlanePort?: number;
  /** Where the run fetches its project archive from (see boot.py). */
  objectStoreHost?: string;
  /**
   * The postgres connector's egress, already validated by databaseUrl.ts. Taken as an already-
   * pinned {host, port, ips} rather than a raw URL — this module has no business re-deciding
   * what counts as a safe DATABASE_URL, and a second copy of that judgment is how the two
   * would eventually disagree.
   */
  databaseUrl?: { host: string; port: number; ips: string[] };
  /**
   * The MCP servers this run was granted, already validated and pinned by `mcpUrl.ts`.
   *
   * Taken as finished rules rather than as endpoints, for exactly the reason `databaseUrl` is:
   * this module has no business re-deciding what counts as a safe user-supplied URL, and a second
   * copy of that judgement is how the two would eventually disagree. An endpoint that did not
   * validate contributes no rule and the run simply cannot reach it — see mcpUrl.ts on why that
   * beats refusing to start a run over one repointed server.
   */
  mcpRules?: EgressRule[];
  /**
   * The HTTP connector's allowlisted domains, already validated and pinned by `connectorSecrets`.
   *
   * THE THIRD USER-SUPPLIED HALF, and it arrives finished for exactly the reason the other two
   * do: this module has no business re-deciding what counts as a safe workspace-supplied host,
   * and a second copy of that judgement is how the two would eventually disagree.
   *
   * Its shape differs from `databaseUrl` in one way that is a decision rather than an accident.
   * A missing DATABASE_URL makes `buildEgressPolicy` REFUSE, because postgres with no host is a
   * run that cannot work and whose failure would name nothing. An empty allowlist does not
   * refuse: the HTTP connector's own template raises at the first call with a sentence naming
   * the variable, which is a better place to learn it than a run that would not start. Same
   * judgement `mcpRules` makes about a server that no longer validates.
   */
  httpRules?: EgressRule[];
}

/**
 * Build the policy for one run: the declared provider, the declared connectors' fixed hosts, the
 * control plane, the object store, the workspace's own validated DATABASE_URL, and the MCP servers
 * it was granted — nothing else, and denied by default.
 *
 * The two user-supplied halves arrive ALREADY VALIDATED AND PINNED, from `databaseUrl.ts` and
 * `mcpUrl.ts`. That is not deference: those are the two SSRF vectors in this system, each has a
 * module that decides what is safe about it, and this function taking raw URLs would be a third
 * opinion on the same question.
 */
export async function buildEgressPolicy(
  input: EgressPolicyInput,
  resolver: Resolver = realResolver,
): Promise<EgressPolicy> {
  const rules: EgressRule[] = [];

  const providerHost = PROVIDER_HOSTS[input.provider];
  if (input.provider && input.provider !== "fake") {
    if (!providerHost) {
      throw new EgressPolicyError(`unknown provider ${JSON.stringify(input.provider)} — no egress host declared`);
    }
    rules.push(await rule(providerHost, `model calls on the ${input.provider} provider`, resolver));
  }

  for (const id of input.connectors) {
    const hosts = CONNECTOR_HOSTS[id];
    if (!hosts) continue; // postgres and anything else without a fixed host list is handled elsewhere
    for (const host of hosts) rules.push(await rule(host, `the ${id} connector`, resolver));
  }

  if (input.controlPlaneHost) {
    rules.push(
      await rule(input.controlPlaneHost, "the control plane", resolver, input.controlPlanePort ?? HTTPS_PORT),
    );
  }
  if (input.objectStoreHost) {
    rules.push(await rule(input.objectStoreHost, "fetching the agent's project archive", resolver));
  }
  if (input.databaseUrl) {
    if (!input.connectors.includes("postgres")) {
      throw new EgressPolicyError("a databaseUrl was supplied but the postgres connector was not selected");
    }
    const { host, port, ips } = input.databaseUrl;
    rules.push({ host, ips, ports: [port], reason: "the postgres connector's own DATABASE_URL" });
  } else if (input.connectors.includes("postgres")) {
    throw new EgressPolicyError("the postgres connector is selected but no validated DATABASE_URL was supplied");
  }

  // Already pinned. Appended rather than re-resolved: `validateMcpUrl` did the lookup, and the
  // whole point of pinning is that nothing does it a second time.
  for (const rule of input.mcpRules ?? []) rules.push(rule);

  // The same, for the HTTP connector's allowlist. Refused here when nothing selected it, which
  // mirrors the databaseUrl guard: granting a sandbox a set of hosts no connector asked for is
  // widening the policy by accident, and an accident is exactly what this shape catches.
  if ((input.httpRules?.length ?? 0) > 0 && !input.connectors.includes("http")) {
    throw new EgressPolicyError("http allowlist rules were supplied but the http connector was not selected");
  }
  for (const rule of input.httpRules ?? []) rules.push(rule);

  return { runId: input.runId, rules };
}

/** Whether `ip:port` is admitted by `policy`. What the hosted RunSandbox actually enforces. */
export function admits(policy: EgressPolicy, ip: string, port: number): boolean {
  return policy.rules.some((r) => r.ips.includes(ip) && r.ports.includes(port));
}
