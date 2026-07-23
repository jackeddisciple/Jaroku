// Graph View (Week 5, 🟢): a read-only React Flow reflection of the agent's LangGraph
// structure. Nodes and edges come from the server's static introspection (graphStore); this
// component only lays them out (dagre, top-down) and renders them to the design system. It is
// NOT an editable canvas — the user changes an agent by talking, not by dragging nodes.
//
// Visual language: nodes are semantic (agent = indigo, tool = teal, start/end = neutral pills)
// with soft depth; edges are bezier with a subtle animated flow and readable branch labels;
// during a run each node carries a persistent status dot in the exact trace-timeline colours,
// and the executing node lifts with an amber glow. Execution/selection state is layered on via
// node data, so that wiring stays presentation-only.

import { useEffect, useMemo, useState } from "react";
import {
  ReactFlow,
  Background,
  BackgroundVariant,
  Controls,
  MiniMap,
  Handle,
  Position,
  MarkerType,
  type Edge,
  type Node,
  type NodeProps,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import Dagre from "@dagrejs/dagre";
import { useBuildStore, type GenFile } from "../store/buildStore.ts";
import { useGraphStore } from "../store/graphStore.ts";
import { useTraceStore } from "../store/traceStore.ts";
import { sendLoadAgentGraph } from "../lib/socket.ts";
import {
  activeEdge,
  activeNodeId,
  latestStepForNode,
  stepEdge,
  stepNodeId,
} from "../lib/traceGraphMap.ts";
import type { AgentGraph, GraphNode as GNode, Step } from "../types.ts";

// Regular nodes and terminal pills get different footprints so dagre gives each real room.
const NODE_W = 208;
const NODE_H = 62;
const PILL_W = 132;
const PILL_H = 40;

type NodeStatus = "ok" | "error" | "running";
type FlowData = {
  label: string;
  ntype: string;
  active: boolean;
  selected: boolean;
  status?: NodeStatus;
};

// Semantic styling by role — identify a node's job at a glance without reading the label.
type TypeStyle = { accent: string; ring: string; grad: string; icon: string; name: string };
const AGENT_STYLE: TypeStyle = {
  accent: "#a5b4fc",
  ring: "rgba(129,140,248,0.55)",
  grad: "linear-gradient(158deg, #212233 0%, #17171f 100%)",
  icon: "✦",
  name: "agent",
};
const TOOL_STYLE: TypeStyle = {
  accent: "#5eead4",
  ring: "rgba(45,212,191,0.5)",
  grad: "linear-gradient(158deg, #16241f 0%, #141a18 100%)",
  icon: "⚙",
  name: "tool",
};
function styleFor(ntype: string): TypeStyle {
  return ntype === "tool" ? TOOL_STYLE : AGENT_STYLE;
}

const STATUS_COLOR: Record<NodeStatus, string> = {
  ok: "#22c55e",
  error: "#ef4444",
  running: "#f59e0b",
};

const HANDLE_CLASS =
  "!w-2 !h-2 !bg-[#52525b] !border-0 opacity-0 group-hover:opacity-70 transition-opacity duration-150";

function StatusDot({ status }: { status?: NodeStatus }) {
  if (!status) return null;
  return (
    <span
      className={`absolute -top-1 -right-1 w-2.5 h-2.5 rounded-full ring-2 ring-bg ${status === "running" ? "animate-pulse" : ""}`}
      style={{ background: STATUS_COLOR[status] }}
      title={status}
    />
  );
}

// Terminal (START / END) — a compact neutral pill, deliberately distinct from the work nodes.
function TerminalPill({ data }: { data: FlowData }) {
  const isStart = data.ntype === "start";
  return (
    <div
      className={`group relative flex items-center justify-center gap-1.5 rounded-full select-none
        transition-all duration-150 hover:-translate-y-px
        ${data.selected ? "ring-1 ring-[#52525b]" : ""}`}
      style={{
        width: PILL_W,
        height: PILL_H,
        background: "linear-gradient(160deg, #1c1c20, #161619)",
        border: "1px solid #26262b",
        boxShadow: "0 2px 8px rgba(0,0,0,0.35)",
      }}
    >
      <span className="text-faint text-[12px]">{isStart ? "▶" : "◼"}</span>
      <span className="text-muted text-[11px] tracking-wide uppercase">{isStart ? "start" : "end"}</span>
      <Handle type="target" position={Position.Top} className={HANDLE_CLASS} />
      <Handle type="source" position={Position.Bottom} className={HANDLE_CLASS} />
    </div>
  );
}

function JarokuNode({ data }: NodeProps) {
  const d = data as FlowData;
  if (d.ntype === "start" || d.ntype === "end") return <TerminalPill data={d} />;

  const s = styleFor(d.ntype);
  const borderColor = d.active ? "#f59e0b" : d.selected ? s.accent : "rgba(255,255,255,0.06)";
  const shadow = d.active
    ? "0 6px 18px rgba(0,0,0,0.45), 0 0 0 3px rgba(245,158,11,0.22)"
    : d.selected
      ? `0 6px 18px rgba(0,0,0,0.45), 0 0 0 1px ${s.ring}`
      : "0 4px 14px rgba(0,0,0,0.4)";

  return (
    <div
      className={`group relative flex items-center gap-3 rounded-xl px-3.5 select-none
        transition-all duration-150 hover:-translate-y-0.5 hover:brightness-110
        ${d.active ? "animate-pulse-node" : ""}`}
      style={{ width: NODE_W, height: NODE_H, background: s.grad, border: `1px solid ${borderColor}`, boxShadow: shadow }}
    >
      <StatusDot status={d.status} />

      {/* icon chip — larger, in the type's accent */}
      <span
        className="flex items-center justify-center rounded-lg shrink-0 text-[18px]"
        style={{ width: 34, height: 34, background: "rgba(255,255,255,0.04)", color: s.accent }}
      >
        {s.icon}
      </span>

      {/* typography hierarchy: bold name, muted type beneath */}
      <span className="flex flex-col min-w-0 leading-tight">
        <span className="text-ink font-semibold text-[13px] truncate">{d.label}</span>
        <span className="text-[10px] uppercase tracking-wider" style={{ color: s.accent, opacity: 0.75 }}>
          {s.name}
        </span>
      </span>

      <Handle type="target" position={Position.Top} className={HANDLE_CLASS} />
      <Handle type="source" position={Position.Bottom} className={HANDLE_CLASS} />
    </div>
  );
}

const nodeTypes = { jaroku: JarokuNode };

function dimsFor(ntype: string): { w: number; h: number } {
  return ntype === "start" || ntype === "end" ? { w: PILL_W, h: PILL_H } : { w: NODE_W, h: NODE_H };
}

function displayLabel(raw: string | null | undefined): string | undefined {
  if (!raw) return undefined;
  if (raw === "__end__" || raw === "END") return "END";
  if (raw === "__start__") return "START";
  return raw;
}

/** dagre top-down layout → React Flow node positions. Generous spacing for breathing room. */
function layout(graph: AgentGraph): { nodes: Node[]; edges: Edge[] } {
  const g = new Dagre.graphlib.Graph().setDefaultEdgeLabel(() => ({}));
  g.setGraph({ rankdir: "TB", nodesep: 84, ranksep: 104, marginx: 24, marginy: 24 });

  for (const n of graph.nodes ?? []) {
    const { w, h } = dimsFor(n.type);
    g.setNode(n.id, { width: w, height: h });
  }
  for (const e of graph.edges ?? []) g.setEdge(e.source, e.target);
  Dagre.layout(g);

  const nodes: Node[] = (graph.nodes ?? []).map((n: GNode) => {
    const pos = g.node(n.id);
    const { w, h } = dimsFor(n.type);
    return {
      id: n.id,
      type: "jaroku",
      position: { x: pos.x - w / 2, y: pos.y - h / 2 },
      data: { label: n.id, ntype: n.type, active: false, selected: false } satisfies FlowData,
    };
  });

  const edges: Edge[] = (graph.edges ?? []).map((e, i) => {
    const color = e.conditional ? "#b4741f" : "#3f3f46";
    return {
      id: `${e.source}->${e.target}-${i}`,
      source: e.source,
      target: e.target,
      type: "default", // bezier
      animated: true, // subtle moving dash — data direction
      label: displayLabel(e.label),
      markerEnd: { type: MarkerType.ArrowClosed, color, width: 16, height: 16 },
      style: { stroke: color, strokeWidth: 1.5, opacity: e.conditional ? 0.9 : 0.7 },
      labelShowBg: true,
      labelBgPadding: [5, 2] as [number, number],
      labelBgBorderRadius: 4,
      labelBgStyle: { fill: "#1c1c20", fillOpacity: 0.95 },
      labelStyle: { fill: e.conditional ? "#e0a75e" : "#71717a", fontSize: 10, fontFamily: "inherit" },
    };
  });

  return { nodes, edges };
}

// Generated agents keep the system prompt as `prompts/system.md` (a `prompts/` package whose
// __init__ re-exports it), with a flat `prompts.py` as an older fallback.
function findPrompt(files: Record<string, GenFile>): string | undefined {
  const all = Object.values(files);
  const md = all.find((f) => /prompt/i.test(f.path) && f.path.endsWith(".md"));
  if (md?.content) return md.content;
  return all.find((f) => f.path.endsWith("prompts.py"))?.content;
}

// Tools live as `tools/<name>.py` (excluding the package __init__), with a flat `tools.py`
// as an older fallback.
function findToolFiles(files: Record<string, GenFile>): GenFile[] {
  const all = Object.values(files);
  const perTool = all.filter(
    (f) => /(^|\/)tools\//.test(f.path) && f.path.endsWith(".py") && !f.path.endsWith("__init__.py"),
  );
  if (perTool.length) return perTool;
  const flat = all.find((f) => f.path.endsWith("tools.py"));
  return flat ? [flat] : [];
}

// Read-only node inspector (Graph View row: prompt / model / tool schema).
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

/** Per-node run status in the trace-timeline colour system, persistent for the active run. */
function computeNodeStatus(
  bucket: Record<string, Step> | undefined,
  activeNode: string | undefined,
): Record<string, NodeStatus> {
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

// Skeleton placeholder — pulsing grey shapes while the topology is introspected (no spinners).
function GraphSkeleton() {
  return (
    <div className="flex h-full items-center justify-center">
      <div className="flex flex-col items-center gap-6">
        {[0, 1, 2].map((i) => (
          <div key={i} className="flex flex-col items-center gap-6">
            <div className="rounded-xl bg-active animate-pulse" style={{ width: i === 0 ? 120 : 200, height: i === 0 ? 40 : 60 }} />
            {i < 2 && <div className="w-px h-6 bg-hair" />}
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
  const [selected, setSelected] = useState<{ id: string; type: string } | null>(null);

  // Live trace state overlaid onto the static graph (execution glow + selection sync + status).
  const activeRunId = useTraceStore((s) => s.activeRunId);
  const bucket = useTraceStore((s) => (activeRunId ? s.stepsByRun[activeRunId] : undefined));
  const running = useTraceStore((s) => (activeRunId ? s.runs[activeRunId]?.status === "running" : false));
  const selectedStepId = useTraceStore((s) => s.selectedStepId);
  const selectStep = useTraceStore((s) => s.selectStep);

  // Fetch the topology the first time an agent's Graph tab is shown (or after it's cleared).
  useEffect(() => {
    if (activeAgentId && !graph && !loading) sendLoadAgentGraph(activeAgentId);
  }, [activeAgentId, graph, loading]);

  const base = useMemo(() => (graph?.nodes ? layout(graph) : { nodes: [], edges: [] }), [graph]);

  // The glowing node (only while running), the node of the selected step, and per-node status.
  const activeNode = useMemo(() => (running ? activeNodeId(bucket) : undefined), [running, bucket]);
  const selectedNode = useMemo(() => {
    const step = selectedStepId && bucket ? bucket[selectedStepId] : undefined;
    return step ? stepNodeId(step, bucket!) : undefined;
  }, [selectedStepId, bucket]);
  const nodeStatus = useMemo(() => computeNodeStatus(bucket, activeNode), [bucket, activeNode]);

  // Edge highlight: a selected step lights an edge only when that step IS a router (its own
  // branch), never a stale global one. With no selection, a running run glows its latest router.
  const hotEdge = useMemo(() => {
    if (selectedStepId && bucket) {
      const step = bucket[selectedStepId];
      return step ? stepEdge(step, bucket) : undefined;
    }
    return running ? activeEdge(bucket) : undefined;
  }, [running, selectedStepId, bucket]);

  const nodes = useMemo(
    () =>
      base.nodes.map((n) => ({
        ...n,
        data: {
          ...(n.data as FlowData),
          active: n.id === activeNode,
          selected: n.id === selectedNode,
          status: nodeStatus[n.id],
        },
      })),
    [base, activeNode, selectedNode, nodeStatus],
  );
  const edges = useMemo(
    () =>
      base.edges.map((e) =>
        hotEdge && e.source === hotEdge.source && e.target === hotEdge.target
          ? {
              ...e,
              style: { ...e.style, stroke: "#f59e0b", strokeWidth: 2, opacity: 1 },
              markerEnd: { type: MarkerType.ArrowClosed, color: "#f59e0b", width: 18, height: 18 },
            }
          : e,
      ),
    [base, hotEdge],
  );

  if (!activeAgentId) {
    return <Empty text="Select an agent to see its graph." />;
  }
  if (loading && !graph) {
    return <GraphSkeleton />;
  }
  if (graph?.error) {
    return <Empty text={`Graph unavailable — ${graph.error}`} />;
  }
  if (!graph?.nodes?.length) {
    return <Empty text="No graph to show." />;
  }

  return (
    <div className="relative h-full w-full">
      <ReactFlow
        nodes={nodes}
        edges={edges}
        nodeTypes={nodeTypes}
        fitView
        fitViewOptions={{ padding: 0.24 }}
        minZoom={0.4}
        maxZoom={1.75}
        proOptions={{ hideAttribution: true }}
        nodesDraggable={false}
        nodesConnectable={false}
        elementsSelectable
        onNodeClick={(_, n) => {
          setSelected({ id: n.id, type: (n.data as FlowData).ntype });
          // Clicking a node selects its latest corresponding trace step (graph → trace sync).
          const step = latestStepForNode(n.id, bucket);
          selectStep(step ? step.id : null);
        }}
        onPaneClick={() => setSelected(null)}
      >
        {/* Figma-faint dot grid */}
        <Background variant={BackgroundVariant.Dots} gap={26} size={1} color="#1b1b20" />
        <Controls showInteractive={false} className="!bg-panel/80 !backdrop-blur !border-0 !rounded-lg !shadow-lg" />
        <MiniMap
          pannable
          zoomable
          className="!bg-panel/80 !rounded-lg !border-0"
          maskColor="rgba(13,13,15,0.7)"
          nodeColor={(n) => {
            const t = (n.data as FlowData)?.ntype;
            if (t === "start" || t === "end") return "#3f3f46";
            return styleFor(t).accent;
          }}
          nodeStrokeWidth={0}
        />
      </ReactFlow>
      {selected && (
        <NodeInspector nodeId={selected.id} ntype={selected.type} onClose={() => setSelected(null)} />
      )}
    </div>
  );
}

function Empty({ text }: { text: string }) {
  return <div className="flex h-full items-center justify-center text-muted text-[12px] px-6 text-center">{text}</div>;
}
