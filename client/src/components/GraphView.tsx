// Graph View (Week 5, 🟢): a read-only React Flow reflection of the agent's LangGraph structure.
// Nodes/edges come from the server's static introspection (graphStore); lib/graphLayout.ts lays
// them out TOP TO BOTTOM and says what each one is, and this component draws them. It is NOT an
// editable canvas — the user changes an agent by talking, not by dragging nodes.
//
// Visual language: flat and minimal, no glow/tilt/gradient. A step is a card that carries its own
// meaning — an icon well, the node's name, and its role and description under it. Start and End
// are pills, because they say nothing an arrow does not. A fork is a small decision pill named
// after the function that decides. The ReAct agent's card names its model and each tool it can
// call in a strip along its bottom edge. Edges are rounded right angles with an arrowhead, and a
// loop goes round the side rather than back up through the cards.
//
// THE CARD USED TO BE EMPTY. It was a 168 × 72 box with one glyph in the middle and the name
// underneath, outside it, in the smallest type on the screen — so zooming out lost the text first
// and kept the box that said nothing longest. Its edges had connection diamonds on every side and
// the last card had a "+" after it, and a screen reader was told it could delete an edge: a
// read-only canvas dressed as an editor. All of that is gone.
//
// Trace sync stays intact: cards carry status dots and the active/selected accent bar, and clicking
// a node still selects its trace step.

import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { ReactElement } from "react";
import {
  ReactFlow,
  Background,
  BackgroundVariant,
  Controls,
  MiniMap,
  Handle,
  MarkerType,
  Position,
  BaseEdge,
  EdgeLabelRenderer,
  type AriaLabelConfig,
  type Edge,
  type EdgeProps,
  type FitViewOptions,
  type Node,
  type NodeProps,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import { useBuildStore, type GenFile } from "../store/buildStore.ts";
import { agentMcpToolNames } from "../store/mcpStore.ts";
import { useGraphStore } from "../store/graphStore.ts";
import { graphErrorCopy, isMappedGraphError, type GraphErrorCopy } from "../lib/graphError.ts";
import { useTraceStore } from "../store/traceStore.ts";
import { useUiStore } from "../store/uiStore.ts";
import { sendLoadAgentGraph } from "../lib/socket.ts";
import { alpha } from "../lib/palette.ts";
import { ACCENT, ICON, INTERACTION, RADIUS, STATUS, SURFACE, TEXT } from "../lib/tokens.ts";
import {
  AGENT_FOOTER_H,
  CARD_H,
  CARD_W,
  FIT_PADDING,
  MAX_FIT_ZOOM,
  MIN_ZOOM,
  ROLE_LABEL,
  buildFlow,
  frameFor,
  isReactAgent,
  loopPath,
  matchesEdge,
  nodeAriaLabel,
  readingOrder,
  routePath,
  type FlowLayout,
  type FlowNodeSpec,
  type FlowRole,
  type Point,
} from "../lib/graphLayout.ts";
import { EmptyState } from "./EmptyState.tsx";
import { Truncate } from "./Truncate.tsx";
import { GitBranchIcon } from "./panelIcons.tsx";
import { activeEdge, activeNodeId, latestStepForNode, stepEdge, stepNodeId, traversedEdges } from "../lib/traceGraphMap.ts";
import type { Step } from "../types.ts";
import {
  AgentIcon,
  ActionIcon,
  ToolIcon,
  TriggerIcon,
  TerminalIcon,
  modelResource,
  toolResource,
} from "./graphIcons.tsx";
import { Icon } from "../lib/icons/registry.ts";

// How much of this canvas the Step Details overlay covers when it is open. It is drawn over
// the graph rather than beside it, so this is the one number that tells fitView the right
// edge is not really the right edge. Kept in step with StepDetailPanel's `w-[340px]`.
const STEP_PANEL_W = 340;
// The node inspector, which is an overlay for the same reason. Kept in step with its `w-64`.
const INSPECTOR_W = 256;

// Glyph sizes on the canvas, named here rather than written out at each call site. They were
// 28px, centred in a card with nothing else in it, because the glyph WAS the card's face. The card
// now carries the node's name beside it, so the same marks are drawn at the size of an icon in a
// row: the well is a 28px square, the pill is a line of 11px text, the strip is a row of logos.
const NODE_ICON = {
  /** Inside a step card's 28px icon well. */
  card: 16,
  /** Inside the Start and End pills. */
  pill: 12,
  /** A model or tool logo in the ReAct agent's strip. */
  resource: 16,
} as const;
/** The step card's icon well. */
const WELL = 28;

type FitOptions = Pick<FitViewOptions, "padding" | "maxZoom">;

// ── palette (flat) ────────────────────────────────────────────────────────────
// Solid, opaque cards on the design-system panel colour; a one-step fill marks the selected/active
// state (paired with a thin accent bar on the left edge — never a glow). Every value is the token
// it was once a hex copy of, which is what keeps the canvas on the same palette as the panels
// behind it.
//
// The fill used to be a slightly LIGHTER step for the selected state, because on near-black that is
// the only direction a surface can move. On §01's light ladder it is a step down, and `SURFACE`
// already knows which.
const CARD_BG = SURFACE.panel; // cards — solid and confident on the canvas behind them
const CARD_BG_ACTIVE = SURFACE.active; // selected/active fill
const ICON_BG = SURFACE.chrome; // the icon square inside a card
const BORDER = SURFACE.edge; // thin, subtle card outline (no colour, no glow)
const DIAMOND = TEXT.faint; // the decision pill's mark
const EDGE = SURFACE.grip;
const SEL = INTERACTION.accent; // selection accent (left bar only) — the app's, not the canvas's own
const AMBER = STATUS.pending; // running/active accent (left bar only)
// Transient click micro-interaction highlight: the accent itself, with two alphas of it carrying the
// falloff. On a light canvas an ink particle is more legible than a coloured one.
const PULSE = INTERACTION.accent;
const PULSE_GLOW_STRONG = alpha(INTERACTION.accent, 0.9);
const PULSE_GLOW = alpha(INTERACTION.accent, 0.65);
// What the minimap dims OUTSIDE the viewport rectangle. The canvas at an alpha rather than ink:
// a dark wash on a light minimap inverts its meaning, making the part you are looking at the part
// that reads as switched off.
const MINIMAP_MASK = alpha(SURFACE.void, 0.7);

type NodeStatus = "ok" | "error" | "running";
const STATUS_COLOR: Record<NodeStatus, string> = { ok: STATUS.ok, error: STATUS.error, running: STATUS.pending };

type Brand = ReturnType<typeof modelResource>;
type FlowData = {
  spec: FlowNodeSpec;
  /** True when this tool node calls a third-party MCP server. Drives the rose marker. */
  mcp?: boolean;
  active: boolean;
  selected: boolean;
  status?: NodeStatus;
  /** The ReAct agent's model and tools, for the strip along its card's bottom edge. */
  resources?: { model: Brand; tools: Brand[] };
};
type EdgeData = {
  hot?: boolean;
  branch?: string;
  back?: boolean;
  via?: Point[];
  lane?: number;
  pulse?: boolean;
  particle?: boolean;
  pulseKey?: number;
};

// THE MARKS, ON THE ROLES THEY MEAN. The same five glyphs as before, each on its own token: a model
// call wears the agent's mark in ink, because calling the model is what an agent is; a tool node
// is ACCENT.reviewed and a plain step ACCENT.state by name, as tokens.ts always said they were.
const ROLE_ICON: Record<Exclude<FlowRole, "decision">, (p: { size?: number }) => ReactElement> = {
  start: TriggerIcon,
  end: TerminalIcon,
  model: AgentIcon,
  step: ActionIcon,
  tool: ToolIcon,
};
const ROLE_ACCENT: Record<Exclude<FlowRole, "decision">, string> = {
  start: STATUS.pending,
  end: TEXT.faint,
  model: TEXT.ink,
  step: ACCENT.state,
  tool: ACCENT.reviewed,
};
// ACCENT.mcp itself — one badge colour across the plan card, the trace and here, from one place.
const ACCENT_MCP = ACCENT.mcp;
const SURFACE_BG = SURFACE.bg;

// WHAT A SCREEN READER IS TOLD ABOUT THE CANVAS. React Flow's defaults describe an editor: "Press
// delete to remove it", "use the arrow keys to move the node around". Nothing here can be moved or
// removed, and saying it can is the same lie the diamonds and the "+" told sighted users.
const READ_ONLY_ARIA: Partial<AriaLabelConfig> = {
  "node.a11yDescription.default": "Press enter to inspect this step.",
  "node.a11yDescription.keyboardDisabled": "Press enter to inspect this step.",
  "edge.a11yDescription.default": "",
};

// ── small building blocks ─────────────────────────────────────────────────────
function Diamond({ style }: { style: React.CSSProperties }) {
  return (
    <span
      className="absolute pointer-events-none"
      style={{ width: 9, height: 9, background: DIAMOND, transform: "translate(-50%,-50%) rotate(45deg)", borderRadius: 1.5, ...style }}
    />
  );
}

const HANDLE_HIDDEN = "!w-1.5 !h-1.5 !bg-transparent !border-0 !min-w-0 !min-h-0";

/**
 * Where edges meet a node: in at the top and out at the bottom, down the column — and one more
 * pair on the right, for a loop. An edge back UP the column drawn top-to-bottom would run straight
 * through every card between its ends; leaving and arriving on the side sends it round them.
 */
function Handles() {
  return (
    <>
      <Handle id="in" type="target" position={Position.Top} className={HANDLE_HIDDEN} />
      <Handle id="out" type="source" position={Position.Bottom} className={HANDLE_HIDDEN} />
      <Handle id="loop-in" type="target" position={Position.Right} className={HANDLE_HIDDEN} />
      <Handle id="loop-out" type="source" position={Position.Right} className={HANDLE_HIDDEN} />
    </>
  );
}

function StatusDot({ status }: { status?: NodeStatus }) {
  if (!status) return null;
  const c = STATUS_COLOR[status];
  return (
    <span
      className={`absolute -top-1.5 -right-1.5 w-3 h-3 rounded-full ${status === "running" ? "animate-stream-pulse motion-reduce:animate-none" : ""}`}
      style={{ background: c, boxShadow: `0 0 0 2.5px ${CARD_BG}` }}
      title={status}
    />
  );
}

// The selected/active state: a slightly lighter fill + a thin accent bar on the left edge.
// No coloured full border, no glow, no shadow (design-system discipline).
function stateBg(d: FlowData): string {
  return d.active || d.selected ? CARD_BG_ACTIVE : CARD_BG;
}
function AccentBar({ d, radius }: { d: FlowData; radius: number }) {
  const color = d.active ? AMBER : d.selected ? SEL : null;
  if (!color) return null;
  return (
    <span
      className="absolute left-0 top-0 bottom-0 pointer-events-none"
      style={{ width: 3, background: color, borderTopLeftRadius: radius, borderBottomLeftRadius: radius }}
    />
  );
}

/** The same plug outline as panelIcons.PlugIcon, at the size this corner marker needs. */
function McpPlugGlyph() {
  return (
    <svg width={11} height={11} viewBox="0 0 24 24" fill="none" stroke="currentColor"
      strokeWidth={2.2} strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M12 22v-5" />
      <path d="M9 8V2" />
      <path d="M15 8V2" />
      <path d="M18 8v5a4 4 0 0 1-4 4h-4a4 4 0 0 1-4-4V8z" />
    </svg>
  );
}

/**
 * A card's second line: what the step does, in its docstring's words — or, without one, what kind
 * of step it is. Not both: "Model call · Split the job descri…" spent half the line repeating the
 * glyph beside it and cut the one sentence only this card can say. The kind is still in the glyph,
 * the hover and the inspector.
 */
function metaOf(d: FlowData): string {
  if (d.mcp) return "Tool node · reaches MCP";
  return d.spec.doc ?? ROLE_LABEL[d.spec.role];
}

// ── step card ─────────────────────────────────────────────────────────────────
function StepNode({ data }: NodeProps) {
  const d = data as FlowData;
  const { spec } = d;
  const role = spec.role as Exclude<FlowRole, "decision">;
  const Glyph = ROLE_ICON[role];
  const meta = metaOf(d);
  return (
    <div className="relative select-none" style={{ width: spec.w, height: spec.h }}>
      <div
        className="relative flex h-full flex-col overflow-hidden rounded-card"
        style={{ background: stateBg(d), border: `1px solid ${BORDER}` }}
      >
        <AccentBar d={d} radius={RADIUS.card} />
        <div className="flex shrink-0 items-center gap-2.5 px-3" style={{ height: CARD_H - 2 }}>
          <span
            className="flex shrink-0 items-center justify-center rounded-control"
            style={{ width: WELL, height: WELL, background: ICON_BG, color: ROLE_ACCENT[role] }}
          >
            <Glyph size={NODE_ICON.card} />
          </span>
          {/* NAME OVER WHAT IT IS. A 13px/500 name over an 11px/400 line at §02's secondary ink is
              two levels apart on three axes at once, which is the whole hierarchy a card needs. */}
          <span className="flex min-w-0 flex-col gap-0.5 leading-tight">
            <Truncate className="text-label text-ink" title={spec.title}>{spec.title}</Truncate>
            <Truncate className={`text-tiny ${d.mcp ? "" : "text-muted"}`} title={d.spec.doc ? `${ROLE_LABEL[spec.role]} — ${d.spec.doc}` : meta}>
              <span style={d.mcp ? { color: ACCENT_MCP } : undefined}>{meta}</span>
            </Truncate>
          </span>
        </div>
        {d.resources && <ResourceStrip resources={d.resources} />}
      </div>
      <StatusDot status={d.status} />
      {/* The MCP marker, corner-mounted like StatusDot. On the card rather than only in the meta
          line, because zoomed out the line is the first thing to become unreadable and this is
          the one label that must survive it. */}
      {d.mcp && (
        <span
          className="absolute -top-1.5 -left-1.5 flex h-4 w-4 items-center justify-center rounded-full"
          style={{ background: SURFACE_BG, color: ACCENT_MCP }}
          title="This tool calls a third-party MCP server Jaroku has not reviewed"
        >
          <McpPlugGlyph />
        </span>
      )}
      <Handles />
    </div>
  );
}

/**
 * The ReAct agent's model and tools, along its card's bottom edge. They were circles hanging under
 * the card on dashed curves, which in a column collide with the next step down; and what they say —
 * this is the model, these are the tools it may call — belongs to the agent, so it sits on it.
 */
function ResourceStrip({ resources }: { resources: { model: Brand; tools: Brand[] } }) {
  const all = [resources.model, ...resources.tools];
  return (
    <div
      className="flex shrink-0 items-center gap-3 overflow-hidden px-3"
      style={{ height: AGENT_FOOTER_H, borderTop: `1px solid ${BORDER}` }}
    >
      {all.map((b, i) => (
        <span key={i} className="flex min-w-0 shrink-0 items-center gap-1.5 text-tiny text-muted">
          <b.Icon size={NODE_ICON.resource} />
          <span className="max-w-[88px]">
            <Truncate title={b.label}>{b.label}</Truncate>
          </span>
        </span>
      ))}
    </div>
  );
}

// ── Start and End ─────────────────────────────────────────────────────────────
function PillNode({ data }: NodeProps) {
  const d = data as FlowData;
  const { spec } = d;
  const role = spec.role as "start" | "end";
  const Glyph = ROLE_ICON[role];
  return (
    <div className="relative select-none" style={{ width: spec.w, height: spec.h }}>
      <div
        className="flex h-full items-center justify-center gap-1.5 rounded-pill text-tiny text-muted"
        style={{ background: stateBg(d), border: `1px solid ${BORDER}` }}
      >
        <span className="flex" style={{ color: ROLE_ACCENT[role] }}>
          <Glyph size={NODE_ICON.pill} />
        </span>
        {spec.title}
      </div>
      <StatusDot status={d.status} />
      <Handles />
    </div>
  );
}

// ── decision ──────────────────────────────────────────────────────────────────
/**
 * A fork, named after the function that decides it, with that function's docstring on hover. The
 * compiled graph has no node here at all — only the edges leaving it — which made the one place an
 * agent chooses the one thing about it the canvas could not show.
 */
function DecisionNode({ data }: NodeProps) {
  const d = data as FlowData;
  const { spec } = d;
  return (
    <div className="relative select-none" style={{ width: spec.w, height: spec.h }} title={spec.doc ?? undefined}>
      <div
        className="flex h-full items-center justify-center gap-2 rounded-pill px-3 text-tiny text-muted"
        style={{ background: d.selected ? CARD_BG_ACTIVE : ICON_BG, border: `1px solid ${BORDER}` }}
      >
        <span className="relative shrink-0" style={{ width: 9, height: 9 }}>
          <Diamond style={{ left: "50%", top: "50%" }} />
        </span>
        <Truncate>{spec.title}</Truncate>
      </div>
      <Handles />
    </div>
  );
}

const nodeTypes = { step: StepNode, pill: PillNode, decision: DecisionNode };

// ── edge ──────────────────────────────────────────────────────────────────────
function FlowEdge({ sourceX, sourceY, targetX, targetY, data, markerEnd }: EdgeProps) {
  const d = (data ?? {}) as EdgeData;
  // Down the column through the points dagre routed it by, or — a loop — up its own lane.
  const s = { x: sourceX, y: sourceY };
  const t = { x: targetX, y: targetY };
  const { d: path, label } = d.lane !== undefined ? loopPath(s, t, d.lane) : routePath(s, t, d.via);
  const labelX = label.x;
  const labelY = label.y;
  // Transient click highlight takes visual precedence over the persistent selection edge.
  const stroke = d.pulse ? PULSE : d.hot ? AMBER : EDGE;
  const width = d.pulse || d.hot ? 2.2 : 1.4;
  return (
    <>
      <BaseEdge
        path={path}
        markerEnd={markerEnd}
        style={{
          stroke,
          strokeWidth: width,
          filter: d.pulse ? `drop-shadow(0 0 3px ${PULSE_GLOW})` : undefined,
          transition: "stroke 120ms ease",
        }}
      />
      {/* a single particle travelling source→target — the real data-flow direction (only when the
          node has executed and this edge was actually traversed). Keyed so re-clicks restart it. */}
      {d.particle && (
        <circle r="3.6" fill={PULSE} style={{ filter: `drop-shadow(0 0 4px ${PULSE_GLOW_STRONG})` }}>
          <animateMotion key={d.pulseKey} dur="0.42s" repeatCount="1" fill="freeze" path={path} />
        </circle>
      )}
      {d.branch && (
        <EdgeLabelRenderer>
          <div
            className="nodrag nopan absolute rounded-pill px-1.5 text-tiny"
            style={{
              transform: `translate(-50%,-50%) translate(${labelX}px, ${labelY}px)`,
              background: ICON_BG,
              color: d.hot ? STATUS.pending : TEXT.muted,
              pointerEvents: "none",
            }}
          >
            {d.branch}
          </div>
        </EdgeLabelRenderer>
      )}
    </>
  );
}

const edgeTypes = { flow: FlowEdge };

// ── helpers ───────────────────────────────────────────────────────────────────
function findPrompt(files: Record<string, GenFile>): string | undefined {
  const all = Object.values(files);
  const md = all.find((f) => /prompt/i.test(f.path) && f.path.endsWith(".md"));
  if (md?.content) return md.content;
  return all.find((f) => f.path.endsWith("prompts.py"))?.content;
}
function findToolFiles(files: Record<string, GenFile>): GenFile[] {
  const all = Object.values(files);
  const perTool = all.filter(
    (f) => /(^|\/)tools\//.test(f.path) && f.path.endsWith(".py") && !f.path.endsWith("__init__.py"),
  );
  if (perTool.length) return perTool;
  const flat = all.find((f) => f.path.endsWith("tools.py"));
  return flat ? [flat] : [];
}

/** What the inspector calls a node. A model-calling step is not the ReAct agent and has no prompt file. */
function inspectorType(spec: FlowNodeSpec): string {
  if (spec.role === "model") return isReactAgent(spec.id) ? "agent" : "model";
  return spec.role;
}

// ── node inspector ────────────────────────────────────────────────────────────
function NodeInspector({ nodeId, ntype, onClose }: { nodeId: string; ntype: string; onClose: () => void }) {
  const files = useBuildStore((s) => s.files);
  const runs = useTraceStore((s) => s.runs);
  const activeRunId = useTraceStore((s) => s.activeRunId);
  const run = activeRunId ? runs[activeRunId] : undefined;
  const prompt = findPrompt(files);
  const toolFiles = findToolFiles(files);

  return (
    <div className="absolute top-2 right-2 bottom-2 w-64 bg-elevated rounded-card border border-edge p-3 overflow-auto text-caption shadow-floating">
      <div className="flex items-center justify-between mb-3">
        <Truncate className="text-ink" title={nodeId}>{nodeId}</Truncate>
        <button className="text-muted transition-colors duration-fast hover:text-ink" title="Close (Esc)" aria-label="Close" onClick={onClose}>
          <Icon.workspace.close size={ICON.sm} />
        </button>
      </div>
      <Row label="Type" value={ntype} />
      {ntype === "agent" && run && <Row label="Model" value={run.model} />}
      {ntype === "agent" && prompt && (
        <Section title="Prompt">
          <pre className="whitespace-pre-wrap text-muted text-tiny leading-relaxed">{prompt.slice(0, 1200)}</pre>
        </Section>
      )}
      {ntype === "tool" && toolFiles.length > 0 && (
        <Section title={`Tools (${toolFiles.length})`}>
          {toolFiles.map((f) => (
            <div key={f.path} className="mb-3">
              <div className="text-faint text-tiny mb-1">{f.path}</div>
              <pre className="whitespace-pre-wrap text-muted text-tiny leading-relaxed">{f.content.slice(0, 800)}</pre>
            </div>
          ))}
        </Section>
      )}
      {ntype === "start" && <p className="text-faint mt-2">Graph entry point.</p>}
      {ntype === "end" && <p className="text-faint mt-2">Graph terminal.</p>}
    </div>
  );
}
function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex justify-between py-1">
      <span className="text-muted">{label}</span>
      <Truncate className="ml-2 text-ink" title={value}>{value}</Truncate>
    </div>
  );
}
function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="mt-3">
      <div className="text-faint mb-1">{title}</div>
      {children}
    </div>
  );
}

function computeNodeStatus(bucket: Record<string, Step> | undefined, activeNode: string | undefined): Record<string, NodeStatus> {
  const out: Record<string, NodeStatus> = {};
  if (!bucket) return out;
  for (const step of Object.values(bucket)) {
    const nid = stepNodeId(step, bucket);
    if (!nid) continue;
    if (step.error) out[nid] = "error";
    else if (out[nid] !== "error") out[nid] = "ok";
  }
  if (activeNode && out[activeNode] !== "error") out[activeNode] = "running";
  return out;
}

// THE SHAPE OF WHAT IS COMING: three cards down the column, as the graph will be drawn.
function GraphSkeleton() {
  return (
    <div className="graph-canvas flex h-full items-center justify-center">
      <div className="flex flex-col items-center gap-6">
        {[0, 1, 2].map((i) => (
          <div key={i} className="flex flex-col items-center gap-6">
            <div className="animate-stream-pulse rounded-card bg-active motion-reduce:animate-none" style={{ width: CARD_W, height: CARD_H }} />
            {i < 2 && <div className="h-6 w-px bg-hair" />}
          </div>
        ))}
      </div>
    </div>
  );
}

export function GraphView() {
  const activeAgentId = useBuildStore((s) => s.activeAgentId);
  // From the AGENT's manifest, not from the graph: topology is introspected from the
  // compiled LangGraph object and knows nothing about where a tool's code came from.
  const agent = useBuildStore((s) => s.agents.find((a) => a.agent_id === s.activeAgentId));
  const mcpNames = useMemo(() => agentMcpToolNames(agent?.mcp_tools), [agent?.mcp_tools]);
  const graph = useGraphStore((s) => (activeAgentId ? s.graphs[activeAgentId] : undefined));
  const loading = useGraphStore((s) => (activeAgentId ? s.loading[activeAgentId] : undefined));
  const files = useBuildStore((s) => s.files);
  const agents = useBuildStore((s) => s.agents);
  const [selected, setSelected] = useState<{ id: string; type: string } | null>(null);

  // Transient click micro-interaction: highlight a clicked node's connected edges (and pulse a
  // particle along the ones that actually carried data), settling back after ~480ms.
  const [pulse, setPulse] = useState<{ node: string; key: number } | null>(null);
  const pulseTimer = useRef<number | undefined>(undefined);
  const triggerPulse = (id: string) => {
    setPulse((p) => ({ node: id, key: (p?.key ?? 0) + 1 }));
    if (pulseTimer.current) clearTimeout(pulseTimer.current);
    pulseTimer.current = window.setTimeout(() => setPulse(null), 480);
  };
  useEffect(() => () => { if (pulseTimer.current) clearTimeout(pulseTimer.current); }, []);

  // Live trace state overlaid onto the static graph (execution status + selection sync).
  const activeRunId = useTraceStore((s) => s.activeRunId);
  const bucket = useTraceStore((s) => (activeRunId ? s.stepsByRun[activeRunId] : undefined));
  const runs = useTraceStore((s) => s.runs);
  const running = activeRunId ? runs[activeRunId]?.status === "running" : false;
  const selectedStepId = useTraceStore((s) => s.selectedStepId);
  const selectStep = useTraceStore((s) => s.selectStep);

  useEffect(() => {
    if (activeAgentId && !graph && !loading) sendLoadAgentGraph(activeAgentId);
  }, [activeAgentId, graph, loading]);

  // provider/model for the agent's strip
  const run = activeRunId ? runs[activeRunId] : undefined;
  const agentMeta = useMemo(() => agents.find((a) => a.agent_id === activeAgentId), [agents, activeAgentId]);
  const provider = run?.provider ?? agentMeta?.default_provider;
  const model = run?.model;

  // The layout, memoised on the static graph. The ReAct agent's card is always laid out with room
  // for its strip, because it always has a model to name.
  const flow = useMemo(() => (graph?.nodes?.length ? buildFlow(graph, { agentFooter: true }) : null), [graph]);
  const order = useMemo(() => (flow ? readingOrder(flow.nodes) : []), [flow]);

  // The ReAct agent's model and tools — derived from the agent's files and provider, not the
  // compiled graph, so they never participate in trace sync.
  const resources = useMemo(
    () => ({
      model: modelResource(provider, model),
      tools: findToolFiles(files).slice(0, 4).map((f) => toolResource(f.path)),
    }),
    [files, provider, model],
  );

  // ── keeping the graph in frame ──────────────────────────────────────────────
  //
  // `fitView` is an on-mount prop: React Flow frames the graph once, against the canvas as
  // it was at that instant, and then holds that viewport for good. Four ordinary things
  // move the frame out from under it, and each one silently cut nodes off with nothing to
  // say anything was missing:
  //
  //   1. Step Details opens. It is an OVERLAY — absolutely positioned over this canvas, not
  //      a column that shrinks it — so the canvas never resizes and fitView, told to use the
  //      full width, frames part of the graph underneath an opaque panel. Reserving the
  //      strip is the whole fix; there is nothing to observe.
  //   2. The node inspector opens, which is the same overlay on the same edge.
  //   3. The pane itself is resized (the column splitter, the window).
  //   4. A different agent is selected, and its topology is bigger than the last one's.
  //
  // Refit for all of them — but only until the user takes the wheel. Once they have panned or
  // zoomed deliberately, refitting is the view fighting them, so `userMoved` latches and
  // this stops. Selecting a different agent is a new graph rather than a new view of the
  // old one, so it releases the latch.
  //
  // AND NEVER PAST REAL SIZE. A three-step agent fitted to a 790px column came out at 175%, cards
  // the size of buttons; `maxZoom` holds a fit at 100% and leaves the space around it empty.
  const rf = useRef<{
    fitView: (o?: FitOptions) => void;
    setViewport: (v: { x: number; y: number; zoom: number }) => void;
  } | null>(null);
  const userMoved = useRef(false);
  const canvasRef = useRef<HTMLDivElement>(null);
  const [frame, setFrame] = useState({ width: 0, height: 0 });

  // Kept in a ref as well as in render, so the ResizeObserver below — registered once — fits
  // against the panel state at the time it fires rather than at the time it was created.
  const detailOpen = useTraceStore((s) => Boolean(s.expandedStepId));
  const inspectorOpen = selected !== null;
  // Mirrors StepDetailPanel's `w-[340px] max-w-[85%]` and the inspector's `w-64`, plus a gutter
  // so the nearest node does not sit flush against the panel's edge.
  const covered = useMemo(() => {
    const width = canvasRef.current?.clientWidth ?? 0;
    return Math.round(detailOpen ? Math.min(STEP_PANEL_W, width * 0.85) + 24 : inspectorOpen ? INSPECTOR_W + 24 : 0);
  }, [detailOpen, inspectorOpen]);
  const fitOptions = useMemo<FitOptions>(
    () =>
      covered
        ? { padding: { top: "6%", bottom: "6%", left: "6%", right: `${covered}px` }, maxZoom: MAX_FIT_ZOOM }
        : { padding: FIT_PADDING, maxZoom: MAX_FIT_ZOOM },
    [covered],
  );

  // Read by the ResizeObserver below, which is registered once and must frame against what is
  // true when it fires rather than when it was created.
  const live = useRef<{ fit: FitOptions; covered: number; flow: FlowLayout | null }>({ fit: fitOptions, covered, flow });
  live.current = { fit: fitOptions, covered, flow };

  // NOT SHOWN UNTIL IT IS FRAMED. React Flow paints its first frame at 100% from the origin, and
  // the framing lands a frame later — so the graph appeared in the corner and jumped to the middle.
  const [framed, setFramed] = useState(false);

  // Fit the whole graph, or open a long one at a readable size from the top (see frameFor).
  const frameGraph = () => {
    const el = canvasRef.current;
    const inst = rf.current;
    const { fit, covered: hidden, flow: laid } = live.current;
    if (!el || !inst || !laid || el.clientWidth === 0) return;
    const framing = frameFor(laid, { width: el.clientWidth, height: el.clientHeight }, hidden);
    if (framing.kind === "fit") inst.fitView(fit);
    else inst.setViewport({ x: framing.x, y: framing.y, zoom: framing.zoom });
    setFramed(true);
  };

  const topologyKey = useMemo(
    () => `${activeAgentId}|${flow?.nodes.map((n) => n.id).join(",") ?? ""}`,
    [activeAgentId, flow],
  );

  useEffect(() => {
    userMoved.current = false;
  }, [activeAgentId]);

  // Before paint, so a new agent's graph is never drawn once in the last one's frame.
  useLayoutEffect(() => {
    if (userMoved.current) return;
    frameGraph();
  }, [topologyKey, fitOptions]);

  useEffect(() => {
    const el = canvasRef.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    let raf = 0;
    const ro = new ResizeObserver(() => {
      // Coalesce to one refit per frame: a drag on the splitter fires this continuously.
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(() => {
        setFrame({ width: el.clientWidth, height: el.clientHeight });
        if (!userMoved.current) frameGraph();
      });
    });
    ro.observe(el);
    return () => {
      cancelAnimationFrame(raf);
      ro.disconnect();
    };
  }, [flow !== null]);

  // THE MINIMAP IS FOR A GRAPH TOO BIG TO READ WHOLE. It took a fifth of the panel to show seven
  // nodes that were already all on screen. It appears when the graph opens from the top because it
  // would not fit readably — which is exactly when you need it to find your way.
  // Not under the inspector, which covers the corner it sits in.
  const showMinimap = !!flow && frame.width > 0 && !inspectorOpen && frameFor(flow, frame, covered).kind === "top";

  const activeNode = useMemo(() => (running ? activeNodeId(bucket) : undefined), [running, bucket]);
  const selectedNode = useMemo(() => {
    const step = selectedStepId && bucket ? bucket[selectedStepId] : undefined;
    return step ? stepNodeId(step, bucket!) : undefined;
  }, [selectedStepId, bucket]);
  const nodeStatus = useMemo(() => computeNodeStatus(bucket, activeNode), [bucket, activeNode]);

  // Edges the current run actually traversed (source→target = real data direction), reused from
  // traceGraphMap. Drives the directional particle in the click micro-interaction.
  const traversed = useMemo(() => {
    const set = new Set<string>();
    for (const e of traversedEdges(bucket)) set.add(`${e.source}->${e.target}`);
    return set;
  }, [bucket]);

  const hotEdge = useMemo(() => {
    if (selectedStepId && bucket) {
      const step = bucket[selectedStepId];
      return step ? stepEdge(step, bucket) : undefined;
    }
    return running ? activeEdge(bucket) : undefined;
  }, [running, selectedStepId, bucket]);

  const nodes = useMemo<Node[]>(() => {
    if (!flow) return [];
    return flow.nodes.map((spec) => {
      // LangGraph gives the whole tool step one node — usually called "tools" — so there is
      // no per-tool card to mark. What IS true of that node is that it reaches unreviewed
      // third-party code, and that is what it says. Deliberately not "MCP tool": the same
      // node also runs the agent's reviewed and bespoke tools, and claiming otherwise would
      // overstate exactly where the badge must not.
      const mcp = spec.role === "tool" && (mcpNames.has(spec.id) || mcpNames.size > 0);
      const data: FlowData = {
        spec,
        mcp,
        active: spec.id === activeNode,
        selected: spec.id === selectedNode || spec.id === selected?.id,
        status: nodeStatus[spec.id],
        resources: isReactAgent(spec.id) ? resources : undefined,
      };
      return {
        id: spec.id,
        type: spec.role === "decision" ? "decision" : spec.role === "start" || spec.role === "end" ? "pill" : "step",
        position: { x: spec.x, y: spec.y },
        // Declared, not left to be measured. These nodes are rebuilt from the introspected
        // topology on every render, so React Flow's measured size never survives onto the
        // object it hands the MiniMap — which skips any node whose dimensions it cannot read,
        // and so drew an empty grey rectangle.
        width: spec.w,
        height: spec.h,
        ariaLabel: nodeAriaLabel(spec, order),
        data,
      };
    });
  }, [flow, order, resources, activeNode, selectedNode, selected?.id, nodeStatus, mcpNames]);

  const edges = useMemo<Edge[]>(() => {
    if (!flow) return [];
    return flow.edges.map((e) => {
      const hot = matchesEdge(e, hotEdge);
      const connected = pulse
        ? e.source === pulse.node || e.target === pulse.node || e.from === pulse.node || e.to.includes(pulse.node)
        : false;
      const particle = connected && e.to.some((t) => traversed.has(`${e.from}->${t}`));
      const color = connected ? PULSE : hot ? AMBER : EDGE;
      return {
        id: e.id,
        source: e.source,
        target: e.target,
        sourceHandle: e.back ? "loop-out" : "out",
        targetHandle: e.back ? "loop-in" : "in",
        type: "flow",
        markerEnd: { type: MarkerType.ArrowClosed, width: 14, height: 14, color },
        data: { hot, pulse: connected, particle, pulseKey: pulse?.key, branch: e.branch, back: e.back, via: e.via, lane: e.lane } satisfies EdgeData,
      };
    });
  }, [flow, hotEdge, pulse, traversed]);

  // Clicking a node and pressing Enter on it do the same thing: open what it is, and point the
  // composer and the trace at it. A decision is not a step; it stands for the step it decides for.
  const openNode = (id: string, viaClick: boolean) => {
    const spec = flow?.nodes.find((n) => n.id === id);
    if (!spec) return;
    const nodeId = spec.decides?.source ?? spec.id;
    setSelected({ id: spec.id, type: inspectorType(spec) });
    useUiStore.getState().setSelectedNodeId(nodeId); // composer context: this graph node
    if (viaClick) triggerPulse(spec.id); // transient connected-edge highlight + directional particle
    const step = latestStepForNode(nodeId, bucket);
    selectStep(step ? step.id : null);
  };

  if (!activeAgentId) return <Empty title="No agent selected" hint="Pick one in the sidebar and its compiled topology is introspected and drawn here." />;
  if (loading && !graph) return <GraphSkeleton />;
  // THE PATH IS NOT PROSE. This branch rendered the server's raw message as centred sans text —
  // which for the common failure is a 120-character object-store key with two UUIDs in it,
  // wrapping across four lines in the middle of the pane. One muted sentence, and the key itself
  // set in mono and middle-truncated by the same component every other path in the app goes
  // through, with the whole string on hover.
  // A FAILURE IS NOT AN EMPTY STATE THAT HAS NOT FILLED IN YET. "No graph for this version yet"
  // over `ContractError: cannot import agents.working_agent.agent: No module named …` made two
  // claims at once — wait, and a hard import failure waiting does not fix — with an internal
  // Python module path between them and no next step after them. See lib/graphError: the class is
  // mapped to a sentence and, where one honestly exists, an action; the server's own string is kept
  // behind a disclosure, because whoever is debugging their own agent needs that module path.
  if (graph?.error) {
    return (
      <GraphFailure
        copy={graphErrorCopy(graph.error)}
        showRaw={isMappedGraphError(graph.error)}
        detail={graph.errorKey}
        onRetry={activeAgentId ? () => sendLoadAgentGraph(activeAgentId) : undefined}
      />
    );
  }
  if (!flow) return <Empty title="No graph to show" hint="This agent’s build_graph() produced no nodes." />;

  return (
    <div
      ref={canvasRef}
      className={`graph-canvas relative h-full w-full ${framed ? "" : "opacity-0"}`}
      // Enter on a focused node opens it, as a click does. Read off the node's own element, because
      // React Flow reports a keyboard selection only for nodes whose state it holds, and these are
      // rebuilt from the introspected topology on every render.
      onKeyDown={(e) => {
        if (e.key !== "Enter" && e.key !== " ") return;
        const id = (e.target as HTMLElement).closest?.(".react-flow__node")?.getAttribute("data-id");
        if (id) {
          e.preventDefault();
          openNode(id, false);
        }
      }}
    >
      <ReactFlow
        nodes={nodes}
        edges={edges}
        nodeTypes={nodeTypes}
        edgeTypes={edgeTypes}
        onInit={(inst) => {
          rf.current = inst;
          frameGraph();
        }}
        // onMove, not onMoveStart: panning is a drag gesture, and its START fires on any
        // mousedown on the canvas — so latching there would have counted an ordinary click
        // on empty space as "the user is driving" and disabled refitting for good. onMove
        // fires only once the viewport actually changes, and reports null when the change
        // came from our own fitView.
        onMove={(event) => {
          if (event) userMoved.current = true;
        }}
        minZoom={MIN_ZOOM}
        maxZoom={1.75}
        // A COLUMN SCROLLS. Two fingers on a trackpad move down a long agent the way they move
        // down a page; a pinch, or the controls, zoom.
        panOnScroll
        proOptions={{ hideAttribution: true }}
        // READ-ONLY, AND SAYING SO. Nothing here can be dragged, connected or deleted, so
        // nothing offers to be: no delete key, no focusable edges, and the canvas's own
        // screen-reader text describes inspecting rather than editing.
        nodesDraggable={false}
        nodesConnectable={false}
        edgesFocusable={false}
        deleteKeyCode={null}
        ariaLabelConfig={READ_ONLY_ARIA}
        elementsSelectable
        onNodeClick={(_, n) => openNode(n.id, true)}
        onPaneClick={() => {
          setSelected(null);
          useUiStore.getState().setSelectedNodeId(null);
        }}
      >
        <Background variant={BackgroundVariant.Dots} gap={28} size={1} color={SURFACE.chrome} />
        <Controls showInteractive={false} className="!bg-elevated/80 !backdrop-blur !border-0 !rounded-card !shadow-floating" />
        {showMinimap && (
          <MiniMap
            pannable
            zoomable
            className="!bg-panel/80 !rounded-card !border-0"
            style={{ width: 120, height: 80 }}
            maskColor={MINIMAP_MASK}
            nodeColor={(n) => {
              const role = (n.data as FlowData | undefined)?.spec.role;
              return role && role !== "decision" ? ROLE_ACCENT[role] : TEXT.faint;
            }}
            nodeStrokeWidth={0}
          />
        )}
      </ReactFlow>
      {selected && <NodeInspector nodeId={selected.id} ntype={selected.type} onClose={() => setSelected(null)} />}
    </div>
  );
}

/**
 * TWO ELEMENTS, A SENTENCE AND A KEY, and it used to be one of each fighting over one slot.
 *
 * `detail` was the whole server message and it went straight through `Truncate variant="path"` —
 * which is a good component doing exactly what it was built for: keep the last path segment whole
 * and collapse everything before it. Handed a sentence ending in an object-store key, it kept
 * `.env.example` and threw away the diagnosis, so the one error path in this product that is wired
 * end to end delivered LESS than a raw string dump would, under a heading it had no visible
 * relationship to. The real sentence was one hover away, which is unreachable on touch.
 *
 * So `hint` carries prose and `detail` carries the identifier, and each is rendered as what it is.
 * Both are optional and either may stand alone: a failure with no key is a sentence, and the two
 * "nothing selected" states below still pass a hint and no key at all.
 */
/**
 * The Graph tab's failure state — §30's three questions, answered in that order.
 *
 * `showRaw` is FALSE for a class the mapping did not recognise, because in that case the raw string
 * is already the sentence and a disclosure would repeat it. That is deliberate rather than a
 * fallback: a default that swallowed an unknown error into "something went wrong" would be worse
 * than what this replaces, where the string was at least true.
 */
function GraphFailure({
  copy, showRaw, detail, onRetry,
}: {
  copy: GraphErrorCopy;
  showRaw: boolean;
  detail?: string;
  onRetry?: () => void;
}) {
  return (
    <div className="graph-canvas h-full">
      <EmptyState
        icon={GitBranchIcon}
        title={copy.title}
        hint={
          <span className="block">
            <span className="block">{copy.sentence}</span>
            {copy.next && <span className="mt-1 block text-muted">{copy.next}</span>}
            {detail && (
              // THE PATH IS NOT PROSE — mono and middle-truncated by the same component every other
              // path in this app goes through, with the whole string on hover.
              <Truncate
                variant="path"
                className="mx-auto mt-1 block max-w-full font-mono text-tiny text-faint"
                title={detail}
              >
                {detail}
              </Truncate>
            )}
            {showRaw && (
              // BEHIND A DISCLOSURE, NOT GONE. The person whose agent this is needs the module
              // path; the person who just opened a tab does not, and giving it to both is how the
              // panel ended up leading with a traceback.
              <details className="mx-auto mt-3 max-w-full text-left">
                <summary className="cursor-pointer text-tiny text-faint transition-colors hover:text-muted">
                  Show the error
                </summary>
                <pre className="mt-1 whitespace-pre-wrap break-words font-mono text-tiny text-faint">
                  {copy.raw}
                </pre>
              </details>
            )}
            {onRetry && copy.retryable && (
              <button
                type="button"
                onClick={onRetry}
                className="mx-auto mt-3 inline-flex items-center gap-1.5 rounded-control border border-edge px-2.5 py-1 text-tiny text-muted transition-colors hover:bg-active hover:text-ink"
              >
                <Icon.graph.retry size={ICON.xs} />
                Try again
              </button>
            )}
          </span>
        }
      />
    </div>
  );
}

function Empty({ title, hint, detail }: { title: string; hint?: string; detail?: string }) {
  return (
    <div className="graph-canvas h-full">
      <EmptyState
        icon={GitBranchIcon}
        title={title}
        hint={
          detail ? (
            <span className="block">
              {hint && <span className="block">{hint}</span>}
              <Truncate
                variant="path"
                className={`mx-auto block max-w-full font-mono text-tiny text-faint${hint ? " mt-1" : ""}`}
                title={detail}
              >
                {detail}
              </Truncate>
            </span>
          ) : (
            hint
          )
        }
      />
    </div>
  );
}
