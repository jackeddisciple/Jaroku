// Capability discovery against the fixture MCP server.
//
// Everything an MCP server tells us is a claim, so the tests are about what happens when
// the claim is inconvenient: a paginated list, a duplicate name, a tool with no schema, a
// server that wants a credential, a server that is not there at all. Each of those is a
// user-visible state, and getting the wrong one means the UI sends someone to fix the wrong
// problem.
//
//   npm run test:mcp-client

import { startMockServer, PAGE_ONE, PAGE_TWO } from "../fixtures/mcp/mockServer.ts";
import { discover, classifyDiscoveryFailure } from "./mcpClient.ts";
import { classify } from "./mcpImpact.ts";

let fail = 0;
const check = (name: string, ok: boolean, detail = "") => {
  if (ok) console.log(`  ok   ${name}`);
  else { fail++; console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ""}`); }
};

// --- 1. the handshake, and following the server's cursor ------------------------------
{
  const mock = await startMockServer();
  const res = await discover({ endpoint: mock.url });

  if (!res.ok) {
    check("discovery succeeds against the fixture", false, `${res.status}: ${res.error}`);
  } else {
    check("discovery succeeds against the fixture", true);
    check("server identity comes from the handshake, not from us",
      res.server_name === "jaroku-mock-mcp" && res.server_version === "0.1.0",
      `${res.server_name} ${res.server_version}`);
    check("the negotiated protocol version is recorded", !!res.protocol_version, String(res.protocol_version));

    // Pagination: a client that stops at the first page silently loses half the tools, and
    // "half the tools" looks exactly like "the server only has these".
    const expected = PAGE_ONE.length + PAGE_TWO.length;
    check(`all ${expected} tools across both pages are discovered`,
      res.tools.length === expected, `got ${res.tools.length}`);
    check("page two really was fetched",
      res.tools.some((t) => t.name === "frobnicate"));
    check("nothing was truncated", res.truncated === false);

    const schemas = new Map(res.tools.map((t) => [t.name, t.input_schema]));
    check("declared schemas survive verbatim",
      JSON.stringify(schemas.get("send_message")?.["required"]) === '["channel","text"]');
    // A tool advertised with no schema is still a tool the server says exists. Dropping it
    // would be us quietly editing the server's answer.
    check("a tool with no declared schema is kept, with an empty object schema",
      schemas.has("frobnicate") &&
        (schemas.get("frobnicate") as Record<string, unknown>)["type"] === "object");

    const annotated = res.tools.find((t) => t.name === "purge_cache");
    check("annotations are kept verbatim",
      annotated?.annotations?.["readOnlyHint"] === true);
  }

  await mock.close();
}

// --- 2. discovery feeds the classifier the way registration will ----------------------
// Not a re-test of mcpImpact: the point is that what the client HANDS OVER classifies
// correctly, which is where a field-name mismatch between the two would show up.
{
  const mock = await startMockServer();
  const res = await discover({ endpoint: mock.url });
  if (!res.ok) {
    check("classification over discovered tools", false, res.error);
  } else {
    const verdicts = new Map(
      res.tools.map((t) => [t.name, classify({ name: t.name, description: t.description, annotations: t.annotations })]),
    );
    const expect: [string, "high" | "low"][] = [
      ["read_page", "low"],
      ["list_items", "low"],
      ["get_message", "low"],
      ["send_message", "high"],
      ["delete_record", "high"],
      ["get_or_create_issue", "high"],
      ["purge_cache", "high"],
      ["frobnicate", "high"],
    ];
    for (const [name, impact] of expect) {
      check(`${name} classifies ${impact}`, verdicts.get(name)?.impact === impact,
        `got ${verdicts.get(name)?.impact}`);
    }
    // The ratchet, end to end against a server that actively claims otherwise.
    check("the server's read-only claim on purge_cache is overruled AND explained",
      verdicts.get("purge_cache")!.reason.includes("does not get to certify"),
      verdicts.get("purge_cache")!.reason);
  }
  await mock.close();
}

// --- 3. a server that wants a credential ----------------------------------------------
{
  const mock = await startMockServer({ token: "sekrit" });

  const denied = await discover({ endpoint: mock.url });
  check("no token is auth_required, not unreachable",
    !denied.ok && denied.status === "auth_required",
    denied.ok ? "succeeded" : denied.status);
  check("the OAuth limitation is stated rather than left as 'unauthorized'",
    !denied.ok && denied.error.includes("OAuth"), denied.ok ? "" : denied.error);

  const wrong = await discover({ endpoint: mock.url, token: "wrong" });
  check("a rejected token is auth_required too", !wrong.ok && wrong.status === "auth_required");

  const ok = await discover({ endpoint: mock.url, token: "sekrit" });
  check("the right token gets in", ok.ok && ok.tools.length > 0);
  // The credential must not come back out in anything a caller might log or display.
  check("no failure message quotes the token",
    !denied.ok && !wrong.ok && !denied.error.includes("sekrit") && !wrong.error.includes("wrong"));

  await mock.close();
}

// --- 4. failures a user acts on differently -------------------------------------------
{
  // Nothing listening: reachable-looking URL, no server.
  const dead = await discover({ endpoint: "http://127.0.0.1:9/mcp", timeoutMs: 2000, deadlineMs: 4000 });
  check("a refused connection is unreachable", !dead.ok && dead.status === "unreachable",
    dead.ok ? "succeeded" : `${dead.status}: ${dead.error}`);

  const notMcp = await discover({ endpoint: "not-a-url" });
  check("a malformed endpoint is an error, not a network problem",
    !notMcp.ok && notMcp.status === "error");

  const wrongScheme = await discover({ endpoint: "ftp://example.com/mcp" });
  check("a non-http transport is refused by name",
    !wrongScheme.ok && wrongScheme.error.includes("only http(s)"));

  // stdio is deliberately unsupported — it means running a third-party binary.
  const stdio = await discover({ endpoint: "stdio:///usr/local/bin/some-server" });
  check("stdio is refused", !stdio.ok);
}

// --- 5. failure classification in isolation -------------------------------------------
{
  const cases: [string, string][] = [
    ["connect ECONNREFUSED 127.0.0.1:9", "unreachable"],
    ["getaddrinfo ENOTFOUND nope.invalid", "unreachable"],
    ["TypeError: fetch failed", "unreachable"],
    ["McpError: Request timed out", "unreachable"],
    ["HTTP 401 Unauthorized", "auth_required"],
    ["Error POSTing to endpoint: 403 Forbidden", "auth_required"],
    ["SyntaxError: Unexpected token < in JSON at position 0", "error"],
    ["something nobody has seen before", "error"],
  ];
  for (const [message, status] of cases) {
    check(`"${message.slice(0, 34)}…" -> ${status}`,
      classifyDiscoveryFailure(new Error(message)).status === status,
      classifyDiscoveryFailure(new Error(message)).status);
  }
  // The default is the one that does NOT invite a retry: a server that answered with
  // nonsense will answer with nonsense again, and retrying just hides that.
  check("unrecognised failures default to error, not unreachable",
    classifyDiscoveryFailure(new Error("???")).status === "error");
  check("a non-Error throw still classifies", classifyDiscoveryFailure("boom").status === "error");
}

console.log(fail === 0 ? "\nALL CORRECT" : `\n${fail} FAILURES`);
process.exit(fail === 0 ? 0 : 1);
