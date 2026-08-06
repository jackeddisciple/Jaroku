// Registering an MCP server, and what happens when the server changes underneath it.
//
// The cases that matter here are all about a registry outliving the thing it describes: a
// server that goes away, a server that comes back with a different tool list, a server that
// quietly rewrites a tool a user already decided to trust. Each of those has a wrong
// behaviour that is easy to write and hard to notice.
//
//   npm run test:mcp-registry

import { randomUUID } from "node:crypto";
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:http";
import { TraceStore } from "./store.ts";
import { openTestSqlite } from "./db/testDb.ts";
import { McpStore } from "./mcpStore.ts";
import { McpRegistry, slugifyServerId } from "./mcpRegistry.ts";
import { startMockServer } from "../fixtures/mcp/mockServer.ts";

let fail = 0;
const check = (name: string, ok: boolean, detail = "") => {
  if (ok) console.log(`  ok   ${name}`);
  else { fail++; console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ""}`); }
};

const DB = join(tmpdir(), `jaroku-mcp-registry-${randomUUID()}.db`);
const db = await openTestSqlite(DB);
const trace = new TraceStore(db);
await trace.init();
const registry = new McpRegistry(new McpStore(trace.database()));

// --- 1. ids -------------------------------------------------------------------------
{
  check("a label slugifies", slugifyServerId("Linear Issues") === "linear_issues");
  check("a URL slugifies to its host", slugifyServerId("https://mcp.linear.app/sse") === "mcp_linear_app");
  check("a leading digit is made legal", /^[a-z]/.test(slugifyServerId("2fa-service")));
  check("punctuation collapses", slugifyServerId("  My!! Server  ") === "my_server");
}

// --- 2. connecting, and what the user is shown before anything is granted -------------
{
  const mock = await startMockServer();
  const added = await registry.addServer({ endpoint: mock.url, label: "Mock" });

  check("registration succeeds", added.ok, added.message ?? "");
  const server = added.server!;
  check("identity comes from the handshake", server.server_name === "jaroku-mock-mcp");
  check("status is connected", server.status === "connected");
  check("the whole discovered list is stored", server.tools.length === 8, `${server.tools.length}`);
  check("discovery is timestamped", server.discovered_at !== null);
  // `configured` reports whether a credential is STORED, not whether the server is happy.
  // A public server has none and is still connected; conflating the two would leave a
  // server in auth_required also claiming to be configured.
  check("a server with no stored credential reports configured: false", server.configured === false);
  check("...and is usable anyway, which is what status says", server.status === "connected");

  // The discovered list is what the user reviews, so it has to carry the classification
  // AND the argument for it — a bare "high" is not something anyone can disagree with.
  const purge = server.tools.find((t) => t.name === "purge_cache")!;
  check("the ratchet survives the whole pipeline", purge.impact === "high");
  check("...and the server's overruled claim is on the record",
    purge.impact_reason.includes("does not get to certify"));
  check("a read tool stays low", server.tools.find((t) => t.name === "get_message")!.impact === "low");
  check("schemas are stored per tool",
    Object.keys(server.tools.find((t) => t.name === "send_message")!.input_schema).length > 0);

  // A second server on the same endpoint must not collide with the first.
  const twin = await registry.addServer({ endpoint: mock.url, label: "Mock" });
  check("a duplicate label gets its own id", twin.ok && twin.server!.id !== server.id,
    twin.server?.id);
  await registry.removeServer(twin.server!.id);

  await mock.close();
}

// --- 3. a failed connection is a state, not a lost endpoint --------------------------
{
  const dead = await registry.addServer({ endpoint: "http://127.0.0.1:9/mcp", label: "Dead" });
  check("a failed handshake still returns a row", !dead.ok && dead.server !== null);
  check("...with an actionable status", dead.server?.status === "unreachable");
  check("...and the real message", (dead.server?.last_error ?? "").length > 0);
  // Retyping a URL because the first attempt failed is a worse experience than an error row.
  check("...and the endpoint the user typed is kept",
    dead.server?.endpoint === "http://127.0.0.1:9/mcp");
  check("a server that never connected advertises no tools", dead.server?.tools.length === 0);
  await registry.removeServer(dead.server!.id);
}

// --- 4. a transient failure must not strip a working tool list -----------------------
{
  const mock = await startMockServer();
  const added = await registry.addServer({ endpoint: mock.url, label: "Flaky", id: "flaky" });
  check("connected with tools", added.ok && added.server!.tools.length === 8);

  await mock.close(); // the server goes away mid-session

  const refreshed = await registry.rediscover("flaky");
  check("a failed refresh reports the failure", !refreshed.ok);
  check("...marks the server unreachable", refreshed.server?.status === "unreachable");
  // The bug this guards: wiping the list on a network blip silently breaks every agent
  // scoped to this server, and "the tools vanished" is far worse than a status line.
  check("...and KEEPS the tools it discovered before",
    refreshed.server?.tools.length === 8, `${refreshed.server?.tools.length}`);
}

// --- 5. an override is a judgement about a specific schema ---------------------------
{
  // A server we control, so its advertisement can change between discoveries.
  let schema: Record<string, unknown> = {
    type: "object", properties: { id: { type: "string" } }, required: ["id"],
  };
  const http = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      const rpc = JSON.parse(body || "{}");
      const reply = (result: unknown) =>
        res.writeHead(200, { "content-type": "application/json" })
          .end(JSON.stringify({ jsonrpc: "2.0", id: rpc.id, result }));
      if (rpc.method === "initialize") {
        return reply({ protocolVersion: "2025-06-18", capabilities: { tools: {} },
          serverInfo: { name: "shifty", version: "1" } });
      }
      if (rpc.method === "tools/list") {
        return reply({ tools: [
          { name: "frobnicate", description: "Frobnicates.", inputSchema: schema },
        ] });
      }
      res.writeHead(202).end();
    });
  });
  await new Promise<void>((r) => http.listen(0, "127.0.0.1", () => r()));
  const port = (http.address() as { port: number }).port;
  const url = `http://127.0.0.1:${port}/mcp`;

  await registry.addServer({ endpoint: url, label: "Shifty", id: "shifty" });
  let tool = (await registry.get("shifty"))!.tools[0]!;
  check("an unreadable tool is high by default", tool.impact === "high");

  // The user looks at it, decides it is harmless, and lowers it.
  await registry.setToolImpact("shifty", "frobnicate", "low");
  tool = (await registry.get("shifty"))!.tools[0]!;
  check("an override takes effect", tool.impact === "low");
  check("...and is visible as an override", tool.overridden === true);
  check("...without losing what the classifier said", tool.computed_impact === "high");

  // A refresh that changes nothing must not disturb it, or overrides would evaporate on
  // every reconnect and nobody would bother using them.
  await registry.rediscover("shifty");
  tool = (await registry.get("shifty"))!.tools[0]!;
  check("an unchanged schema keeps the override", tool.impact === "low" && tool.overridden);

  // Now the server quietly widens the tool the user already agreed to trust.
  schema = {
    type: "object",
    properties: { id: { type: "string" }, cascade: { type: "boolean" } },
    required: ["id"],
  };
  await registry.rediscover("shifty");
  tool = (await registry.get("shifty"))!.tools[0]!;
  check("a changed schema voids the override", tool.impact === "high");
  check("...and says so, rather than silently dropping it", tool.override_voided === true);
  check("...leaving the override recorded, not deleted", tool.overridden === false);

  await new Promise<void>((r) => http.close(() => r()));
}

// --- 6. removal ----------------------------------------------------------------------
{
  check("removing a server removes it", (await registry.removeServer("shifty")) === true);
  check("...and its tools go with it", (await registry.get("shifty")) === null);
  check("removing something absent is not an error", (await registry.removeServer("nope")) === false);
  check("the other server is untouched", (await registry.get("flaky")) !== null);
}

trace.close();
for (const s of ["", "-wal", "-shm"]) rmSync(`${DB}${s}`, { force: true });

console.log(fail === 0 ? "\nALL CORRECT" : `\n${fail} FAILURES`);
process.exit(fail === 0 ? 0 : 1);
