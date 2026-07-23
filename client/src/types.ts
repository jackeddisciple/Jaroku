// Frozen event schema mirror. Canonical source: schema/events.md (v1).
// Kept in sync by hand with server/src/types.ts and runtime/jaroku_interceptor/schema.py.

export const SCHEMA_VERSION = 1;

export type RunStatus = "running" | "completed" | "error";
export type StepType = "llm_call" | "tool_call" | "state_update" | "router";

export interface Run {
  id: string;
  agent_id: string;
  provider: string;
  model: string;
  status: RunStatus;
  started_at: string;
  ended_at: string | null;
  cost: number;
  tokens: number;
  error: string | null;
}

export interface Step {
  id: string;
  run_id: string;
  seq: number;
  type: StepType;
  name: string;
  input: unknown;
  output: unknown;
  state_before: unknown;
  state_after: unknown;
  tokens: number | null;
  cost: number | null;
  latency_ms: number;
  error: string | null;
  parent_step_id: string | null;
  started_at: string;
}

// A run plus the derived step count the relay's history snapshot includes (read-side only).
export type RunSummary = Run & { step_count?: number };

export type TraceEvent =
  | { kind: "run_start"; schema_version: number; run: Run }
  | { kind: "step"; schema_version: number; step: Step }
  | { kind: "run_end"; schema_version: number; run: Run };

// --- generation ---
// Deliberately NOT part of the frozen event schema above. Generation is a separate concern
// on its own channel; it never enters the trace store.

export interface AgentSummary {
  agent_id: string;
  name: string;
  description: string;
  connectors: string[];
  required_env: string[];
  default_provider: string;
  created_at: string | null;
  hand_written: boolean;
  runnable: boolean;
  edit_count?: number; // applied edits available to undo (fix loop)
}

export interface GenUsage {
  input_tokens: number;
  output_tokens: number;
  cache_read_input_tokens: number;
  cache_creation_input_tokens: number;
  cost_usd: number;
}

export type GenMessage =
  | { channel: "gen"; type: "started"; prompt: string }
  | { channel: "gen"; type: "file_start"; path: string }
  | { channel: "gen"; type: "file_delta"; path: string; text: string }
  | { channel: "gen"; type: "file_end"; path: string }
  | { channel: "gen"; type: "done"; agentId: string; name: string; files: string[]; usage: GenUsage }
  | { channel: "gen"; type: "error"; message: string; problems?: string[] };

// --- editing (fix loop) ---
// Like generation: its own channel, never part of the frozen event schema.

export interface FileDiffHunk {
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
  lines: string[]; // " ctx" | "+added" | "-removed"
}

export interface FileDiff {
  path: string;
  status: "added" | "modified";
  additions: number;
  deletions: number;
  hunks: FileDiffHunk[];
}

export interface AgentFile {
  path: string;
  content: string;
  readOnly: boolean;
}

// --- graph view ---
// Static LangGraph topology, derived server-side by introspecting the compiled graph
// (jaroku_runner.graph). Its own channel — never part of the frozen trace schema.

export type GraphNodeType = "start" | "end" | "tool" | "agent";

export interface GraphNode {
  id: string;
  type: GraphNodeType | string;
}

export interface GraphEdge {
  source: string;
  target: string;
  conditional: boolean;
  label: string | null;
}

export interface AgentGraph {
  agent_id: string;
  nodes?: GraphNode[];
  edges?: GraphEdge[];
  error?: string;
}

export type EditMessage =
  | { channel: "edit"; type: "started"; agentId: string; instruction: string }
  | { channel: "edit"; type: "file_start"; path: string }
  | { channel: "edit"; type: "file_delta"; path: string; text: string }
  | { channel: "edit"; type: "file_end"; path: string }
  | { channel: "edit"; type: "proposal"; proposalId: string; agentId: string; instruction: string; summary: string; files: FileDiff[]; usage: GenUsage }
  | { channel: "edit"; type: "applied"; proposalId: string; agentId: string; version: number; summary: string }
  | { channel: "edit"; type: "undone"; agentId: string; version: number; summary: string }
  | { channel: "edit"; type: "discarded"; proposalId: string; agentId: string }
  | { channel: "edit"; type: "error"; message: string; problems?: string[]; agentId?: string; proposalId?: string };

// --- server → client channel messages (see server/src/wsRelay.ts) ---

export type ServerMessage =
  | { channel: "history"; runs: RunSummary[] }
  | { channel: "trace"; event: TraceEvent }
  | { channel: "runSteps"; runId: string; steps: Step[] }
  | { channel: "log"; level: "stderr" | "parseError"; text: string }
  | { channel: "agents"; agents: AgentSummary[] }
  | { channel: "agentFiles"; agentId: string; files: AgentFile[] }
  | { channel: "graph"; agentId: string; graph: AgentGraph | null }
  | GenMessage
  | EditMessage;

// --- client → server commands ---

export type ClientCommand =
  | { cmd: "run"; input?: string; provider?: string; model?: string; agentId?: string }
  | { cmd: "loadRun"; runId: string }
  | { cmd: "generate"; prompt: string; connectors?: string[]; name?: string }
  | { cmd: "listAgents" }
  | { cmd: "edit"; agentId: string; instruction: string }
  | { cmd: "applyEdit"; proposalId: string }
  | { cmd: "undoEdit"; agentId: string }
  | { cmd: "discardEdit"; proposalId: string }
  | { cmd: "loadAgentFiles"; agentId: string }
  | { cmd: "loadAgentGraph"; agentId: string };
