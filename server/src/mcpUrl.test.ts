// A user-supplied MCP endpoint, and the two moments it has to be refused.
//
// THE HOSTILE FIXTURES ARE THE POINT. Every case below is a URL somebody could type into the MCP
// panel that, without this check, would have the CONTROL PLANE fetch it — this process, inside
// the VPC, with the server's own network position and no sandbox around it. The metadata endpoint
// is the first thing anything reaches for; the rest are the infrastructure it would find next.
//
// AND THEN AGAIN AT RE-DISCOVERY, which is the case that is easy to leave out. A URL checked once
// at registration and trusted afterwards is a URL whose DNS the owner can repoint the following
// day — the classic rebinding shape, and the reason `refuseEndpoint` runs before EVERY handshake
// rather than before the first. The suite proves it by registering with one resolver answer and
// re-discovering with another, and asserting that the second is refused AND that the tool list
// discovered by the first survives it.
//
// That last assertion is the one that would be easy to break while fixing this. "Refuse a
// repointed server" and "never let a failed refresh destroy a working tool list" pull in opposite
// directions if you implement the first by wiping the row.
//
//   npm run test:mcp-url

import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { migrate } from "./db/migrate.ts";
import { SqliteDb } from "./db/sqlite.ts";
import { newRequestId, systemContext, systemContextFor, type TenantContext } from "./db/tenant.ts";
import { IdentityRepository } from "./db/repositories/identity.ts";
import { McpStore } from "./mcpStore.ts";
import { McpRegistry } from "./mcpRegistry.ts";
import {
  admissibleMcpAddress, loopbackAllowed, MCP_ALLOW_LOOPBACK_ENV, McpUrlError, mcpEgressRules,
  validateMcpUrl,
} from "./mcpUrl.ts";
import { buildEgressPolicy, EgressPolicyError, admits, type Resolver } from "./sandbox/egressPolicy.ts";

let failures = 0;
const check = (ok: boolean, msg: string, detail = ""): void => {
  if (ok) console.log(`  ok   ${msg}`);
  else {
    failures++;
    console.log(`  FAIL ${msg}${detail ? ` — ${detail}` : ""}`);
  }
};

const MIGRATIONS = join(fileURLToPath(new URL("..", import.meta.url)), "migrations");

const publicAnswer: Resolver = async () => ({ v4: ["198.51.101.7"], v6: [] });
const metadataAnswer: Resolver = async () => ({ v4: ["169.254.169.254"], v6: [] });
const mixedAnswer: Resolver = async () => ({ v4: ["198.51.101.7", "10.0.1.7"], v6: [] });

async function refused(url: string, resolver: Resolver = publicAnswer): Promise<Error | null> {
  // An empty environment: development defaults, which is the posture every other case here wants.
  return validateMcpUrl(url, resolver, {}).then(() => null, (e: Error) => e);
}

/** The same, with a chosen environment, for the seam. */
async function refusedIn(
  url: string,
  env: NodeJS.ProcessEnv,
  resolver: Resolver = publicAnswer,
): Promise<Error | null> {
  return validateMcpUrl(url, resolver, env).then(() => null, (e: Error) => e);
}

// --- the hostile fixtures ---------------------------------------------------------------
console.log("\nendpoints the control plane must never fetch");
{
  const cases: [string, string][] = [
    ["the cloud metadata endpoint", "http://169.254.169.254/latest/meta-data/"],
    ["...spelled as an IPv4-mapped IPv6 address", "http://[::ffff:a9fe:a9fe]/latest/meta-data/"],
    ["...spelled as an IPv4-compatible IPv6 address", "http://[::169.254.169.254]/"],
    ["RFC1918 space", "http://10.0.1.7:8080/mcp"],
    ["...the 172.16/12 block", "http://172.20.4.4:8080/mcp"],
    ["...the 192.168/16 block", "http://192.168.1.1:8080/mcp"],
    ["link-local IPv6", "http://[fe80::1]/mcp"],
    ["...and the rest of fe80::/10, which a prefix match on the string would miss", "http://[febf::1]/mcp"],
    ["unique-local IPv6", "http://[fd00::1]/mcp"],
    ["carrier-grade NAT", "http://100.64.0.1:8080/mcp"],
    ["a 6to4 address wrapping a private IPv4", "http://[2002:0a00:0107::1]/mcp"],
  ];
  for (const [label, url] of cases) {
    const err = await refused(url);
    check(err !== null, `${label} is refused`, url);
  }

  // Loopback is the one block with a development seam over it, so it is asserted against the
  // PRODUCTION posture here and the seam gets its own section below.
  const prod: NodeJS.ProcessEnv = { NODE_ENV: "production" };
  for (const [label, url] of [
    ["loopback", "http://127.0.0.1:8080/mcp"],
    ["...as IPv6", "http://[::1]:8080/mcp"],
    ["...as another address in the same /8", "http://127.9.9.9:8080/mcp"],
  ] as const) {
    check((await refusedIn(url, prod)) !== null, `${label} is refused in production`, url);
  }
}

console.log("\nand endpoints that are the wrong shape entirely");
{
  check((await refused("stdio:///usr/local/bin/some-server")) instanceof McpUrlError,
    "stdio is refused — it means running a third-party binary, which is a different decision");
  check((await refused("file:///etc/passwd")) instanceof McpUrlError, "file:// is refused");
  check((await refused("gopher://example.com/")) instanceof McpUrlError, "so is anything else non-http");
  check((await refused("not a url")) instanceof McpUrlError, "and so is something that is not a URL");
  check((await refused("https://")) instanceof McpUrlError, "...or has no host");
}

console.log("\nports that are never an MCP server");
{
  for (const [port, what] of [[6379, "redis — the queue, the semaphores, the tickets"], [5432, "postgres"], [22, "ssh"], [25, "smtp"], [27017, "mongodb"]] as const) {
    const err = await refused(`http://mcp.example.com:${port}/`);
    check(err instanceof McpUrlError, `port ${port} is refused (${what})`);
  }
  // A DENYLIST, not an allowlist — self-hosted MCP servers legitimately sit anywhere.
  check((await refused("http://mcp.example.com:3000/")) === null, "but 3000 is fine — self-hosted servers live there");
  check((await refused("http://mcp.example.com:8080/")) === null, "...and so is 8080");
  check((await refused("https://mcp.example.com/sse")) === null, "...and an ordinary https endpoint");
}

console.log("\nDNS is where the interesting refusals happen");
{
  const rebound = await refused("https://mcp.attacker.example/sse", metadataAnswer);
  check(rebound instanceof EgressPolicyError, "a public-looking hostname that RESOLVES to the metadata endpoint is refused");
  check(
    (rebound?.message ?? "").includes("169.254.169.254"),
    "...naming the address it actually resolved to, which is the actionable half",
  );

  const partly = await refused("https://mcp.attacker.example/sse", mixedAnswer);
  check(
    partly instanceof EgressPolicyError,
    "a hostname answering with ONE public and ONE private address is refused WHOLE",
  );
  check(
    (partly?.message ?? "").includes("10.0.1.7"),
    "...because a round-robin resolver could hand out the dangerous one on the next lookup",
  );

  const ok = await validateMcpUrl("https://mcp.example.com/sse", publicAnswer);
  check(ok.ips.join(",") === "198.51.101.7", "a good one comes back with LITERAL pinned addresses");
  check(ok.port === 443, "...and the port https implies");
  check(admissibleMcpAddress("198.51.101.7"), "the call-time predicate agrees about a public address");
  check(!admissibleMcpAddress("169.254.169.254"), "...and about the metadata endpoint");
  check(!admissibleMcpAddress("not-an-address"), "...and refuses something that is not one at all");
}

// --- the development seam, and the one thing that closes it ---------------------------------
console.log("\nloopback: allowed for the mock server, never in production");
{
  const dev: NodeJS.ProcessEnv = {};
  const off: NodeJS.ProcessEnv = { [MCP_ALLOW_LOOPBACK_ENV]: "0" };
  const prod: NodeJS.ProcessEnv = { NODE_ENV: "production" };
  const prodAsking: NodeJS.ProcessEnv = { NODE_ENV: "production", [MCP_ALLOW_LOOPBACK_ENV]: "1" };

  check(loopbackAllowed(dev), "on by default in development — the README's fixture path says paste a 127.0.0.1 URL");
  check(!loopbackAllowed(off), "...and off for somebody who wants the production posture locally");
  check(!loopbackAllowed(prod), "off under NODE_ENV=production");
  check(
    !loopbackAllowed(prodAsking),
    "AND STILL OFF WHEN PRODUCTION ASKS FOR IT — no variable gets to open this",
  );

  const mock = await validateMcpUrl("http://127.0.0.1:8765/mcp", publicAnswer, dev);
  check(mock.ips.join(",") === "127.0.0.1", "the mock server validates in development, pinned to itself");
  check(
    (await refusedIn("http://127.0.0.1:8765/mcp", prodAsking)) !== null,
    "...and the identical URL is refused in production",
  );

  // The seam is a LITERAL loopback host, not a name that resolves to one. Admitting the second
  // would make the seam the rebinding hole it exists alongside.
  check(
    (await refusedIn("http://localhost.attacker.example/mcp", dev, async () => ({ v4: ["127.0.0.1"], v6: [] }))) !== null,
    "a hostname that merely RESOLVES to loopback is refused even in development",
  );
  // And it is loopback only — nothing about developing locally needs a private network.
  check((await refusedIn("http://10.0.1.7:8080/mcp", dev)) !== null, "RFC1918 is refused in development too");
  check(
    (await refusedIn("http://169.254.169.254/", dev)) !== null,
    "...and so, emphatically, is the metadata endpoint",
  );
}

// --- the egress rules a run is granted -----------------------------------------------------
console.log("\nwhat a run is actually granted");
{
  const built = await mcpEgressRules(
    [
      { id: "good", endpoint: "https://mcp.example.com/sse" },
      { id: "repointed", endpoint: "https://mcp.attacker.example/sse" },
    ],
    // One resolver for both: the good name is not the attacker one, so this answers publicly for
    // the first and the check below drives the second through the denied path by its literal.
    async (host) => (host === "mcp.example.com" ? { v4: ["198.51.101.7"], v6: [] } : { v4: ["169.254.169.254"], v6: [] }),
  );
  check(built.rules.length === 1, "only the endpoint that validated contributes a rule");
  check(built.rules[0]?.host === "mcp.example.com", "...and it is the good one");
  check(built.refused.length === 1 && built.refused[0]?.id === "repointed", "the other is reported, by id");

  const policy = await buildEgressPolicy(
    { runId: "r1", provider: "anthropic", connectors: [], mcpRules: built.rules },
    async () => ({ v4: ["203.0.114.1"], v6: [] }),
  );
  check(admits(policy, "198.51.101.7", 443), "the run may reach the MCP server it was granted");
  check(!admits(policy, "169.254.169.254", 443), "and may NOT reach the one that was refused");
  check(!admits(policy, "198.51.101.7", 6379), "...nor the granted host on a port it was not granted");
  check(admits(policy, "203.0.114.1", 443), "while the provider rule is untouched");
}

// --- and through the registry, at both moments ----------------------------------------------
console.log("\nrefused at registration, and again at re-discovery");
{
  const scratch: string[] = [];
  const dir = mkdtempSync(join(tmpdir(), "jaroku-mcpurl-"));
  scratch.push(dir);
  const db = new SqliteDb(join(dir, "u.db"));
  await migrate(db.migrationTarget(), join(MIGRATIONS, "sqlite"), () => {});
  const identity = new IdentityRepository(db);
  const store = new McpStore(db);

  const ws = await identity.createWorkspaceUnowned(systemContext(newRequestId()), {
    name: `mcpurl ${randomUUID().slice(0, 6)}`,
  });
  const A: TenantContext = systemContextFor(ws.id, newRequestId());

  // Registration, against a name that already resolves badly.
  const hostile = new McpRegistry(store, undefined, metadataAnswer);
  const added = await hostile.addServer(A, { endpoint: "http://metadata.attacker.example/", id: "hostile" });
  check(!added.ok, "an endpoint resolving to the metadata endpoint cannot be registered");
  check(
    (await store.getServer(A, "hostile"))?.status === "error",
    "...and the row says `error` rather than `unreachable`, which would invite a retry",
  );
  check(
    ((await store.getServer(A, "hostile"))?.last_error ?? "").length > 0,
    "...with a reason a person can act on",
  );
  check((await store.listTools(A, "hostile")).length === 0, "and nothing was discovered from it");

  // A server registered while its name was fine, with a tool list to lose.
  await store.upsertServer(A, {
    id: "good", label: "good", endpoint: "https://mcp.example.com/sse", transport: "http",
    auth_env_key: null, server_name: null, server_version: null, protocol_version: null,
    status: "connected", last_error: null, discovered_at: null,
  });
  await store.replaceTools(A, "good", [
    { name: "read_page", description: null, input_schema: { type: "object", properties: {} },
      annotations: null, impact: "low", impact_reason: "a read verb" },
  ]);
  check((await store.listTools(A, "good")).length === 1, "it has a tool list");

  // And now its name answers with the metadata endpoint. THE REBINDING CASE.
  const repointed = new McpRegistry(store, undefined, metadataAnswer);
  const res = await repointed.rediscover(A, "good");
  check(!res.ok, "a re-discovery of a repointed server is refused");
  check(
    (await store.getServer(A, "good"))?.status === "error",
    "...and the status says so, so nothing keeps talking to it",
  );
  check(
    (await store.listTools(A, "good")).length === 1,
    "AND ITS TOOLS SURVIVE — refusing a repointed server must not strip every agent scoped to it",
  );

  await new Promise((r) => setTimeout(r, 50));
  await db.close();
  await new Promise((r) => setTimeout(r, 50));
  for (const d of scratch) rmSync(d, { recursive: true, force: true });
}

console.log(failures === 0 ? "\nALL CORRECT" : `\n${failures} FAILURES`);
process.exit(failures === 0 ? 0 : 1);
