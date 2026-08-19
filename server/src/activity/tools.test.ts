// §9's tool and MCP rollup, as claims — the four numbers nothing else in the product reports.
//
// ALL FOUR ARE READ OFF ROWS THAT ALREADY EXIST, and none of them has a column. That is the whole
// difficulty, and it is why each has a claim here rather than a comment:
//
//   THE CONFIRMATION RATES come from the steps the gate raised on. Nothing records a confirmation
//   being answered — the gate lives inside `mcp_bridge.py`, raises when it is refused and returns
//   silently when it is not — so a high-impact call carrying the runtime's "was not approved"
//   sentence is a refusal and one without it went through. That makes the numbers available for
//   history as well as for today, which a new write would not.
//
//   THE TRUNCATION RATE comes from a marker the Python runtime writes into the result itself. It is
//   a cross-language coupling and the suite asserts it against the runtime FILE rather than against
//   a copy of the string, so the two cannot drift without this going red.
//
//   THE REVIEWED-CONNECTOR FAILURE COUNT is v0.1.12's bug in aggregate: "trust in reviewed code
//   depends on failures being loud". It is a number that should be zero, in a place somebody will
//   notice it is not.
//
//   THE HIGH-IMPACT CALL COUNT is the denominator the first of those is a rate over.
//
// AND A REVIEWED CONNECTOR AND AN UNREAD SERVER TOOL MUST NEVER LOOK ALIKE, which §9 says in one
// sentence and which this suite holds by asserting the origin of every row.
//
//   npm run test:activity-tools

import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";

import { openTestSqlite } from "../db/testDb.ts";
import { IdentityRepository } from "../db/repositories/identity.ts";
import { AgentRepository } from "../db/repositories/agents.ts";
import { McpStore } from "../mcpStore.ts";
import { TraceStore } from "../store.ts";
import { newRequestId, systemContext, systemContextFor, type TenantContext } from "../db/tenant.ts";
import type { Run, Step } from "../types.ts";
import { ActivityStore } from "./activityStore.ts";
import { resolveWindow } from "./range.ts";
import { NOT_APPROVED, TRUNCATION_MARKER } from "./feed.ts";

let fail = 0;
const check = (name: string, ok: boolean, detail = ""): void => {
  if (ok) console.log(`  ok   ${name}`);
  else { fail++; console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ""}`); }
};

const NOW = new Date("2026-08-19T12:00:00.000Z");
const HOUR = 3_600_000;
const ago = (ms: number): string => new Date(NOW.getTime() - ms).toISOString();
const w = resolveWindow("24h", NOW, null);

/** The connector catalogue, read the way the connector layer reads it. */
const RUNTIME = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "runtime");
const catalog = JSON.parse(readFileSync(join(RUNTIME, "tool_templates", "catalog.json"), "utf8")) as {
  connectors: { tools: { name: string }[] }[];
};
const REVIEWED = catalog.connectors.flatMap((c) => c.tools.map((t) => t.name));

const db = await openTestSqlite();
const identity = new IdentityRepository(db);
const agents = new AgentRepository(db);
const mcp = new McpStore(db);
const trace = new TraceStore(db);
const store = new ActivityStore(db);

async function workspace(name: string): Promise<TenantContext> {
  const ws = await identity.createWorkspaceUnowned(systemContext(newRequestId()), {
    name: `${name} ${randomUUID().slice(0, 6)}`,
  });
  const ctx = systemContextFor(ws.id, newRequestId());
  await agents.upsertFromDisk(ctx, { slug: "worker", display_name: "Worker" });
  const runId = randomUUID();
  await trace.upsertRun(ctx, {
    id: runId, agent_id: "worker", provider: "anthropic", model: "claude-haiku-4-5",
    status: "completed", started_at: ago(2 * HOUR), ended_at: ago(HOUR), cost: 0, tokens: 0, error: null,
  } as Run);
  runs.set(ws.id, runId);
  return ctx;
}
const runs = new Map<string, string>();

let seq = 0;
async function toolCall(
  ctx: TenantContext,
  opts: { name: string; error?: string | null; output?: unknown; at?: string },
): Promise<void> {
  await trace.insertStep(ctx, {
    id: randomUUID(), run_id: runs.get(ctx.workspaceId)!, seq: seq++, type: "tool_call",
    name: opts.name, input: null, output: opts.output ?? "fine", state_before: null, state_after: null,
    tokens: null, cost: null, latency_ms: 10, error: opts.error ?? null,
    parent_step_id: null, started_at: opts.at ?? ago(90 * 60_000),
  } as Step);
}

async function highImpactTool(ctx: TenantContext, name: string, impact: "high" | "low" = "high"): Promise<void> {
  await mcp.upsertServer(ctx, {
    id: "mock", label: "mock", endpoint: "https://mcp.example", transport: "http",
    auth_env_key: null, server_name: null, server_version: null, protocol_version: null,
    status: "connected", last_error: null, discovered_at: null,
  });
  const existing = await mcp.listTools(ctx, "mock");
  await mcp.replaceTools(ctx, "mock", [
    ...existing.map((t) => ({
      name: t.name, description: t.description, input_schema: t.input_schema,
      annotations: t.annotations, impact: t.impact, impact_reason: t.impact_reason,
    })),
    { name, description: "a tool", input_schema: { type: "object" }, annotations: null, impact, impact_reason: "declared" },
  ]);
}

// --- the cross-language markers are the ones the runtime actually writes ---------------------------

console.log("\nthe two strings this rollup matches are the runtime's own");
{
  const bridge = readFileSync(join(RUNTIME, "tool_templates", "mcp_bridge.py"), "utf8");
  // THE COUPLING, ASSERTED. Neither of these has a column; both are sentences the Python side
  // writes into a step. If either phrase changes there and not here, a rate silently becomes zero —
  // so the check is against the file rather than against a second copy of the string.
  check(`the refusal phrase "${NOT_APPROVED}" is in mcp_bridge.py`, bridge.includes(NOT_APPROVED));
  check(`the truncation marker "${TRUNCATION_MARKER}" is too`, bridge.includes(TRUNCATION_MARKER));
  check("and the two refusal sentences are both there", bridge.includes("you declined this call") && bridge.includes("nobody confirmed it within"));
  check("the catalogue names some reviewed tools", REVIEWED.length > 0, REVIEWED.join(", "));
}

// --- a reviewed connector and an unread server tool do not look alike -------------------------------

console.log("\nthree origins, and none of them looks like another");
{
  const ctx = await workspace("origins");
  await highImpactTool(ctx, "send_message");
  await toolCall(ctx, { name: "send_message" });
  await toolCall(ctx, { name: REVIEWED[0]! });
  await toolCall(ctx, { name: "compute_discount" });

  const usage = await store.toolUsage(ctx, w, REVIEWED);
  const byName = new Map(usage.tools.map((t) => [t.name, t]));
  check("an MCP tool is marked as one", byName.get("send_message")?.origin === "mcp");
  check("...and carries its server", byName.get("send_message")?.serverId === "mock");
  check("...and its classification", byName.get("send_message")?.impact === "high");
  check("a reviewed connector tool is marked reviewed", byName.get(REVIEWED[0]!)?.origin === "reviewed");
  check("...and belongs to no server", byName.get(REVIEWED[0]!)?.serverId === null);
  check("anything else is bespoke", byName.get("compute_discount")?.origin === "bespoke");
  check("every call is counted once", usage.totalCalls === 3);
}

// --- the confirmation rates ---------------------------------------------------------------------------

console.log("\napprove, deny and time out, read off the steps the gate raised on");
{
  const ctx = await workspace("confirmations");
  await highImpactTool(ctx, "send_message");
  // Four that went through, two declined, one nobody answered.
  for (let i = 0; i < 4; i++) await toolCall(ctx, { name: "send_message" });
  for (let i = 0; i < 2; i++) {
    await toolCall(ctx, { name: "send_message", error: "mock/send_message was not approved: you declined this call." });
  }
  await toolCall(ctx, {
    name: "send_message",
    error: "mock/send_message was not approved: nobody confirmed it within 120s, so it was declined.",
  });

  const usage = await store.toolUsage(ctx, w, REVIEWED);
  check("seven high-impact calls", usage.highImpactCalls === 7, `${usage.highImpactCalls}`);
  check("four approved", usage.approved === 4, `${usage.approved}`);
  check("two denied", usage.denied === 2, `${usage.denied}`);
  check("one timed out", usage.timedOut === 1, `${usage.timedOut}`);
  // §9: both count as a refusal, "which is already how the runtime treats them".
  check("so three of seven were refused", usage.denied + usage.timedOut === 3);
  check("and the split still says which, because the two call for different next steps", usage.denied !== usage.timedOut);
}

// --- a low-impact call is not a confirmation ------------------------------------------------------------

console.log("\na low-impact tool is not asked about, so it is not in the rate");
{
  const ctx = await workspace("low impact");
  await highImpactTool(ctx, "read_page", "low");
  for (let i = 0; i < 5; i++) await toolCall(ctx, { name: "read_page" });

  const usage = await store.toolUsage(ctx, w, REVIEWED);
  check("the calls are counted", usage.totalCalls === 5);
  check("...and none of them is a high-impact call", usage.highImpactCalls === 0);
  // Which is the point: a rate whose denominator included every tool call would report a workspace
  // as 100% approving because most of what it does is never asked about.
  check("so the approval count is not inflated by them", usage.approved === 0);
}

// --- an override raises a tool, and the rollup follows it ---------------------------------------------------

console.log("\na workspace that raised a tool's classification means it");
{
  const ctx = await workspace("override");
  await highImpactTool(ctx, "fetch_thing", "low");
  await toolCall(ctx, { name: "fetch_thing" });

  const before = await store.toolUsage(ctx, w, REVIEWED);
  check("it starts out low", before.highImpactCalls === 0);

  await mcp.setToolImpactOverride(ctx, "mock", "fetch_thing", "high");
  const after = await store.toolUsage(ctx, w, REVIEWED);
  check("the override wins", after.highImpactCalls === 1);
  check("...and the row says so", after.tools.find((t) => t.name === "fetch_thing")?.impact === "high");
}

// --- the truncation rate ----------------------------------------------------------------------------------

console.log("\nhow often a tool result hit the size cap");
{
  const ctx = await workspace("truncation");
  await highImpactTool(ctx, "big_reader", "low");
  await toolCall(ctx, { name: "big_reader", output: "a short answer" });
  await toolCall(ctx, {
    name: "big_reader",
    output: `lots of text\n\n${TRUNCATION_MARKER} 84210 more characters were returned]`,
  });
  await toolCall(ctx, {
    name: "big_reader",
    output: `more text\n\n${TRUNCATION_MARKER} 12 more characters were returned]`,
  });

  const usage = await store.toolUsage(ctx, w, REVIEWED);
  check("three calls", usage.totalCalls === 3);
  check("two of them were truncated", usage.truncatedCalls === 2, `${usage.truncatedCalls}`);
  check("...and the per-tool row says so too", usage.tools.find((t) => t.name === "big_reader")?.truncated === 2);
}

// --- reviewed connector failures ------------------------------------------------------------------------------

console.log("\na reviewed connector's failures are counted where somebody will see them");
{
  const ctx = await workspace("reviewed failures");
  const reviewed = REVIEWED[0]!;
  await toolCall(ctx, { name: reviewed });
  await toolCall(ctx, { name: reviewed, error: "psycopg.OperationalError: connection refused" });
  await toolCall(ctx, { name: reviewed, error: "psycopg.OperationalError: connection refused" });
  // A bespoke tool failing is a different thing and must not be counted here.
  await toolCall(ctx, { name: "compute_discount", error: "ZeroDivisionError" });

  const usage = await store.toolUsage(ctx, w, REVIEWED);
  check("two reviewed failures", usage.reviewedFailures === 2, `${usage.reviewedFailures}`);
  // v0.1.12's bug in aggregate: a reviewed connector's failures had no route to the user at all.
  // The number that matters is the one that should be zero.
  check("the bespoke failure is not one of them", usage.reviewedFailures !== 3);
  check("though it is still on its own row", usage.tools.find((t) => t.name === "compute_discount")?.failures === 1);
}

// --- an empty range -----------------------------------------------------------------------------------------

console.log("\nno tool calls is no rows, not rows of zeros");
{
  const ctx = await workspace("no tools");
  const usage = await store.toolUsage(ctx, w, REVIEWED);
  check("no tools", usage.tools.length === 0);
  check("no calls", usage.totalCalls === 0 && usage.highImpactCalls === 0);
  // The card renders §3.5's dash from `totalCalls === 0`. A refusal RATE over nothing is what it
  // must never render as 0%, which would read as "every call was approved".
  check("and nothing to compute a rate from", usage.approved === 0 && usage.denied === 0 && usage.timedOut === 0);
}

await db.close();
console.log(fail === 0 ? "\nALL CORRECT" : `\n${fail} FAILURES`);
process.exit(fail === 0 ? 0 : 1);
