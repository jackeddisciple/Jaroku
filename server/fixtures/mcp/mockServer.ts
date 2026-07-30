// A fixture MCP server, so MCP support can be built and verified without a live
// third-party server, without credentials, and without spending money.
//
// Same purpose as server/fixtures/*.txt for the generation path (JAROKU_GEN_FIXTURE): the
// whole feature has to be exercisable end to end for free, or it only gets tested by
// accident.
//
// Deliberately written against node:http and raw JSON-RPC rather than the MCP SDK's server
// half. Two reasons:
//
//   1. A fixture has to be able to advertise things a well-behaved SDK server would never
//      let it advertise — a tool with no schema, a tool whose annotations claim it is
//      read-only while its name says otherwise, a cursor that keeps going. Those are the
//      cases the client and the classifier exist to handle, so the fixture must be able to
//      produce them.
//
//   2. It means the client is tested against a server that does NOT share its
//      implementation. Two halves of one library agreeing with each other proves less.
//
// Usage:
//   npm run mock:mcp                      # http://127.0.0.1:8931/mcp
//   MOCK_MCP_PORT=9000 npm run mock:mcp
//   MOCK_MCP_TOKEN=sekrit npm run mock:mcp    # requires Authorization: Bearer sekrit
//
// The tool list below is chosen to span the impact classifier's decision points, so a
// change that breaks classification shows up in the UI immediately and not just in a unit
// test. See mcpImpact.ts.

import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const PROTOCOL_VERSION = "2025-06-18";

interface MockTool {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  annotations?: Record<string, unknown>;
}

const str = (description: string) => ({ type: "string", description });

/**
 * Page one: the tools whose classification should be obvious.
 * Page two: the ones that are only correct if the ratchet works.
 */
export const PAGE_ONE: MockTool[] = [
  {
    name: "read_page",
    description: "Reads a page and returns its text content.",
    inputSchema: { type: "object", properties: { url: str("Page URL") }, required: ["url"] },
  },
  {
    name: "list_items",
    description: "Lists every item in a workspace.",
    inputSchema: {
      type: "object",
      properties: { workspace: str("Workspace id"), limit: { type: "integer", default: 20 } },
      required: ["workspace"],
    },
  },
  {
    // The false-friction guard. "message" is the object here, not the verb, and a gate that
    // fires on every mail-reading tool is a gate nobody reads.
    name: "get_message",
    description: "Returns a single message by id.",
    inputSchema: { type: "object", properties: { id: str("Message id") }, required: ["id"] },
  },
  {
    name: "send_message",
    description: "Sends a message to a channel. This is immediate and cannot be undone.",
    inputSchema: {
      type: "object",
      properties: { channel: str("Channel id"), text: str("Message body") },
      required: ["channel", "text"],
    },
  },
];

export const PAGE_TWO: MockTool[] = [
  {
    name: "delete_record",
    description: "Permanently deletes a record.",
    inputSchema: { type: "object", properties: { id: str("Record id") }, required: ["id"] },
  },
  {
    // The mixed name: leads with a read verb, writes anyway.
    name: "get_or_create_issue",
    description: "Finds an issue by title, creating it when there is no match.",
    inputSchema: {
      type: "object",
      properties: { title: str("Issue title"), team: str("Team key") },
      required: ["title"],
    },
  },
  {
    // The ratchet, end to end: the server insists this is read-only. It is called "purge".
    // The classifier must keep it high and must say that it overruled the server.
    name: "purge_cache",
    description: "Clears cached data for a workspace.",
    inputSchema: { type: "object", properties: { workspace: str("Workspace id") } },
    annotations: { readOnlyHint: true, title: "Purge cache" },
  },
  {
    // Says nothing about itself, and has no schema at all. Must land on high by default.
    name: "frobnicate",
    description: "Frobnicates.",
    inputSchema: {},
  },
];

const ALL_TOOLS = [PAGE_ONE, PAGE_TWO];

// --- JSON-RPC ----------------------------------------------------------------

interface RpcRequest {
  jsonrpc: "2.0";
  id?: string | number;
  method: string;
  params?: Record<string, unknown>;
}

const result = (id: unknown, value: unknown) => ({ jsonrpc: "2.0", id, result: value });
const rpcError = (id: unknown, code: number, message: string) => ({
  jsonrpc: "2.0",
  id,
  error: { code, message },
});

function handleRpc(req: RpcRequest): unknown | null {
  switch (req.method) {
    case "initialize":
      return result(req.id, {
        protocolVersion: PROTOCOL_VERSION,
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: "jaroku-mock-mcp", version: "0.1.0" },
      });

    case "notifications/initialized":
      return null; // a notification: acknowledged with 202 and no body

    case "tools/list": {
      // Paginated on purpose. A cursor is server-controlled state and the client has to
      // follow it correctly and bound it — neither is exercised by a single-page list.
      const cursor = req.params?.["cursor"];
      const page = cursor === undefined ? 0 : Number(cursor);
      if (!Number.isInteger(page) || page < 0 || page >= ALL_TOOLS.length) {
        return rpcError(req.id, -32602, `unknown cursor: ${String(cursor)}`);
      }
      const isLast = page === ALL_TOOLS.length - 1;
      return result(req.id, {
        tools: ALL_TOOLS[page],
        ...(isLast ? {} : { nextCursor: String(page + 1) }),
      });
    }

    case "tools/call": {
      const name = String(req.params?.["name"] ?? "");
      const args = (req.params?.["arguments"] ?? {}) as Record<string, unknown>;
      const known = ALL_TOOLS.flat().find((t) => t.name === name);
      if (!known) return rpcError(req.id, -32602, `unknown tool: ${name}`);
      return result(req.id, {
        content: [
          {
            type: "text",
            text: `${name} ran with ${JSON.stringify(args)}`,
          },
        ],
        isError: false,
      });
    }

    case "ping":
      return result(req.id, {});

    default:
      return rpcError(req.id, -32601, `method not found: ${req.method}`);
  }
}

// --- transport ---------------------------------------------------------------

const readBody = (req: IncomingMessage): Promise<string> =>
  new Promise((resolve, reject) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => resolve(body));
    req.on("error", reject);
  });

function send(res: ServerResponse, status: number, payload: unknown, headers: Record<string, string> = {}): void {
  const body = payload === null ? "" : JSON.stringify(payload);
  res.writeHead(status, {
    "content-type": "application/json",
    "mcp-session-id": "mock-session",
    ...headers,
  });
  res.end(body);
}

export interface MockServerHandle {
  url: string;
  close: () => Promise<void>;
}

/** Start the fixture server. Returns its /mcp endpoint and a close function. */
export function startMockServer(opts: { port?: number; token?: string | null } = {}): Promise<MockServerHandle> {
  const token = opts.token ?? null;

  const server = createServer((req, res) => {
    void (async () => {
      if (!req.url?.startsWith("/mcp")) return send(res, 404, { error: "not found" });

      // Auth, when the fixture is configured to want it. The 401 carries a
      // WWW-Authenticate header so the client's auth_required path is exercised against a
      // realistic response rather than a bare status code.
      if (token) {
        const provided = req.headers["authorization"];
        if (provided !== `Bearer ${token}`) {
          return send(
            res,
            401,
            rpcError(null, -32001, "Unauthorized: a bearer token is required"),
            { "www-authenticate": 'Bearer realm="mock", error="invalid_token"' },
          );
        }
      }

      if (req.method === "DELETE") return send(res, 200, {});
      // No server-initiated stream. A client that insists on one should fail cleanly rather
      // than hang, which is itself worth having a fixture for.
      if (req.method === "GET") return send(res, 405, { error: "SSE stream not supported" });
      if (req.method !== "POST") return send(res, 405, { error: "method not allowed" });

      let parsed: unknown;
      try {
        parsed = JSON.parse(await readBody(req));
      } catch {
        return send(res, 400, rpcError(null, -32700, "parse error"));
      }

      // A batch is a JSON array; the spec allows it and clients do send them.
      const requests: RpcRequest[] = Array.isArray(parsed) ? parsed : [parsed as RpcRequest];
      const responses = requests.map(handleRpc).filter((r) => r !== null);
      if (responses.length === 0) return send(res, 202, null);
      return send(res, 200, Array.isArray(parsed) ? responses : responses[0]);
    })().catch(() => {
      if (!res.headersSent) send(res, 500, rpcError(null, -32603, "internal error"));
    });
  });

  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(opts.port ?? 0, "127.0.0.1", () => {
      const addr = server.address();
      const port = typeof addr === "object" && addr ? addr.port : 0;
      resolve({
        url: `http://127.0.0.1:${port}/mcp`,
        close: () => new Promise((done) => server.close(() => done())),
      });
    });
  });
}

// Run directly: `npm run mock:mcp`. Importing it from a test starts nothing.
if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  const port = Number(process.env["MOCK_MCP_PORT"] ?? 8931);
  const token = process.env["MOCK_MCP_TOKEN"] ?? null;
  startMockServer({ port, token }).then((h) => {
    console.log(`[mock-mcp] listening on ${h.url}`);
    console.log(`[mock-mcp] ${ALL_TOOLS.flat().length} tools across ${ALL_TOOLS.length} pages`);
    if (token) console.log("[mock-mcp] a bearer token is required");
  });
}
