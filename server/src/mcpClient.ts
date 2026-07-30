// The MCP client: capability discovery against a remote server.
//
// This is the only place in the codebase that talks to an MCP server, and everything it
// learns is a CLAIM, not a fact. A server tells us its name, its version and its tool list;
// none of that has been reviewed by anyone, and a server that lies is not a malfunction to
// be defended against with an exception handler — it is the expected case the design has to
// survive. So:
//
//   * Nothing is assumed. The tool list comes from the server's own advertisement via the
//     standard handshake (initialize -> notifications/initialized -> tools/list). We never
//     guess what a server can do, and we never carry over a previous list.
//
//   * Every wait is bounded. A slow server is indistinguishable from a hostile one holding
//     the connection open, and either way "add a server" must not hang the UI. There is a
//     per-request timeout AND a whole-discovery deadline, because a server that answers
//     each page just inside the request timeout would otherwise stall forever legally.
//
//   * Pagination is bounded too. `nextCursor` is server-controlled, so a cursor that never
//     terminates is a trivial denial of service against our own process. Both the page
//     count and the total tool count are capped.
//
//   * Failure is classified, not swallowed. "Unreachable" and "needs a credential" and
//     "answered, but not with MCP" are three different things a user acts on differently,
//     so the status carries which one it was and the real message survives.
//
// The transport is Streamable HTTP only. stdio is deliberately unsupported: it means
// spawning a third-party binary on the user's machine, which is a much larger trust
// decision than making an HTTP request and is not what this feature is for.

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { McpServerStatus } from "./mcpStore.ts";

/** Per-request ceiling. Applies to the handshake and to each page of tools/list. */
const REQUEST_TIMEOUT_MS = Number(process.env["JAROKU_MCP_TIMEOUT_MS"] ?? 10_000);
/** Whole-discovery ceiling, so many just-fast-enough responses can't stall indefinitely. */
const DISCOVERY_DEADLINE_MS = Number(process.env["JAROKU_MCP_DISCOVERY_MS"] ?? 30_000);
/** Cursor loops are server-controlled. These are the guards on that. */
const MAX_PAGES = 50;
const MAX_TOOLS = 500;

/** What a server claims about one tool. Every field is unverified. */
export interface AdvertisedTool {
  name: string;
  description: string | null;
  /** The declared JSON Schema for the tool's arguments, exactly as advertised. */
  input_schema: Record<string, unknown>;
  /** The server's ToolAnnotations. Kept verbatim; may only RAISE impact (mcpImpact.ts). */
  annotations: Record<string, unknown> | null;
}

export interface DiscoverySuccess {
  ok: true;
  server_name: string | null;
  server_version: string | null;
  protocol_version: string | null;
  tools: AdvertisedTool[];
  /** Set when the server advertised more tools than we are willing to accept. */
  truncated: boolean;
}

export interface DiscoveryFailure {
  ok: false;
  status: Exclude<McpServerStatus, "connected">;
  error: string;
}

export type DiscoveryResult = DiscoverySuccess | DiscoveryFailure;

export interface DiscoverOptions {
  endpoint: string;
  /**
   * The credential value, already read from the environment by the caller.
   *
   * It is passed as an argument rather than looked up here so that this module has no
   * opinion about where secrets live, and so that nothing in it can accidentally log one:
   * the value is used once, to build a header, and never formatted into any message.
   */
  token?: string | null;
  /** Overrides for tests. */
  timeoutMs?: number;
  deadlineMs?: number;
}

const lower = (s: string): string => s.toLowerCase();

/**
 * Turn a thrown error into the status a user can act on.
 *
 * Same posture as evalRunner.isTransientFailure (`evalRunner.ts:62-84`): match on known
 * markers, and let the DEFAULT be the conservative answer. Here the conservative answer is
 * "error" rather than "unreachable", because "unreachable" invites a retry and a server
 * that answered us with nonsense will answer with nonsense again.
 */
export function classifyDiscoveryFailure(err: unknown): {
  status: DiscoveryFailure["status"];
  error: string;
} {
  const raw = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
  const e = lower(raw);

  const unauthorized = ["401", "403", "unauthorized", "unauthenticated", "forbidden",
    "authentication", "invalid_token", "invalid token", "access denied"];
  if (unauthorized.some((m) => e.includes(m))) {
    return {
      status: "auth_required",
      // Deliberately names the OAuth limitation instead of failing vaguely. A server that
      // needs an interactive OAuth flow will keep rejecting a pasted token forever, and
      // "unauthorized" alone sends the user off to hunt for a key that does not exist.
      error:
        `${raw} — this server requires authorization. Add a bearer token or API key for it. ` +
        `If it uses an interactive OAuth flow, that isn't supported yet.`,
    };
  }

  const unreachable = ["econnrefused", "econnreset", "enotfound", "etimedout", "eai_again",
    "ehostunreach", "enetunreach", "epipe", "fetch failed", "network", "socket hang up",
    "timed out", "timeout", "requesttimeout", "aborted", "502", "503", "504"];
  if (unreachable.some((m) => e.includes(m))) {
    return { status: "unreachable", error: raw };
  }

  return { status: "error", error: raw };
}

/**
 * A result schema that validates nothing, used for `tools/list`.
 *
 * The SDK's own `listTools()` validates the whole page against a strict schema and throws
 * when ANY entry fails. For a client whose entire job is surviving unreviewed servers that
 * is the wrong posture: one third-party tool with a slightly-off `inputSchema` would take
 * out discovery of the nineteen beside it, and the user would be told the server is broken
 * rather than shown the tools that are fine.
 *
 * So the SDK keeps the parts it is genuinely better at — the handshake, session handling,
 * the Streamable-HTTP/SSE transport — and the untrusted payload is coerced here instead, by
 * readTool(), which drops what it cannot read and keeps what it can. The trust boundary
 * belongs on this side of it.
 */
const PASSTHROUGH = {
  parse: (v: unknown) => v,
  safeParse: (v: unknown) => ({ success: true as const, data: v }),
} as unknown as Parameters<Client["request"]>[1];

interface ToolsListPage {
  tools?: unknown;
  nextCursor?: unknown;
}

/** Coerce one advertised tool entry. Never throws; an unusable entry returns null. */
function readTool(raw: unknown): AdvertisedTool | null {
  if (!raw || typeof raw !== "object") return null;
  const t = raw as Record<string, unknown>;
  if (typeof t["name"] !== "string" || !t["name"]) return null;
  const schema = t["inputSchema"];
  const usable = schema && typeof schema === "object" && !Array.isArray(schema)
    ? (schema as Record<string, unknown>)
    : null;
  return {
    name: t["name"],
    description: typeof t["description"] === "string" ? t["description"] : null,
    // A tool advertised with a missing, non-object, or entirely empty schema is kept, not
    // dropped: the server said this tool exists, and hiding it would be us editing its
    // answer. It is normalised to the empty object schema so everything downstream — the
    // Python bridge building an args schema, the validator checking a generated call — has
    // one shape to handle. That is normalisation of a vacuous schema, not interpretation of
    // a meaningful one: anything that declares anything at all is passed through verbatim.
    input_schema: usable && Object.keys(usable).length > 0
      ? usable
      : { type: "object", properties: {} },
    annotations:
      t["annotations"] && typeof t["annotations"] === "object" && !Array.isArray(t["annotations"])
        ? (t["annotations"] as Record<string, unknown>)
        : null,
  };
}

/**
 * Perform the MCP handshake and return everything the server advertises.
 *
 * Never throws: every failure comes back as a DiscoveryFailure carrying a status and the
 * real message. Adding a server is a user action in a UI, and an exception escaping here
 * would take out the command handler that ran it.
 */
export async function discover(opts: DiscoverOptions): Promise<DiscoveryResult> {
  const timeout = opts.timeoutMs ?? REQUEST_TIMEOUT_MS;
  const deadline = Date.now() + (opts.deadlineMs ?? DISCOVERY_DEADLINE_MS);
  const remaining = (): number => Math.max(0, deadline - Date.now());

  let url: URL;
  try {
    url = new URL(opts.endpoint);
  } catch {
    return { ok: false, status: "error", error: `not a valid URL: ${opts.endpoint}` };
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    return { ok: false, status: "error", error: `unsupported transport "${url.protocol}" — only http(s) is supported` };
  }

  const headers: Record<string, string> = {};
  if (opts.token) headers["Authorization"] = `Bearer ${opts.token}`;

  const transport = new StreamableHTTPClientTransport(url, {
    requestInit: { headers },
  });
  const client = new Client(
    { name: "jaroku", version: "1.0.0" },
    // We advertise no capabilities: Jaroku does not accept sampling, elicitation or roots
    // requests from a server. A server that cannot ask us to do things is a smaller trust
    // surface, and nothing in the product needs those.
    { capabilities: {} },
  );

  try {
    await client.connect(transport, { timeout: Math.min(timeout, remaining() || 1) });

    const tools: AdvertisedTool[] = [];
    let cursor: string | undefined;
    let pages = 0;
    let truncated = false;

    do {
      if (remaining() <= 0) throw new Error("discovery timed out while listing tools");
      if (++pages > MAX_PAGES) {
        truncated = true;
        break;
      }
      const page = (await client.request(
        { method: "tools/list", params: cursor === undefined ? {} : { cursor } },
        PASSTHROUGH,
        { timeout: Math.min(timeout, remaining() || 1) },
      )) as ToolsListPage;

      for (const raw of Array.isArray(page.tools) ? page.tools : []) {
        const tool = readTool(raw);
        if (!tool) continue;
        if (tools.length >= MAX_TOOLS) {
          truncated = true;
          break;
        }
        tools.push(tool);
      }
      cursor = typeof page.nextCursor === "string" ? page.nextCursor : undefined;
    } while (cursor !== undefined && !truncated);

    // A server may advertise the same name twice; the last one would silently win at call
    // time. Keeping the first and dropping the rest makes the collision visible in the
    // count rather than in behaviour.
    const seen = new Set<string>();
    const unique = tools.filter((t) => (seen.has(t.name) ? false : (seen.add(t.name), true)));

    return {
      ok: true,
      server_name: client.getServerVersion()?.name ?? null,
      server_version: client.getServerVersion()?.version ?? null,
      protocol_version: transport.protocolVersion ?? null,
      tools: unique,
      truncated,
    };
  } catch (err) {
    return { ok: false, ...classifyDiscoveryFailure(err) };
  } finally {
    // Best effort: a server that refuses to close must not turn discovery into a hang.
    await client.close().catch(() => {});
  }
}
