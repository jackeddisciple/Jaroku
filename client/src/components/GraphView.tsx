// Graph View (Week 5, 🟢): a read-only React Flow reflection of the agent's LangGraph structure.
// Nodes/edges come from the server's static introspection (graphStore); this component lays them
// out (dagre, LEFT→RIGHT) and renders them. It is NOT an editable canvas — the user changes an
// agent by talking, not by dragging nodes.
//
// Visual language (n8n workflow-canvas restyle): flat and minimal, no glow/tilt/gradient. The
// compiled graph nodes are "flow nodes" on the main horizontal path (icon-in-a-square + bold
// title + muted subtitle for the LLM agent; compact centred-icon cards with the label beneath
// for trigger/tool/action/terminal). Beneath the LLM agent hang circular "resource nodes" — its
// model and each tool it can call, shown with full-colour brand logos, connected by dashed
// drooping curves labelled Model / Tool (exactly the reference's Model/Memory/Tool pattern).
// Connection points are small diamonds. Restraint + organization reads as premium on its own.
//
// Trace sync stays intact: the compiled flow nodes still carry status dots and the active/selected
// borders, and clicking a node still selects its trace step. Resource nodes are informational
// (derived from the agent's files, not the compiled graph) and never participate in trace sync.

import { useEffect, useMemo, useRef, useState } from "react";
import type { ReactElement } from "react";
import {
  ReactFlow,
  Background,
  BackgroundVariant,
  Controls,
  MiniMap,
  Handle,
  Position,
  BaseEdge,
  EdgeLabelRenderer,
  getBezierPath,
  type Edge,
  type EdgeProps,
  type Node,
  type NodeProps,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import Dagre from "@dagrejs/dagre";
import { useBuildStore, type GenFile } from "../store/buildStore.ts";
import { useGraphStore } from "../store/graphStore.ts";
import { useTraceStore } from "../store/traceStore.ts";
import { useUiStore } from "../store/uiStore.ts";
import { sendLoadAgentGraph } from "../lib/socket.ts";
import { activeEdge, activeNodeId, latestStepForNode, stepEdge, stepNodeId, traversedEdges } from "../lib/traceGraphMap.ts";
import type { AgentGraph, GraphNode as GNode, Step } from "../types.ts";
import {
  AgentIcon,
  ActionIcon,
  ToolIcon,
  TriggerIcon,
  TerminalIcon,
  modelResource,
  toolResource,
} from "./graphIcons.tsx";

// ── dimensions ────────────────────────────────────────────────────────────────
const AGENT_W = 300; // wide "AI Agent" card
const AGENT_H = 96;
const CARD_W = 168; // compact trigger/tool/action/terminal card
const CARD_H = 72;
const RES_D = 78; // resource circle diameter — prominent, brand-forward
const RANKSEP = 250; // horizontal gap between columns (generous, balanced)
const NODESEP = 190; // vertical gap between branch siblings
const RES_DROP = 178; // vertical distance from agent bottom to resource circles
const RES_GAP = 148; // horizontal spacing between resource circles
// Closest two resource circles may sit, centre to centre: their own width plus a gap wide enough
// that neither one's label can reach the other. The floor the model/tool row layout is held to.
const RES_MIN_SEP = RES_D + 24;

// ── palette (flat, n8n-ish) ───────────────────────────────────────────────────
// Solid, opaque cards on the design-system panel colour; a slightly lighter fill marks the
// selected/active state (paired with a thin accent bar on the left edge — never a glow).
const CARD_BG = "#18181b"; // panel colour — solid, confident cards
const CARD_BG_ACTIVE = "#1e1e22"; // selected/active fill (design-system "active" token)
const ICON_BG = "#232329"; // the icon square inside a card
const BORDER = "#2a2a30"; // thin, subtle card outline (no colour, no glow)
const DIAMOND = "#6c6c78";
const EDGE = "#4c4c56";
const EDGE_DASH = "#5a5a66";
const SEL = "#6b8afd"; // selection accent (left bar only)
const AMBER = "#f59e0b"; // running/active accent (left bar only)
const PULSE = "#8aa0ff"; // transient click micro-interaction highlight

type NodeStatus = "ok" | "error" | "running";
const STATUS_COLOR: Record<NodeStatus, string> = { ok: "#22c55e", error: "#ef4444", running: "#f59e0b" };

type FlowKind = "trigger" | "agent" | "tool" | "action" | "terminal";
type FlowData = {
  title: string;
  subtitle: string;
  kind: FlowKind;
  active: boolean;
  selected: boolean;
  status?: NodeStatus;
  ports?: { model: boolean; tool: boolean }; // agent-only bottom resource ports
};
type ResourceData = { label: string; kind: "model" | "tool"; parent: string; Icon: (p: { size?: number }) => ReactElement };

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

function StatusDot({ status }: { status?: NodeStatus }) {
  if (!status) return null;
  const c = STATUS_COLOR[status];
  return (
    <span
      className={`absolute -top-1.5 -right-1.5 w-3 h-3 rounded-full ${status === "running" ? "animate-pulse" : ""}`}
      style={{ background: c, boxShadow: `0 0 0 2.5px ${CARD_BG}` }}
      title={status}
    />
  );
}

// A small "+" extensibility affordance (decorative for now — the canvas is read-only).
function PlusChip({ style }: { style: React.CSSProperties }) {
  return (
    <span
      className="absolute flex items-center justify-center text-muted text-[13px] leading-none pointer-events-none"
      style={{ width: 20, height: 20, borderRadius: 6, background: "#202024", border: `1px solid ${BORDER}`, ...style }}
    >
      +
    </span>
  );
}

const KIND_ICON: Record<FlowKind, (p: { size?: number }) => ReactElement> = {
  trigger: TriggerIcon,
  agent: AgentIcon,
  tool: ToolIcon,
  action: ActionIcon,
  terminal: TerminalIcon,
};
const KIND_ACCENT: Record<FlowKind, string> = {
  trigger: "#f59e0b",
  agent: "#e4e4e7",
  tool: "#5eead4",
  action: "#a5b4fc",
  terminal: "#9ca3af",
};

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

// ── flow node ─────────────────────────────────────────────────────────────────
function FlowNode({ data }: NodeProps) {
  const d = data as FlowData;
  const Icon = KIND_ICON[d.kind];
  const accent = KIND_ACCENT[d.kind];

  if (d.kind === "agent") {
    const showModel = d.ports?.model;
    const showTool = d.ports?.tool;
    return (
      <div className="relative select-none font-mono" style={{ width: AGENT_W, height: AGENT_H }}>
        <div
          className="relative flex items-center gap-4 rounded-2xl px-5 h-full overflow-hidden"
          style={{ background: stateBg(d), border: `1px solid ${BORDER}` }}
        >
          <AccentBar d={d} radius={16} />
          <StatusDot status={d.status} />
          <span
            className="flex items-center justify-center rounded-xl shrink-0"
            style={{ width: 46, height: 46, background: ICON_BG, color: accent, border: `1px solid ${BORDER}` }}
          >
            <Icon size={24} />
          </span>
          <span className="flex flex-col min-w-0 leading-tight gap-1">
            <span className="text-ink font-semibold text-[15px] truncate">{d.title}</span>
            <span className="text-muted text-[12px] truncate">{d.subtitle}</span>
          </span>
        </div>

        {/* bottom resource ports — diamonds + a "+" by the tool port. The category label
            ("Model" / "Tool") lives on the dashed edge itself, so it isn't repeated here. */}
        {showModel && <Diamond style={{ left: "22%", top: AGENT_H }} />}
        {showTool && (
          <>
            <Diamond style={{ left: "74%", top: AGENT_H }} />
            <PlusChip style={{ left: "74%", top: AGENT_H + 15, transform: "translateX(-50%)" }} />
          </>
        )}

        {/* handles: flow in/out + resource ports */}
        <Handle id="in" type="target" position={Position.Left} className={HANDLE_HIDDEN} />
        <Handle id="out" type="source" position={Position.Right} className={HANDLE_HIDDEN} />
        <Handle id="res-model" type="source" position={Position.Bottom} style={{ left: "22%" }} className={HANDLE_HIDDEN} />
        <Handle id="res-tool" type="source" position={Position.Bottom} style={{ left: "74%" }} className={HANDLE_HIDDEN} />
        <Diamond style={{ left: 0, top: AGENT_H / 2 }} />
        <Diamond style={{ left: AGENT_W, top: AGENT_H / 2 }} />
      </div>
    );
  }

  // compact card (trigger / tool / action / terminal) — centred icon, label BELOW the card
  return (
    <div className="relative select-none font-mono" style={{ width: CARD_W, height: CARD_H }}>
      <div
        className="relative flex items-center justify-center rounded-2xl h-full overflow-hidden"
        style={{ background: stateBg(d), border: `1px solid ${BORDER}` }}
      >
        <AccentBar d={d} radius={16} />
        <StatusDot status={d.status} />
        <span style={{ color: accent }}>
          <Icon size={28} />
        </span>
        {d.kind === "terminal" && <PlusChip style={{ left: CARD_W + 12, top: CARD_H / 2, transform: "translateY(-50%)" }} />}
      </div>

      {/* label beneath the card */}
      <div className="absolute left-1/2 -translate-x-1/2 text-center" style={{ top: CARD_H + 8, width: 200 }}>
        <div className="text-ink text-[13px] font-medium leading-tight truncate">{d.title}</div>
        <div className="text-muted text-[11.5px] leading-tight truncate">{d.subtitle}</div>
      </div>

      <Handle id="in" type="target" position={Position.Left} className={HANDLE_HIDDEN} />
      <Handle id="out" type="source" position={Position.Right} className={HANDLE_HIDDEN} />
      <Diamond style={{ left: 0, top: CARD_H / 2 }} />
      <Diamond style={{ left: CARD_W, top: CARD_H / 2 }} />
    </div>
  );
}

// ── resource node (circle) ────────────────────────────────────────────────────
function ResourceNode({ data }: NodeProps) {
  const d = data as ResourceData;
  const Icon = d.Icon;
  return (
    <div className="relative select-none flex flex-col items-center font-mono" style={{ width: RES_D }}>
      <div
        className="flex items-center justify-center rounded-full"
        style={{ width: RES_D, height: RES_D, background: CARD_BG, border: `1px solid ${BORDER}` }}
      >
        <Icon size={44} />
      </div>
      <div className="absolute left-1/2 -translate-x-1/2 text-center" style={{ top: RES_D + 9, width: 112 }}>
        <div className="text-ink text-[12.5px] leading-tight truncate">{d.label}</div>
      </div>
      <Handle id="in" type="target" position={Position.Top} className={HANDLE_HIDDEN} />
      <Diamond style={{ left: RES_D / 2, top: 0 }} />
    </div>
  );
}

const nodeTypes = { flow: FlowNode, resource: ResourceNode };

// ── custom edges ──────────────────────────────────────────────────────────────
function FlowEdge({ sourceX, sourceY, targetX, targetY, sourcePosition, targetPosition, data }: EdgeProps) {
  const [path] = getBezierPath({ sourceX, sourceY, targetX, targetY, sourcePosition, targetPosition });
  const d = (data ?? {}) as { hot?: boolean; branch?: string; pulse?: boolean; particle?: boolean; pulseKey?: number };
  const hot = Boolean(d.hot);
  const branch = d.branch;
  // Transient click highlight takes visual precedence over the persistent selection edge.
  const stroke = d.pulse ? PULSE : hot ? AMBER : EDGE;
  const width = d.pulse ? 2.4 : hot ? 2.4 : 1.6;
  return (
    <>
      <BaseEdge
        path={path}
        style={{
          stroke,
          strokeWidth: width,
          filter: d.pulse ? "drop-shadow(0 0 3px rgba(138,160,255,0.65))" : undefined,
          transition: "stroke 120ms ease",
        }}
      />
      {/* a single particle travelling source→target — the real data-flow direction (only when the
          node has executed and this edge was actually traversed). Keyed so re-clicks restart it. */}
      {d.particle && (
        <circle r="3.6" fill={PULSE} style={{ filter: "drop-shadow(0 0 4px rgba(138,160,255,0.9))" }}>
          <animateMotion key={d.pulseKey} dur="0.42s" repeatCount="1" fill="freeze" path={path} />
        </circle>
      )}
      {branch && (
        // Place the branch label a short way ALONG the edge (not at the shared source point), so
        // sibling conditional edges leaving the same node don't stack their labels on top of each
        // other. Interpolating toward each distinct target separates them vertically.
        (() => {
          const t = 0.3;
          const lx = sourceX + (targetX - sourceX) * t;
          const ly = sourceY + (targetY - sourceY) * t - 9;
          return (
            <EdgeLabelRenderer>
              <div
                className="nodrag nopan absolute text-[11px] font-mono"
                style={{
                  transform: `translate(-50%,-50%) translate(${lx}px, ${ly}px)`,
                  color: hot ? "#fbbf24" : "#9a9aa4",
                  pointerEvents: "none",
                }}
              >
                {branch}
              </div>
            </EdgeLabelRenderer>
          );
        })()
      )}
    </>
  );
}

function ResourceEdge({ sourceX, sourceY, targetX, targetY, data }: EdgeProps) {
  // a dashed curve that drops out of the agent's bottom port and droops to the circle
  const path = `M ${sourceX},${sourceY} C ${sourceX},${sourceY + 54} ${targetX},${targetY - 44} ${targetX},${targetY}`;
  const label = (data as { label?: string })?.label;
  const mx = (sourceX + targetX) / 2;
  const my = (sourceY + targetY) / 2;
  return (
    <>
      <BaseEdge path={path} style={{ stroke: EDGE_DASH, strokeWidth: 1.4, strokeDasharray: "5 4" }} />
      {label && (
        <EdgeLabelRenderer>
          <div
            className="nodrag nopan absolute text-[11px] text-muted font-mono"
            style={{ transform: `translate(-50%,-50%) translate(${mx}px, ${my - 4}px)`, pointerEvents: "none" }}
          >
            {label}
          </div>
        </EdgeLabelRenderer>
      )}
    </>
  );
}

const edgeTypes = { flow: FlowEdge, resource: ResourceEdge };

// ── helpers ───────────────────────────────────────────────────────────────────
function prettify(id: string): string {
  if (id === "__start__") return "Start";
  if (id === "__end__" || id === "END") return "End";
  return id.replace(/[_-]+/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}
function branchName(raw: string | null | undefined): string | undefined {
  if (!raw) return undefined;
  if (raw === "__end__" || raw === "END") return "end";
  return raw;
}
function flowKind(n: GNode): FlowKind {
  if (n.type === "start") return "trigger";
  if (n.type === "end") return "terminal";
  if (n.type === "tool") return "tool";
  if (n.id === "agent" || n.id === "assistant") return "agent";
  return "action";
}
function subtitleFor(kind: FlowKind, model?: string): string {
  switch (kind) {
    case "agent":
      return model || "LLM agent";
    case "tool":
      return "Tool node";
    case "trigger":
      return "Trigger";
    case "terminal":
      return "Terminal";
    default:
      return "Action";
  }
}
function dimsFor(kind: FlowKind): { w: number; h: number } {
  return kind === "agent" ? { w: AGENT_W, h: AGENT_H } : { w: CARD_W, h: CARD_H };
}

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

// ── layout ────────────────────────────────────────────────────────────────────
// dagre lays out just the compiled flow nodes/edges (LEFT→RIGHT). Resource nodes are placed
// afterwards, beneath the agent — so they never perturb the main-path layout.
function layoutFlow(graph: AgentGraph, model?: string): { nodes: Node[]; edges: Edge[]; agentBox?: { x: number; y: number } } {
  const g = new Dagre.graphlib.Graph().setDefaultEdgeLabel(() => ({}));
  g.setGraph({ rankdir: "LR", nodesep: NODESEP, ranksep: RANKSEP, marginx: 60, marginy: 60 });

  const kinds = new Map<string, FlowKind>();
  for (const n of graph.nodes ?? []) {
    const kind = flowKind(n);
    kinds.set(n.id, kind);
    const { w, h } = dimsFor(kind);
    g.setNode(n.id, { width: w, height: h });
  }
  for (const e of graph.edges ?? []) g.setEdge(e.source, e.target);
  Dagre.layout(g);

  let agentBox: { x: number; y: number } | undefined;
  const nodes: Node[] = (graph.nodes ?? []).map((n: GNode) => {
    const kind = kinds.get(n.id)!;
    const pos = g.node(n.id);
    const { w, h } = dimsFor(kind);
    const position = { x: pos.x - w / 2, y: pos.y - h / 2 };
    if (kind === "agent") agentBox = position;
    return {
      id: n.id,
      type: "flow",
      position,
      data: {
        title: prettify(n.id),
        subtitle: subtitleFor(kind, model),
        kind,
        active: false,
        selected: false,
      } satisfies FlowData,
    };
  });

  const edges: Edge[] = (graph.edges ?? []).map((e, i) => ({
    id: `${e.source}->${e.target}-${i}`,
    source: e.source,
    target: e.target,
    sourceHandle: "out",
    targetHandle: "in",
    type: "flow",
    data: { branch: e.conditional ? branchName(e.label) : undefined },
  }));

  return { nodes, edges, agentBox };
}

// Build the circular resource nodes (model + tools) that hang beneath the agent node.
function buildResources(
  llmId: string,
  agentBox: { x: number; y: number },
  tools: GenFile[],
  model: { label: string; Icon: (p: { size?: number }) => ReactElement },
): { nodes: Node[]; edges: Edge[] } {
  const nodes: Node[] = [];
  const edges: Edge[] = [];
  const y = agentBox.y + AGENT_H + RES_DROP;

  // model circle under the left ("Model") port
  const modelPortX = agentBox.x + AGENT_W * 0.22;
  nodes.push({
    id: "res:model",
    type: "resource",
    position: { x: modelPortX - RES_D / 2, y },
    data: { label: model.label, kind: "model", parent: llmId, Icon: model.Icon } satisfies ResourceData,
    selectable: true,
    draggable: false,
  });
  edges.push({
    id: "res-edge:model",
    source: llmId,
    target: "res:model",
    sourceHandle: "res-model",
    targetHandle: "in",
    type: "resource",
    data: { label: "Model" },
  });

  // tool circles spread under the right ("Tool") port
  //
  // The model sits at a fixed x under its own port; the tool row is centred under the tool port and
  // grows outward in both directions. Those two facts collide: at three tools the row's left end
  // reached back past the model circle and sat almost exactly on top of it, so "Dry-run" and
  // "Gmail" were drawn over each other into an unreadable smear. Three tools is an ordinary agent,
  // so this was the common case, not an edge one.
  //
  // The row still centres under its port whenever there is room; it just cannot start left of the
  // model any more. Nothing overlaps at any tool count.
  const toolPortX = agentBox.x + AGENT_W * 0.74;
  const n = tools.length;
  const modelCx = modelPortX;
  const firstCx = Math.max(toolPortX - ((n - 1) * RES_GAP) / 2, modelCx + RES_MIN_SEP);
  tools.forEach((f, i) => {
    const { label, Icon } = toolResource(f.path);
    const cx = firstCx + i * RES_GAP;
    const id = `res:tool:${i}`;
    nodes.push({
      id,
      type: "resource",
      position: { x: cx - RES_D / 2, y },
      data: { label, kind: "tool", parent: llmId, Icon } satisfies ResourceData,
      selectable: true,
      draggable: false,
    });
    edges.push({
      id: `res-edge:tool:${i}`,
      source: llmId,
      target: id,
      sourceHandle: "res-tool",
      targetHandle: "in",
      type: "resource",
      data: { label: "Tool" },
    });
  });

  return { nodes, edges };
}

// ── node inspector (unchanged behaviour) ──────────────────────────────────────
function NodeInspector({ nodeId, ntype, onClose }: { nodeId: string; ntype: string; onClose: () => void }) {
  const files = useBuildStore((s) => s.files);
  const runs = useTraceStore((s) => s.runs);
  const activeRunId = useTraceStore((s) => s.activeRunId);
  const run = activeRunId ? runs[activeRunId] : undefined;
  const prompt = findPrompt(files);
  const toolFiles = findToolFiles(files);

  return (
    <div className="absolute top-2 right-2 bottom-2 w-64 bg-panel rounded-lg p-3 overflow-auto text-[12px] shadow-2xl">
      <div className="flex items-center justify-between mb-3">
        <span className="text-ink truncate">{nodeId}</span>
        <button className="text-muted hover:text-ink" onClick={onClose}>✕</button>
      </div>
      <Row label="Type" value={ntype} />
      {ntype === "agent" && run && <Row label="Model" value={run.model} />}
      {ntype === "agent" && prompt && (
        <Section title="Prompt">
          <pre className="whitespace-pre-wrap text-muted text-[11px] leading-relaxed">{prompt.slice(0, 1200)}</pre>
        </Section>
      )}
      {ntype === "tool" && toolFiles.length > 0 && (
        <Section title={`Tools (${toolFiles.length})`}>
          {toolFiles.map((f) => (
            <div key={f.path} className="mb-3">
              <div className="text-faint text-[10px] mb-1">{f.path}</div>
              <pre className="whitespace-pre-wrap text-muted text-[11px] leading-relaxed">{f.content.slice(0, 800)}</pre>
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
      <span className="text-ink truncate ml-2">{value}</span>
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

function GraphSkeleton() {
  return (
    <div className="graph-canvas flex h-full items-center justify-center">
      <div className="flex items-center gap-10">
        {[0, 1, 2].map((i) => (
          <div key={i} className="flex items-center gap-10">
            <div className="rounded-2xl bg-active animate-pulse" style={{ width: i === 1 ? AGENT_W : CARD_W, height: i === 1 ? AGENT_H : CARD_H }} />
            {i < 2 && <div className="h-px w-8 bg-hair" />}
          </div>
        ))}
      </div>
    </div>
  );
}

export function GraphView() {
  const activeAgentId = useBuildStore((s) => s.activeAgentId);
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

  // provider/model for the model resource + agent subtitle
  const run = activeRunId ? runs[activeRunId] : undefined;
  const agentMeta = useMemo(() => agents.find((a) => a.agent_id === activeAgentId), [agents, activeAgentId]);
  const provider = run?.provider ?? agentMeta?.default_provider;
  const model = run?.model;

  // main-path layout (memoised on the static graph + model label)
  const base = useMemo(() => (graph?.nodes ? layoutFlow(graph, model) : { nodes: [], edges: [] as Edge[], agentBox: undefined }), [graph, model]);

  // resource nodes/edges beneath the agent (derived from the agent's files + provider)
  const resources = useMemo(() => {
    const llm = base.nodes.find((n) => (n.data as FlowData).kind === "agent");
    if (!llm || !base.agentBox) return { nodes: [] as Node[], edges: [] as Edge[], hasModel: false, hasTool: false };
    const tools = findToolFiles(files).slice(0, 6);
    const m = modelResource(provider, model);
    const built = buildResources(llm.id, base.agentBox, tools, m);
    return { ...built, hasModel: true, hasTool: tools.length > 0 };
  }, [base, files, provider, model]);

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

  const nodes = useMemo(() => {
    const flow = base.nodes.map((n) => {
      const d = n.data as FlowData;
      const ports = d.kind === "agent" ? { model: resources.hasModel, tool: resources.hasTool } : undefined;
      return {
        ...n,
        data: { ...d, active: n.id === activeNode, selected: n.id === selectedNode, status: nodeStatus[n.id], ports },
      };
    });
    return [...flow, ...resources.nodes];
  }, [base.nodes, resources, activeNode, selectedNode, nodeStatus]);

  const edges = useMemo(() => {
    const flow = base.edges.map((e) => {
      const hot = hotEdge && e.source === hotEdge.source && e.target === hotEdge.target;
      const connected = pulse ? e.source === pulse.node || e.target === pulse.node : false;
      const particle = connected && traversed.has(`${e.source}->${e.target}`);
      return { ...e, data: { ...(e.data as object), hot, pulse: connected, particle, pulseKey: pulse?.key } };
    });
    return [...flow, ...resources.edges];
  }, [base.edges, resources.edges, hotEdge, pulse, traversed]);

  if (!activeAgentId) return <Empty text="Select an agent to see its graph." />;
  if (loading && !graph) return <GraphSkeleton />;
  if (graph?.error) return <Empty text={`Graph unavailable — ${graph.error}`} />;
  if (!graph?.nodes?.length) return <Empty text="No graph to show." />;

  return (
    <div className="graph-canvas relative h-full w-full">
      <ReactFlow
        nodes={nodes}
        edges={edges}
        nodeTypes={nodeTypes}
        edgeTypes={edgeTypes}
        fitView
        fitViewOptions={{ padding: 0.2 }}
        minZoom={0.35}
        maxZoom={1.75}
        proOptions={{ hideAttribution: true }}
        nodesDraggable={false}
        nodesConnectable={false}
        elementsSelectable
        onNodeClick={(_, n) => {
          if (n.type === "resource") {
            // resource circles describe the agent — open the agent's inspector, no trace step.
            const parent = (n.data as ResourceData).parent;
            setSelected({ id: parent, type: "agent" });
            useUiStore.getState().setSelectedNodeId(parent); // composer context: the agent node
            return;
          }
          const d = n.data as FlowData;
          const ntype = d.kind === "trigger" ? "start" : d.kind === "terminal" ? "end" : d.kind === "tool" ? "tool" : "agent";
          setSelected({ id: n.id, type: ntype });
          useUiStore.getState().setSelectedNodeId(n.id); // composer context: this graph node
          triggerPulse(n.id); // transient connected-edge highlight + directional particle
          const step = latestStepForNode(n.id, bucket);
          selectStep(step ? step.id : null);
        }}
        onPaneClick={() => {
          setSelected(null);
          useUiStore.getState().setSelectedNodeId(null);
        }}
      >
        <Background variant={BackgroundVariant.Dots} gap={28} size={1} color="#242429" />
        <Controls showInteractive={false} className="!bg-panel/80 !backdrop-blur !border-0 !rounded-lg !shadow-lg" />
        <MiniMap
          pannable
          zoomable
          className="!bg-panel/80 !rounded-lg !border-0"
          maskColor="rgba(13,13,15,0.7)"
          nodeColor={(n) => {
            if (n.type === "resource") return "#3f3f46";
            const k = (n.data as FlowData)?.kind;
            return k ? KIND_ACCENT[k] : "#52525b";
          }}
          nodeStrokeWidth={0}
        />
      </ReactFlow>
      {selected && <NodeInspector nodeId={selected.id} ntype={selected.type} onClose={() => setSelected(null)} />}
    </div>
  );
}

function Empty({ text }: { text: string }) {
  return <div className="flex h-full items-center justify-center text-muted text-[12px] px-6 text-center">{text}</div>;
}
