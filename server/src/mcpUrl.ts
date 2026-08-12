// Validating a user-supplied MCP endpoint before anything connects to it.
//
// THE SECOND SSRF VECTOR THE MIGRATION SPEC NAMES, and the one that is easier to miss than
// `DATABASE_URL` because it does not look like a credential. A user types a URL into the MCP
// panel and the CONTROL PLANE fetches it — this process, inside the VPC, with whatever network
// position the server has. `http://169.254.169.254/latest/meta-data/iam/security-credentials/`
// is a perfectly well-formed URL, and so is `http://10.0.1.7:6379/`, and so is a hostname the
// attacker owns that resolves to either.
//
// It is worse than the database case in one specific way. A `DATABASE_URL` is only ever handed
// to a SANDBOX, which has an egress policy around it. An MCP endpoint is fetched TWICE: once by
// the control plane, at discovery, where there is no sandbox and no policy — only this check —
// and again by the sandbox at call time, where the egress policy is what holds. Both are covered
// here: this module is the first, and `mcpEgressRules` builds the pinned rules for the second.
//
// THE REFUSAL IS `egressPolicy`'s, NOT A SECOND COPY OF IT. `isDeniedAddress` already knows that
// `::ffff:a9fe:a9fe` and `169.254.169.254` are the same address written two ways, that `febf::1`
// is link-local, and that a 6to4 address carries an IPv4 in bytes 2-5. That knowledge took a
// module to write and would take a module to duplicate incorrectly, so this file parses,
// constrains the port, and delegates — exactly as `databaseUrl.ts` does, for the same reason.
//
// AND THE RESULT IS PINNED. Resolving at validation time and letting the sandbox resolve again at
// call time is the DNS-rebinding hole: a name that answers publicly while somebody clicks Save
// and answers `169.254.169.254` when the bridge connects. What comes back here is literal
// addresses, and they are what the egress rule admits.

import { EgressPolicyError, isDeniedAddress, resolveAndPin, type EgressRule, type Resolver, realResolver } from "./sandbox/egressPolicy.ts";

export class McpUrlError extends Error {}

export const MCP_ALLOW_LOOPBACK_ENV = "JAROKU_MCP_ALLOW_LOOPBACK";

/**
 * Whether a loopback endpoint may be connected to. False everywhere that matters.
 *
 * THIS EXISTS FOR ONE REASON: `npm run mock:mcp`. The README is rightly proud of a development
 * path that needs no cloud account and no third-party server, and the mock MCP server it ships
 * listens on `127.0.0.1`. A refusal with no seam would mean the fixture path — and
 * `test:mcp-registry`, which drives it — could not connect to the very thing built to be
 * connected to, and the standing rule for this whole migration is that the local path is not
 * deleted.
 *
 * SO IT IS A SEAM, AND IT IS SHAPED LIKE EVERY OTHER SEAM OF THIS KIND HERE. It admits LOOPBACK
 * ONLY — never RFC1918, never link-local, never the metadata endpoint — because the mock server
 * is on this machine and nothing about developing locally requires reaching into a private
 * network. And it is OFF UNDER `NODE_ENV=production`, unconditionally and unoverridably, exactly
 * as `LocalSubprocessSandbox` refuses to start there and `JAROKU_SECRET_STORE=dotenv` refuses to
 * run there: a hosted deployment where a user-supplied URL can reach the control plane's own
 * localhost is the whole vulnerability, and no environment variable gets to ask for it.
 *
 * THE DEFAULT IS ON IN DEVELOPMENT, and that direction is the decision. The README documents the
 * fixture path as "run `npm run mock:mcp`, paste `http://127.0.0.1:8765/mcp` into the panel", and
 * a default that required a second environment variable first would make that documentation
 * wrong — which is a regression of the free-development path the standing rules protect, in
 * exchange for nothing, because production ignores the variable either way.
 * `JAROKU_MCP_ALLOW_LOOPBACK=0` turns it off for somebody who wants the production posture
 * locally.
 *
 * Read per call rather than captured at import — the same rule the billing rates and the
 * platform-key switch follow, and a trap this repository has already fixed once in queue/jobs.ts.
 */
export function loopbackAllowed(env: NodeJS.ProcessEnv = process.env): boolean {
  if (env["NODE_ENV"] === "production") return false;
  return (env[MCP_ALLOW_LOOPBACK_ENV] ?? "1").trim().toLowerCase() !== "0";
}

/** The IPv4 loopback block and the IPv6 loopback address. Nothing else is ever admitted by the seam. */
function isLoopback(ip: string): boolean {
  return /^127\./.test(ip) || ip === "::1" || ip === "0:0:0:0:0:0:0:1";
}

/**
 * Ports an MCP endpoint may not target, whatever it resolves to.
 *
 * A DENYLIST HERE RATHER THAN AN ALLOWLIST, WHICH IS THE OPPOSITE OF `databaseUrl.ts`, and the
 * asymmetry is deliberate. Postgres has conventions — 5432, and two well-known variants — so an
 * allowlist costs nothing and closes a port scan. MCP has none: it is HTTP, self-hosted servers
 * legitimately sit on 3000 and 8080 and 8443 and whatever a container was given, and an allowlist
 * would refuse ordinary deployments while somebody worked out why.
 *
 * So the primary defence is the address check, not the port — a public IP on 6379 is somebody
 * else's Redis, not ours, and ours is unreachable because it is private. This list is defence in
 * depth against the one case the address check cannot see: an operator whose infrastructure has
 * a PUBLIC address. None of these is ever an MCP endpoint.
 */
const DENIED_PORTS = new Set([
  22,    // ssh
  23,    // telnet
  25,    // smtp — an open relay reached through our egress is our reputation
  445,   // smb
  1433,  // sql server
  3306,  // mysql
  3389,  // rdp
  5432,  // postgres
  5433,  // this repo's own docker-compose postgres
  6379,  // redis — the queue, the semaphores, the ws-tickets
  9200,  // elasticsearch
  11211, // memcached
  27017, // mongodb
]);

export interface ValidatedMcpUrl {
  host: string;
  port: number;
  /** Literal, resolved, pinned. What an egress rule admits and what nothing re-resolves. */
  ips: string[];
}

/**
 * Parse, constrain and resolve a workspace-supplied MCP endpoint.
 *
 * Throws `McpUrlError` (a message written here and safe to show) or `EgressPolicyError` (the
 * shared private-range refusal) on anything that must not be connected to.
 *
 * THE CREDENTIAL-IN-URL REFUSAL IS NOT HERE, and that is not an omission: `mcpClient.discover`
 * already refuses a URL carrying userinfo, before anything is sent, and deliberately does not
 * quote the URL back — because the error text lands in `mcp_servers.last_error`, on every
 * client's registry snapshot, and in the log. Repeating the check here would be a second place
 * for that rule to be got subtly wrong.
 */
export async function validateMcpUrl(
  raw: string,
  resolver: Resolver = realResolver,
  env: NodeJS.ProcessEnv = process.env,
): Promise<ValidatedMcpUrl> {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new McpUrlError(`not a valid URL: ${String(raw).slice(0, 120)}`);
  }

  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new McpUrlError(
      `an MCP endpoint must be http(s), not ${JSON.stringify(url.protocol)} — stdio is deliberately unsupported`,
    );
  }
  if (!url.hostname) throw new McpUrlError("that endpoint has no host");

  const port = url.port ? Number(url.port) : url.protocol === "https:" ? 443 : 80;
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new McpUrlError(`${url.port} is not a port`);
  }
  if (DENIED_PORTS.has(port)) {
    throw new McpUrlError(
      `port ${port} is not something an MCP server listens on — it is refused so that a URL ` +
        `cannot be used to reach infrastructure through this server`,
    );
  }

  // THE DEVELOPMENT SEAM, and it is deliberately narrow: a LITERAL loopback host, only when the
  // variable is set, and never under NODE_ENV=production. A hostname that RESOLVES to loopback
  // does not qualify — that is the rebinding shape, and admitting it would make the seam the
  // vulnerability. See loopbackAllowed.
  if (isLoopback(url.hostname) && loopbackAllowed(env)) {
    return { host: url.hostname, port, ips: [url.hostname] };
  }

  // Otherwise it delegates to the exact refusal every other egress host goes through: resolved
  // fresh, pinned, and refused whole on ANY denied answer — not the first, because a round-robin
  // resolver could hand out the dangerous one on the very next lookup.
  const ips = await resolveAndPin(url.hostname, resolver);
  return { host: url.hostname, port, ips };
}

/**
 * The same check, as a predicate, for the call-time path.
 *
 * A pinned rule is what the sandbox's network layer enforces, and this is what decides whether a
 * given address is admissible at all. Separate from `validateMcpUrl` because at call time there
 * is no URL to parse — there is an address the bridge is about to connect to, and the question is
 * only whether it is one of the ones this run was granted.
 */
export function admissibleMcpAddress(ip: string): boolean {
  return !isDeniedAddress(ip);
}

/**
 * Egress rules for the MCP servers a run was granted.
 *
 * ONE RULE PER SERVER, pinned, and NOTHING for a server whose endpoint no longer validates. That
 * last part is the interesting decision: a server that has since been repointed at a private
 * address contributes no rule, so the run simply cannot reach it and the tool call fails with a
 * network error the bridge reports. The alternative — refusing to start the run — would mean one
 * repointed MCP server takes down an agent that has three others and may not even call this one.
 *
 * Failures are collected rather than thrown for the same reason. The caller logs them; the run
 * proceeds with the rules that are safe.
 */
export async function mcpEgressRules(
  endpoints: { id: string; endpoint: string }[],
  resolver: Resolver = realResolver,
): Promise<{ rules: EgressRule[]; refused: { id: string; reason: string }[] }> {
  const rules: EgressRule[] = [];
  const refused: { id: string; reason: string }[] = [];
  for (const server of endpoints) {
    try {
      const { host, port, ips } = await validateMcpUrl(server.endpoint, resolver);
      rules.push({ host, ips, ports: [port], reason: `the ${server.id} MCP server` });
    } catch (err) {
      const known = err instanceof McpUrlError || err instanceof EgressPolicyError;
      refused.push({ id: server.id, reason: known ? (err as Error).message : "could not be checked" });
    }
  }
  return { rules, refused };
}
