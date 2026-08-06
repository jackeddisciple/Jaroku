// WebSocket relay (doc §8): pushes trace events to browser clients in real time, and
// serves the static debug client over the same HTTP port. On connect, a client receives the
// run history snapshot; thereafter it receives live events as they arrive.

import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { readFile } from "node:fs/promises";
import { WebSocketServer, WebSocket } from "ws";
import type { TraceStore } from "./store.ts";
import type { TraceEvent } from "./types.ts";

export type RunCommand = {
  cmd: "run";
  input?: string;
  provider?: string;
  model?: string;
  agentId?: string;
};
export type LoadRunCommand = { cmd: "loadRun"; runId: string };
export type GenerateCommand = {
  cmd: "generate";
  prompt: string;
  connectors?: string[];
  /**
   * The MCP tools this agent is scoped to, as `"server/tool"` refs.
   *
   * Per-TOOL rather than per-server, and that is the least-privilege rule in one field: a
   * connected server's whole catalogue is never handed to an agent because the server
   * happens to be connected. Only what was selected here can reach the manifest.
   */
  mcpTools?: string[];
  name?: string;
  /** A plan the user confirmed. The server builds what that plan describes, not what this
   *  command's other fields say — see planner.take(). */
  planId?: string;
};
// The pre-generation gate: describe the agent, see a plan, confirm. `revisePlanId` turns
// `prompt` into feedback on the plan with that id rather than a fresh brief.
export type PlanAgentCommand = {
  cmd: "planAgent";
  prompt: string;
  connectors?: string[];
  /** Scoped MCP tools, as `"server/tool"` refs. See GenerateCommand.mcpTools. */
  mcpTools?: string[];
  name?: string;
  revisePlanId?: string;
};
export type DiscardPlanCommand = { cmd: "discardPlan"; planId: string };
export type ListAgentsCommand = { cmd: "listAgents" };
// The fix loop (doc §8 Week 4): every mutation is proposal -> explicit apply/undo.
export type EditCommand = { cmd: "edit"; agentId: string; instruction: string };
export type ApplyEditCommand = { cmd: "applyEdit"; proposalId: string };
export type UndoEditCommand = { cmd: "undoEdit"; agentId: string };
export type DiscardEditCommand = { cmd: "discardEdit"; proposalId: string };
export type LoadAgentFilesCommand = { cmd: "loadAgentFiles"; agentId: string };
// Graph View (Week 5): request the agent's static LangGraph topology. Answered locally by
// spawning the isolated `jaroku_runner.graph` entrypoint — never touches the trace stream.
export type LoadAgentGraphCommand = { cmd: "loadAgentGraph"; agentId: string };
// Debug depth (Week 6): pause a running run at its next node boundary, or resume a paused run
// from its durable checkpoint. Both are forwarded to the app (control-plane, never touch the
// frozen trace stream).
export type PauseRunCommand = { cmd: "pauseRun"; runId: string };
export type ResumeRunCommand = { cmd: "resumeRun"; runId: string };
// Fork a new run from `fromRunId` at step `atSeq` (its node boundary), optionally with a
// validated domain-field edit applied to the state before continuing. Original run is untouched.
export type BranchRunCommand = {
  cmd: "branchRun";
  fromRunId: string;
  atSeq: number;
  editNode?: string;
  editedState?: Record<string, unknown>;
};
// Eval Engine (Week 7): dataset CRUD. These are control-plane commands like pause/resume —
// they mutate the eval tables and never touch the frozen trace stream. They're forwarded
// to the app rather than answered here so the relay stays a transport and doesn't grow a
// second store dependency; the app answers by broadcasting on the "eval" channel.
export type CreateDatasetCommand = { cmd: "createDataset"; agentId: string; name: string };
export type RenameDatasetCommand = { cmd: "renameDataset"; datasetId: string; name: string };
export type DeleteDatasetCommand = { cmd: "deleteDataset"; datasetId: string; agentId: string };
export type ListDatasetsCommand = { cmd: "listDatasets"; agentId?: string };
export type LoadDatasetCommand = { cmd: "loadDataset"; datasetId: string };
export type AddExampleCommand = {
  cmd: "addExample";
  datasetId: string;
  input: string;
  expected?: string | null;
  notes?: string | null;
};
export type UpdateExampleCommand = {
  cmd: "updateExample";
  datasetId: string;
  exampleId: string;
  input?: string;
  expected?: string | null;
  notes?: string | null;
};
export type DeleteExampleCommand = { cmd: "deleteExample"; datasetId: string; exampleId: string };
// One-click "promote this test input into the eval dataset" (doc §4.7.6). It resolves the
// target dataset server-side (agent's most recent, or a new default) so promotion is a
// single round trip and lands in the SAME dataset_examples table the builder writes —
// there is deliberately no second way to create an eval example.
export type PromoteTestInputCommand = {
  cmd: "promoteTestInput";
  agentId: string;
  agentName?: string;
  input: string;
  expected?: string | null;
};
/** Fan a dataset out across providers. `budgetUsd` is a hard ceiling on TRUE spend. */
export type StartEvalCommand = {
  cmd: "startEval";
  datasetId: string;
  agentId: string;
  targets: { provider: string; model: string }[];
  budgetUsd?: number | null;
};
export type CancelEvalCommand = { cmd: "cancelEval"; evalId: string };
// The rubric is product surface, not a constant — "correct" for a refund bot is not
// "correct" for a SQL agent. Saving one for a dataset overrides the shared default.
export type LoadRubricCommand = { cmd: "loadRubric"; datasetId: string };
/** The comparison dashboard's data: per-provider rollups plus per-example rows. */
export type LoadEvalResultsCommand = { cmd: "loadEvalResults"; evalId: string };
/** Past evals for a dataset (or all), so a finished comparison stays reachable. */
export type ListEvalsCommand = { cmd: "listEvals"; datasetId?: string };
/** What a real-provider eval will roughly cost, BEFORE committing to it. */
export type EstimateEvalCommand = {
  cmd: "estimateEval";
  datasetId: string;
  agentId: string;
  targets: { provider: string; model: string }[];
};
export type SaveRubricCommand = {
  cmd: "saveRubric";
  datasetId: string;
  name?: string;
  criteria: { id: string; label: string; description: string; weight: number }[];
};

// MCP server management. Control-plane commands like the eval set: they mutate the MCP
// registry tables and never touch the frozen trace stream. Forwarded to the app rather than
// answered here because connecting is a network round trip against an unreviewed third
// party — it can take seconds, fail in four different ways, and the app owns the registry
// that knows which. `listMcpServers` is the exception and is answered locally, like
// `listAgents`, because it is a pure read of state already in memory.
export type AddMcpServerCommand = {
  cmd: "addMcpServer";
  endpoint: string;
  label?: string;
  /**
   * A bearer token or API key, if the server needs one.
   *
   * This is the first of three fields on any command in this file that carry a secret (see
   * SetProviderKeyCommand.key and SetRailwayTokenCommand.token). It travels
   * one way — browser to server, over the loopback socket the whole product runs on — and
   * is written to runtime/.env and forgotten. Nothing ever sends it back: a server reports
   * `configured: true`, never its credential. See envWriter.ts.
   */
  token?: string;
};
export type RemoveMcpServerCommand = { cmd: "removeMcpServer"; serverId: string };
/** Re-run the handshake. On failure the previously discovered tools are kept. */
export type RediscoverMcpServerCommand = { cmd: "rediscoverMcpServer"; serverId: string };
export type ListMcpServersCommand = { cmd: "listMcpServers" };
/**
 * A user's explicit override of the impact classification. `impact: null` clears it and
 * returns the tool to whatever the classifier says.
 */
export type SetMcpToolImpactCommand = {
  cmd: "setMcpToolImpact";
  serverId: string;
  toolName: string;
  impact: "high" | "low" | null;
};

/**
 * Answer a pending confirmation. `verdict` is "once" | "run" | "deny".
 *
 * "run" grants for the remainder of THIS run only; nothing persists past it.
 */
export type ResolveMcpConfirmCommand = {
  cmd: "resolveMcpConfirm";
  runId: string;
  nonce: string;
  verdict: "once" | "run" | "deny";
};

/** Set or clear a server's credential. `token: null` removes the key entirely. */
export type SetMcpServerAuthCommand = {
  cmd: "setMcpServerAuth";
  serverId: string;
  token: string | null;
};

// Model-provider credentials. Grouped and forwarded exactly like the MCP set above, for the
// same reason: writing a key touches runtime/.env and — for the test — makes a network call
// against someone else's API, so the app answers with a precise result rather than the relay
// guessing. `listProviders` is the exception and is answered locally, like `listMcpServers`,
// because it is a pure read of state already in memory.

/**
 * Store a provider's API key. Answered with a fresh provider snapshot.
 *
 * `key` is the second of the three fields on any command in this file that carry a secret
 * (see AddMcpServerCommand.token and SetRailwayTokenCommand.token). It travels one way — browser to server, over the loopback
 * socket the whole product runs on — is written to runtime/.env by the same credential writer
 * every other key goes through, and is forgotten. Nothing ever sends it back: a provider
 * reports `configured: true`, never its credential. See envWriter.ts and providers.ts.
 */
export type SetProviderKeyCommand = { cmd: "setProviderKey"; provider: string; key: string };
/**
 * Prove a key works without storing it — the "Test connection" button.
 *
 * Deliberately not folded into setProviderKey: a test that writes first would put a
 * credential on disk before the user pressed Save, which is not what the button says it does.
 * The same one-way, never-echoed discipline applies to `key` here.
 */
export type TestProviderKeyCommand = { cmd: "testProviderKey"; provider: string; key: string };
export type ListProvidersCommand = { cmd: "listProviders" };

/** Provider-channel commands, grouped so the forwarding switch stays readable. */
export type ProviderCommand = SetProviderKeyCommand | TestProviderKeyCommand;

const PROVIDER_COMMANDS = new Set(["setProviderKey", "testProviderKey"]);

// Deploy. Everything below rides beside the frozen schema in a new channel, exactly as
// pause/resume, the eval engine and the MCP registry did — a deploy is not an agent run and
// emits no trace events at all.
//
// One rule governs every shape here: NAMES TRAVEL, VALUES DO NOT. A deploy hands the user's
// own credentials to their own hosting account, and nothing about that transaction needs a
// value to cross this socket. The only exception is the same one the other two credential
// commands are: a token going ONE WAY, browser to server, to be written to runtime/.env.

/**
 * What a deploy would need, before committing to one. Answered on the deploy channel with a
 * plan: variable names, what is missing, what would be refused. Nothing is created and
 * nothing is spent, so this is safe to call whenever the form changes.
 */
export type PlanDeployCommand = {
  cmd: "planDeploy";
  agentId: string;
  provider: string;
  model: string;
};

/** Start a deploy. `envKeys` are NAMES the user ticked — the server reads the values. */
export type DeployCommand = {
  cmd: "deploy";
  agentId: string;
  provider: string;
  model: string;
  envKeys: string[];
  /** Proceed even though a declared variable has no value on this machine. */
  allowMissing?: boolean;
  /** Serve with no bearer token. The UI has to ask for this explicitly; it is never default. */
  publicEndpoint?: boolean;
};

export type CancelDeployCommand = { cmd: "cancelDeploy"; deploymentId: string };

/** Detach a deployment record from Jaroku. Never touches anything in the user's account. */
export type ForgetDeploymentCommand = { cmd: "forgetDeployment"; deploymentId: string };

export type ListDeploymentsCommand = { cmd: "listDeployments" };
export type LoadDeployLogsCommand = { cmd: "loadDeployLogs"; deploymentId: string; sinceSeq?: number };

/**
 * Store the user's Railway token. Answered with a fresh deploy snapshot.
 *
 * `token` is the third and last field on any command in this file that carries a secret (see
 * AddMcpServerCommand.token and SetProviderKeyCommand.key). Same discipline, same writer: one
 * way, browser to server, into runtime/.env, forgotten. What comes back is `configured: true`.
 * `token: null` removes the key.
 */
export type SetRailwayTokenCommand = { cmd: "setRailwayToken"; token: string | null };

/**
 * Prove a Railway token works without storing it — the "Test connection" button, again.
 *
 * A separate command for the reason testProviderKey is: a test that wrote first would put a
 * credential on disk before the user pressed Save.
 */
export type TestRailwayTokenCommand = { cmd: "testRailwayToken"; token: string };

/** Deploy-channel commands, grouped so the forwarding switch stays readable. */
export type DeployChannelCommand =
  | PlanDeployCommand
  | DeployCommand
  | CancelDeployCommand
  | ForgetDeploymentCommand
  | LoadDeployLogsCommand
  | SetRailwayTokenCommand
  | TestRailwayTokenCommand;

const DEPLOY_COMMANDS = new Set([
  "planDeploy", "deploy", "cancelDeploy", "forgetDeployment", "loadDeployLogs",
  "setRailwayToken", "testRailwayToken",
]);

/** MCP-channel commands, grouped so the forwarding switch stays readable. */
export type McpCommand =
  | AddMcpServerCommand
  | RemoveMcpServerCommand
  | RediscoverMcpServerCommand
  | SetMcpToolImpactCommand
  | SetMcpServerAuthCommand
  | ResolveMcpConfirmCommand;

const MCP_COMMANDS = new Set([
  "addMcpServer", "removeMcpServer", "rediscoverMcpServer", "setMcpToolImpact",
  "setMcpServerAuth", "resolveMcpConfirm",
]);

// Unified composer "explain": a prose answer about a step / node / the agent, built from
// in-context data — the one genuinely-new composer intent (no code change).
export type ExplainSubject =
  | { kind: "step"; step: { name: string; type: string; seq: number; error: string | null; input: unknown; output: unknown } }
  | { kind: "node"; nodeId: string }
  | { kind: "agent" };
export type ExplainCommand = { cmd: "explain"; agentId: string; question: string; subject: ExplainSubject };
export type ClientCommand =
  | RunCommand
  | LoadRunCommand
  | GenerateCommand
  | PlanAgentCommand
  | DiscardPlanCommand
  | ListAgentsCommand
  | EditCommand
  | ApplyEditCommand
  | UndoEditCommand
  | DiscardEditCommand
  | LoadAgentFilesCommand
  | LoadAgentGraphCommand
  | PauseRunCommand
  | ResumeRunCommand
  | BranchRunCommand
  | ExplainCommand
  | EvalCommand
  | McpCommand
  | ListMcpServersCommand
  | ProviderCommand
  | ListProvidersCommand
  | DeployChannelCommand
  | ListDeploymentsCommand;

/** Eval-channel commands, grouped so the forwarding switch stays readable. */
export type EvalCommand =
  | CreateDatasetCommand
  | RenameDatasetCommand
  | DeleteDatasetCommand
  | ListDatasetsCommand
  | LoadDatasetCommand
  | AddExampleCommand
  | UpdateExampleCommand
  | DeleteExampleCommand
  | PromoteTestInputCommand
  | StartEvalCommand
  | CancelEvalCommand
  | LoadRubricCommand
  | SaveRubricCommand
  | LoadEvalResultsCommand
  | ListEvalsCommand
  | EstimateEvalCommand;

const EVAL_COMMANDS = new Set([
  "createDataset", "renameDataset", "deleteDataset", "listDatasets",
  "loadDataset", "addExample", "updateExample", "deleteExample", "promoteTestInput",
  "startEval", "cancelEval", "loadRubric", "saveRubric",
  "loadEvalResults", "listEvals", "estimateEval",
]);

/** Commands the relay forwards to the app rather than answering locally. */
export type ForwardedCommand =
  | RunCommand
  | GenerateCommand
  | PlanAgentCommand
  | DiscardPlanCommand
  | EditCommand
  | ApplyEditCommand
  | UndoEditCommand
  | DiscardEditCommand
  | PauseRunCommand
  | ResumeRunCommand
  | BranchRunCommand
  | ExplainCommand
  | EvalCommand
  | McpCommand
  | ProviderCommand
  | DeployChannelCommand;

// Generation rides its own channel, deliberately parallel to "trace". It never enters the
// trace store or the event schema — schema/events.md v1 stays frozen.
export type GenEvent =
  | { type: "file_start"; path: string }
  | { type: "file_delta"; path: string; text: string }
  | { type: "file_end"; path: string }
  | { type: "started"; prompt: string }
  | { type: "done"; agentId: string; name: string; files: string[]; usage: unknown; planUsage: unknown }
  | { type: "error"; message: string; problems?: string[] }
  // The pre-generation plan gate. These ride "gen" rather than a channel of their own because
  // a plan is an earlier phase of the same generation, not a separate feature.
  //
  // plan_error is deliberately NOT the "error" member above: that one is wired to
  // buildStore.fail() on the client, which paints the build pane as a FAILED GENERATION. A
  // plan refusal happens when no generation is running, so reusing it would report a failure
  // that never occurred.
  | { type: "plan_started"; prompt: string; input: string; revision: number }
  | { type: "plan_delta"; text: string }
  | {
      type: "plan";
      planId: string;
      prompt: string;
      connectors: string[];
      name?: string;
      plan: unknown;
      warnings: string[];
      usage: unknown;
      revision: number;
    }
  | { type: "plan_discarded"; planId: string }
  | { type: "plan_error"; message: string };

// Editing rides its own channel too, parallel to "gen" — it never enters the trace store
// or the frozen event schema either. Payload shapes are owned by editor.ts.
export type EditEvent =
  | { type: "started"; agentId: string; instruction: string }
  | { type: "file_start"; path: string }
  | { type: "file_delta"; path: string; text: string }
  | { type: "file_end"; path: string }
  | { type: "proposal"; proposalId: string; agentId: string; instruction: string; summary: string; files: unknown[]; usage: unknown }
  | { type: "applied"; proposalId: string; agentId: string; version: number; summary: string }
  | { type: "undone"; agentId: string; version: number; summary: string }
  | { type: "discarded"; proposalId: string; agentId: string }
  | { type: "error"; message: string; problems?: string[]; agentId?: string; proposalId?: string };

// Debug depth rides its own channel too, parallel to "trace"/"gen"/"edit". It carries only
// control-plane facts (a run paused / resumed / a boundary reached / a control error); the run's
// own steps still flow as normal schema-v1 trace events on the "trace" channel.
// The "explain" reply rides its own channel too, parallel to trace/gen/edit/debug — a streaming
// prose answer that never touches the trace store or the frozen event schema.
export type ReplyEvent =
  | { type: "started"; agentId: string; question: string }
  | { type: "delta"; agentId: string; text: string }
  | { type: "done"; agentId: string }
  | { type: "error"; agentId: string; message: string };

// Eval rides its own channel too, parallel to trace/gen/edit/debug/reply.
//
// This channel deliberately carries NO step traffic. An eval's individual runs still
// persist as ordinary Run/Step rows and are still read back through the existing
// `loadRun` path — but their live events must not go out on "trace", because
// traceStore.applyEvent focuses activeRunId on every run_start, and twenty parallel eval
// runs would thrash the timeline out from under whatever the user was reading.
export type EvalEvent =
  | { type: "datasets"; agentId: string | null; datasets: unknown[] }
  | { type: "dataset"; datasetId: string; examples: unknown[] }
  | { type: "datasetDeleted"; datasetId: string }
  // Answer to a one-click promotion, so the composer can confirm where the input landed.
  // `duplicate` means the dataset already had that exact input and nothing was added.
  | { type: "promoted"; datasetId: string; datasetName: string; duplicate: boolean }
  // Eval lifecycle. Progress is counts only — the individual runs' steps stay off this
  // channel (and off "trace") so a fan-out never disturbs the timeline.
  | {
      type: "evalStarted";
      evalId: string;
      datasetId: string;
      agentId: string;
      total: number;
      targets: { provider: string; model: string }[];
    }
  | { type: "evalProgress"; evalId: string; total: number; done: number; running: number; queued: number; failed: number }
  | { type: "evalFinished"; evalId: string; status: string; error?: string }
  | { type: "rubric"; datasetId: string; rubric: unknown; isDefault: boolean }
  // Scoring runs after the runs finish, so quality lands after the rest of the row. A null
  // score is UNSCORED (with a reason), never a zero.
  | { type: "scored"; evalId: string; jobId: string; score: number | null; error?: string | null }
  | { type: "scoringFinished"; evalId: string; scored: number; unscored: number }
  | { type: "evalResults"; evalId: string; results: unknown }
  | { type: "evals"; evals: unknown[] }
  | { type: "estimate"; estimate: unknown }
  | { type: "error"; message: string; datasetId?: string };

// MCP rides its own channel too, parallel to trace/gen/edit/debug/reply/eval.
//
// Like the eval channel it deliberately carries no step traffic: an agent's MCP tool call
// is an ORDINARY tool_call Step and arrives on "trace" with everything else. What travels
// here is registry state — which servers are connected, what they advertise, and how each
// tool was classified.
//
// Every mutation answers with a full `servers` snapshot rather than a delta, the same
// discipline as the eval channel: the client replaces rather than merges, so it can never
// hold a half-applied view of what a third-party server said.
//
// Nothing on this channel ever carries a credential. `configured` says a key is set.
export type McpEvent =
  | { type: "servers"; servers: unknown[] }
  // A handshake is a network round trip against someone else's server; the UI needs to be
  // able to say it is waiting rather than appear to have ignored the click.
  | { type: "discovering"; serverId: string | null; endpoint: string }
  | { type: "error"; message: string; serverId?: string }
  // A discovery that succeeded but is worth a word anyway (e.g. a truncated tool list).
  | { type: "notice"; message: string; serverId?: string }
  // A run has HALTED before a high-impact MCP tool's first call and is waiting for an
  // answer. This is the one message on any channel that describes a blocked process, which
  // is why the client renders it as a modal rather than a notification.
  | {
      type: "confirmRequest";
      runId: string;
      nonce: string;
      server: string;
      tool: string;
      /** Why the tool was classified high-impact, so the ask can be argued with. */
      impactReason: string;
      /** The arguments the model produced, as JSON text. Capped by the bridge. */
      args: string;
      /** Seconds the runner will wait before denying. */
      timeoutS: number;
      requestedAt: string;
    }
  // The request is over: answered, or the run died, or the runner gave up waiting.
  | { type: "confirmResolved"; runId: string; nonce: string; verdict: string };

// Model-provider credentials ride their own channel, parallel to trace/gen/edit/debug/reply/
// eval/mcp — still one socket, and still no second transport.
//
// It is not folded into "mcp" because that channel means "the MCP registry": every message on
// it is a full snapshot of the connected third-party servers, and the client REPLACES its
// whole server list on each one. A provider key is not an MCP server, and smuggling it
// through would make a message about Anthropic look like a claim about somebody's MCP
// endpoints.
//
// Same discipline as the eval and MCP channels: every mutation answers with a full snapshot,
// so a client replaces rather than merges. And like them, nothing here ever carries a
// credential — `configured` says a NAMED VARIABLE IS SET, and that is the whole of it.
export type ProviderEvent =
  | { type: "providers"; providers: unknown[] }
  // The answer to "Test connection": did that key authenticate. Nothing was written.
  | { type: "testResult"; provider: string; ok: boolean; message: string | null }
  // A write that could not happen (an unknown provider, a value the .env format cannot store
  // faithfully — see envWriter.renderLine).
  | { type: "error"; message: string; provider?: string }
  // A write that happened but comes with a caveat worth a sentence — most often that the same
  // variable is exported in the server's shell and will win again after a restart.
  | { type: "notice"; message: string; provider?: string };

// Deploy rides its own channel, for the same reason providers does: a deployment is not an
// MCP server and not a provider, and the other channels are full snapshots of something else.
// schema/events.md v1 is untouched — a deploy emits no trace events at all.
//
// Every mutation answers with a full snapshot, so a client replaces rather than merges. And
// as everywhere else: `deployments[].env_keys` are NAMES, `railwayConfigured` says a named
// variable is set, and nothing on this channel carries a credential — with one deliberate,
// one-shot exception, `serveToken` below.
export type DeployEvent =
  // The whole picture: every deployment, plus whether a Railway token is configured.
  | { type: "deployments"; deployments: unknown[]; railwayConfigured: boolean; cliVersion?: string | null }
  // What a deploy would need, answered before anything is created or spent.
  | { type: "plan"; agentId: string; secrets: unknown[]; problems: string[]; warnings: string[]; redeploy: boolean }
  | { type: "started"; deploymentId: string; agentId: string }
  // One per phase transition. The UI reads `stage` for the narrative and `status` for the row.
  | { type: "stage"; deploymentId: string; stage: string; status: string }
  // One line of build output, already scrubbed of every secret this deploy handled.
  | { type: "log"; deploymentId: string; seq: number; stage: string; stream: string; text: string }
  // A backfill of stored lines, for a client that connected mid-deploy or reloaded.
  | { type: "logs"; deploymentId: string; lines: unknown[] }
  | { type: "finished"; deploymentId: string; status: string; url: string | null; error: string | null }
  /**
   * The bearer token for a newly live endpoint, sent exactly once.
   *
   * The one credential that travels server -> browser anywhere in this file, and it is
   * deliberate: Jaroku generated it, set it on Railway, and keeps no copy, so this message is
   * the only chance the user has to see it. It is not persisted, not in the deployment row,
   * and not in the log table — which is exactly why it has to be its own event rather than a
   * `log` line.
   */
  | { type: "serveToken"; deploymentId: string; url: string; token: string }
  | { type: "testResult"; ok: boolean; message: string | null }
  | { type: "error"; message: string; deploymentId?: string }
  | { type: "notice"; message: string; deploymentId?: string };

export type DebugEvent =
  | { type: "paused"; runId: string; seq: number }
  | { type: "resumed"; runId: string; seqOffset: number }
  | { type: "boundary"; runId: string; seq: number; next: string[] }
  | { type: "branched"; parentRunId: string; branchId: string; fromSeq: number }
  | { type: "error"; runId?: string; message: string };

export interface RelayOptions {
  port: number;
  store: TraceStore;
  clientHtmlPath: string;
  // "loadRun", "listAgents", "loadAgentFiles", "loadAgentGraph", "listMcpServers" and
  // "listProviders" are answered locally; the rest are forwarded.
  onCommand?: (cmd: ForwardedCommand) => void;
  // The database-backed reads return promises now; the filesystem-backed ones do not. Both
  // shapes are accepted so a caller is not forced to wrap a synchronous answer in one.
  listAgents?: () => unknown[] | Promise<unknown[]>;
  listAgentFiles?: (agentId: string) => unknown[];
  getAgentGraph?: (agentId: string) => Promise<unknown>;
  listMcpServers?: () => unknown[] | Promise<unknown[]>;
  /** Which provider keys are set, by name. Never a value — see providers.ts. */
  listProviders?: () => unknown[];
  /** Every deployment, plus whether a Railway token is configured. Names only. */
  listDeployments?: () =>
    | { deployments: unknown[]; railwayConfigured: boolean }
    | Promise<{ deployments: unknown[]; railwayConfigured: boolean }>;
}

export class WsRelay {
  private wss: WebSocketServer;
  private clients = new Set<WebSocket>();
  private store: TraceStore;
  private onCommand?: (cmd: ForwardedCommand) => void;

  constructor(private opts: RelayOptions) {
    this.store = opts.store;
    this.onCommand = opts.onCommand;

    const http = createServer((req, res) => this.serveStatic(req, res));
    this.wss = new WebSocketServer({ server: http });

    this.wss.on("connection", (ws) => {
      this.clients.add(ws);
      // Snapshot: recent runs + the agent list so a reconnecting client isn't blank.
      //
      // Sent from one async block rather than five, so they still arrive in this order. A
      // client that received `agents` before `history` would render a sidebar whose runs
      // belong to agents it has not been told about yet.
      void (async () => {
        this.sendTo(ws, { channel: "history", runs: await this.store.listRuns() });
        this.sendTo(ws, { channel: "agents", agents: (await this.opts.listAgents?.()) ?? [] });
        this.sendTo(ws, { channel: "mcp", type: "servers", servers: (await this.opts.listMcpServers?.()) ?? [] });
        // Which providers are connected, so a first-run client knows on frame one whether it
        // is looking at a configured install or an empty one.
        this.sendTo(ws, { channel: "providers", type: "providers", providers: this.opts.listProviders?.() ?? [] });
        // And what is deployed, so the sidebar's Deployed filter is right on frame one rather
        // than after a round trip.
        const deploySnapshot = (await this.opts.listDeployments?.()) ?? {
          deployments: [],
          railwayConfigured: false,
        };
        this.sendTo(ws, { channel: "deploy", type: "deployments", ...deploySnapshot });
      })().catch((err) => console.error("[relay] initial snapshot failed:", (err as Error).message));

      ws.on("message", (data) => {
        try {
          const msg = JSON.parse(data.toString()) as ClientCommand;
          if (!msg || typeof msg.cmd !== "string") return;
          if (msg.cmd === "run") {
            this.onCommand?.(msg);
          } else if (msg.cmd === "generate" && typeof msg.prompt === "string") {
            this.onCommand?.(msg);
          } else if (msg.cmd === "planAgent" && typeof msg.prompt === "string") {
            this.onCommand?.(msg);
          } else if (msg.cmd === "discardPlan" && typeof msg.planId === "string") {
            this.onCommand?.(msg);
          } else if (msg.cmd === "edit" && typeof msg.agentId === "string" && typeof msg.instruction === "string") {
            this.onCommand?.(msg);
          } else if (msg.cmd === "applyEdit" && typeof msg.proposalId === "string") {
            this.onCommand?.(msg);
          } else if (msg.cmd === "undoEdit" && typeof msg.agentId === "string") {
            this.onCommand?.(msg);
          } else if (msg.cmd === "discardEdit" && typeof msg.proposalId === "string") {
            this.onCommand?.(msg);
          } else if (msg.cmd === "loadAgentFiles" && typeof msg.agentId === "string") {
            this.sendTo(ws, {
              channel: "agentFiles",
              agentId: msg.agentId,
              files: this.opts.listAgentFiles?.(msg.agentId) ?? [],
            });
          } else if (msg.cmd === "loadAgentGraph" && typeof msg.agentId === "string") {
            // Async: spawn introspection, then answer only the requesting client.
            const agentId = msg.agentId;
            void Promise.resolve(this.opts.getAgentGraph?.(agentId))
              .then((graph) => this.sendTo(ws, { channel: "graph", agentId, graph: graph ?? null }))
              .catch((err) =>
                this.sendTo(ws, {
                  channel: "graph",
                  agentId,
                  graph: { agent_id: agentId, error: String((err as Error)?.message ?? err) },
                }),
              );
          } else if (msg.cmd === "pauseRun" && typeof msg.runId === "string") {
            this.onCommand?.(msg);
          } else if (msg.cmd === "resumeRun" && typeof msg.runId === "string") {
            this.onCommand?.(msg);
          } else if (msg.cmd === "branchRun" && typeof msg.fromRunId === "string" && typeof msg.atSeq === "number") {
            this.onCommand?.(msg);
          } else if (msg.cmd === "explain" && typeof msg.agentId === "string" && typeof msg.question === "string") {
            this.onCommand?.(msg);
          } else if (msg.cmd === "listMcpServers") {
            void this.answer(ws, async () => ({
              channel: "mcp",
              type: "servers",
              servers: (await this.opts.listMcpServers?.()) ?? [],
            }));
          } else if (msg.cmd === "listDeployments") {
            void this.answer(ws, async () => ({
              channel: "deploy",
              type: "deployments",
              ...((await this.opts.listDeployments?.()) ?? { deployments: [], railwayConfigured: false }),
            }));
          } else if (msg.cmd === "listProviders") {
            this.sendTo(ws, {
              channel: "providers",
              type: "providers",
              providers: this.opts.listProviders?.() ?? [],
            });
          } else if (DEPLOY_COMMANDS.has(msg.cmd)) {
            // Shape-checked in the app, which owns the deploy manager and can answer with a
            // precise error on the "deploy" channel rather than dropping the message here.
            this.onCommand?.(msg as DeployChannelCommand);
          } else if (PROVIDER_COMMANDS.has(msg.cmd)) {
            // Shape-checked in the app, which owns the credential writer and can answer with a
            // precise error on the "providers" channel rather than dropping the message here.
            this.onCommand?.(msg as ProviderCommand);
          } else if (MCP_COMMANDS.has(msg.cmd)) {
            // Shape-checked in the app, which owns the registry and can answer with a
            // precise error on the "mcp" channel rather than dropping the message here.
            this.onCommand?.(msg as McpCommand);
          } else if (EVAL_COMMANDS.has(msg.cmd)) {
            // Shape-checked in the app, which owns the eval store and can answer with a
            // precise error on the "eval" channel rather than dropping the message here.
            this.onCommand?.(msg as EvalCommand);
          } else if (msg.cmd === "listAgents") {
            void this.answer(ws, async () => ({
              channel: "agents",
              agents: (await this.opts.listAgents?.()) ?? [],
            }));
          } else if (msg.cmd === "loadRun" && typeof msg.runId === "string") {
            // Answer only the requesting client with that run's steps (ordered by seq).
            const runId = msg.runId;
            void this.answer(ws, async () => ({
              channel: "runSteps",
              runId,
              steps: await this.store.stepsForRun(runId),
            }));
          }
        } catch {
          /* ignore malformed client messages */
        }
      });
      ws.on("close", () => this.clients.delete(ws));
      ws.on("error", () => this.clients.delete(ws));
    });

    http.listen(opts.port, () => {
      console.log(`[relay] http+ws listening on http://localhost:${opts.port}`);
    });
  }

  private async serveStatic(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (req.url === "/" || req.url === "/index.html") {
      try {
        const html = await readFile(this.opts.clientHtmlPath);
        res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
        res.end(html);
      } catch {
        res.writeHead(500).end("debug client not found");
      }
      return;
    }
    res.writeHead(404).end("not found");
  }

  private sendTo(ws: WebSocket, payload: unknown): void {
    if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(payload));
  }

  /**
   * Answer one client with something a database has to be asked for.
   *
   * A read that throws must not take the socket down with it: the client asked a question,
   * the answer is unavailable, and the connection is still good for every other question.
   * `sendTo` already no-ops on a socket that closed while the query was in flight.
   */
  private async answer(ws: WebSocket, build: () => Promise<unknown>): Promise<void> {
    try {
      this.sendTo(ws, await build());
    } catch (err) {
      console.error("[relay] read failed:", (err as Error).message);
    }
  }

  // Broadcast a trace event to every connected client.
  broadcast(event: TraceEvent): void {
    const msg = JSON.stringify({ channel: "trace", event });
    for (const ws of this.clients) {
      if (ws.readyState === WebSocket.OPEN) ws.send(msg);
    }
  }

  // Broadcast a diagnostic (stderr line, parse error) for visibility in the client.
  broadcastLog(level: "stderr" | "parseError", text: string): void {
    const msg = JSON.stringify({ channel: "log", level, text });
    for (const ws of this.clients) {
      if (ws.readyState === WebSocket.OPEN) ws.send(msg);
    }
  }

  // Broadcast a generation event. Separate channel from "trace" by design.
  broadcastGen(event: GenEvent): void {
    const msg = JSON.stringify({ channel: "gen", ...event });
    for (const ws of this.clients) {
      if (ws.readyState === WebSocket.OPEN) ws.send(msg);
    }
  }

  // Broadcast an edit-flow event. Separate channel from "trace" and "gen" by design.
  broadcastEdit(event: EditEvent): void {
    const msg = JSON.stringify({ channel: "edit", ...event });
    for (const ws of this.clients) {
      if (ws.readyState === WebSocket.OPEN) ws.send(msg);
    }
  }

  // Broadcast a debug-depth control event (pause/resume/boundary/branched). Separate channel by
  // design — the run's steps still arrive as normal schema-v1 events on "trace".
  broadcastDebug(event: DebugEvent): void {
    const msg = JSON.stringify({ channel: "debug", ...event });
    for (const ws of this.clients) {
      if (ws.readyState === WebSocket.OPEN) ws.send(msg);
    }
  }

  // Broadcast an "explain" reply event (unified composer). Separate channel by design — it never
  // enters the trace store or the frozen event schema.
  broadcastReply(event: ReplyEvent): void {
    const msg = JSON.stringify({ channel: "reply", ...event });
    for (const ws of this.clients) {
      if (ws.readyState === WebSocket.OPEN) ws.send(msg);
    }
  }

  // Broadcast an eval-channel event (datasets, and later eval progress/results). Separate
  // channel by design — it never carries trace steps, so a running eval can't steal the
  // Trace timeline's focus.
  broadcastEval(event: EvalEvent): void {
    const msg = JSON.stringify({ channel: "eval", ...event });
    for (const ws of this.clients) {
      if (ws.readyState === WebSocket.OPEN) ws.send(msg);
    }
  }

  // Broadcast an MCP registry event. Separate channel by design — an MCP tool call itself
  // is an ordinary tool_call Step and still arrives on "trace" like any other.
  broadcastMcp(event: McpEvent): void {
    const msg = JSON.stringify({ channel: "mcp", ...event });
    for (const ws of this.clients) {
      if (ws.readyState === WebSocket.OPEN) ws.send(msg);
    }
  }

  /** Broadcast a deploy event. Separate channel by design — see DeployEvent. */
  broadcastDeploy(event: DeployEvent): void {
    const msg = JSON.stringify({ channel: "deploy", ...event });
    for (const ws of this.clients) {
      if (ws.readyState === WebSocket.OPEN) ws.send(msg);
    }
  }

  // Broadcast a provider-credential event. Separate channel by design — see ProviderEvent.
  // Nothing on it ever carries a key: `configured` says a named variable is set.
  broadcastProviders(event: ProviderEvent): void {
    const msg = JSON.stringify({ channel: "providers", ...event });
    for (const ws of this.clients) {
      if (ws.readyState === WebSocket.OPEN) ws.send(msg);
    }
  }

  // Push a refreshed run-history snapshot to everyone (e.g. after a branch is created, so the new
  // branch run appears in history without needing a run_start event of its own).
  async broadcastHistory(): Promise<void> {
    const msg = JSON.stringify({ channel: "history", runs: await this.store.listRuns() });
    for (const ws of this.clients) {
      if (ws.readyState === WebSocket.OPEN) ws.send(msg);
    }
  }

  // Push an agent's current on-disk files to everyone (after an apply or undo, so the
  // Code tab reflects what will actually run).
  broadcastAgentFiles(agentId: string): void {
    const msg = JSON.stringify({
      channel: "agentFiles",
      agentId,
      files: this.opts.listAgentFiles?.(agentId) ?? [],
    });
    for (const ws of this.clients) {
      if (ws.readyState === WebSocket.OPEN) ws.send(msg);
    }
  }

  // Push a refreshed graph to everyone (after an apply/undo, whose edit may have changed the
  // agent's topology). Recomputes via the same introspection path.
  async broadcastAgentGraph(agentId: string): Promise<void> {
    const graph = (await this.opts.getAgentGraph?.(agentId)) ?? null;
    const msg = JSON.stringify({ channel: "graph", agentId, graph });
    for (const ws of this.clients) {
      if (ws.readyState === WebSocket.OPEN) ws.send(msg);
    }
  }

  // Push a refreshed agent list to everyone (after a generation lands).
  async broadcastAgents(): Promise<void> {
    const msg = JSON.stringify({ channel: "agents", agents: (await this.opts.listAgents?.()) ?? [] });
    for (const ws of this.clients) {
      if (ws.readyState === WebSocket.OPEN) ws.send(msg);
    }
  }
}
