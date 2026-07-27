// Frozen event schema mirror. Canonical source: schema/events.md (v1).
// Kept in sync by hand with server/src/types.ts and runtime/jaroku_interceptor/schema.py.

export const SCHEMA_VERSION = 1;

// "paused" is a store-only status (debug depth) the client displays; it is never carried by a
// frozen trace event (a paused run simply has no run_end yet). The three event statuses mirror
// schema/events.md; "paused" is control-plane, added here for rendering run history.
export type RunStatus = "running" | "completed" | "error" | "paused";
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
// Debug depth: a run may be a branch of another. `parent_run_id`/`branch_from_seq` are store-only
// (control-plane) columns, never part of a frozen event — present on history rows for the tree.
export type RunSummary = Run & {
  step_count?: number;
  parent_run_id?: string | null;
  branch_from_seq?: number | null;
};

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

// --- eval ---
// Its own channel, like gen/edit/debug — never part of the frozen event schema. An eval's
// individual runs still produce ordinary Run/Step rows and are read back through the
// normal `loadRun` path; this channel carries only control-plane facts about the eval
// itself, so a running eval never steals the Trace timeline's focus.

export interface Dataset {
  id: string;
  agent_id: string;
  name: string;
  created_at: string;
  updated_at: string;
  example_count?: number;
}

export interface DatasetExample {
  id: string;
  dataset_id: string;
  /** The agent's runtime input — exactly what Test mode would send. */
  input: string;
  /** Optional ground truth, given to the judge as reference when present. */
  expected: string | null;
  notes: string | null;
  position: number;
  created_at: string;
}

export type EvalMessage =
  | { channel: "eval"; type: "datasets"; agentId: string | null; datasets: Dataset[] }
  | { channel: "eval"; type: "dataset"; datasetId: string; examples: DatasetExample[] }
  | { channel: "eval"; type: "datasetDeleted"; datasetId: string }
  | { channel: "eval"; type: "error"; message: string; datasetId?: string };

// --- server → client channel messages (see server/src/wsRelay.ts) ---

export type ServerMessage =
  | { channel: "history"; runs: RunSummary[] }
  | { channel: "trace"; event: TraceEvent }
  | { channel: "runSteps"; runId: string; steps: Step[] }
  | { channel: "log"; level: "stderr" | "parseError"; text: string }
  | { channel: "agents"; agents: AgentSummary[] }
  | { channel: "agentFiles"; agentId: string; files: AgentFile[] }
  | { channel: "graph"; agentId: string; graph: AgentGraph | null }
  | { channel: "debug"; type: "paused"; runId: string; seq: number }
  | { channel: "debug"; type: "resumed"; runId: string; seqOffset: number }
  | { channel: "debug"; type: "boundary"; runId: string; seq: number; next: string[] }
  | { channel: "debug"; type: "branched"; parentRunId: string; branchId: string; fromSeq: number }
  | { channel: "debug"; type: "error"; runId?: string; message: string }
  | { channel: "reply"; type: "started"; agentId: string; question: string }
  | { channel: "reply"; type: "delta"; agentId: string; text: string }
  | { channel: "reply"; type: "done"; agentId: string }
  | { channel: "reply"; type: "error"; agentId: string; message: string }
  | GenMessage
  | EditMessage
  | EvalMessage;

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
  | { cmd: "loadAgentGraph"; agentId: string }
  | { cmd: "pauseRun"; runId: string }
  | { cmd: "resumeRun"; runId: string }
  | { cmd: "branchRun"; fromRunId: string; atSeq: number; editNode?: string; editedState?: Record<string, unknown> }
  | { cmd: "explain"; agentId: string; question: string; subject: ExplainSubject }
  // Eval: dataset CRUD. Every mutation is answered with a fresh snapshot on the "eval"
  // channel, so the client never reconciles a partial update against local state.
  | { cmd: "createDataset"; agentId: string; name: string }
  | { cmd: "renameDataset"; datasetId: string; name: string }
  | { cmd: "deleteDataset"; datasetId: string; agentId: string }
  | { cmd: "listDatasets"; agentId?: string }
  | { cmd: "loadDataset"; datasetId: string }
  | { cmd: "addExample"; datasetId: string; input: string; expected?: string | null; notes?: string | null }
  | { cmd: "updateExample"; datasetId: string; exampleId: string; input?: string; expected?: string | null; notes?: string | null }
  | { cmd: "deleteExample"; datasetId: string; exampleId: string };

// Unified composer "explain" subject — what the question is about, built from already-in-memory
// context (a trace step, a graph node, or the agent generally). No new data is fetched.
export type ExplainSubject =
  | { kind: "step"; step: { name: string; type: string; seq: number; error: string | null; input: unknown; output: unknown } }
  | { kind: "node"; nodeId: string }
  | { kind: "agent" };
