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

import { createContext, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import {
  ReactFlow,
  Background,
  BackgroundVariant,
  ControlButton,
  Controls,
  MiniMap,
  Handle,
  MarkerType,
  NodeToolbar,
  Position,
  BaseEdge,
  EdgeLabelRenderer,
  getBezierPath,
  type AriaLabelConfig,
  type Edge,
  type EdgeProps,
  type Node,
  type NodeChange,
  type NodeProps,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import { useBuildStore, type GenFile } from "../store/buildStore.ts";
import { agentMcpToolNames } from "../store/mcpStore.ts";
import { graphKey, useGraphStore } from "../store/graphStore.ts";
import { DRAFT, graphErrorCopy, isDraftGraphError, isMappedGraphError, type GraphErrorCopy } from "../lib/graphError.ts";
import { useTraceStore } from "../store/traceStore.ts";
import { useSessionStore } from "../store/sessionStore.ts";
import { graphPositionsKey, readPositions, topologySig, writePositions, type Positions } from "../lib/graphPositions.ts";
import { sendBranchRun, sendLoadAgentGraph } from "../lib/socket.ts";
import { alpha } from "../lib/palette.ts";
import { ACCENT, ICON, INTERACTION, NODE_HUE, RADIUS, STATUS, SURFACE, TEXT } from "../lib/tokens.ts";
import {
  AGENT_H,
  END_D,
  LABEL_GAP,
  MAX_SUBS,
  MIN_ZOOM,
  ROLE_LABEL,
  SUB_D,
  TILE,
  buildFlow,
  findNodes,
  frameFor,
  isReactAgent,
  loopPath,
  matchesEdge,
  nodeAriaLabel,
  portPath,
  readingOrder,
  routePath,
  titleOf,
  type FlowLayout,
  type FlowNodeSpec,
  type Point,
} from "../lib/graphLayout.ts";
import { EmptyState } from "./EmptyState.tsx";
import { Truncate } from "./Truncate.tsx";
import { GitBranchIcon } from "./panelIcons.tsx";
import { activeEdge, activeNodeId, latestStepForNode, stepEdge, stepNodeId, traversedEdges } from "../lib/traceGraphMap.ts";
import type { Step } from "../types.ts";
import { TriggerIcon, modelResource, toolResource } from "./graphIcons.tsx";
import { ProviderMark } from "../lib/icons.tsx";
import { useUiStore } from "../store/uiStore.ts";
import { FindControl, GraphToolbar, RunControls, ToolButton, ToolDivider, VersionControl } from "./GraphToolbar.tsx";
import { compareGraphs, segmentMark, type DiffMark } from "../lib/graphCompare.ts";
import { marksFor, type NodeMark } from "./graphNodeIcons.ts";
import { Icon } from "../lib/icons/registry.ts";
import { fmtCost, fmtLatency } from "../lib/format.ts";
import { nodeTimings, replayFrames, stepsUpTo, type NodeTiming } from "../lib/graphReplay.ts";
import { GraphRunStrip } from "./GraphRunStrip.tsx";

// How much of this canvas the Step Details overlay covers when it is open. It is drawn over
// the graph rather than beside it, so this is the one number that tells the framing the right
// edge is not really the right edge. Kept in step with StepDetailPanel's `w-[340px]`.
const STEP_PANEL_W = 340;
// The node inspector, which is an overlay for the same reason. Kept in step with its `w-64`.
const INSPECTOR_W = 256;
// How much of the canvas's top the toolbar takes: its height and the gap above it.
const TOOLBAR_H = 44;

// Mark sizes on the canvas, named here rather than written out at each call site. A step's mark IS
// its tile's face, the way n8n draws a node, so it is large; the rest are proportions of the box
// each sits in.
const NODE_ICON = {
  /** On a step's 64px tile. */
  tile: 30,
  /** On End's 44px circle. */
  end: 20,
  /** In the ReAct agent card's icon well. */
  agent: 24,
  /** A model or tool logo on one of the agent's circles. */
  resource: 24,
  /** The provider badge on a model-calling tile's corner. */
  badge: 12,
  /** Start's bolt, beside its tile as n8n's sits beside a trigger. */
  bolt: 16,
} as const;


// ── palette (flat) ────────────────────────────────────────────────────────────
// White tiles on the dotted canvas, each carrying one coloured mark; a selected tile takes the app's
// accent as its border. Every value is a token, which is what keeps the canvas on the same palette
// as the panels behind it.
const CARD_BG = SURFACE.panel; // tiles — solid on the canvas behind them
const CARD_BG_ACTIVE = SURFACE.active; // the agent card's selected fill
const ICON_BG = SURFACE.chrome; // the agent card's icon well, a branch label's chip
const BORDER = SURFACE.edge; // a tile's resting outline
const DIAMOND = TEXT.faint; // a port's mark, as n8n draws one
const EDGE = SURFACE.grip;
const EDGE_DASH = TEXT.disabled; // the dashed line to one of the agent's circles
const SEL = INTERACTION.accent; // selection — the app's accent, not the canvas's own
const AMBER = STATUS.pending; // running
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
  /** What this node is drawn as — see graphNodeIcons. Absent on the agent's circles. */
  mark?: NodeMark;
  /** On a model-calling tile: the provider the agent runs on, as a corner badge. */
  badge?: Brand;
  /** On one of the agent's circles: the model's or tool's own logo and name. */
  brand?: Brand;
  /** On the agent card: its ports, in order, for their labels down its right edge. */
  ports?: Array<"Model" | "Tools">;
  /** True when this tool node calls a third-party MCP server. Drives the rose marker. */
  mcp?: boolean;
  /** Whether an edge leaves this node downwards — n8n's output dot is drawn only then. */
  out?: boolean;
  /** Hovered (and nothing is being dragged): its toolbar shows. */
  hover?: boolean;
  /** How long it took and what it cost in the run on screen. */
  timing?: NodeTiming;
  /** In a comparison: new since the older version, or gone since it. */
  diff?: DiffMark;
  active: boolean;
  selected: boolean;
  status?: NodeStatus;
};
type EdgeData = {
  hot?: boolean;
  /** The travelled edge of a run in progress: dashes move along it. */
  flowing?: boolean;
  /** Touching the hovered node, or not touching it while one is hovered. */
  lit?: boolean;
  dim?: boolean;
  /** Somebody has moved a node, so dagre's routing no longer describes where things are. */
  free?: boolean;
  /** In a comparison: new since the older version, or gone since it. */
  diff?: DiffMark;
  branch?: string;
  back?: boolean;
  via?: Point[];
  lane?: number;
  pulse?: boolean;
  particle?: boolean;
  pulseKey?: number;
};

// ACCENT.mcp itself — one badge colour across the plan card, the trace and here, from one place.
const ACCENT_MCP = ACCENT.mcp;
const SURFACE_BG = SURFACE.bg;

// WHAT A SCREEN READER IS TOLD ABOUT THE CANVAS. React Flow's defaults describe an editor: "Press
// delete to remove it". Nothing here can be removed or connected — a node can only be moved, which
// changes the drawing and not the agent — and saying more would be the lie a "+" would tell.
const READ_ONLY_ARIA: Partial<AriaLabelConfig> = {
  "node.a11yDescription.default": "Press enter to inspect this step. Arrow keys move it on the canvas.",
  "node.a11yDescription.keyboardDisabled": "Press enter to inspect this step.",
  "edge.a11yDescription.default": "",
};

/** Whether this viewer has asked for less motion — read once; it stops the run animation. */
const REDUCED_MOTION = typeof window !== "undefined" && window.matchMedia?.("(prefers-reduced-motion: reduce)").matches === true;

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
 * Where edges meet a tiled node: in at the top of the tile, out under its label — the dot n8n draws
 * — and a pair on each side of the tile, half way down it, for a loop.
 */
function Handles({ tileMid, tileHalf }: { tileMid: number; tileHalf: number }) {
  return (
    <>
      <Handle id="in" type="target" position={Position.Top} className={HANDLE_HIDDEN} />
      <Handle id="out" type="source" position={Position.Bottom} className={HANDLE_HIDDEN} />
      <Handle id="loop-in" type="target" position={Position.Right} className={HANDLE_HIDDEN} style={{ top: tileMid, right: `calc(50% - ${tileHalf}px)` }} />
      <Handle id="loop-out" type="source" position={Position.Right} className={HANDLE_HIDDEN} style={{ top: tileMid, right: `calc(50% - ${tileHalf}px)` }} />
      <Handle id="loop-in-l" type="target" position={Position.Left} className={HANDLE_HIDDEN} style={{ top: tileMid, left: `calc(50% - ${tileHalf}px)` }} />
      <Handle id="loop-out-l" type="source" position={Position.Left} className={HANDLE_HIDDEN} style={{ top: tileMid, left: `calc(50% - ${tileHalf}px)` }} />
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

/**
 * A tile's border: the accent when selected, amber while it runs, otherwise the resting edge — and
 * in a comparison, green for a step that is new and a faint dash for one that is gone.
 */
function tileBorder(d: FlowData): string {
  if (d.active) return AMBER;
  if (d.selected) return SEL;
  if (d.diff === "added") return NODE_HUE.green;
  if (d.diff === "removed") return TEXT.faint;
  return BORDER;
}
/** ...and the soft ring n8n puts round a selected node. */
function tileRing(d: FlowData): string | undefined {
  if (d.active) return `0 0 0 4px ${alpha(AMBER, 0.18)}`;
  if (d.selected) return `0 0 0 4px ${alpha(SEL, 0.12)}`;
  if (d.diff === "added") return `0 0 0 4px ${alpha(NODE_HUE.green, 0.16)}`;
  return undefined;
}
/** A step that is gone since the older version: drawn where it was, faded and dashed. */
function goneStyle(d: FlowData): React.CSSProperties | undefined {
  return d.diff === "removed" ? { opacity: 0.45, borderStyle: "dashed" } : undefined;
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

/** A node's mark, in its hue — or, for a brand, in the brand's own colours. */
function Mark({ mark, size }: { mark?: NodeMark; size: number }) {
  if (!mark) return null;
  const M = mark.Icon;
  return mark.kind === "brand" ? (
    <M size={size} />
  ) : (
    <span className="flex" style={{ color: mark.hue }}>
      <M size={size} />
    </span>
  );
}

/**
 * The name under a tile and one line under that: what the step does, in its docstring's words, or
 * — without one — what kind of step it is. n8n's "Slack / Send message", with the code's own name.
 */
function Label({ d, sub }: { d: FlowData; sub?: string | null }) {
  const { spec } = d;
  const line = d.mcp ? "Tool node · reaches MCP" : sub ?? spec.doc ?? ROLE_LABEL[spec.role];
  return (
    <div className="flex w-full flex-col items-center leading-tight" style={{ marginTop: LABEL_GAP }}>
      <Truncate className="max-w-full text-caption font-medium text-ink" title={spec.title}>{spec.title}</Truncate>
      <Truncate
        className={`max-w-full text-tiny ${d.mcp ? "" : "text-muted"}`}
        title={spec.doc ? `${ROLE_LABEL[spec.role]} — ${spec.doc}` : line}
      >
        <span style={d.mcp ? { color: ACCENT_MCP } : undefined}>{line}</span>
      </Truncate>
    </div>
  );
}

/** A node's time and cost in the run on screen, beside its tile: a clock and a coin, and the numbers. */
function Timing({ t, style }: { t?: NodeTiming; style: React.CSSProperties }) {
  if (!t || t.runs === 0) return null;
  return (
    <span className="pointer-events-none absolute flex flex-col gap-0.5 whitespace-nowrap text-tiny tabular-nums text-muted" style={style}>
      <span className="flex items-center gap-1" title={t.runs > 1 ? `${t.runs} runs` : undefined}>
        <Icon.graphControl.time size={ICON.xs} />
        {fmtLatency(t.ms)}
      </span>
      {t.cost !== null && (
        <span className="flex items-center gap-1">
          <Icon.graphControl.cost size={ICON.xs} />
          {fmtCost(t.cost)}
        </span>
      )}
    </span>
  );
}

/** n8n's output dot, under the label, where the edge leaves. */
function OutDot() {
  return (
    <span
      className="pointer-events-none absolute left-1/2 rounded-full"
      style={{ bottom: -4, width: 8, height: 8, transform: "translateX(-50%)", background: EDGE }}
    />
  );
}

// ── the toolbar over a hovered node ───────────────────────────────────────────
// What a node's own controls do, given by GraphView — the nodes are drawn by React Flow, which only
// hands them their data.
type NodeActions = {
  inspect: (id: string) => void;
  code: (id: string) => void;
  /** Branch a run from this node's checkpoint, when the run on screen passed through it. */
  branch: (id: string) => void;
  canBranch: (id: string) => boolean;
  /** Keep the toolbar up while the pointer is on it, and let it go when it leaves. */
  hold: (id: string | null) => void;
};
const NodeActionsContext = createContext<NodeActions | null>(null);

/**
 * n8n's node toolbar, over the tile while it is hovered: Inspect, Open code, and — when the run on
 * screen went through this step — Branch from here. Marks only, as the canvas toolbar is.
 */
function HoverBar({ d }: { d: FlowData }) {
  const actions = useContext(NodeActionsContext);
  if (!actions || d.diff === "removed") return null;
  const { id } = d.spec;
  return (
    <NodeToolbar isVisible={!!d.hover} position={Position.Top} offset={6}>
      <div
        className="flex items-center gap-0.5 rounded-card border border-edge bg-elevated px-0.5 py-0.5 shadow-floating"
        onMouseEnter={() => actions.hold(id)}
        onMouseLeave={() => actions.hold(null)}
      >
        <ToolButton label="Inspect" onClick={() => actions.inspect(id)}>
          <Icon.graphControl.inspect size={ICON.sm} />
        </ToolButton>
        <ToolButton label="Open code" onClick={() => actions.code(id)}>
          <Icon.graphControl.openCode size={ICON.sm} />
        </ToolButton>
        {actions.canBranch(id) && (
          <ToolButton label="Branch a run from here" onClick={() => actions.branch(id)}>
            <Icon.graphControl.branch size={ICON.sm} />
          </ToolButton>
        )}
      </div>
    </NodeToolbar>
  );
}

// ── a tile: Start, a step, a fork ─────────────────────────────────────────────
function TileNode({ data }: NodeProps) {
  const d = data as FlowData;
  const { spec } = d;
  const start = spec.role === "start";
  // n8n's trigger is a D: its leading side rounded right round. Turned for a flow that runs down,
  // the rounded side is the top.
  const radius = start ? `${TILE / 2}px ${TILE / 2}px ${RADIUS.lg}px ${RADIUS.lg}px` : `${RADIUS.lg}px`;
  return (
    <div className="relative flex select-none flex-col items-center" style={{ width: spec.w, height: spec.h }}>
      <div className="relative" style={{ width: TILE, height: TILE }}>
        {d.active && (
          // A RUNNING STEP BREATHES, in the colour of running — n8n's spinning border, quieter.
          <span
            className="pointer-events-none absolute -inset-1.5 animate-stream-pulse motion-reduce:animate-none"
            style={{ borderRadius: radius, border: `2px solid ${alpha(AMBER, 0.5)}` }}
          />
        )}
        <div
          className="flex h-full w-full items-center justify-center"
          style={{
            background: CARD_BG,
            border: `1.5px solid ${tileBorder(d)}`,
            borderRadius: radius,
            boxShadow: tileRing(d),
            transition: "border-color 120ms ease, box-shadow 120ms ease",
            ...goneStyle(d),
          }}
        >
          <Mark mark={d.mark} size={NODE_ICON.tile} />
        </div>
        {start && (
          // The bolt n8n puts beside a trigger: the existing trigger mark, in its own colour.
          <span className="pointer-events-none absolute flex" style={{ left: -22, top: TILE / 2 - NODE_ICON.bolt / 2, color: STATUS.pending }}>
            <TriggerIcon size={NODE_ICON.bolt} />
          </span>
        )}
        {d.badge && (
          // The model this step calls, as a badge — the tile's own mark says what the step does.
          <span
            className="absolute flex items-center justify-center rounded-full"
            // Bottom right: the top right is where a run's status dot goes, and it would cover this.
            style={{ right: -7, bottom: -7, width: 20, height: 20, background: CARD_BG, border: `1px solid ${BORDER}` }}
            title={`Calls ${d.badge.label}`}
          >
            <d.badge.Icon size={NODE_ICON.badge} />
          </span>
        )}
        {d.mcp && (
          // The MCP marker, corner-mounted like StatusDot, so it survives the label going unreadable.
          <span
            className="absolute -top-1.5 -left-1.5 flex h-4 w-4 items-center justify-center rounded-full"
            style={{ background: SURFACE_BG, color: ACCENT_MCP }}
            title="This tool calls a third-party MCP server Jaroku has not reviewed"
          >
            <McpPlugGlyph />
          </span>
        )}
        <StatusDot status={d.status} />
        <Timing t={d.timing} style={{ left: TILE + 8, top: 8 }} />
      </div>
      <Label d={d} sub={start ? (spec.doc ?? "When the agent is asked") : undefined} />
      {d.out && <OutDot />}
      {!start && <HoverBar d={d} />}
      <Handles tileMid={TILE / 2} tileHalf={TILE / 2} />
    </div>
  );
}

// ── End ───────────────────────────────────────────────────────────────────────
function EndNode({ data }: NodeProps) {
  const d = data as FlowData;
  const { spec } = d;
  return (
    <div className="relative flex select-none flex-col items-center" style={{ width: spec.w, height: spec.h }}>
      <div
        className="relative flex items-center justify-center rounded-full"
        style={{ width: END_D, height: END_D, background: CARD_BG, border: `1.5px solid ${tileBorder(d)}`, boxShadow: tileRing(d) }}
      >
        <Mark mark={d.mark} size={NODE_ICON.end} />
        <StatusDot status={d.status} />
      </div>
      <div className="text-caption font-medium leading-tight text-ink" style={{ marginTop: LABEL_GAP }}>{spec.title}</div>
      <Handles tileMid={END_D / 2} tileHalf={END_D / 2} />
    </div>
  );
}

// ── the ReAct agent: n8n's wide card ──────────────────────────────────────────
function AgentNode({ data }: NodeProps) {
  const d = data as FlowData;
  const { spec } = d;
  const ports = d.ports ?? [];
  return (
    <div className="relative select-none" style={{ width: spec.w, height: spec.h }}>
      <div
        className="flex h-full items-center gap-3 px-4"
        style={{
          background: d.selected || d.active ? CARD_BG_ACTIVE : CARD_BG,
          border: `1.5px solid ${tileBorder(d)}`,
          borderRadius: RADIUS.lg,
          boxShadow: tileRing(d),
        }}
      >
        <span className="flex shrink-0 items-center justify-center rounded-control" style={{ width: 40, height: 40, background: ICON_BG }}>
          <Mark mark={d.mark} size={NODE_ICON.agent} />
        </span>
        <span className="flex min-w-0 flex-col gap-0.5 leading-tight">
          <Truncate className="text-label text-ink" title={spec.title}>{spec.title}</Truncate>
          <Truncate className="text-tiny text-muted" title={spec.doc ?? ROLE_LABEL[spec.role]}>{spec.doc ?? ROLE_LABEL[spec.role]}</Truncate>
        </span>
      </div>
      <StatusDot status={d.status} />
      <HoverBar d={d} />
      <Timing t={d.timing} style={{ left: 0, top: spec.h + 6 }} />
      {/* THE PORTS, down the card's right edge, each with the diamond n8n gives one. Their names
          ride on the dashed lines, by the circles — three names stacked at the card's edge would sit
          on top of each other's lines. */}
      {ports.map((_, i) => {
        const y = (spec.h * (i + 1)) / (ports.length + 1);
        return (
          <span key={i}>
            <Diamond style={{ left: spec.w, top: y }} />
            <Handle id={`port-${i}`} type="source" position={Position.Right} className={HANDLE_HIDDEN} style={{ top: y }} />
          </span>
        );
      })}
      <Handles tileMid={AGENT_H / 2} tileHalf={spec.w / 2} />
    </div>
  );
}

// ── one of the agent's circles ────────────────────────────────────────────────
function ResourceNode({ data }: NodeProps) {
  const d = data as FlowData;
  const { spec } = d;
  const B = d.brand?.Icon;
  return (
    <div className="relative flex select-none flex-col items-center" style={{ width: spec.w, height: spec.h }}>
      <div
        className="flex items-center justify-center rounded-full"
        style={{ width: SUB_D, height: SUB_D, background: CARD_BG, border: `1.5px solid ${BORDER}` }}
      >
        {B ? <B size={NODE_ICON.resource} /> : <span className="text-tiny font-medium text-muted">{spec.title}</span>}
      </div>
      <Truncate className="mt-1.5 max-w-full text-tiny leading-tight text-ink" title={spec.title}>{spec.title}</Truncate>
      <Handle id="in" type="target" position={Position.Left} className={HANDLE_HIDDEN} style={{ top: SUB_D / 2, left: (spec.w - SUB_D) / 2 }} />
    </div>
  );
}

const nodeTypes = { tile: TileNode, end: EndNode, agent: AgentNode, resource: ResourceNode };

// ── edges ─────────────────────────────────────────────────────────────────────
function FlowEdge({ sourceX, sourceY, targetX, targetY, sourcePosition, targetPosition, data, markerEnd }: EdgeProps) {
  const d = (data ?? {}) as EdgeData;
  const s = { x: sourceX, y: sourceY };
  const t = { x: targetX, y: targetY };
  let path: string;
  let label: Point;
  if (d.free) {
    // MOVED: dagre's route described where things were. A loop goes round the side it leaves from;
    // anything else is a plain curve from where it leaves to where it arrives.
    if (d.back) {
      const lane = sourcePosition === Position.Left ? Math.min(s.x, t.x) - 36 : Math.max(s.x, t.x) + 36;
      ({ d: path, label } = loopPath(s, t, lane));
    } else {
      const [p, lx, ly] = getBezierPath({ sourceX, sourceY, sourcePosition, targetX, targetY, targetPosition });
      path = p;
      label = { x: lx, y: ly };
    }
  } else {
    // Down the column through the points dagre routed it by, or — a loop — up its own lane.
    ({ d: path, label } = d.lane !== undefined ? loopPath(s, t, d.lane) : routePath(s, t, d.via));
  }
  // Transient click highlight takes visual precedence over the persistent selection edge.
  const stroke = d.pulse ? PULSE : d.hot ? AMBER : d.lit ? SEL : d.diff === "added" ? NODE_HUE.green : EDGE;
  const width = d.pulse || d.hot ? 2.4 : d.lit ? 2 : 1.75;
  return (
    <>
      <BaseEdge
        path={path}
        markerEnd={markerEnd}
        style={{
          stroke,
          strokeWidth: width,
          opacity: d.dim ? 0.25 : d.diff === "removed" ? 0.5 : 1,
          strokeDasharray: d.diff === "removed" ? "5 4" : undefined,
          filter: d.pulse ? `drop-shadow(0 0 3px ${PULSE_GLOW})` : undefined,
          transition: REDUCED_MOTION ? undefined : "stroke 120ms ease, opacity 120ms ease",
        }}
      />
      {d.flowing && (
        // THE RUN, MOVING: dashes travelling down the edge a running agent is on.
        <path d={path} fill="none" stroke={alpha(AMBER, 0.9)} strokeWidth={2.4} strokeDasharray="6 8" strokeLinecap="round">
          <animate attributeName="stroke-dashoffset" from="28" to="0" dur="0.9s" repeatCount="indefinite" />
        </path>
      )}
      {/* a single particle travelling source→target — the real data-flow direction (only when the
          node has executed and this edge was actually traversed). Keyed so re-clicks restart it. */}
      {d.particle && (
        <circle r="3.6" fill={PULSE} style={{ filter: `drop-shadow(0 0 4px ${PULSE_GLOW_STRONG})` }}>
          <animateMotion key={d.pulseKey} dur="0.42s" repeatCount="1" fill="freeze" path={path} />
        </circle>
      )}
      {d.branch && (
        // A branch's own name, as n8n writes "true" and "false" beside an If node's outputs.
        <EdgeLabelRenderer>
          <div
            className="nodrag nopan absolute rounded-pill px-1.5 text-tiny"
            style={{
              transform: `translate(-50%,-50%) translate(${label.x}px, ${label.y}px)`,
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

/** The dashed line from one of the agent's ports to its circle — n8n's sub-node connection — named by the circle. */
function PortEdge({ sourceX, sourceY, targetX, targetY, data }: EdgeProps) {
  const { d: path } = portPath({ x: sourceX, y: sourceY }, { x: targetX, y: targetY });
  const { port, dim } = (data ?? {}) as { port?: string; dim?: boolean };
  return (
    <>
      <BaseEdge path={path} style={{ stroke: EDGE_DASH, strokeWidth: 1.4, strokeDasharray: "5 4", opacity: dim ? 0.25 : 1 }} />
      {port && (
        <EdgeLabelRenderer>
          <div
            className="nodrag nopan absolute text-tiny text-faint"
            style={{ transform: `translate(-100%, -100%) translate(${targetX - 6}px, ${targetY - 3}px)`, pointerEvents: "none" }}
          >
            {port}
          </div>
        </EdgeLabelRenderer>
      )}
    </>
  );
}

const edgeTypes = { flow: FlowEdge, port: PortEdge };

// ── helpers ───────────────────────────────────────────────────────────────────
// What each provider is called where its logo stands — the product, not the company.
const PROVIDER_NAME: Record<string, string> = { anthropic: "Claude", openai: "ChatGPT", meta: "Meta AI" };

/**
 * A provider's own logo — Claude's, ChatGPT's — as `ProviderMark` draws it beside the composer's
 * model chip, so the graph and the composer show the same mark for the same model. Undefined for a
 * provider without one (the dry-run model), which then wears no badge at all.
 */
function providerBrand(provider?: string, model?: string): Brand | undefined {
  const id = (provider ?? "").toLowerCase();
  if (!PROVIDER_NAME[id]) return undefined;
  const Mark = ({ size }: { size?: number }) => <ProviderMark provider={id} size={size} />;
  return { label: model || PROVIDER_NAME[id]!, Icon: Mark };
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

// ── node inspector ────────────────────────────────────────────────────────────
type Link = { id: string; branch?: string };

/**
 * A node's edges as the code has them — a decision stands for the fork of the step it decides for,
 * so its two segments are read back into the one edge each branch really is, with its label.
 */
function connections(spec: FlowNodeSpec, flow: FlowLayout): { incoming: string[]; outgoing: Link[] } {
  const real = new Map<string, { source: string; target: string; branch?: string }>();
  for (const e of flow.edges) {
    for (const t of e.to) {
      const key = `${e.from}->${t}`;
      const branch = e.target === t ? e.branch : undefined;
      real.set(key, { source: e.from, target: t, branch: real.get(key)?.branch ?? branch });
    }
  }
  const id = spec.decides?.source ?? spec.id;
  const all = [...real.values()];
  if (spec.role === "decision") {
    return { incoming: [id], outgoing: all.filter((r) => r.source === id).map((r) => ({ id: r.target, branch: r.branch })) };
  }
  return {
    incoming: [...new Set(all.filter((r) => r.target === id).map((r) => r.source))],
    outgoing: all.filter((r) => r.source === id).map((r) => ({ id: r.target, branch: r.branch })),
  };
}

/** What Start and End are, since they have no docstring to say it. */
const PILL_DOC: Record<"start" | "end", string> = {
  start: "Where every run begins.",
  end: "Where a run finishes.",
};

/**
 * What the selected node is, what it does, where it sits, and how it went in the run on screen.
 *
 * IT USED TO TITLE START `__start__` AND CALL EVERY STEP AN AGENT. Every node that was not a tool,
 * a start or an end was filed as "agent", so `extract_jd` read "Type: agent" over the whole agent's
 * prompt file. The prompt belongs to the ReAct agent node alone; a step says what its docstring says.
 */
function NodeInspector({
  spec, flow, bucket, onOpen, onOpenCode, onClose,
}: {
  spec: FlowNodeSpec;
  flow: FlowLayout;
  bucket: Record<string, Step> | undefined;
  onOpen: (id: string) => void;
  /** Open the node's function in the code — what double-clicking it does, for a keyboard. */
  onOpenCode: () => void;
  onClose: () => void;
}) {
  const files = useBuildStore((s) => s.files);
  const runs = useTraceStore((s) => s.runs);
  const activeRunId = useTraceStore((s) => s.activeRunId);
  const run = activeRunId ? runs[activeRunId] : undefined;
  const reactAgent = spec.role === "model" && isReactAgent(spec.id);
  const prompt = reactAgent ? findPrompt(files) : undefined;
  const toolFiles = spec.role === "tool" ? findToolFiles(files) : [];
  const { incoming, outgoing } = connections(spec, flow);
  const doc = spec.role === "start" || spec.role === "end" ? PILL_DOC[spec.role] : spec.doc;
  const step = spec.role === "decision" ? undefined : latestStepForNode(spec.id, bucket);
  const forkHere = flow.nodes.find((n) => n.decides?.source === spec.id);

  return (
    <div className="absolute top-2 right-2 bottom-2 w-64 bg-elevated rounded-card border border-edge p-3 overflow-auto text-caption shadow-floating">
      <div className="flex items-start justify-between gap-2">
        <span className="flex min-w-0 flex-col gap-0.5">
          <Truncate className="text-label text-ink" title={spec.title}>{spec.title}</Truncate>
          <span className="text-tiny text-muted">{ROLE_LABEL[spec.role]}</span>
        </span>
        <button className="text-muted transition-colors duration-fast hover:text-ink" title="Close (Esc)" aria-label="Close" onClick={onClose}>
          <Icon.workspace.close size={ICON.sm} />
        </button>
      </div>

      {spec.source && (
        <button
          type="button"
          onClick={onOpenCode}
          className="mt-2 text-tiny text-muted underline decoration-hair underline-offset-2 transition-colors hover:text-ink"
          title="Double-clicking the node does this too"
        >
          Open code · {spec.source.file}:{spec.source.line}
        </button>
      )}

      {doc ? (
        <p className="mt-3 text-ink">{doc}</p>
      ) : spec.role !== "decision" ? (
        <p className="mt-3 text-faint">No docstring says what this step does.</p>
      ) : null}

      {incoming.length > 0 && (
        <Section title={spec.role === "decision" ? "Decides for" : "Comes from"}>
          <Links links={incoming.map((id) => ({ id }))} onOpen={onOpen} />
        </Section>
      )}
      {outgoing.length > 0 && (
        <Section title={spec.role === "decision" ? "Chooses between" : forkHere ? `Goes to, as ${forkHere.title} decides` : "Goes to"}>
          <Links links={outgoing} onOpen={onOpen} />
        </Section>
      )}

      {step && (
        <Section title="In this run">
          <span className={step.error ? "text-ink" : "text-muted"}>
            {step.error ? "Failed" : "Ran"} · {fmtLatency(step.latency_ms)}
          </span>
          {step.error && <p className="mt-1 whitespace-pre-wrap break-words text-tiny text-muted">{step.error}</p>}
        </Section>
      )}

      {reactAgent && run && <Section title="Model"><span className="text-ink">{run.model}</span></Section>}
      {prompt && (
        <Section title="Prompt">
          <pre className="whitespace-pre-wrap text-muted text-tiny leading-relaxed">{prompt.slice(0, 1200)}</pre>
        </Section>
      )}
      {toolFiles.length > 0 && (
        <Section title={`Tools (${toolFiles.length})`}>
          {toolFiles.map((f) => (
            <div key={f.path} className="mb-3">
              <div className="text-faint text-tiny mb-1">{f.path}</div>
              <pre className="whitespace-pre-wrap text-muted text-tiny leading-relaxed">{f.content.slice(0, 800)}</pre>
            </div>
          ))}
        </Section>
      )}
    </div>
  );
}

/** The nodes a node connects to, each one a way to open it. */
function Links({ links, onOpen }: { links: Link[]; onOpen: (id: string) => void }) {
  return (
    <span className="flex flex-col items-start gap-1">
      {links.map((l) => (
        <button
          key={l.id}
          type="button"
          onClick={() => onOpen(l.id)}
          className="flex max-w-full items-center gap-1.5 text-left text-ink transition-colors hover:text-muted"
        >
          <Truncate title={titleOf(l.id)}>{titleOf(l.id)}</Truncate>
          {l.branch && <span className="shrink-0 rounded-pill bg-chrome px-1.5 text-tiny text-muted">{l.branch}</span>}
        </button>
      ))}
    </span>
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

// THE SHAPE OF WHAT IS COMING: three tiles down the column, as the graph will be drawn.
function GraphSkeleton() {
  return (
    <div className="graph-canvas flex h-full items-center justify-center">
      <div className="flex flex-col items-center gap-3">
        {[0, 1, 2].map((i) => (
          <div key={i} className="flex flex-col items-center gap-3">
            <div className="animate-stream-pulse rounded-lg bg-active motion-reduce:animate-none" style={{ width: TILE, height: TILE }} />
            <div className="h-2 w-16 animate-stream-pulse rounded-pill bg-active motion-reduce:animate-none" />
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
  const [selected, setSelected] = useState<{ id: string } | null>(null);

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

  // A draft is not asked about: it has no code, so the answer is already known.
  const draft = agent?.draft === true;
  useEffect(() => {
    if (activeAgentId && !draft && !graph && !loading) sendLoadAgentGraph(activeAgentId);
  }, [activeAgentId, draft, graph, loading]);

  // provider/model for the agent's strip
  const run = activeRunId ? runs[activeRunId] : undefined;
  const agentMeta = useMemo(() => agents.find((a) => a.agent_id === activeAgentId), [agents, activeAgentId]);
  // THE MODEL A RUN FROM HERE WOULD USE: the run on screen, else what the composer has chosen,
  // else the agent's own default — what its logo on the graph should say.
  const chosenProvider = useUiStore((s) => s.provider);
  const chosenModel = useUiStore((s) => s.model);
  const provider = run?.provider ?? (chosenProvider || agentMeta?.default_provider);
  const model = run?.model ?? (chosenProvider ? chosenModel : undefined);

  // The ReAct agent's model and tools, as the circles beside its card — derived from the agent's
  // files and provider, not the compiled graph, so they never participate in trace sync. Past
  // MAX_SUBS the last circle says how many more there are; the inspector lists them all.
  const subs = useMemo<Array<{ title: string; brand?: Brand }>>(() => {
    const all = [providerBrand(provider, model) ?? modelResource(provider, model), ...findToolFiles(files).map((f) => toolResource(f.path))];
    if (all.length <= MAX_SUBS) return all.map((b) => ({ title: b.label, brand: b }));
    const shown = all.slice(0, MAX_SUBS - 1).map((b) => ({ title: b.label, brand: b }));
    return [...shown, { title: `+${all.length - shown.length}` }];
  }, [files, provider, model]);

  // The layout, memoised on the static graph and the agent's circles.
  // ── an earlier version, alone or against this one ──────────────────────────
  // `viewing` is the version picked (null: the current one). Its graph is fetched once and kept
  // under its own key; comparing lays out both versions as one, every node either had, each marked.
  const [viewing, setViewing] = useState<number | null>(null);
  const [comparing, setComparing] = useState(false);
  useEffect(() => {
    setViewing(null);
    setComparing(false);
  }, [activeAgentId]);
  const latest = graph?.latest ?? graph?.version ?? 0;
  const older = useGraphStore((s) => (activeAgentId && viewing ? s.graphs[graphKey(activeAgentId, viewing)] : undefined));
  const olderLoading = useGraphStore((s) => (activeAgentId && viewing ? s.loading[graphKey(activeAgentId, viewing)] : undefined));
  useEffect(() => {
    if (activeAgentId && viewing && !older && !olderLoading) sendLoadAgentGraph(activeAgentId, viewing);
  }, [activeAgentId, viewing, older, olderLoading]);
  const olderReady = !!older?.nodes?.length;
  const diff = useMemo(
    () => (comparing && graph?.nodes && olderReady ? compareGraphs(graph, older!) : undefined),
    [comparing, graph, older, olderReady],
  );
  // What is drawn: the union when comparing, the picked version alone, or the current graph.
  const shownGraph = diff ? diff.union : viewing && olderReady ? older! : graph;
  const pastVersion = viewing !== null && olderReady;

  const flow = useMemo(
    () => (shownGraph?.nodes?.length ? buildFlow(shownGraph, { resources: subs.map((x) => x.title) }) : null),
    [shownGraph, subs],
  );
  const order = useMemo(() => (flow ? readingOrder(flow.nodes) : []), [flow]);

  // ── where somebody has dragged things ───────────────────────────────────────
  // Saved per workspace and agent, for this graph's shape only (see lib/graphPositions). `edits`
  // holds the arrangement once it has been touched in this tab, `loaded` what was saved before.
  const workspaceId = useSessionStore((s) => s.workspaceId);
  const posKey = activeAgentId ? graphPositionsKey(workspaceId, activeAgentId) : null;
  const sig = useMemo(() => (flow ? topologySig(flow.nodes, flow.edges) : ""), [flow]);
  const layoutId = `${posKey}|${sig}`;
  const loaded = useMemo(() => (posKey && sig ? readPositions(posKey, sig) : {}), [posKey, sig]);
  const [edits, setEdits] = useState<{ id: string; at: Positions } | null>(null);
  const positions = edits?.id === layoutId ? edits.at : loaded;
  const moved = Object.keys(positions).length > 0;
  const positionsRef = useRef(positions);
  positionsRef.current = positions;
  const save = (at: Positions) => {
    if (posKey && sig) writePositions(posKey, sig, at);
  };
  const onNodesChange = (changes: NodeChange[]) => {
    let next: Positions | null = null;
    let settled = false;
    for (const c of changes) {
      if (c.type !== "position" || !c.position) continue;
      next = { ...(next ?? positionsRef.current), [c.id]: c.position };
      if (!c.dragging) settled = true; // the end of a drag, or a keyboard move
    }
    if (!next) return;
    setEdits({ id: layoutId, at: next });
    if (settled) save(next);
  };
  const resetLayout = () => {
    setEdits({ id: layoutId, at: {} });
    save({});
    userMoved.current = false;
    requestAnimationFrame(frameGraph);
  };

  // ── hovering a node lights its path ─────────────────────────────────────────
  // Let go a moment late, so the pointer can travel from a tile up onto its toolbar without the
  // toolbar vanishing on the way.
  const [hovered, setHovered] = useState<string | null>(null);
  const [dragging, setDragging] = useState(false);
  const hideTimer = useRef<number | undefined>(undefined);
  const hover = (id: string | null) => {
    window.clearTimeout(hideTimer.current);
    if (id) setHovered(id);
    else hideTimer.current = window.setTimeout(() => setHovered(null), 160);
  };
  useEffect(() => () => window.clearTimeout(hideTimer.current), []);
  const near = useMemo(() => {
    if (!hovered || !flow) return null;
    const set = new Set([hovered]);
    for (const e of flow.edges) {
      if (e.source === hovered) set.add(e.target);
      if (e.target === hovered) set.add(e.source);
    }
    return set;
  }, [hovered, flow]);

  // What each node is drawn as: its own mark, never another node's, a connector's logo where the
  // agent has that connector. Taken in the runtime's order, so the same graph draws the same way.
  const marks = useMemo(
    () => (flow ? marksFor(flow.nodes.filter((n) => n.role !== "resource"), { connectors: agentMeta?.connectors }) : new Map<string, NodeMark>()),
    [flow, agentMeta?.connectors],
  );
  // The provider a model-calling step runs on, for the badge on its tile's corner.
  // Only a provider somebody would recognise, in its own logo: an agent whose saved default is the
  // dry-run model would otherwise wear a badge reading "Calls Dry-run" on every step.
  const provider_ = useMemo(() => providerBrand(provider, model), [provider, model]);

  // ── keeping the graph in frame ──────────────────────────────────────────────
  //
  // React Flow frames a graph once, against the canvas as it was at that instant, and then
  // holds that viewport for good. Three ordinary things move the frame out from under it, and
  // each one silently cut nodes off with nothing to say anything was missing:
  //
  //   1. Step Details opens. It is an OVERLAY — absolutely positioned over this canvas, not
  //      a column that shrinks it — so the canvas never resizes and a frame told to use the
  //      full width puts part of the graph underneath an opaque panel. Reserving the strip
  //      is the whole fix; there is nothing to observe.
  //   2. The pane itself is resized (the column splitter, the window).
  //   3. A different agent is selected, and its topology is bigger than the last one's.
  //
  // THE NODE INSPECTOR IS NOT ONE OF THEM, though it is the same overlay on the same edge. It
  // opens on a click, and re-framing on a click moved the node out from under the pointer — so
  // the second click of a double-click landed on empty canvas. It slides the view sideways
  // instead, only as far as keeps the clicked node clear of it, at the same zoom (see openNode).
  //
  // Refit for all of them — but only until the user takes the wheel. Once they have panned or
  // zoomed deliberately, refitting is the view fighting them, so `userMoved` latches and
  // this stops. Selecting a different agent is a new graph rather than a new view of the
  // old one, so it releases the latch.
  //
  // AND NEVER PAST REAL SIZE. A three-step agent fitted to a 790px column came out at 175%, cards
  // the size of buttons; `frameFor` holds a fit at 100% and leaves the space around it empty.
  const rf = useRef<{
    setViewport: (v: { x: number; y: number; zoom: number }, o?: { duration?: number }) => void;
    getViewport: () => { x: number; y: number; zoom: number };
    setCenter: (x: number, y: number, o?: { zoom?: number; duration?: number }) => void;
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
    return Math.round(detailOpen ? Math.min(STEP_PANEL_W, width * 0.85) + 24 : 0);
  }, [detailOpen]);

  // ── replaying a finished run ────────────────────────────────────────────────
  // While a frame is on screen it decides which node is lit, which edge is hot and which statuses
  // show — the run as it was at that step, not as it ended.
  const frames = useMemo(() => replayFrames(bucket), [bucket]);
  const timings = useMemo(() => nodeTimings(bucket), [bucket]);
  const [replayAt, setReplayAt] = useState<number | null>(null);
  const [playing, setPlaying] = useState(false);
  const [stripClosed, setStripClosed] = useState<string | null>(null);
  useEffect(() => {
    setReplayAt(null);
    setPlaying(false);
  }, [activeRunId]);
  const replayFrame = replayAt !== null ? frames[replayAt] : undefined;
  const stripShown = frames.length > 0 && !!run && run.status !== "running" && stripClosed !== activeRunId;

  // Read by the ResizeObserver below, which is registered once and must frame against what is
  // true when it fires rather than when it was created.
  const live = useRef<{ covered: number; flow: FlowLayout | null; positions: Positions; strip: boolean }>({ covered, flow, positions, strip: false });
  live.current = { covered, flow, positions, strip: stripShown };

  // NOT SHOWN UNTIL IT IS FRAMED. React Flow paints its first frame at 100% from the origin, and
  // the framing lands a frame later — so the graph appeared in the corner and jumped to the middle.
  const [framed, setFramed] = useState(false);

  // Fit the whole graph, or open a long one at a readable size from the top (see frameFor).
  const frameGraph = () => {
    const el = canvasRef.current;
    const inst = rf.current;
    const { covered: hidden, flow: laid, positions: at, strip } = live.current;
    if (!el || !inst || !laid || el.clientWidth === 0) return;
    // A moved arrangement is framed by where its nodes now are, not by the layout's own box.
    const placed = laid.nodes.map((n) => ({ ...n, ...(at[n.id] ?? {}) }));
    const box = Object.keys(at).length
      ? {
          minX: Math.min(...placed.map((n) => n.x)) - 24,
          minY: Math.min(...placed.map((n) => n.y)) - 24,
          maxX: Math.max(...placed.map((n) => n.x + n.w)) + 24,
          maxY: Math.max(...placed.map((n) => n.y + n.h)) + 24,
        }
      : { minX: 0, minY: 0, maxX: laid.width, maxY: laid.height };
    // The toolbar floats over the canvas's top edge; the graph is framed in what is left below it.
    // ...and above the run strip, when there is one along the bottom.
    const f = frameFor(
      { width: box.maxX - box.minX, height: box.maxY - box.minY },
      { width: el.clientWidth, height: el.clientHeight - TOOLBAR_H - (strip ? TOOLBAR_H : 0) },
      hidden,
    );
    inst.setViewport({ x: f.x - box.minX * f.zoom, y: TOOLBAR_H + f.y - box.minY * f.zoom, zoom: f.zoom });
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
  }, [topologyKey, covered]);

  useEffect(() => {
    const el = canvasRef.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    let raf = 0;
    let wasHidden = el.clientWidth === 0;
    const ro = new ResizeObserver(() => {
      // Coalesce to one refit per frame: a drag on the splitter fires this continuously.
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(() => {
        setFrame({ width: el.clientWidth, height: el.clientHeight });
        // A CANVAS THAT WAS HIDDEN CANNOT HAVE BEEN MOVED BY ANYBODY. Mounted in a closed panel, or
        // behind a dialog that held the app on launch, it has no size; when it first gets one it is
        // framed afresh rather than shown at whatever viewport it was left with.
        if (wasHidden && el.clientWidth > 0) userMoved.current = false;
        wasHidden = el.clientWidth === 0;
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

  const activeNode = useMemo(
    () => (replayFrame ? replayFrame.node : running ? activeNodeId(bucket) : undefined),
    [replayFrame, running, bucket],
  );
  const selectedNode = useMemo(() => {
    const step = selectedStepId && bucket ? bucket[selectedStepId] : undefined;
    return step ? stepNodeId(step, bucket!) : undefined;
  }, [selectedStepId, bucket]);
  const nodeStatus = useMemo(
    () => computeNodeStatus(replayFrame && bucket ? stepsUpTo(bucket, replayFrame) : bucket, activeNode),
    [replayFrame, bucket, activeNode],
  );

  // Edges the current run actually traversed (source→target = real data direction), reused from
  // traceGraphMap. Drives the directional particle in the click micro-interaction.
  const traversed = useMemo(() => {
    const set = new Set<string>();
    for (const e of traversedEdges(bucket)) set.add(`${e.source}->${e.target}`);
    return set;
  }, [bucket]);

  const hotEdge = useMemo(() => {
    if (replayFrame) return replayFrame.edge;
    if (selectedStepId && bucket) {
      const step = bucket[selectedStepId];
      return step ? stepEdge(step, bucket) : undefined;
    }
    return running ? activeEdge(bucket) : undefined;
  }, [replayFrame, running, selectedStepId, bucket]);

  const nodes = useMemo<Node[]>(() => {
    if (!flow) return [];
    return flow.nodes.map((spec) => {
      // LangGraph gives the whole tool step one node — usually called "tools" — so there is
      // no per-tool card to mark. What IS true of that node is that it reaches unreviewed
      // third-party code, and that is what it says. Deliberately not "MCP tool": the same
      // node also runs the agent's reviewed and bespoke tools, and claiming otherwise would
      // overstate exactly where the badge must not.
      const mcp = spec.role === "tool" && (mcpNames.has(spec.id) || mcpNames.size > 0);
      const agentCard = spec.role === "model" && isReactAgent(spec.id);
      const sub = spec.role === "resource" ? subs[Number(spec.id.slice(4))] : undefined;
      const data: FlowData = {
        spec,
        mark: marks.get(spec.id),
        badge: spec.role === "model" && !agentCard ? provider_ : undefined,
        brand: sub?.brand,
        ports: agentCard ? flow.edges.filter((e) => e.port).map((e) => e.port!) : undefined,
        mcp,
        out: flow.edges.some((e) => e.source === spec.id && !e.back && !e.port),
        hover: hovered === spec.id && !dragging,
        timing: timings.get(spec.id),
        diff: diff ? diff.nodes.get(spec.decides?.source ?? spec.id) : undefined,
        active: spec.id === activeNode,
        selected: spec.id === selectedNode || spec.id === selected?.id,
        status: nodeStatus[spec.id],
      };
      return {
        id: spec.id,
        type: agentCard ? "agent" : spec.role === "end" ? "end" : spec.role === "resource" ? "resource" : "tile",
        position: positions[spec.id] ?? { x: spec.x, y: spec.y },
        style: { opacity: near && !near.has(spec.id) ? 0.35 : 1, transition: REDUCED_MOTION ? undefined : "opacity 120ms ease" },
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
  }, [flow, order, marks, provider_, subs, activeNode, selectedNode, selected?.id, nodeStatus, mcpNames, positions, near, hovered, dragging, timings, diff]);

  const edges = useMemo<Edge[]>(() => {
    if (!flow) return [];
    return flow.edges.map((e) => {
      const hot = matchesEdge(e, hotEdge);
      const connected = pulse
        ? e.source === pulse.node || e.target === pulse.node || e.from === pulse.node || e.to.includes(pulse.node)
        : false;
      const particle = connected && e.to.some((t) => traversed.has(`${e.from}->${t}`));
      const lit = !!near && (e.source === hovered || e.target === hovered);
      const dim = !!near && !lit;
      const color = connected ? PULSE : hot ? AMBER : lit ? SEL : EDGE;
      if (e.port) {
        const i = Number(e.target.slice(4));
        return {
          id: e.id, source: e.source, target: e.target, sourceHandle: `port-${i}`, targetHandle: "in", type: "port", focusable: false,
          data: { port: e.port === "Model" ? "Model" : "Tool", dim },
        };
      }
      const side = e.side === "left" ? "-l" : "";
      return {
        id: e.id,
        source: e.source,
        target: e.target,
        sourceHandle: e.back ? `loop-out${side}` : "out",
        targetHandle: e.back ? `loop-in${side}` : "in",
        type: "flow",
        markerEnd: { type: MarkerType.ArrowClosed, width: 14, height: 14, color },
        data: {
          hot, lit, dim, pulse: connected, particle, pulseKey: pulse?.key, branch: e.branch, back: e.back, via: e.via, lane: e.lane,
          flowing: hot && running && !REDUCED_MOTION, free: moved,
          diff: diff ? segmentMark(diff, e.from, e.to) : undefined,
        } satisfies EdgeData,
      };
    });
  }, [flow, hotEdge, pulse, traversed, near, hovered, running, moved, diff]);

  // Clicking a node and pressing Enter on it do the same thing: open its inspector, and only that.
  //
  // IT USED TO REACH INTO THE COMPOSER AS WELL. A click set the composer's selected node and the
  // trace's selected step, and each of those draws a context chip over the composer — "node:
  // extract_jd", "step #3" — a small dialog appearing somewhere other than where somebody clicked.
  // The inspector already says what the step is and how it ran in the run on screen.
  const openNode = (id: string, viaClick: boolean) => {
    // One of the agent's circles describes the agent: it opens the agent.
    const hit = flow?.nodes.find((n) => n.id === id);
    const spec = hit?.role === "resource" ? flow?.nodes.find((n) => n.role === "model" && isReactAgent(n.id)) : hit;
    if (!spec) return;
    setSelected({ id: spec.id });
    // Keep the node clear of the inspector that is about to cover the canvas's right edge.
    const inst = rf.current;
    const el = canvasRef.current;
    if (inst && el) {
      const vp = inst.getViewport();
      const at = positions[spec.id] ?? { x: spec.x, y: spec.y };
      const right = (at.x + spec.w) * vp.zoom + vp.x;
      const limit = el.clientWidth - INSPECTOR_W - 24;
      if (right > limit) inst.setViewport({ ...vp, x: vp.x - (right - limit) }, { duration: REDUCED_MOTION ? 0 : 200 });
    }
    if (viaClick) triggerPulse(spec.id); // transient connected-edge highlight + directional particle
  };

  // DOUBLE-CLICK OPENS THE CODE, at the function the node runs — the runtime says where each is
  // written (graph schema 3). A circle stands for the agent; a fork, for its deciding function.
  // Without a location (a library ToolNode, an older graph) it opens agent.py at the top.
  const openCode = (id: string) => {
    const hit = flow?.nodes.find((n) => n.id === id);
    const spec = hit?.role === "resource" ? flow?.nodes.find((n) => n.role === "model" && isReactAgent(n.id)) : hit;
    if (!spec || spec.role === "start" || spec.role === "end") return;
    const at = spec.source;
    useBuildStore.getState().openInCode(at?.file ?? "agent.py", at?.line);
  };

  // FIND: centre a match and pulse it, at no less than a readable zoom. Not a click — the inspector
  // stays as it was — and not a move of the user's: refitting is not switched off by looking.
  const [findSignal, setFindSignal] = useState(0);
  const focusNode = (id: string) => {
    const spec = flow?.nodes.find((n) => n.id === id);
    const inst = rf.current;
    if (!spec || !inst) return;
    const at = positions[spec.id] ?? { x: spec.x, y: spec.y };
    const zoom = Math.max(inst.getViewport().zoom, 0.9);
    inst.setCenter(at.x + spec.w / 2, at.y + spec.h / 2, { zoom, duration: REDUCED_MOTION ? 0 : 250 });
    triggerPulse(spec.id);
  };

  // What each node's hover toolbar does. Branching needs the run on screen to have passed through
  // the node — its checkpoint there is what the branch starts from (the same call the state editor
  // makes) — and a run that has finished or paused, not one still moving.
  const branchable = run && run.status !== "running" ? bucket : undefined;
  const nodeActions: NodeActions = {
    inspect: (id) => openNode(id, false),
    code: (id) => openCode(id),
    canBranch: (id) => !!activeRunId && !!latestStepForNode(id, branchable),
    branch: (id) => {
      const step = latestStepForNode(id, branchable);
      if (activeRunId && step) sendBranchRun(activeRunId, step.seq);
    },
    hold: hover,
  };

  if (!activeAgentId) return <Empty title="No agent selected" hint="Pick one in the sidebar and its compiled topology is introspected and drawn here." />;
  // A DRAFT IS A STATE, NOT A FAILURE. It used to be asked about, answered "no published version",
  // and drawn as "This graph could not be drawn" over a Try again that could never succeed.
  if (draft || isDraftGraphError(graph?.error)) {
    return (
      <div className="graph-canvas h-full">
        <EmptyState
          icon={GitBranchIcon}
          title={agent?.name ? `${agent.name} is a draft` : DRAFT.title}
          hint={
            <span className="block">
              <span className="block">{DRAFT.sentence}</span>
              <span className="mt-1 block text-muted">{DRAFT.next}</span>
            </span>
          }
        />
      </div>
    );
  }
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
      className={`graph-canvas relative h-full w-full focus:outline-none ${framed ? "" : "opacity-0"}`}
      // Enter on a focused node opens it, as a click does. Read off the node's own element, because
      // React Flow reports a keyboard selection only for nodes whose state it holds, and these are
      // rebuilt from the introspected topology on every render.
      tabIndex={-1}
      onKeyDown={(e) => {
        if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "f") {
          e.preventDefault();
          setFindSignal((n) => n + 1);
          return;
        }
        if (e.key !== "Enter" && e.key !== " ") return;
        const id = (e.target as HTMLElement).closest?.(".react-flow__node")?.getAttribute("data-id");
        if (id) {
          e.preventDefault();
          openNode(id, false);
        }
      }}
    >
      {/* An earlier version's steps are not the code that is loaded: no toolbar over them. */}
      <NodeActionsContext.Provider value={pastVersion ? null : nodeActions}>
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
        // came from our own framing.
        onMove={(event) => {
          if (event) userMoved.current = true;
        }}
        minZoom={MIN_ZOOM}
        maxZoom={1.75}
        // A COLUMN SCROLLS. Two fingers on a trackpad move down a long agent the way they move
        // down a page; a pinch, or the controls, zoom.
        panOnScroll
        proOptions={{ hideAttribution: true }}
        // MOVABLE, AND NOTHING MORE. A node can be dragged to rearrange the drawing — remembered
        // for this agent on this computer — and that is all: nothing connects, nothing deletes,
        // and the agent itself only changes by being asked to.
        nodesDraggable
        onNodesChange={onNodesChange}
        onNodeMouseEnter={(_, n) => hover(n.id)}
        onNodeMouseLeave={() => hover(null)}
        onNodeDragStart={() => setDragging(true)}
        onNodeDragStop={() => setDragging(false)}
        nodesConnectable={false}
        edgesFocusable={false}
        deleteKeyCode={null}
        ariaLabelConfig={READ_ONLY_ARIA}
        elementsSelectable
        onNodeClick={(_, n) => openNode(n.id, true)}
        onNodeDoubleClick={(_, n) => openCode(n.id)}
        // Double-click belongs to the nodes; on the canvas it would zoom, which nobody asked for.
        zoomOnDoubleClick={false}
        onPaneClick={() => setSelected(null)}
      >
        {/* n8n's DOTTED CANVAS, and visibly so: the dots were the page's own chrome tone, which on
            this background was a grid nobody could see. */}
        <Background variant={BackgroundVariant.Dots} gap={20} size={1.6} color={TEXT.disabled} />
        <Controls
          showInteractive={false}
          className="!bg-elevated/80 !backdrop-blur !border-0 !rounded-card !shadow-floating"
          // Fit means "frame it for me again": the same framing the canvas opened with, which
          // counts the loop lanes and the overlays React Flow's own fit does not, and refitting
          // resumes on resize.
          onFitView={() => {
            userMoved.current = false;
            requestAnimationFrame(frameGraph);
          }}
        >
          {moved && (
            // Only once something has been moved: there is nothing to reset before then.
            // React Flow's controls fill every svg, which floods a stroke mark; this one keeps its lines.
            <ControlButton
              onClick={resetLayout}
              title="Reset layout"
              aria-label="Reset layout"
              className="[&_svg]:!fill-none [&_svg]:!max-h-[14px] [&_svg]:!max-w-[14px]"
            >
              <Icon.graph.resetLayout size={ICON.sm} />
            </ControlButton>
          )}
        </Controls>
        {showMinimap && (
          <MiniMap
            pannable
            zoomable
            className="!bg-panel/80 !rounded-card !border-0"
            style={{ width: 120, height: 80 }}
            maskColor={MINIMAP_MASK}
            nodeColor={(n) => {
              const mark = (n.data as FlowData | undefined)?.mark;
              return mark?.kind === "glyph" ? mark.hue : TEXT.faint;
            }}
            nodeStrokeWidth={0}
          />
        )}
      </ReactFlow>
      </NodeActionsContext.Provider>
      {stripShown && (
        <GraphRunStrip
          count={frames.length}
          at={replayAt}
          playing={playing}
          onAt={setReplayAt}
          onPlaying={setPlaying}
          onClose={() => {
            setReplayAt(null);
            setPlaying(false);
            setStripClosed(activeRunId);
          }}
        />
      )}
      {/* THE TOOLBAR, over the canvas rather than in it, so it neither pans nor zooms. */}
      <GraphToolbar>
        <RunControls agentId={activeAgentId} runnable={agentMeta?.runnable ?? false} />
        <ToolDivider />
        <FindControl
          find={(q) => findNodes(flow.nodes, q).map((n) => n.id)}
          onFocus={focusNode}
          openSignal={findSignal}
        />
        {latest > 1 && <ToolDivider />}
        <VersionControl
          latest={latest}
          viewing={viewing}
          comparing={comparing}
          onPick={(v) => {
            setViewing(v);
            if (v === null) setComparing(false);
          }}
          onCompare={setComparing}
        />
      </GraphToolbar>
      {selected && flow && (() => {
        const spec = flow.nodes.find((n) => n.id === selected.id);
        return spec ? (
          <NodeInspector
            spec={spec}
            flow={flow}
            bucket={bucket}
            onOpen={(id) => openNode(id, true)}
            onOpenCode={() => openCode(spec.id)}
            onClose={() => setSelected(null)}
          />
        ) : null;
      })()}
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
