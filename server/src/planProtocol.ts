// The pre-generation plan: what the agent WILL be, shown before any code exists.
//
//     <<<PLAN section="tools">>>
//     - gmail_search — reviewed connector template (gmail)
//     - order_lookup — bespoke; reads order status from Postgres by order id
//     <<<ENDPLAN>>>
//
// Delimiters rather than bare `TOOLS:` headings for the reason fileProtocol.ts gives: a
// notes paragraph plausibly contains a line starting "STATE:"; nothing plausibly contains
// <<<PLAN section=…>>>. It also keeps the format coherent for a model already taught
// <<<FILE path=…>>> by the same prompt module.
//
// UNLIKE fileProtocol.ts this is NOT an incremental parser. The client renders raw deltas as
// prose while the plan streams and only needs structure once the stream ends, so none of the
// chunk-boundary holdback machinery is needed — parsePlan() is a pure function over the
// complete text.
//
// It DEGRADES, never hard-fails. Every AgentPlan carries `raw`, the plan card always falls
// back to rendering it, and confirming a plan is never blocked on a successful parse. A model
// that ignores the protocol entirely still produces something the user can read and act on;
// the structure is a bonus that buys grouped rendering and the connector cross-check below.

import type { Connector } from "./connectors.ts";
import type { McpToolView } from "./mcpRegistry.ts";

/**
 * Where a planned tool comes from. Three genuinely different provenances, and the plan card
 * renders each differently because the difference is what a reader needs:
 *
 *   connector  an audited template, copied in byte-for-byte
 *   bespoke    about to be written by a model, for this agent
 *   mcp        a call into a third-party server nobody here has reviewed
 */
export type ToolOrigin = "connector" | "bespoke" | "mcp";

export interface PlannedTool {
  name: string;
  origin: ToolOrigin;
  /** Catalog id, when the plan named one (e.g. "gmail"). Absent means "unresolved". */
  connectorId?: string;
  /** MCP server id, when origin is "mcp" and the plan named one. */
  mcpServerId?: string;
  summary: string;
}

export interface PlannedStateField {
  name: string;
  type: string;
  purpose: string;
}

export interface AgentPlan {
  tools: PlannedTool[];
  state: PlannedStateField[];
  /** Node/edge lines in plain language, verbatim. */
  graph: string[];
  notes: string[];
  /** Always the model's complete output — the card's fallback rendering. */
  raw: string;
  /** False when the stream ended inside an unclosed section (truncation). */
  complete: boolean;
}

const OPEN_RE = /<<<PLAN\s+section="([^"]+)"\s*>>>/g;
const CLOSE = "<<<ENDPLAN>>>";

/** Headings a model reaches for when it ignores the delimiters — the degraded fallback. */
const HEADING_RE = /^\s*(?:#{1,6}\s*)?(?:\*\*)?(tools|state|graph|nodes|edges|notes)(?:\*\*)?\s*:?\s*(?:\*\*)?\s*$/i;

// Words that precede "connector" as adjectives rather than naming one. Without this,
// "reviewed connector template" resolves to a connector called "reviewed".
const QUALIFIERS = new Set([
  "reviewed", "template", "the", "a", "an", "existing", "selected", "installed", "provided",
  "this", "that", "its", "our", "your",
  // For the MCP forms: "the external MCP server" must not resolve to a server called
  // "external", and "an MCP server" must not resolve to one called "an".
  "external", "third", "party", "connected", "remote", "mcp", "tool", "tools", "server",
]);

const BULLET_RE = /^\s*(?:[-*•‣]|\d+[.)])\s+/;
// Em dash, en dash, or a spaced hyphen. A bare hyphen is NOT a separator: tool and field
// names legitimately contain them.
const DASH_RE = /\s+[—–]\s+|\s+-\s+/;

/** Drop a markdown fence wrapping the whole response (or an individual section body). */
function stripFence(text: string): string {
  const t = text.trim();
  if (!t.startsWith("```")) return text;
  const firstNewline = t.indexOf("\n");
  if (firstNewline < 0) return text;
  const closing = t.lastIndexOf("```");
  if (closing <= firstNewline) return text;
  return t.slice(firstNewline + 1, closing);
}

/** Body lines of a section, bullets stripped, blanks dropped. */
function bulletLines(body: string): string[] {
  return stripFence(body)
    .split("\n")
    .map((l) => l.replace(BULLET_RE, "").trim())
    .filter((l) => l.length > 0);
}

function splitOnDash(line: string): [string, string] {
  const m = DASH_RE.exec(line);
  if (!m) return [line.trim(), ""];
  return [line.slice(0, m.index).trim(), line.slice(m.index + m[0].length).trim()];
}

function parseTool(line: string): PlannedTool | null {
  const [head, rest] = splitOnDash(line);
  // "name (bespoke)" / "name: ..." are both common — take the leading identifier.
  const name = (/^[`*]*([A-Za-z_][A-Za-z0-9_]*)/.exec(head)?.[1] ?? head).trim();
  if (!name) return null;

  const tail = rest || head.slice(name.length);

  // MCP is tested FIRST, before the connector test. A model writing "MCP connector" means
  // the third-party one, and letting the connector branch claim that line would label
  // unreviewed code as audited — the one mislabelling with real consequences.
  const isMcp = /\bmcp\b|\bexternal\s+(server|tool)\b/i.test(tail);
  if (isMcp) {
    // "mcp: linear/create_issue" / "(mcp: linear)" / "from the linear MCP server".
    const serverId = [
      /\bmcp[:\s]+([a-z][a-z0-9_]*)\s*\//i.exec(tail)?.[1],
      /\(\s*mcp[:\s]*([a-z][a-z0-9_]*)\s*\)/i.exec(tail)?.[1],
      /\b([a-z][a-z0-9_]*)\s+mcp\s+server\b/i.exec(tail)?.[1],
      // Colon required. Whitespace alone would let "MCP server tool" name a server "tool";
      // "MCP server: linear" is someone actually saying which one.
      /\bmcp\s+server:\s*([a-z][a-z0-9_]*)/i.exec(tail)?.[1],
    ]
      .map((c) => c?.toLowerCase())
      .find((c): c is string => Boolean(c) && !QUALIFIERS.has(c!));
    const tool: PlannedTool = { name, origin: "mcp", summary: tail.trim() };
    if (serverId) tool.mcpServerId = serverId;
    return tool;
  }

  const isConnector = /\b(reviewed|connector|template)\b/i.test(tail);
  // "(gmail)" / "connector: gmail" / "the gmail connector". The last form needs the qualifier
  // guard: "reviewed connector template" would otherwise yield a connector named "reviewed".
  const id = [
    /\(([a-z][a-z0-9_]*)\)/.exec(tail)?.[1],
    /\b([a-z][a-z0-9_]*)\s+connector\b/i.exec(tail)?.[1],
    /\bconnector[:\s]+([a-z][a-z0-9_]*)/i.exec(tail)?.[1],
  ]
    .map((c) => c?.toLowerCase())
    .find((c): c is string => Boolean(c) && !QUALIFIERS.has(c!));

  const tool: PlannedTool = {
    name,
    origin: isConnector ? "connector" : "bespoke",
    summary: tail.trim(),
  };
  if (isConnector && id) tool.connectorId = id;
  return tool;
}

function parseStateField(line: string): PlannedStateField | null {
  const [head, purpose] = splitOnDash(line);
  const colon = head.indexOf(":");
  const name = (colon >= 0 ? head.slice(0, colon) : head).replace(/[`*]/g, "").trim();
  if (!name) return null;
  return {
    name,
    type: colon >= 0 ? head.slice(colon + 1).replace(/[`*]/g, "").trim() : "",
    purpose: purpose.trim(),
  };
}

/**
 * Collect `section -> body` from the delimited blocks. An unclosed final block is kept (a
 * truncated plan is still worth showing) and reported via `complete: false`.
 */
function collectSections(text: string): { sections: Map<string, string>; complete: boolean } {
  const sections = new Map<string, string>();
  let complete = true;

  // Collect every opening delimiter up front, so each body can be bounded by the NEXT one
  // without any lastIndex juggling.
  const opens: { name: string; bodyStart: number; at: number }[] = [];
  OPEN_RE.lastIndex = 0;
  for (let m = OPEN_RE.exec(text); m; m = OPEN_RE.exec(text)) {
    opens.push({ name: m[1]!.trim().toLowerCase(), bodyStart: m.index + m[0].length, at: m.index });
  }

  if (opens.length > 0) {
    for (let i = 0; i < opens.length; i++) {
      const { name, bodyStart } = opens[i]!;
      const limit = opens[i + 1]?.at ?? text.length;
      const closeAt = text.indexOf(CLOSE, bodyStart);
      // A close belonging to THIS block must fall before the next block starts. Otherwise the
      // block was never closed — a truncated stream, or a model that forgot the delimiter.
      const closed = closeAt >= 0 && closeAt < limit;
      if (!closed) complete = false;
      const body = text.slice(bodyStart, closed ? closeAt : limit);
      sections.set(name, (sections.get(name) ?? "") + body);
    }
    return { sections, complete };
  }

  // No delimiters at all — fall back to markdown-ish headings so a model that ignored the
  // protocol still renders as something better than one prose blob.
  const lines = text.split("\n");
  let current: string | null = null;
  const buf: string[] = [];
  const flush = () => {
    if (current) sections.set(current, (sections.get(current) ?? "") + buf.join("\n") + "\n");
    buf.length = 0;
  };
  for (const line of lines) {
    const h = HEADING_RE.exec(line);
    if (h) {
      flush();
      const name = h[1]!.toLowerCase();
      // The prompt asks for "graph"; a model that writes NODES/EDGES means the same thing.
      current = name === "nodes" || name === "edges" ? "graph" : name;
      continue;
    }
    if (current) buf.push(line);
  }
  flush();
  return { sections, complete: true };
}

/** Parse a complete plan response. Never throws; unparseable input yields an empty plan
 *  whose `raw` still carries everything the model said. */
export function parsePlan(raw: string): AgentPlan {
  const text = raw.replace(/\r\n/g, "\n");
  const { sections, complete } = collectSections(text);

  const tools: PlannedTool[] = [];
  for (const line of bulletLines(sections.get("tools") ?? "")) {
    const t = parseTool(line);
    if (t) tools.push(t);
  }

  const state: PlannedStateField[] = [];
  for (const line of bulletLines(sections.get("state") ?? "")) {
    const f = parseStateField(line);
    if (f) state.push(f);
  }

  return {
    tools,
    state,
    graph: bulletLines(sections.get("graph") ?? ""),
    notes: bulletLines(sections.get("notes") ?? ""),
    raw: text,
    complete,
  };
}

/** Mirrors FileProtocolParser.finish(): an error string, or null when there's something to
 *  show. Only a genuinely empty response is an error — a plan that parsed into nothing but
 *  still has prose is degraded, not failed. */
export function planProblem(plan: AgentPlan): string | null {
  if (!plan.raw.trim()) return "the model produced no plan";
  return null;
}

/** True when the structure is empty and the card must fall back to raw text. */
export function isDegraded(plan: AgentPlan): boolean {
  return plan.tools.length === 0 && plan.state.length === 0 && plan.graph.length === 0;
}

/**
 * Cross-check the plan's connector claims against what the user actually selected — the
 * wrong-direction check that makes the structured parse earn its keep. Connector selection is
 * explicit UI (BuildPane), so a mismatch here is exactly the class of mistake this gate
 * exists to surface BEFORE any code is generated.
 */
export function reconcileWithSelection(
  plan: AgentPlan,
  selected: Connector[],
  /** The MCP tools the user scoped this agent to. Empty when none were selected. */
  mcpSelected: McpToolView[] = [],
): string[] {
  const warnings: string[] = [];
  const byId = new Map(selected.map((c) => [c.id, c]));
  const ownerOfTool = new Map<string, Connector>();
  for (const c of selected) for (const t of c.tools) ownerOfTool.set(t.name, c);

  // Scoped MCP tools, by name. Note what this reconciliation deliberately does NOT do: it
  // does not decide which tools the agent receives. That is the user's explicit per-tool
  // selection, full stop.
  //
  // The tempting alternative — intersect the selection with what the plan text mentions —
  // would hang a security boundary off a parser this very file documents as degrading
  // rather than failing. A plan the model wrote in prose instead of the delimiters would
  // silently strip every tool the user ticked, and a generation would come out broken for
  // reasons nobody could see. Warnings below; never a silent revocation.
  const mcpByName = new Map<string, McpToolView>();
  for (const t of mcpSelected) mcpByName.set(t.name, t);
  const mcpUsed = new Set<string>();
  const used = new Set<string>();

  for (const tool of plan.tools) {
    const owner = ownerOfTool.get(tool.name);
    const mcp = mcpByName.get(tool.name);

    if (tool.origin === "mcp") {
      if (mcp) {
        mcpUsed.add(mcp.name);
        // A plan naming a different server than the one the tool actually came from is
        // worth saying out loud: two servers can advertise the same tool name.
        if (tool.mcpServerId && tool.mcpServerId !== mcp.server_id) {
          warnings.push(
            `the plan attributes ${tool.name} to the ${tool.mcpServerId} MCP server, but the ` +
              `tool you selected with that name comes from ${mcp.server_id}. The selected one will be used.`,
          );
        }
      } else {
        warnings.push(
          `the plan calls ${tool.name} an MCP tool, but it isn't one of the MCP tools you ` +
            `selected — it will be written as bespoke code instead. Select it and re-plan to ` +
            `call the real one.`,
        );
      }
      continue;
    }

    // Marked connector or bespoke, but a scoped MCP tool has that exact name. The MCP tool
    // is what the agent will actually be given, so the plan is describing the wrong thing —
    // and describing unreviewed third-party code as either audited or model-written is the
    // mislabelling that matters most here.
    if (mcp) {
      mcpUsed.add(mcp.name);
      warnings.push(
        `the plan lists ${tool.name} as ${tool.origin === "connector" ? "a reviewed connector tool" : "bespoke"}, ` +
          `but it is an MCP tool from ${mcp.server_id} — third-party code Jaroku has not reviewed. ` +
          `That is what the agent will call.`,
      );
      continue;
    }

    if (tool.origin === "connector") {
      const id = tool.connectorId ?? owner?.id;
      if (id && byId.has(id)) {
        used.add(id);
      } else if (id) {
        warnings.push(
          `the plan uses the ${id} connector, which isn't selected — ${tool.name} will be ` +
            `written as bespoke code instead. Enable ${id} and re-plan to use the reviewed template.`,
        );
      } else {
        warnings.push(
          `the plan calls ${tool.name} a reviewed connector tool, but no selected connector ` +
            `provides it — it will be written as bespoke code.`,
        );
      }
      continue;
    }

    // Marked bespoke, but a selected connector already provides that exact tool.
    if (owner) {
      used.add(owner.id);
      warnings.push(
        `the plan lists ${tool.name} as bespoke, but it comes from the ${owner.id} connector — ` +
          `the reviewed template will be used, not model-written code.`,
      );
    }
  }

  for (const c of selected) {
    if (used.has(c.id)) continue;
    // Only claim this when the plan actually parsed a tool list; an empty one proves nothing.
    if (plan.tools.length === 0) continue;
    warnings.push(
      `${c.id} is selected and will be copied into the project, but the plan doesn't use any ` +
        `of its tools.`,
    );
  }

  // A scoped MCP tool the plan never mentions. Worth more than the connector version of this
  // warning: the agent WILL be handed it, and being handed a reach into someone else's system
  // that nothing in the plan asked for is exactly the over-grant least privilege is about.
  // Untick it and re-plan, or leave it — but knowingly.
  for (const t of mcpSelected) {
    if (mcpUsed.has(t.name)) continue;
    if (plan.tools.length === 0) continue;
    warnings.push(
      `you selected the MCP tool ${t.server_id}/${t.name}, but the plan doesn't use it. The ` +
        `agent will still be given it — untick it and re-plan if it isn't needed.`,
    );
  }

  return warnings;
}
