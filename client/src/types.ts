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
  /**
   * `"server/tool"` refs this agent is scoped to, from its manifest.
   *
   * The only way the client knows a trace step came from MCP: the frozen Step schema has no
   * provenance field and must not grow one, so the badge is derived by joining this against
   * the step's tool name.
   */
  mcp_tools?: string[];
  required_env: string[];
  default_provider: string;
  created_at: string | null;
  hand_written: boolean;
  runnable: boolean;
  edit_count?: number; // applied edits available to undo (fix loop)
  /**
   * This agent's current deployment, or null if it has never been deployed.
   *
   * Carried on the agent list rather than fetched per row so the sidebar's Deployed filter is
   * answerable without N round trips. `url` is null until the host has one — never a guess.
   */
  deployment?: { id: string; status: DeployStatus; url: string | null } | null;
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
/**
 * Where a planned tool comes from — three genuinely different provenances, rendered
 * differently because the difference is what a reader needs (see server/src/planProtocol.ts).
 *
 *   connector  an audited template, copied in byte-for-byte
 *   bespoke    about to be written by a model, for this agent
 *   mcp        a call into a third-party server nobody here has reviewed
 */
export type ToolOrigin = "connector" | "bespoke" | "mcp";

export interface PlannedTool {
  name: string;
  origin: ToolOrigin;
  /** MCP server id, when origin is "mcp" and the plan named one. */
  mcpServerId?: string;
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

/**
 * Which build session an event on the gen / edit / reply channels belongs to (§3.1).
 *
 * ON THE ENVELOPE, ONCE, rather than on each member: it answers the same question for all of them,
 * and the server attaches it in one place for the same reason. Absent on a refusal answered to
 * whoever asked, which belongs to no session — so `undefined` here means "file this nowhere", not
 * "file it in whatever is open".
 *
 * It is what makes a conversation shared rather than local: the tab that sent the command knows
 * which thread it was in, and every OTHER tab in the workspace only learns it from here.
 */
export type InThread = { threadId?: string };

export type GenMessage = InThread &
  ( | { channel: "gen"; type: "started"; prompt: string }
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
      /** The MCP tools this plan was written against, as `"server/tool"` refs. */
      mcpTools?: string[];
      name?: string;
      plan: AgentPlan;
      warnings: string[];
      usage: GenUsage;
      revision: number;
    }
  | { channel: "gen"; type: "plan_discarded"; planId: string }
  | { channel: "gen"; type: "plan_error"; message: string });

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

export type EditMessage = InThread &
  ( | { channel: "edit"; type: "started"; agentId: string; instruction: string }
  | { channel: "edit"; type: "file_start"; path: string }
  | { channel: "edit"; type: "file_delta"; path: string; text: string }
  | { channel: "edit"; type: "file_end"; path: string }
  | { channel: "edit"; type: "proposal"; proposalId: string; agentId: string; instruction: string; summary: string; files: FileDiff[]; usage: GenUsage }
  | { channel: "edit"; type: "applied"; proposalId: string; agentId: string; version: number; summary: string }
  | { channel: "edit"; type: "undone"; agentId: string; version: number; summary: string }
  | { channel: "edit"; type: "discarded"; proposalId: string; agentId: string }
  | { channel: "edit"; type: "error"; message: string; problems?: string[]; agentId?: string; proposalId?: string });

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
  /** False when this cell's cost is a FLOOR — some step had tokens and no price. */
  costComplete: boolean;
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
  // `spentDeltaUsd` is §4.3.3's live figure for an eval — the only cost this channel carries, and the
  // only route a running eval's spend has to a client, since its runs are kept off `trace`.
  | {
      channel: "eval"; type: "evalProgress"; evalId: string; total: number; done: number;
      running: number; queued: number; failed: number; spentDeltaUsd: number;
    }
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

/**
 * A run has HALTED before a high-impact MCP tool's first call and is waiting for an answer.
 *
 * The only message on any channel that describes a blocked process, which is why the client
 * renders it as a modal rather than a notification.
 */
export interface McpConfirmRequest {
  runId: string;
  nonce: string;
  server: string;
  tool: string;
  /** Why the tool was classified high-impact — so the ask can be argued with, not just obeyed. */
  impactReason: string;
  /** The arguments the model produced, as JSON text. Already capped by the bridge. */
  args: string;
  /** Seconds the runner waits before denying. It never allows on timeout. */
  timeoutS: number;
  requestedAt: string;
}

export type McpConfirmVerdict = "once" | "run" | "deny";

export type McpMessage =
  | { channel: "mcp"; type: "servers"; servers: McpServer[] }
  | { channel: "mcp"; type: "discovering"; serverId: string | null; endpoint: string }
  | { channel: "mcp"; type: "error"; message: string; serverId?: string }
  | { channel: "mcp"; type: "notice"; message: string; serverId?: string }
  | ({ channel: "mcp"; type: "confirmRequest" } & McpConfirmRequest)
  | { channel: "mcp"; type: "confirmResolved"; runId: string; nonce: string; verdict: string };

// --- model providers (see server/src/providers.ts) ---
//
// Jaroku is bring-your-own-key: a provider key is the user's, it is written to runtime/.env
// through the same credential writer MCP tokens go through, and it is read from the
// environment at the moment of use. Nothing on this channel ever carries the key — the most a
// client learns is `configured: true`, meaning a NAMED VARIABLE IS SET, exactly as it does for
// an MCP server's credential.

/**
 * A provider a key can be connected for. Mirrors the server's `keyof typeof PROVIDER_ENV_KEY`.
 *
 * IT WAS TWO-VALUED WHILE THE PRODUCT SHIPPED THREE. Nothing broke — every render path keys off
 * `string` — but the client's own type system could not express a provider the server has supported
 * since Gemini landed, so `google` was invisible to every exhaustiveness check in this file. `fake`
 * is deliberately absent: it is the free dry-run path and there is no key to connect for it.
 */
export type ProviderId = "anthropic" | "openai" | "google";

/**
 * One selectable model, as the server offers it.
 *
 * FROM `runtime/pricing.json`, WHICH IS THE POINT. The client used to hold the catalogue as a
 * constant, and it had drifted four models behind the price sheet — including the newest Anthropic
 * one — so a model the product knew how to price, run and meter could not be chosen anywhere. A
 * catalogue that is the price sheet cannot drift from it.
 *
 * `label` is the PROVIDER's display name, resolved server-side: the browser used to hold two
 * hardcoded copies of that mapping and they disagreed, so one provider was "Gemini" where you picked
 * it and `google` where you configured it.
 */
export interface ProviderModel {
  id: string;
  provider: string;
  label: string;
  /** Whether running on it costs anybody anything. What identifies the dry-run path. */
  free: boolean;
}

export interface ProviderStatus {
  id: ProviderId;
  /** The NAME of the variable holding this provider's key. Never a value. */
  env_key: string;
  configured: boolean;
  /**
   * Whether Jaroku ITSELF thinks with this provider.
   *
   * Planning, generation, the fix loop, explain and the eval judge are Anthropic-only.
   * Connecting OpenAI lets an AGENT run on GPT and nothing more — reported by the server so
   * the UI can say so rather than hardcode a rule that would drift.
   */
  powers_jaroku: boolean;
}

export type ProviderMessage =
  // `ownKeyForPlatform` is a preference, not a credential: whether THIS WORKSPACE'S key pays for
  // the calls Jaroku makes on its behalf — generation, the plan gate, the fix loop, explain, the
  // judge. It rides this snapshot because it is meaningless without the list of what is connected.
  // It was missing from this type while the server was already sending it, so it was parsed off
  // the wire and thrown away.
  | {
      channel: "providers";
      type: "providers";
      providers: ProviderStatus[];
      ownKeyForPlatform: boolean;
      /** Every model a run may be started on, from the server's price sheet. See ProviderModel. */
      models: ProviderModel[];
    }
  | { channel: "providers"; type: "testResult"; provider: string; ok: boolean; message: string | null }
  | { channel: "providers"; type: "error"; message: string; provider?: string }
  | { channel: "providers"; type: "notice"; message: string; provider?: string };

// --- connections (see server/src/oauth/) ---
//
// What this workspace has authorised Jaroku to reach on its behalf. Its own channel rather than a
// field on `providers`, and the difference is real: a provider key is a credential the workspace
// HOLDS and pasted in, while a connection is a grant somebody else's system made to us — which
// can be revoked from the other end at any moment, needs a consent screen to create, and has a
// state (`reauth_required`) that no API key has.
//
// NOTHING HERE IS A CREDENTIAL. A connection reports a status, the scopes that were actually
// granted, and a label naming the account. That is the whole of what a browser is ever told, and
// it is the same promise `configured: true` makes on the providers channel.

export type ConnectionStatus = "active" | "reauth_required" | "revoked" | "disconnected";

export interface ConnectionView {
  connectorId: string;
  label: string;
  provider: string;
  status: ConnectionStatus;
  /** What was GRANTED — never what was asked for. A partial consent must read as partial. */
  scopes: string[];
  /** What connecting means, in sentences, shown BEFORE the button rather than after. */
  consent: string[];
  /** Which mailbox, which Slack. Null when the provider named nothing a person would recognise. */
  account: string | null;
  connectedAt: string | null;
  lastError: string | null;
  /** Whether this DEPLOYMENT can run the flow. False locally, which is not an error state. */
  available: boolean;
}

export type ConnectionMessage =
  | { channel: "connections"; type: "connections"; connections: ConnectionView[] }
  /** Where the browser must navigate. A socket cannot redirect, so the client does it. */
  | { channel: "connections"; type: "authorize"; connectorId: string; url: string; expiresAt: number }
  | { channel: "connections"; type: "error"; message: string; connectorId?: string }
  | { channel: "connections"; type: "notice"; message: string; connectorId?: string };

// --- billing (see server/src/billing/) ---
//
// What this workspace has spent, and against which limits. Every figure here is computed by the
// server's own budget gate — the same one that refuses a run — rather than assembled from parts
// the client could recombine differently. A page that disagreed with a refusal would be worse
// than no page.
//
// `costKnown` travels with EVERY figure, at every level, and that is the point rather than
// thoroughness: `false` means something in that rollup could not be priced, so the number is a
// FLOOR. The whole cost model has been arranged since the beginning so that unknown and zero
// never collapse into each other, and a dashboard is the last place that could quietly happen.

export interface UsageBreakdown {
  usd: number;
  tokens: number;
  costKnown: boolean;
}

export interface UsageSnapshot {
  periodStart: string;
  periodEnd: string;
  plan: { id: string; label: string };
  spentUsd: number;
  costKnown: boolean;
  /** The effective ceiling — the workspace's own, else its plan's. Null means none. */
  ceilingUsd: number | null;
  headroomUsd: number | null;
  overCeiling: boolean;
  balanceUsd: number;
  reservedUsd: number;
  availableUsd: number;
  /** What the PLATFORM paid on this workspace's behalf, and the ceiling bounding it. */
  platformSpentUsd: number;
  platformCeilingUsd: number | null;
  ownKeyForPlatform: boolean;
  byAgent: (UsageBreakdown & { agentId: string | null; label: string; runs: number })[];
  byRun: (UsageBreakdown & { runId: string; label: string | null })[];
  byKind: (UsageBreakdown & { kind: string; payer: string })[];
  /**
   * What this deployment offers, so the panel that names your plan can offer another.
   *
   * FROM THE SERVER RATHER THAN A CONSTANT HERE. The `plans` table is where deployment-specific
   * configuration lives — `purchasable` and the price id are its columns — and the limits beside
   * each plan come from the code that enforces them, so this list cannot advertise a ceiling the
   * budget gate would not apply.
   */
  plans: {
    id: string;
    label: string;
    /** Purchasable AND priced. A plan with no configured price cannot be bought, and says so. */
    purchasable: boolean;
    current: boolean;
    monthlyCreditsUsd: number;
    budgetCeilingUsd: number | null;
    platformKeyCeilingUsd: number | null;
    retentionDays: number;
    seats: number | null;
    deploy: boolean;
  }[];
  /**
   * Whether this deployment can take a payment at all.
   *
   * The local path has no Stripe keys and that is not an error state, so the Upgrade control is
   * absent there rather than present and refusing — the same signal the checkout route answers
   * "payments are not configured on this deployment" from.
   */
  paymentsConfigured: boolean;
}

// The abuse ladder, as the wire carries it.
//
// NOTHING HERE IS DERIVED CLIENT-SIDE, which is the reason `explain` and `refusesWork` are fields
// rather than functions: both are computed by the same server code a REFUSAL is built from, so the
// strip explaining the state and the refusal a user just hit cannot drift apart. A client that
// re-derived either would eventually disagree with the thing that stopped their run.
export type EnforcementLevelView =
  | "none" | "watch" | "soft_limit" | "verify" | "suspended" | "blocked";

export interface EnforcementStateView {
  level: EnforcementLevelView;
  reason: string;
  appliedAt: string | null;
  expiresAt: string | null;
  /** Whether a person applied it. The two rungs that stop work outright always have one. */
  byHuman: boolean;
  /** The rung's own sentence, as a refusal carries it. Null when nothing is in force. */
  explain: string | null;
  refusesWork: boolean;
}

export interface EnforcementRowView {
  id: number;
  level: EnforcementLevelView;
  reason: string;
  applied_at: string;
  expires_at: string | null;
  lifted_at: string | null;
  lifted_reason: string | null;
  appeal_note: string | null;
  appealed_at: string | null;
}

/** One row of the audit log, as the wire carries it. Mirrors `IdentityRepository.AuditEntry`. */
export interface AuditEntryView {
  id: number;
  workspace_id: string | null;
  actor_user_id: string | null;
  action: string;
  target_type: string | null;
  target_id: string | null;
  metadata: Record<string, unknown>;
  ip: string | null;
  created_at: string;
}

export type BillingMessage =
  | { channel: "billing"; type: "usage"; usage: UsageSnapshot }
  | { channel: "billing"; type: "error"; message: string };

// --- deploy (see server/src/deployStore.ts, deployManager.ts) ---
//
// Jaroku orchestrates a deploy; it hosts nothing. The agent goes to the USER's own Railway
// account, on the user's own credentials, and this channel carries the state of that.
//
// One rule everywhere below: names travel, values do not. `env_keys` on a deployment and
// `name` on a secret are variable NAMES; `configured` says one is set. The single exception
// is `serveToken`, documented where it appears — it is the only credential that ever travels
// server to browser in this product, and it does so once because Jaroku keeps no copy.

export type DeployStatus =
  | "queued" | "packaging" | "uploading" | "building" | "deploying"
  | "live" | "failed" | "cancelled" | "interrupted" | "superseded" | "removed";

/** Statuses a deploy can still leave under its own power. Mirror of deployStore.IN_FLIGHT. */
export const DEPLOY_IN_FLIGHT: ReadonlySet<DeployStatus> = new Set<DeployStatus>([
  "queued", "packaging", "uploading", "building", "deploying",
]);

export function isDeployInFlight(status: DeployStatus): boolean {
  return DEPLOY_IN_FLIGHT.has(status);
}

export interface Deployment {
  id: string;
  agent_id: string;
  target: string;
  status: DeployStatus;
  url: string | null;
  provider: string;
  model: string;
  /** NAMES of the variables handed to the host. Never values. */
  env_keys: string[];
  error: string | null;
  /**
   * The agent version this deploy built from — migration 041.
   *
   * NULL for a row written before it, and never backfilled: a guess here would be a confident lie
   * about somebody's production. §B.8.2's canvas draws no ▼ rather than one under a guess.
   */
  version: number | null;
  created_at: string;
  updated_at: string;
  ended_at: string | null;
}

export interface DeploySecretStatus {
  /** The NAME of a variable the deployed agent needs. */
  name: string;
  /** Whether this machine has a value for it. */
  configured: boolean;
  reason: string;
  /** Whether a deploy is refused without it. */
  required: boolean;
}

export interface DeployLogLine {
  deployment_id: string;
  seq: number;
  ts: string;
  stage: string;
  stream: string;
  /** Already scrubbed server-side of every secret the deploy handled. */
  text: string;
}

export type DeployMessage =
  | { channel: "deploy"; type: "deployments"; deployments: Deployment[]; railwayConfigured: boolean; cliVersion?: string | null }
  | { channel: "deploy"; type: "plan"; agentId: string; secrets: DeploySecretStatus[]; problems: string[]; warnings: string[]; redeploy: boolean }
  | { channel: "deploy"; type: "started"; deploymentId: string; agentId: string }
  | { channel: "deploy"; type: "stage"; deploymentId: string; stage: string; status: DeployStatus }
  | { channel: "deploy"; type: "log"; deploymentId: string; seq: number; stage: string; stream: string; text: string }
  | { channel: "deploy"; type: "logs"; deploymentId: string; lines: DeployLogLine[] }
  | { channel: "deploy"; type: "finished"; deploymentId: string; status: DeployStatus; url: string | null; error: string | null }
  /**
   * The bearer token for a newly live endpoint — the ONE credential that travels server to
   * browser in this product. Jaroku generated it, set it on Railway, and kept no copy, so this
   * message is the only chance to see it. Never persisted anywhere; show it, do not store it.
   */
  | { channel: "deploy"; type: "serveToken"; deploymentId: string; url: string; token: string }
  | { channel: "deploy"; type: "testResult"; ok: boolean; message: string | null }
  | { channel: "deploy"; type: "error"; message: string; deploymentId?: string }
  | { channel: "deploy"; type: "notice"; message: string; deploymentId?: string };

// --- server → client channel messages (see server/src/wsRelay.ts) ---

// The session channel: the only one about the CONNECTION rather than the work. Every message
// on it means this connection is over or about to be — see server/src/wsRelay.ts SessionEvent.
export type SessionMessage =
  | { channel: "session"; type: "expiring"; expiresAt: number }
  | { channel: "session"; type: "expired" }
  | { channel: "session"; type: "revoked"; message: string }
  | { channel: "session"; type: "workspace_changed"; message: string }
  | { channel: "session"; type: "role_changed"; role: string };

// --- threads (see server/src/wsRelay.ts ThreadEvent, and the Threads spec §3–§4) ---
//
// A THREAD IS NOT A CHAT. It is a build session with side effects: it spent money, it may have left
// an unapplied diff, it may have deployed something. So what the list renders is not "what was last
// said" but what the session LEFT — which is why every derived field below arrives from the server
// rather than being computed here. §3.3's status is a function of pending diffs, in-flight runs,
// failed steps and awaiting plans, none of which a browser can see.

/** §3.3's five, derived server-side and never sent back. */
export type ThreadStatus = "needs_you" | "running" | "errored" | "idle" | "archived";

export interface ThreadView {
  id: string;
  /** Null before an agent exists (§3.1's planning stage) and null again once one is deleted. */
  agent_id: string | null;
  /**
   * What the agent chip renders: a live name, a deleted one's snapshot, or null for `(no agent)`.
   *
   * The pair with `agent_deleted` is what tells §4.3's three cases apart — a name with no id is
   * `name (deleted)`, dimmed, and null with no id is a thread that never had one.
   */
  agent_name: string | null;
  agent_deleted: boolean;
  title: string;
  /** True once somebody renamed it. Auto-titling never overwrites one afterwards (§5). */
  title_is_custom: boolean;
  /** The user id, for the Team-only author column. In Personal the column does not exist. */
  created_by: string | null;
  created_at: string;
  last_activity_at: string;
  archived_at: string | null;
  status: ThreadStatus;
  /** §4.3's state fragment: one decision-relevant fact, or null when there is nothing to say. */
  fragment: string | null;
  /**
   * Cumulative spend, or null when nothing has cost anything yet.
   *
   * THREE STATES, NOT TWO. Null is "nothing spent"; a figure with `cost_known: false` is a floor and
   * renders as `$0.04+`; a figure with it true is the answer. A zero would claim the last about the
   * first, which is the confidently-wrong number §9 forbids everywhere.
   */
  cost_usd: number | null;
  cost_known: boolean;
  /** The last thing the USER said. Their own intent is what makes a session recognisable (§4.3). */
  preview: string | null;
  /**
   * The runs of this thread that are in flight (§4.3.3).
   *
   * Not a message type of its own: a running thread's cost increments from the per-step cost events the
   * trace and eval channels already carry, and these ids are how one of those is attributed to a
   * session. Empty for anything not running — a finished run's cost is in `cost_usd`.
   */
  live_run_ids: string[];
  /**
   * The evals of this thread that are in flight, by EVAL id (§4.3.3).
   *
   * The same job `live_run_ids` does, for the channel an eval's cost arrives on. A step on `trace`
   * names its run; a progress event on `eval` names its eval — and eval runs are deliberately kept
   * off `trace`, so the run ids above never receive a step and cannot attribute one.
   */
  live_eval_ids: string[];
  /**
   * How far a running eval has got. The denominator §4.3.3's projection needs.
   *
   * The NUMBERS rather than the `eval 34/120` string, so nothing here parses a display string back out
   * to do arithmetic on. Null when there is no denominator, which is the honest answer for a generation
   * or an interactive run: §4.3.3 says show no projection at all rather than a guess.
   */
  eval_progress: { done: number; total: number } | null;
  /**
   * How many threads on this agent are blocked or running right now, including this one (§4.3.4).
   *
   * `2` means this session and one other are live against the same agent's files — which in a Team
   * workspace, where any member may act on any thread, is a guaranteed occurrence rather than a
   * hypothetical. Counting `needs_you` and `running` only: an idle thread on the same agent is history.
   */
  agent_active: number;
  /**
   * True when this session is a large share of what the workspace has spent this period (§4.3.6).
   *
   * A FLAG, NOT A PERCENTAGE. A bare figure says nothing about whether it is typical, and "worth a
   * second look" is the whole of what a triage row needs — the number itself belongs in Activity, and
   * putting it here would be a second metric competing for space in an already-dense line.
   */
  cost_share_high: boolean;
}

/** §4.4's five chips. Counted once on the server and rendered twice — see the nav badge, §2.1. */
export interface ThreadCounts {
  all: number;
  /** The Needs You SECTION: `needs_you` plus `errored`, which is what §4.2 puts in it. */
  needs_you: number;
  running: number;
  recent: number;
  archived: number;
}

/**
 * One row of what a thread owns, as `loadThread` answers with (§4.5).
 *
 * The user's own turns plus a stub per run, plan, generation, proposal and eval. Jaroku's replies
 * are deliberately not stored server-side, so a reopened thread shows what somebody said and what
 * it caused — never a transcript of the answers.
 */
export interface ThreadItemView {
  kind: "run" | "eval" | "plan" | "generation" | "proposal" | "message";
  ref_id: string | null;
  role: "user" | null;
  body: string | null;
  created_at: string;
}

/** Threads. Full snapshots, plus the single row `loadThread` answers the asking client with. */
export type ThreadMessage =
  | { channel: "threads"; type: "threads"; threads: ThreadView[]; counts: ThreadCounts }
  // `reason` says which of the two things that answer with one row this is: `loaded` answers a
  // `loadThread` the client sent because it was already opening that thread, and `created` is a row
  // `createThread` just made that nothing has opened yet — see the socket's handler.
  | {
      channel: "threads"; type: "thread"; thread: ThreadView; items: ThreadItemView[];
      reason: "loaded" | "created";
    }
  | { channel: "threads"; type: "error"; message: string; threadId?: string }
  | { channel: "threads"; type: "notice"; message: string; threadId?: string };

/** Membership. Full snapshots, except `inviteLink`, which carries a credential once. */
export type MemberMessage =
  | { channel: "members"; type: "members"; members: unknown[]; invites: unknown[] }
  | { channel: "members"; type: "inviteLink"; email: string; role: string; token: string; expiresAt: string }
  | { channel: "members"; type: "error"; message: string }
  | { channel: "members"; type: "notice"; message: string };


// --- GitHub (see server/src/wsRelay.ts GithubEvent, and the design spec's §0–§8) ---
//
// NOTHING ON THIS CHANNEL IS A CREDENTIAL, and the shapes below are where that is enforced on this
// side of the wire: `connected` is a boolean, `accountLogin` is a name GitHub prints on a public
// profile, and there is no field a token would fit in. Linking an account is an HTTP request in
// the secrets group, because elevation rides on a header a WebSocket cannot carry.

/** The six states §3.5's verdict line renders, each with exactly one primary action. */
export type SyncState = "unlinked" | "in_sync" | "ahead" | "behind" | "diverged" | "broken" | "syncing";

/** Why a link is broken, when it is. Three causes, three different next steps. */
export type BrokenReason = "repo_missing" | "branch_missing" | "token_revoked";

export interface GithubLinkRow {
  id: string;
  agent_id: string;
  repo_full_name: string;
  branch: string;
  subdirectory: string | null;
  include_artifacts: boolean;
  last_pushed_version_id: string | null;
  last_pushed_sha: string | null;
  last_known_remote_sha: string | null;
  last_synced_at: string | null;
}

/** A Jaroku version, as §2.3's rows render it. A projection — never the manifest. */
export interface GithubVersionRow {
  id: string;
  version: number;
  summary: string;
  createdAt: string;
  files: number;
  additions: number;
  deletions: number;
  /** The commit it became, or null while it is still local only. */
  sha: string | null;
  shaUrl: string | null;
}

/** A commit no version accounts for — §3.8's hollow dots. */
export interface GithubCommitRow {
  sha: string;
  message: string;
  author: string | null;
  at: string;
  url: string;
}

export interface GithubBranchRow {
  name: string;
  sha: string;
  isDefault: boolean;
  current: boolean;
}

/**
 * One file the unpushed versions touched — §3.3's Changes region.
 *
 * Derived server-side from `file_stats` across the unpushed run rather than from a working tree,
 * because Jaroku has none: an agent's files are immutable per version, so the "uncommitted change"
 * a git client would show is the set of paths the versions since the last push touched.
 */
export interface GithubChangeRow {
  path: string;
  status: "added" | "modified";
  additions: number;
  deletions: number;
  /** §3.3's PROTECTED group. Listed, visible, and never stageable. */
  locked: boolean;
}

/**
 * One hunk of one file — §B.4.1's checkbox row.
 *
 * `index` IS THE IDENTITY AND THE POSITION AT ONCE, which is safe only because the server sorts
 * both the file list and each file's hunks deterministically: two reads of an unchanged pair
 * produce the same list, so a checkbox a person ticked does not become a different hunk between
 * renders. Nothing here is derived in the browser — the hunks, their figures and their headers all
 * arrive computed, for the same reason the verdict does.
 */
export interface GithubHunkRow {
  index: number;
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
  lines: string[];
  additions: number;
  deletions: number;
  /** `@@ -12,6 +12,9 @@ def get_weather` — range plus the definition the hunk opens inside. */
  header: string;
}

/** One changed file, with the hunks a checkbox column renders. */
export interface GithubStagedFile {
  path: string;
  status: "added" | "modified" | "deleted";
  additions: number;
  deletions: number;
  /** §3.3's PROTECTED group. Listed, visible, and never stageable — never merely unchecked. */
  locked: boolean;
  /** Empty for a deletion: a file is in the tree or it is not, so there is no half of one. */
  hunks: GithubHunkRow[];
}

/** One unpushed version, as §B.4.4's draggable row renders it. */
export interface GithubStackRow {
  versionId: string;
  version: number;
  summary: string;
  /** True on exactly one row — the single most recent unpushed version. §B.4.3's whole bound. */
  amendable: boolean;
}

/** What the panel staged, sent with a push. Absent means the ordinary everything-push. */
export interface GithubHunkSelection {
  path: string;
  hunks: number[];
}

/** One step of a restacked history. More than one version id is a squash; omission is a drop. */
export interface GithubRestackStep {
  versionIds: string[];
}

export interface GithubPrRow {
  number: number;
  title: string;
  url: string;
  commits: number;
  files: number;
  additions: number;
  deletions: number;
  /** `success` / `failure` / `pending`, or null when nothing reported. Null is NOT passing. */
  checks: string | null;
}

export interface GithubEventRow {
  id: string;
  kind: string;
  outcome: string;
  version_ids: string[];
  commit_sha: string | null;
  detail: string | null;
  created_at: string;
}

export interface GithubRepoRow {
  fullName: string;
  private: boolean;
  defaultBranch: string;
  htmlUrl: string;
  /** Null is "not asked", and it is what the repository list carries — see `GithubRepo.empty`. */
  empty: boolean | null;
  pushedAt: string | null;
}

/** One agent's whole reconciliation. Assembled server-side in one pass — see githubService.ts. */
export interface GithubView {
  agentId: string;
  agentSlug: string;
  link: GithubLinkRow;
  repoUrl: string;
  state: SyncState;
  reason?: BrokenReason;
  ahead: number;
  /** null means "the remote moved and nobody has counted by how much" — not zero. */
  behind: number | null;
  badge: string | null;
  verdict: string;
  unpushed: GithubVersionRow[];
  pushed: GithubVersionRow[];
  remoteOnly: GithubCommitRow[];
  branches: GithubBranchRow[];
  /** §3.3's PROTECTED group, repository-relative. From the server, never derived here. */
  protectedPaths: string[];
  changes: GithubChangeRow[];
  /**
   * §B.4.1's hunk-level view of those same changes, beside `changes` rather than instead of it.
   *
   * The two agree in every ordinary case; where they differ, this one is what a push would write,
   * because it is computed from the snapshots themselves rather than from what the versions
   * recorded they did. Empty when the object store could not be read — never a partial list.
   */
  staging: GithubStagedFile[];
  /** §B.4.4's UNPUSHED list, newest first. The bounded set a restack may operate within. */
  stack: GithubStackRow[];
  /** Paths the remote changed since our watermark — §A.4's FROM REMOTE group. Paths, not a diff. */
  remoteChanges: string[];
  pr: GithubPrRow | null;
  /** §B.5.1's REVIEW region, oldest first. Empty when there is no open pull request. */
  review: GithubReviewRow[];
  /** §B.8.2's eval markers, newest first. Empty until §B.1 is opted into on this agent. */
  checks: GithubCheckMarker[];
  /**
   * §B.1.2's opt-in for this agent, or null when nothing has ever configured it.
   *
   * NULL IS A STATE. The absence of a row means "post nothing": linking a repository deliberately
   * does not enable an eval check, because unbounded spend on every push to a pull request is not a
   * default. So "off" and "on, against this dataset" are different sentences, and neither is
   * inferred from an empty string.
   */
  ci: { datasetId: string | null; policy: GithubProviderPolicy } | null;
  events: GithubEventRow[];
}

/**
 * §B.1.3's three positions. Never a boolean — the middle one is the interesting case.
 *
 * `dry_run_only`        a check runs the free dry-run provider. Nobody's money.
 * `collaborators_paid`  a collaborator's pull request may spend; a stranger's may not.
 * `always_paid`         any pull request may spend this workspace's provider balance.
 */
export type GithubProviderPolicy = "dry_run_only" | "collaborators_paid" | "always_paid";

/** §3.6's refusal card. Its own message type, because an error strip could carry none of it. */
export interface GithubRefusal {
  agentId: string;
  check: string;
  path: string | null;
  message: string;
  candidate: number | null;
}

/**
 * §B.4.4's refusal card: a reordered history that does not work at every step.
 *
 * ITS OWN SHAPE FOR THE SAME REASON `GithubRefusal` IS. The panel highlights the row at `position`
 * and renders `problems` under it, and an error strip carrying one sentence could do neither. The
 * position is a number rather than a phrase inside the message, so the row that lights up is the
 * one that actually failed.
 */
/**
 * One squiggle — §B.3's live diagnostics.
 *
 * ALWAYS ADVISORY. There is no `severity` value at which this stops anything, and the type says so
 * rather than leaving it to a comment: what blocks a commit is the real validator, on the real file
 * set, at the moment somebody presses Commit & Push. This surface changes when a person LEARNS
 * about a problem and never what a bad file is allowed to do.
 */
export interface Diagnostic {
  line: number;
  column?: number;
  endColumn?: number;
  /** The rule number, when the check is one of the eleven. Null for the contract checks. */
  rule: number | null;
  message: string;
  severity: "warning";
}

/**
 * §B.6.1's refusal card: a push the scanner turned away.
 *
 * NO FINDING CARRIES A MATCHED VALUE, which is what lets this shape cross a socket into a browser
 * at all. A path, a rule name, a line and a sentence — enough to open the file and know what to
 * do, and nothing a screenshot of this panel could leak.
 */
export interface GithubScanFinding {
  path: string;
  kind: string;
  rule: string;
  line: number | null;
  message: string;
}

export interface GithubScanRefusal {
  agentId: string;
  message: string;
  findings: GithubScanFinding[];
}

/**
 * One §B.2 shadow run, as the transient list renders it.
 *
 * `staged` GOES FALSE BEFORE `runId` DOES, and the two are genuinely independent: the sweep
 * reclaims the materialised project after fifteen minutes, and the TRACE is an ordinary run on
 * retention's own schedule. So a row an hour old still opens into its trace and no longer has a
 * directory — which is exactly what makes a short sweep window safe.
 */
export interface GithubShadowRun {
  id: string;
  ref: string;
  headSha: string;
  /** The ordinary run this produced. Null while staging, or if it never got a slot. */
  runId: string | null;
  status: string;
  error: string | null;
  createdAt: string;
  endedAt: string | null;
  staged: boolean;
}

/**
 * One row of §B.7's Agent diff.
 *
 * `verb` AND `object` ARRIVE SEPARATELY so the panel renders them through `ActionRow` — the same
 * narrative-line vocabulary the whole app speaks, which is what makes "tool added" here read
 * exactly like "tool added" in a plan card. A pre-composed sentence would be a second vocabulary
 * in one product.
 */
export interface GithubSemanticRow {
  kind: string;
  verb: string;
  object: string;
  detail?: string;
  /** True on exactly one kind: a widened MCP grant. §B.7.2 — nothing else may borrow the tone. */
  warn?: boolean;
}

export interface GithubSemanticDiff {
  agentId: string;
  ref: string;
  rows: GithubSemanticRow[];
  /** Set when one side did not fully parse. The rows that came back are still real. */
  partial?: string;
}

/**
 * One review comment, as §B.5.1's REVIEW region renders it.
 *
 * `path` IS PROJECT-RELATIVE, translated server-side out of GitHub's repository-relative form, so
 * this row's filename matches the file row above it in the same panel. Two lists about the same
 * file spelling it two ways would look like two files.
 */
/**
 * One eval check, as §B.8.2's ⧫ marker renders it.
 *
 * KEYED ON `headSha` because that is where the marker sits — beneath the commit it ran against. A
 * pull request is a range of commits and a check is about one, so hanging a marker off the range
 * would put it under whichever commit the canvas happened to draw last.
 */
export interface GithubCheckMarker {
  headSha: string;
  prNumber: number;
  /** 0..1, or null when nothing scored. The marker renders no percentage rather than "0%". */
  passRate: number | null;
  conclusion: string | null;
  createdAt: string;
}

export interface GithubReviewRow {
  id: string;
  author: string | null;
  path: string | null;
  line: number | null;
  body: string;
  resolution: "open" | "proposed" | "applied" | "dismissed";
  resolvedVersion: number | null;
  /** When the threaded reply reached GitHub. Null after an applied edit whose reply failed. */
  repliedAt: string | null;
  createdAt: string;
}

export interface GithubRestackRefusal {
  agentId: string;
  /** Zero-based, in the NEW order — where the user just put it, not where it used to be. */
  position: number;
  message: string;
  problems: string[];
}

/**
 * What the composer has attached from GitHub — §7.
 *
 * A REFERENCE, NOT CONTENT. The chip holds an identifier and the server resolves it when the
 * message is sent, so an attachment made five minutes ago describes the repository as it is now
 * rather than as it was when somebody clicked.
 */
export type GithubAttachment =
  | { kind: "unpushed" }
  | { kind: "commit"; sha: string }
  | { kind: "file"; path: string; ref: string }
  | { kind: "sinceSync" }
  | { kind: "pr" }
  /**
   * §B.5.1: one review comment.
   *
   * A CHIP RATHER THAN PASTED TEXT. §B.5.1 is emphatic: a review comment is CONTEXT, not an
   * instruction, and attaching it keeps it exactly as inert as every other chip §7 defines. Pasting
   * it into the composer would put a stranger's words where a user's own instruction goes.
   */
  | { kind: "reviewComment"; commentId: string };

export type GithubMessage =
  | {
      channel: "github";
      type: "state";
      agentId: string | null;
      connected: boolean;
      accountLogin: string | null;
      links: GithubLinkRow[];
      view: GithubView | null;
    }
  | { channel: "github"; type: "repos"; repos: GithubRepoRow[] }
  | { channel: "github"; type: "nameCheck"; name: string; available: boolean }
  | {
      channel: "github";
      type: "stage";
      agentId: string;
      op: "push" | "pull";
      stage: string;
      status: "active" | "done" | "error";
    }
  | { channel: "github"; type: "message"; agentId: string; message: string }
  | ({ channel: "github"; type: "refused" } & GithubRefusal)
  | ({ channel: "github"; type: "scanRefused" } & GithubScanRefusal)
  | { channel: "github"; type: "shadowRuns"; agentId: string; runs: GithubShadowRun[] }
  | ({ channel: "github"; type: "semanticDiff" } & GithubSemanticDiff)
  | ({ channel: "github"; type: "restackRefused" } & GithubRestackRefusal)
  | {
      channel: "github";
      type: "diagnostics";
      agentId: string;
      path: string;
      /** Echoed back unchanged, so a client can drop an answer about text it has replaced. */
      nonce: number;
      diagnostics: Diagnostic[];
    }
  | { channel: "github"; type: "error"; message: string; agentId?: string }
  | { channel: "github"; type: "notice"; message: string; agentId?: string };

export type ServerMessage =
  | SessionMessage
  | MemberMessage
  | ThreadMessage
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
  // A cancelled run is stored as `error` with "cancelled by user" against it — there is no
  // fifth RunStatus, because a cancellation is an ending and the store already has one for
  // "stopped before it finished". The event exists so the row stops saying `running` in the
  // frame the button was pressed, rather than whenever the next history snapshot lands.
  | { channel: "debug"; type: "cancelled"; runId: string }
  | { channel: "debug"; type: "error"; runId?: string; message: string }
  // The workspace's own record of what has been done to it. Answered to the socket that asked;
  // a channel of its own because `audit_log` is written by five subsystems and only one of them
  // is membership.
  | { channel: "audit"; type: "audit"; entries: AuditEntryView[] }
  | { channel: "audit"; type: "error"; message: string }
  // The workspace's standing on the abuse ladder. Broadcast, not answered to one socket: a rung
  // refuses every member's work, so one member's appeal is every tab's business.
  | { channel: "enforcement"; type: "enforcement"; state: EnforcementStateView; history: EnforcementRowView[] }
  | { channel: "enforcement"; type: "notice"; message: string }
  | { channel: "enforcement"; type: "error"; message: string }
  | (InThread & { channel: "reply"; type: "started"; agentId: string; question: string })
  | (InThread & { channel: "reply"; type: "delta"; agentId: string; text: string })
  | (InThread & { channel: "reply"; type: "done"; agentId: string })
  | (InThread & { channel: "reply"; type: "error"; agentId: string; message: string })
  | GenMessage
  | BillingMessage
  | EditMessage
  | EvalMessage
  | McpMessage
  | ProviderMessage
  | ConnectionMessage
  | DeployMessage
  | GithubMessage;

// --- client → server commands ---

export type ClientCommand =
  // Membership. `acceptInvite` is deliberately absent: the accepter is not a member yet, so
  // they have no socket scoped to the workspace they are joining — it is POST /v1/invites/accept.
  // Threads (§7.1). The two reads are answered to this client alone; the four mutations come back
  // as a full snapshot to the whole workspace, so nothing here ever merges a partial update.
  | { cmd: "listThreads" }
  | { cmd: "loadThread"; threadId: string }
  | { cmd: "createThread"; agentId?: string | null; title?: string }
  | { cmd: "renameThread"; threadId: string; title: string }
  | { cmd: "archiveThread"; threadId: string }
  | { cmd: "restoreThread"; threadId: string }
  | { cmd: "listMembers" }
  /**
   * The workspace's audit trail, newest first.
   *
   * `workspace:manage` — the owner's — because of what the rows contain rather than because reading
   * is privileged: who revealed which credential, who overrode a push refusal, who removed whom.
   * Answered to this socket alone; nothing about a read is anybody else's business.
   */
  | { cmd: "listAudit"; limit?: number }
  /**
   * Which rung of the abuse ladder this workspace is under, and its answer to it.
   *
   * A MEMBER's, both of them: the rung is what refused their work, and the repository's own doc is
   * explicit that an appeal which has to go through the party that applied the enforcement is not
   * an appeal. It records a note and changes nothing — a person reviews it.
   */
  | { cmd: "loadEnforcement" }
  | { cmd: "appealEnforcement"; note: string }
  | { cmd: "inviteMember"; email: string; role: string }
  | { cmd: "revokeInvite"; inviteId: string }
  | { cmd: "setMemberRole"; userId: string; role: string }
  | { cmd: "removeMember"; userId: string }
  // `threadId` on the five commands that START work: the session it belongs to. Optional on every
  // one of them — a client that does not name a thread gets the agent's most recently active one,
  // which is the continuity the backfill established.
  | { cmd: "run"; input?: string; provider?: string; model?: string; agentId?: string; threadId?: string }
  | { cmd: "loadRun"; runId: string }
  // `mcpTools` is per-TOOL (`"server/tool"` refs), never per-server: a connected server's
  // whole catalogue is never handed to an agent just because the server is connected.
  | { cmd: "generate"; prompt: string; connectors?: string[]; mcpTools?: string[]; name?: string; planId?: string; threadId?: string }
  | { cmd: "planAgent"; prompt: string; connectors?: string[]; mcpTools?: string[]; name?: string; revisePlanId?: string; threadId?: string }
  | { cmd: "discardPlan"; planId: string }
  | { cmd: "listAgents" }
  | { cmd: "edit"; agentId: string; instruction: string; threadId?: string }
  | { cmd: "applyEdit"; proposalId: string }
  | { cmd: "undoEdit"; agentId: string }
  | { cmd: "discardEdit"; proposalId: string }
  | { cmd: "loadAgentFiles"; agentId: string }
  | { cmd: "loadAgentGraph"; agentId: string }
  | { cmd: "pauseRun"; runId: string }
  | { cmd: "resumeRun"; runId: string }
  // Stop, and there is nothing to resume from afterwards — which is why it is a third command
  // rather than a flag on `pauseRun`. The server's own refusals ("stop it before resuming this
  // one", "stop it before branching") are instructions to send this, so a client that could not
  // send it left the user reading advice they had no way to take.
  | { cmd: "cancelRun"; runId: string }
  | { cmd: "branchRun"; fromRunId: string; atSeq: number; editNode?: string; editedState?: Record<string, unknown> }
  | { cmd: "explain"; agentId: string; question: string; subject: ExplainSubject; github?: GithubAttachment[]; threadId?: string }
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
  | { cmd: "startEval"; datasetId: string; agentId: string; targets: EvalTarget[]; budgetUsd?: number | null; threadId?: string }
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
  | { cmd: "setMcpToolImpact"; serverId: string; toolName: string; impact: McpImpact | null }
  | { cmd: "resolveMcpConfirm"; runId: string; nonce: string; verdict: McpConfirmVerdict }
  // Model providers. NO COMMAND HERE CARRIES A KEY ANY MORE. `setProviderKey` and
  // `testProviderKey` did, and they were the way around the Secrets passcode gate — elevation
  // travels on a request header, which a WebSocket cannot carry, so neither could ever be gated.
  // Both moved to the secrets routes; what is left asks which names are set.
  | { cmd: "listProviders" }
  // Carries no credential: both keys are already stored, and this decides which of them pays for
  // the calls Jaroku makes on the workspace's behalf. Which is why it survived the removal of the
  // two commands beside it.
  | { cmd: "setOwnKeyForPlatform"; on: boolean }
  | { cmd: "loadUsage" }
  /**
   * The workspace's OWN spend ceiling — not its plan's.
   *
   * Three meanings, which is why `usd` is nullable: `null` uses the plan's number, `0` means start
   * nothing, and a positive number is a limit of its own. A control that could not send `null`
   * would make setting a ceiling a one-way door.
   */
  | { cmd: "setSpendCeiling"; usd: number | null }
  // Connections. THE ONE SET IN THIS UNION THAT CARRIES NO SECRET IN EITHER DIRECTION: a
  // credential for a connected account is minted by the provider and collected at the callback,
  // so the browser never holds one and never sends one. `returnTo` is a PATH — the server
  // discards anything that could be absolute rather than cleaning it, because a callback that
  // redirects wherever it is told is a phishing primitive on our own domain.
  | { cmd: "listConnections" }
  | { cmd: "connectConnector"; connectorId: string; returnTo?: string }
  | { cmd: "disconnectConnector"; connectorId: string }
  // Deploy. `envKeys` are NAMES the user ticked — the server reads the values from its own
  // environment. `token` is the third and last field in this union carrying a secret, and it
  // takes the identical path: one way, into runtime/.env, never echoed back.
  | { cmd: "listDeployments" }
  | { cmd: "planDeploy"; agentId: string; provider: string; model: string }
  | {
      cmd: "deploy";
      agentId: string;
      provider: string;
      model: string;
      envKeys: string[];
      allowMissing?: boolean;
      publicEndpoint?: boolean;
    }
  | { cmd: "cancelDeploy"; deploymentId: string }
  | { cmd: "forgetDeployment"; deploymentId: string }
  | { cmd: "loadDeployLogs"; deploymentId: string; sinceSeq?: number }
  | { cmd: "setRailwayToken"; token: string | null }
  | { cmd: "testRailwayToken"; token: string }
  // GitHub. Twelve commands about REPOSITORIES and not one about a token — connecting an account
  // is POST /v1/github/connect, in the secrets group, for the same reason `setProviderKey` stopped
  // being a command here: a browser cannot put an elevation header on a WebSocket.
  | { cmd: "listGithub"; agentId?: string }
  | { cmd: "listGithubRepos"; query?: string }
  | { cmd: "checkGithubRepo"; name: string }
  | {
      cmd: "linkGithub";
      agentId: string;
      repoFullName?: string;
      createName?: string;
      createPrivate?: boolean;
      branch?: string;
      subdirectory?: string | null;
      includeArtifacts?: boolean;
    }
  | { cmd: "unlinkGithub"; agentId: string }
  // §A.1's Fetch and the panel's own refresh are ONE command. Both do the identical read; the
  // flag only decides whether it is worth an audit row.
  | { cmd: "refreshGithub"; agentId: string; explicit?: boolean }
  | {
      cmd: "pushGithub";
      agentId: string;
      squash?: boolean;
      force?: boolean;
      confirmSlug?: string;
      /** §B.4.1's hand-staged subset. Absent is the ordinary push; empty is refused as a no-op. */
      stage?: GithubHunkSelection[];
      /** §B.4.4's restacked order. Carried with the push and never stored — see §B.9. */
      steps?: GithubRestackStep[];
      /** §3.4's box, for a staged subset with no version instruction to borrow. */
      message?: string;
      /** §B.6.1's "Ignore & push anyway", from under the kebab. Recorded, never silent. */
      ignoreSecrets?: boolean;
    }
  | { cmd: "pullGithub"; agentId: string; force?: boolean; confirmSlug?: string }
  | { cmd: "switchGithubBranch"; agentId: string; branch: string; onUnpushed?: "push" | "keep" | "cancel" }
  | { cmd: "createGithubBranch"; agentId: string; branch: string }
  | { cmd: "openGithubPr"; agentId: string }
  | { cmd: "commitGithub"; agentId: string; message: string; push?: boolean; ignoreSecrets?: boolean }
  // §3.4's ✨ generate. Its own command because it is the one thing in this family that costs
  // money — the default message needs no model call at all.
  | { cmd: "generateGithubMessage"; agentId: string }
  /**
   * §B.1.2's opt-in: which dataset a pull request runs, and whose money it may spend.
   *
   * BOTH FIELDS OPTIONAL, because "set this to null" and "leave this alone" are different
   * instructions: clearing the dataset turns checks off and must keep the policy somebody chose,
   * and choosing a policy must not clear the dataset.
   */
  | {
      cmd: "setAgentCiConfig";
      agentId: string;
      datasetId?: string | null;
      policy?: GithubProviderPolicy;
    }
  /**
   * §B.3: analyse an unsaved buffer.
   *
   * THE SOURCE TRAVELS WITH THE COMMAND, unlike every other command here, because there is nothing
   * to look up — the buffer has not been saved. That is the feature.
   */
  | { cmd: "diagnoseFile"; agentId: string; path: string; source: string; nonce?: number }
  /**
   * §B.2's `[ Run ◆ ]`: run a ref once, without switching to it.
   *
   * Its own command rather than a flag on `switchGithubBranch`, because §3.2 treats switching as
   * heavy — it re-materialises the working state — and this deliberately does not. One name for
   * each, rather than the heavy action and the disposable one a boolean apart.
   */
  | { cmd: "shadowRunGithub"; agentId: string; ref: string; input?: string; provider?: string; model?: string }
  | { cmd: "listShadowRuns"; agentId: string }
  /**
   * §B.7's Agent diff. On demand rather than on the snapshot: it costs a tree read from GitHub and
   * a parse of both sides, and a toggle is a click where a snapshot is a render.
   */
  | { cmd: "semanticDiffGithub"; agentId: string; ref?: string }
  /**
   * §B.5.3: record what happened to a review comment, and optionally reply in its thread.
   *
   * SEPARATE FROM APPLYING THE EDIT. The apply is the ordinary one, on the ordinary diff card,
   * through the ordinary validator — an apply that also replied would be a write path a review
   * comment reached, which is what §B's governing constraint forbids.
   */
  | {
      cmd: "resolveReviewComment";
      agentId: string;
      commentId: string;
      resolution: "applied" | "dismissed";
      version?: number;
      reply?: string;
    };

// Unified composer "explain" subject — what the question is about, built from already-in-memory
// context (a trace step, a graph node, or the agent generally). No new data is fetched.
export type ExplainSubject =
  | { kind: "step"; step: { name: string; type: string; seq: number; error: string | null; input: unknown; output: unknown } }
  | { kind: "node"; nodeId: string }
  | { kind: "agent" };
