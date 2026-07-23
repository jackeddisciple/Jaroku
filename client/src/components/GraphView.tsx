// Graph View (Week 5, 🟢): a read-only React Flow reflection of the agent's LangGraph
// structure. Nodes and edges come from the server's static introspection (graphStore); this
// component only lays them out (dagre, top-down) and renders them to the design system. It is
// NOT an editable canvas — the user changes an agent by talking, not by dragging nodes.
//
// Execution glow + trace↔graph selection are layered on in Commit 2 via node data (`active`,
// `selected`); the node component already honors those flags so that wiring is presentation-only.

import { useEffect, useMemo, useState } from "react";
import {
  ReactFlow,
  Background,
  Controls,
  Handle,
  Position,
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
import type { AgentGraph, GraphNode as GNode } from "../types.ts";

const NODE_W = 168;
const NODE_H = 44;

type FlowData = {
  label: string;
  ntype: string;
  active: boolean;
  selected: boolean;
};

// A node's glyph. Functional/structure glyphs are monochrome; brand color is reserved for
// meaning (Commit 2's active glow), never decoration here.
function glyphFor(ntype: string): string {
  switch (ntype) {
    case "start": return "▶";
    case "end": return "■";
    case "tool": return "⚙";
    default: return "◆"; // agent / state node
  }
}

function JarokuNode({ data }: NodeProps) {
  const d = data as FlowData;
  const terminal = d.ntype === "start" || d.ntype === "end";
  return (
    <div
      className={[
        "flex items-center gap-2 rounded px-3 h-11 text-[12px] select-none transition-colors",
        terminal ? "bg-panel text-muted" : "bg-active text-ink",
        d.active ? "ring-1 ring-run shadow-[0_0_0_3px_rgba(245,158,11,0.25)] animate-pulse-node" : "",
        d.selected && !d.active ? "ring-1 ring-[#3f3f46]" : "",
      ].join(" ")}
      style={{ width: NODE_W }}
    >
      {/* thin left accent when selected — the design system's 2px accent, not a fill */}
      <span
        className={`absolute left-0 top-1 bottom-1 w-0.5 rounded ${
          d.active ? "bg-run" : d.selected ? "bg-[#52525b]" : "bg-transparent"
        }`}
      />
      <span className={`text-[13px] ${d.active ? "text-run" : terminal ? "text-faint" : "text-muted"}`}>
        {glyphFor(d.ntype)}
      </span>
      <span className="truncate">{d.label}</span>
      <Handle type="target" position={Position.Top} className="!bg-[#3f3f46] !border-0 !w-1.5 !h-1.5" />
      <Handle type="source" position={Position.Bottom} className="!bg-[#3f3f46] !border-0 !w-1.5 !h-1.5" />
    </div>
  );
}

const nodeTypes = { jaroku: JarokuNode };

/** dagre top-down layout → React Flow node positions. Pure; recomputed when topology changes. */
function layout(graph: AgentGraph): { nodes: Node[]; edges: Edge[] } {
  const g = new Dagre.graphlib.Graph().setDefaultEdgeLabel(() => ({}));
  g.setGraph({ rankdir: "TB", nodesep: 40, ranksep: 56 });

  for (const n of graph.nodes ?? []) g.setNode(n.id, { width: NODE_W, height: NODE_H });
  for (const e of graph.edges ?? []) g.setEdge(e.source, e.target);
  Dagre.layout(g);

  const nodes: Node[] = (graph.nodes ?? []).map((n: GNode) => {
    const pos = g.node(n.id);
    return {
      id: n.id,
      type: "jaroku",
      position: { x: pos.x - NODE_W / 2, y: pos.y - NODE_H / 2 },
      data: { label: n.id, ntype: n.type, active: false, selected: false } satisfies FlowData,
    };
  });

  const edges: Edge[] = (graph.edges ?? []).map((e, i) => ({
    id: `${e.source}->${e.target}-${i}`,
    source: e.source,
    target: e.target,
    animated: false,
    label: e.label ?? undefined,
    style: {
      stroke: e.conditional ? "#52525b" : "#3f3f46",
      strokeDasharray: e.conditional ? "4 3" : undefined,
    },
    labelStyle: { fill: "#71717a", fontSize: 10, fontFamily: "inherit" },
  }));

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
    <div className="absolute top-2 right-2 bottom-2 w-64 bg-panel rounded p-3 overflow-auto text-[12px] shadow-lg">
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

export function GraphView() {
  const activeAgentId = useBuildStore((s) => s.activeAgentId);
  const graph = useGraphStore((s) => (activeAgentId ? s.graphs[activeAgentId] : undefined));
  const loading = useGraphStore((s) => (activeAgentId ? s.loading[activeAgentId] : undefined));
  const [selected, setSelected] = useState<{ id: string; type: string } | null>(null);

  // Live trace state overlaid onto the static graph (execution glow + selection sync).
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

  // The glowing node (only while running) and the node of the currently-selected step.
  const activeNode = useMemo(() => (running ? activeNodeId(bucket) : undefined), [running, bucket]);
  const selectedNode = useMemo(() => {
    const step = selectedStepId && bucket ? bucket[selectedStepId] : undefined;
    return step ? stepNodeId(step, bucket!) : undefined;
  }, [selectedStepId, bucket]);
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
        data: { ...(n.data as FlowData), active: n.id === activeNode, selected: n.id === selectedNode },
      })),
    [base, activeNode, selectedNode],
  );
  const edges = useMemo(
    () =>
      base.edges.map((e) =>
        hotEdge && e.source === hotEdge.source && e.target === hotEdge.target
          ? { ...e, animated: true, style: { ...e.style, stroke: "#f59e0b", strokeDasharray: undefined } }
          : e,
      ),
    [base, hotEdge],
  );

  if (!activeAgentId) {
    return <Empty text="Select an agent to see its graph." />;
  }
  if (loading && !graph) {
    return <Empty text="Building graph…" />;
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
        <Background color="#26262b" gap={20} />
        <Controls showInteractive={false} className="!bg-panel !border-0" />
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
