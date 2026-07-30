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

// The pre-generation plan (server/src/planProtocol.ts). Hand-mirrored like every other
// cross-boundary type here. `raw` is always populated and is what the plan card renders when
// the structure came back empty — confirming a plan is never blocked on a successful parse.
export type ToolOrigin = "connector" | "bespoke";

export interface PlannedTool {
  name: string;
  origin: ToolOrigin;
  connectorId?: string;
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
  graph: string[];
  notes: string[];
  raw: string;
  complete: boolean;
}

export type GenMessage =
  | { channel: "gen"; type: "started"; prompt: string }
  | { channel: "gen"; type: "file_start"; path: string }
  | { channel: "gen"; type: "file_delta"; path: string; text: string }
  | { channel: "gen"; type: "file_end"; path: string }
  | { channel: "gen"; type: "done"; agentId: string; name: string; files: string[]; usage: GenUsage; planUsage: GenUsage }
  | { channel: "gen"; type: "error"; message: string; problems?: string[] }
  // The pre-generation plan gate. On "gen" rather than a channel of its own because a plan is
  // an earlier phase of the same generation. plan_error is separate from "error" above: that
  // one drives buildStore.fail(), which reports a FAILED GENERATION — and a plan refusal
  // happens when no generation is running.
  | { channel: "gen"; type: "plan_started"; prompt: string; input: string; revision: number }
  | { channel: "gen"; type: "plan_delta"; text: string }
  | {
      channel: "gen";
      type: "plan";
      planId: string;
      prompt: string;
      connectors: string[];
      name?: string;
      plan: AgentPlan;
      warnings: string[];
      usage: GenUsage;
      revision: number;
    }
  | { channel: "gen"; type: "plan_discarded"; planId: string }
  | { channel: "gen"; type: "plan_error"; message: string };

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

export interface EvalTarget {
  provider: string;
  model: string;
}

export interface EvalRunSummary {
  id: string;
  dataset_id: string;
  agent_id: string;
  status: string;
  targets: EvalTarget[];
  budget_usd: number | null;
  judge_cost_usd: number;
  started_at: string;
  ended_at: string | null;
  error: string | null;
}

/** One (provider, model) leg of the comparison. */
export interface ProviderMetrics {
  provider: string;
  model: string;
  total: number;
  succeeded: number;
  failed: number;
  successRate: number;
  /** Succeeded runs only — the like-for-like figure. null when the model is unpriced. */
  comparisonCostUsd: number | null;
  costPerRunUsd: number | null;
  /** Every attempt on this leg, succeeded or not. */
  spentUsd: number;
  tokens: number;
  latencyP50Ms: number | null;
  latencyP95Ms: number | null;
  /** No pricing entry — cost is UNKNOWN, not zero. Must never render as $0.00. */
  costUnknown: boolean;
  /** Some steps couldn't be priced; the figure shown is a floor. */
  costIncomplete: boolean;
  /** Mean judge score over scored runs. null when nothing was scored. */
  qualityScore: number | null;
  scored: number;
  unscored: number;
}

export interface EvalTotals {
  trueSpendUsd: number;
  judgeCostUsd: number;
  agentSpendUsd: number;
  budgetUsd: number | null;
}

/** One cell of the grid: what one provider did with one example. */
export interface ExampleCell {
  jobId: string;
  provider: string;
  model: string;
  status: string;
  /** The ordinary run this produced — the handle for opening the full trace. */
  runId: string | null;
  costUsd: number | null;
  latencyMs: number | null;
  attempt: number;
  error: string | null;
  /** null = unscored, with scoreError saying why. Never treat as zero. */
  score: number | null;
  scoreError: string | null;
  perCriterion: Record<string, number> | null;
  rationale: string | null;
}

export interface ExampleRow {
  exampleId: string;
  input: string;
  expected: string | null;
  cells: ExampleCell[];
}

export interface EvalResults {
  evalId: string;
  datasetId: string;
  agentId: string;
  status: string;
  startedAt: string;
  endedAt: string | null;
  providers: ProviderMetrics[];
  totals: EvalTotals;
  rows: ExampleRow[];
}

export interface RubricCriterion {
  id: string;
  label: string;
  description: string;
  weight: number;
}

export interface Rubric {
  id: string;
  dataset_id: string | null;
  name: string;
  criteria: RubricCriterion[];
}

export type EstimateBasis = "measured" | "other-model" | "default";

export interface TargetEstimate {
  provider: string;
  model: string;
  runs: number;
  /** null when the model has no pricing entry — unknown, not free. */
  lowUsd: number | null;
  highUsd: number | null;
  basis: EstimateBasis;
  sampleSize: number;
  priced: boolean;
}

export interface EvalEstimate {
  examples: number;
  targets: number;
  totalRuns: number;
  perTarget: TargetEstimate[];
  judgeLowUsd: number;
  judgeHighUsd: number;
  totalLowUsd: number;
  totalHighUsd: number;
  hasUnpricedTarget: boolean;
  notes: string[];
}

export type EvalMessage =
  | { channel: "eval"; type: "datasets"; agentId: string | null; datasets: Dataset[] }
  | { channel: "eval"; type: "dataset"; datasetId: string; examples: DatasetExample[] }
  | { channel: "eval"; type: "datasetDeleted"; datasetId: string }
  | { channel: "eval"; type: "promoted"; datasetId: string; datasetName: string; duplicate: boolean }
  | { channel: "eval"; type: "evalStarted"; evalId: string; datasetId: string; agentId: string; total: number; targets: EvalTarget[] }
  | { channel: "eval"; type: "evalProgress"; evalId: string; total: number; done: number; running: number; queued: number; failed: number }
  | { channel: "eval"; type: "evalFinished"; evalId: string; status: string; error?: string }
  | { channel: "eval"; type: "scored"; evalId: string; jobId: string; score: number | null; error?: string | null }
  | { channel: "eval"; type: "scoringFinished"; evalId: string; scored: number; unscored: number }
  | { channel: "eval"; type: "evalResults"; evalId: string; results: EvalResults }
  | { channel: "eval"; type: "evals"; evals: EvalRunSummary[] }
  | { channel: "eval"; type: "estimate"; estimate: EvalEstimate }
  | { channel: "eval"; type: "rubric"; datasetId: string; rubric: Rubric; isDefault: boolean }
  | { channel: "eval"; type: "error"; message: string; datasetId?: string };

// --- MCP (see server/src/mcpRegistry.ts, server/src/mcpStore.ts) ---
//
// A connected MCP server is UNREVIEWED THIRD-PARTY CODE. Everything below is a claim it
// made about itself during the handshake, not a fact anyone verified — which is why an
// MCP-sourced tool carries a distinct badge everywhere it appears, and why a high-impact
// one stops for a confirmation before it runs.

export type McpImpact = "high" | "low";

export type McpServerStatus = "connected" | "unreachable" | "auth_required" | "error";

export interface McpTool {
  server_id: string;
  name: string;
  description: string | null;
  /** The tool's declared JSON Schema, exactly as the server advertised it. */
  input_schema: Record<string, unknown>;
  schema_hash: string;
  /** What the confirmation gate will actually use — an override if one applies, else below. */
  impact: McpImpact;
  /** What the classifier decided, before any override. */
  computed_impact: McpImpact;
  /** Why, in words. Shown beside the classification and in the confirmation modal. */
  impact_reason: string;
  overridden: boolean;
  /** An override exists but no longer applies: the server changed the tool's schema. */
  override_voided: boolean;
  annotations: Record<string, unknown> | null;
}

export interface McpServer {
  id: string;
  label: string;
  endpoint: string;
  transport: string;
  /** The NAME of the env var holding this server's credential. Never a value. */
  auth_env_key: string | null;
  server_name: string | null;
  server_version: string | null;
  protocol_version: string | null;
  status: McpServerStatus;
  last_error: string | null;
  discovered_at: string | null;
  created_at: string;
  /** A credential is stored. Never the credential itself — that never crosses the wire. */
  configured: boolean;
  tools: McpTool[];
}

export type McpMessage =
  | { channel: "mcp"; type: "servers"; servers: McpServer[] }
  | { channel: "mcp"; type: "discovering"; serverId: string | null; endpoint: string }
  | { channel: "mcp"; type: "error"; message: string; serverId?: string }
  | { channel: "mcp"; type: "notice"; message: string; serverId?: string };

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
  | EvalMessage
  | McpMessage;

// --- client → server commands ---

export type ClientCommand =
  | { cmd: "run"; input?: string; provider?: string; model?: string; agentId?: string }
  | { cmd: "loadRun"; runId: string }
  | { cmd: "generate"; prompt: string; connectors?: string[]; name?: string; planId?: string }
  | { cmd: "planAgent"; prompt: string; connectors?: string[]; name?: string; revisePlanId?: string }
  | { cmd: "discardPlan"; planId: string }
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
  | { cmd: "deleteExample"; datasetId: string; exampleId: string }
  | { cmd: "promoteTestInput"; agentId: string; agentName?: string; input: string; expected?: string | null }
  | { cmd: "startEval"; datasetId: string; agentId: string; targets: EvalTarget[]; budgetUsd?: number | null }
  | { cmd: "cancelEval"; evalId: string }
  | { cmd: "loadEvalResults"; evalId: string }
  | { cmd: "listEvals"; datasetId?: string }
  | { cmd: "estimateEval"; datasetId: string; agentId: string; targets: EvalTarget[] }
  | { cmd: "loadRubric"; datasetId: string }
  | { cmd: "saveRubric"; datasetId: string; name?: string; criteria: RubricCriterion[] }
  // MCP: server registry. Same discipline as the eval commands — every mutation comes back
  // as a full snapshot on the "mcp" channel.
  | { cmd: "listMcpServers" }
  // `token` is the only field in this union that carries a secret. It travels one way, over
  // the loopback socket, and is never sent back: a server reports `configured`, not its key.
  | { cmd: "addMcpServer"; endpoint: string; label?: string; token?: string }
  | { cmd: "removeMcpServer"; serverId: string }
  | { cmd: "rediscoverMcpServer"; serverId: string }
  | { cmd: "setMcpServerAuth"; serverId: string; token: string | null }
  | { cmd: "setMcpToolImpact"; serverId: string; toolName: string; impact: McpImpact | null };

// Unified composer "explain" subject — what the question is about, built from already-in-memory
// context (a trace step, a graph node, or the agent generally). No new data is fetched.
export type ExplainSubject =
  | { kind: "step"; step: { name: string; type: string; seq: number; error: string | null; input: unknown; output: unknown } }
  | { kind: "node"; nodeId: string }
  | { kind: "agent" };
