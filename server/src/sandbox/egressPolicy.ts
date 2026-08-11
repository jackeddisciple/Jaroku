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
  slack: ["slack.com"],
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

/** True for loopback, link-local, unique-local and the IPv4-mapped form of any denied IPv4. */
function isDeniedIpv6(ip: string): boolean {
  const lower = ip.toLowerCase();
  if (lower === "::1" || lower === "::") return true;
  if (lower.startsWith("fe80:")) return true; // link-local
  if (/^f[cd][0-9a-f]{2}:/.test(lower)) return true; // fc00::/7 unique local
  // ::ffff:a.b.c.d — an IPv4 address wearing a v6 suit. Unwrap and re-check, or the v4 rules
  // above are a fence with a gate in it.
  const mapped = lower.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
  if (mapped) return isDeniedIpv4(mapped[1]!);
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
}

/**
 * Build the policy for one run: the declared provider, the declared connectors' fixed hosts,
 * the control plane, and the object store — nothing else. DATABASE_URL and MCP server hosts are
 * added by later commits (databaseUrl.ts, and the MCP grant respectively); this is deliberately
 * the subset that needs no user-supplied URL, so it has no SSRF surface of its own to validate.
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

  return { runId: input.runId, rules };
}

/** Whether `ip:port` is admitted by `policy`. What the hosted RunSandbox actually enforces. */
export function admits(policy: EgressPolicy, ip: string, port: number): boolean {
  return policy.rules.some((r) => r.ips.includes(ip) && r.ports.includes(port));
}
