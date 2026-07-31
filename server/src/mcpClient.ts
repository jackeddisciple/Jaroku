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

// --- bounds on what a server may say about itself ----------------------------
//
// The bridge already treats a tool RESULT as hostile input: bounded, stripped of control
// characters, framed as external data (mcp_bridge.py:sanitize). An advertisement is the same
// kind of input and travels considerably further — a name and a description are stored, put on
// every registry snapshot every connected client receives, written into mcp_tools.json, and
// pasted into the generation prompt. They are read once and repeated everywhere, so they are
// bounded here, at the only point they enter the system.

/**
 * What a tool may be called.
 *
 * Not a style preference. The name has to survive three consumers that each have their own
 * rules, and none of them fails gracefully:
 *
 *   * The model API accepts `[A-Za-z0-9_-]` and nothing else. A tool called "my tool" does not
 *     produce a broken tool — it produces a 400 on every request the agent ever makes, taking
 *     every OTHER tool down with it, for a reason nothing in the error names.
 *   * Generated Python may reference a granted tool as an identifier (`read_page.invoke(...)`),
 *     which is also what the validator's shadow and argument checks look for.
 *   * It is rendered in logs, in the UI, and in the confirmation prompt a person reads before
 *     approving an irreversible action. An ANSI escape in that string repaints their terminal.
 *
 * A name outside this is not a tool we can accept, so it is dropped and counted rather than
 * stored and blamed on something else later.
 */
const TOOL_NAME_RE = /^[A-Za-z0-9_-]{1,128}$/;

/**
 * Names that are legal by the pattern and still unusable as keys.
 *
 * `out[name] = tool` on a plain JS object assigns the PROTOTYPE when name is "__proto__" —
 * silently, with no own property left behind. The validator's grant map was built that way, so
 * a server naming a tool `__proto__` had it vanish from the argument checks; if it was the only
 * tool, the entire MCP validation block was skipped. Null-prototype maps fix the specific
 * consumers, but a name nothing downstream can hold safely is better refused at the door.
 */
const RESERVED_TOOL_NAMES = new Set(["__proto__", "constructor", "prototype"]);

/** Long enough for a real tool's documentation, short enough that 500 of them stay sane. */
const MAX_DESCRIPTION_CHARS = 4_000;
/** serverInfo is a claim, and a claim does not need a hundred kilobytes to make. */
const MAX_SERVER_FIELD_CHARS = 200;
/**
 * A schema is JSON we re-serialise, store, hash, and paste into a prompt in full. A tool that
 * needs more than this to describe its arguments cannot be used in a prompt anyway, and the
 * honest answer is to refuse it rather than to store a schema nothing will ever render.
 */
const MAX_SCHEMA_BYTES = 64 * 1024;

/** The C0 set except tab/newline, DEL, and C1 — same set the bridge strips from results. */
const CONTROL_CHARS = /[\x00-\x08\x0b-\x1f\x7f-\x9f]/g;
const ANSI_ESCAPE = /\x1b\[[0-9;?]*[ -\/]*[@-~]/g;

/** Strip what should never be rendered, and cap. Never throws; never returns undefined. */
function clean(text: string, max: number): string {
  const stripped = text.replace(ANSI_ESCAPE, "").replace(CONTROL_CHARS, "");
  return stripped.length > max ? `${stripped.slice(0, max)}… (truncated by Jaroku)` : stripped;
}

/**
 * A description, flattened to a single line.
 *
 * renderMcpReference (prompt.ts) pastes descriptions into an indented block in the generation
 * prompt. A description carrying its own newlines can leave that block and write what reads
 * like a new instruction section addressed to the model. Nothing can defend against injection
 * in the CONTENT — the words are kept verbatim, and the model is told where they came from —
 * but a third party does not get to control the SHAPE of a prompt we build.
 */
function cleanDescription(text: string): string {
  return clean(text, MAX_DESCRIPTION_CHARS).replace(/\s+/g, " ").trim();
}

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
  /**
   * How many advertised tools were refused as unusable — an illegal name, an unreadable
   * entry, a schema too large to store. Surfaced rather than counted in silence: a user who
   * cannot find the tool they came for deserves to be told it was dropped and not that it
   * does not exist.
   */
  rejected: number;
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
  const name = t["name"];
  // The name rule is applied here rather than trusted downstream because here is the only
  // place that still knows the tool came from a server, and can drop it instead of turning it
  // into a 400 from the model API three steps later. See TOOL_NAME_RE.
  if (typeof name !== "string" || !TOOL_NAME_RE.test(name) || RESERVED_TOOL_NAMES.has(name)) {
    return null;
  }
  const schema = t["inputSchema"];
  const usable = schema && typeof schema === "object" && !Array.isArray(schema)
    ? (schema as Record<string, unknown>)
    : null;
  // Measured before anything is kept: an oversized schema is refused whole, because storing a
  // truncated one would mean checking arguments against a schema the server never declared.
  if (usable && JSON.stringify(usable).length > MAX_SCHEMA_BYTES) return null;
  return {
    name,
    description: typeof t["description"] === "string" ? cleanDescription(t["description"]) : null,
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
  if (url.username || url.password) {
    // Refused before anything is sent, and the endpoint is deliberately NOT quoted back.
    //
    // fetch() rejects a credentialed URL outright, so this can never connect — but the
    // TypeError it throws quotes the whole URL, and that message is what gets stored in
    // mcp_servers.last_error, broadcast to every connected client, and printed to the log. A
    // URL a user pasted because it had their token in it would put that token in three places
    // that are supposed to never hold one.
    return {
      ok: false,
      status: "error",
      error:
        "this endpoint has a username or password in the URL, which cannot be used and would " +
        "put a credential somewhere Jaroku does not store credentials. Give the plain URL and " +
        "add the token separately — it is written to runtime/.env and sent as a bearer token.",
    };
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
    let rejected = 0;

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
        if (!tool) {
          rejected++;
          continue;
        }
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

    // serverInfo is a claim like any other, and it is rendered in the panel and logged. Bound
    // and strip it for the same reason the tool fields are.
    const info = client.getServerVersion();
    return {
      ok: true,
      server_name: info?.name ? clean(info.name, MAX_SERVER_FIELD_CHARS) : null,
      server_version: info?.version ? clean(info.version, MAX_SERVER_FIELD_CHARS) : null,
      protocol_version: transport.protocolVersion
        ? clean(transport.protocolVersion, MAX_SERVER_FIELD_CHARS)
        : null,
      tools: unique,
      truncated,
      rejected: rejected + (tools.length - unique.length),
    };
  } catch (err) {
    return { ok: false, ...classifyDiscoveryFailure(err) };
  } finally {
    // Best effort: a server that refuses to close must not turn discovery into a hang.
    await client.close().catch(() => {});
  }
}
