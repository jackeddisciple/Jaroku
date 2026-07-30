// WebSocket client for the Jaroku relay. Mirrors the reconnect pattern of the original
// debug-client.html (1s backoff) and dispatches each server message into the trace store.
// The relay only speaks WebSocket, so this is the single channel between UI and pipeline.

import { useTraceStore } from "../store/traceStore.ts";
import { useBuildStore } from "../store/buildStore.ts";
import { useChatStore } from "../store/chatStore.ts";
import { useGraphStore } from "../store/graphStore.ts";
import { useEvalStore } from "../store/evalStore.ts";
import { useMcpStore } from "../store/mcpStore.ts";
import type {
  ClientCommand, EvalTarget, ExplainSubject, McpConfirmVerdict, McpImpact, RubricCriterion,
  ServerMessage,
} from "../types.ts";

const WS_URL = import.meta.env.VITE_JAROKU_WS ?? `ws://localhost:4317`;
const RECONNECT_MS = 1000;

let ws: WebSocket | null = null;
let started = false;

function dispatch(msg: ServerMessage): void {
  const s = useTraceStore.getState();
  switch (msg.channel) {
    case "history":
      s.applyHistory(msg.runs);
      break;
    case "trace":
      s.applyEvent(msg.event);
      break;
    case "runSteps":
      s.applyRunSteps(msg.runId, msg.steps);
      break;
    case "log":
      s.addLog({ level: msg.level, text: msg.text });
      break;
    case "agents":
      useBuildStore.getState().setAgents(msg.agents);
      break;
    case "agentFiles":
      useBuildStore.getState().setAgentFiles(msg.agentId, msg.files);
      break;
    case "graph":
      useGraphStore.getState().setGraph(msg.agentId, msg.graph);
      break;
    case "gen": {
      // Generation is routed to its own store — it never touches trace state.
      // Lifecycle events are mirrored into the conversation (chatStore); the file
      // streaming itself stays in buildStore only.
      const b = useBuildStore.getState();
      const c = useChatStore.getState();
      switch (msg.type) {
        case "started": b.startGeneration(msg.prompt); c.genStarted(msg.prompt); break;
        case "file_start": b.fileStart(msg.path); break;
        case "file_delta": b.fileDelta(msg.path, msg.text); break;
        case "file_end": b.fileEnd(msg.path); break;
        case "done": b.finish(msg.agentId, msg.usage); c.genDone(msg.agentId, msg.files, msg.usage, msg.planUsage); break;
        case "error": b.fail(msg.message, msg.problems); c.genError(msg.message, msg.problems); break;
        // The pre-generation gate. NOTE that none of these touch buildStore: a plan writes no
        // files, so the build pane has nothing to show and — crucially — nothing to mark as
        // failed. plan_error goes to the conversation, never to b.fail().
        case "plan_started": c.planStarted(msg.input, msg.revision); break;
        case "plan_delta": c.planDelta(msg.text); break;
        case "plan": c.planReady(msg); break;
        case "plan_discarded": c.planDiscarded(msg.planId); break;
        case "plan_error": c.planError(msg.message); break;
        default:
          // This switch used to drop anything it didn't know silently, so a server running
          // ahead of the client showed nothing at all rather than saying so.
          console.warn("[gen] unknown event type", (msg as { type?: string }).type);
      }
      break;
    }
    case "edit": {
      // The fix loop lives in the conversation — it never touches trace or build state
      // (the post-apply file refresh arrives separately on "agentFiles").
      const c = useChatStore.getState();
      switch (msg.type) {
        case "started": c.editStarted(msg.agentId, msg.instruction); break;
        case "file_start": c.editFileStart(msg.path); break;
        case "file_delta": c.editFileDelta(msg.path, msg.text.length); break;
        case "file_end": c.editFileEnd(msg.path); break;
        case "proposal": c.proposal(msg); break;
        case "applied": c.applied(msg.proposalId, msg.agentId, msg.version); break;
        case "undone": c.undone(msg.agentId, msg.version, msg.summary); break;
        case "discarded": c.discarded(msg.proposalId, msg.agentId); break;
        case "error": c.editError(msg); break;
      }
      break;
    }
    case "debug": {
      // Debug depth control plane: reflect pause/resume on the run's status. The run's steps
      // still arrive as normal "trace" events; "boundary" is informational (no state change).
      if (msg.type === "paused") s.setRunStatus(msg.runId, "paused");
      else if (msg.type === "resumed") s.setRunStatus(msg.runId, "running");
      else if (msg.type === "branched") {
        // The new branch run is in the refreshed history; focus it and load its (copied) prefix.
        s.selectRun(msg.branchId);
        sendLoadRun(msg.branchId);
      } else if (msg.type === "error") s.addLog({ level: "stderr", text: `debug: ${msg.message}` });
      break;
    }
    case "eval": {
      // Eval control plane. Every message is a full snapshot of what it names, so these
      // are replaces, not merges. Nothing here touches trace state — an eval's runs are
      // ordinary runs, loaded on demand through the normal loadRun path.
      const e = useEvalStore.getState();
      if (msg.type === "datasets") e.setDatasets(msg.datasets);
      else if (msg.type === "dataset") e.setExamples(msg.datasetId, msg.examples);
      else if (msg.type === "datasetDeleted") e.removeDataset(msg.datasetId);
      else if (msg.type === "promoted") e.setPromoted(msg.datasetName, msg.duplicate);
      else if (msg.type === "evalStarted") {
        e.setProgress({ evalId: msg.evalId, total: msg.total, done: 0, running: 0, queued: msg.total, failed: 0 });
        e.selectEval(msg.evalId);
      } else if (msg.type === "evalProgress") e.setProgress({ ...msg });
      else if (msg.type === "evalFinished") {
        // Runs are done; scoring may still be in flight, so the panel says so rather than
        // showing a quality column that's about to fill in.
        e.patchProgress({ status: msg.status, scoring: true });
        sendLoadEvalResults(msg.evalId);
        sendListEvals();
      } else if (msg.type === "scored") {
        // Refresh the aggregate so the quality column fills in as verdicts land.
        sendLoadEvalResults(msg.evalId);
      } else if (msg.type === "scoringFinished") {
        e.patchProgress({ scoring: false });
        sendLoadEvalResults(msg.evalId);
      } else if (msg.type === "evalResults") e.setResults(msg.evalId, msg.results);
      else if (msg.type === "evals") e.setEvals(msg.evals);
      else if (msg.type === "rubric") e.setRubric(msg.rubric, msg.isDefault);
      else if (msg.type === "estimate") e.setEstimate(msg.estimate);
      else if (msg.type === "error") e.setError(msg.message);
      break;
    }
    case "mcp": {
      // The MCP registry. Every message is a full snapshot of the server list, so this is a
      // replace and never a merge — see mcpStore. Nothing here touches trace state: an
      // agent's MCP tool call is an ordinary tool_call Step and arrives on "trace".
      const m = useMcpStore.getState();
      if (msg.type === "servers") m.setServers(msg.servers);
      else if (msg.type === "discovering") m.setDiscovering(msg.serverId, msg.endpoint);
      else if (msg.type === "error") m.setError(msg.message);
      else if (msg.type === "notice") m.setNotice(msg.message);
      else if (msg.type === "confirmRequest") m.addConfirm(msg);
      else if (msg.type === "confirmResolved") m.resolveConfirm(msg.runId, msg.nonce);
      break;
    }
    case "reply": {
      // Unified composer "explain": a streaming prose answer in the conversation (chatStore).
      const c = useChatStore.getState();
      if (msg.type === "started") c.replyStarted(msg.agentId, msg.question);
      else if (msg.type === "delta") c.replyDelta(msg.agentId, msg.text);
      else if (msg.type === "done") c.replyDone(msg.agentId);
      else if (msg.type === "error") c.replyError(msg.agentId, msg.message);
      break;
    }
  }
}

function connect(): void {
  useTraceStore.getState().setConnection("connecting");
  ws = new WebSocket(WS_URL);

  ws.onopen = () => useTraceStore.getState().setConnection("open");

  ws.onmessage = (ev) => {
    try {
      dispatch(JSON.parse(ev.data as string) as ServerMessage);
    } catch {
      /* ignore malformed server frames */
    }
  };

  ws.onclose = () => {
    useTraceStore.getState().setConnection("closed");
    ws = null;
    setTimeout(connect, RECONNECT_MS); // auto-reconnect
  };

  // On error the socket also fires close; let close drive reconnection.
  ws.onerror = () => ws?.close();
}

/** Start the singleton connection once (safe under React StrictMode double-invoke). */
export function startSocket(): void {
  if (started) return;
  started = true;
  connect();
}

function send(cmd: ClientCommand): void {
  if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(cmd));
}

export function sendRun(
  input?: string,
  provider?: string,
  model?: string,
  agentId?: string,
): void {
  // `model` is forwarded now — the relay and index.ts always accepted it, but this client
  // was dropping it, so a real-provider run silently used the agent's default model.
  send({ cmd: "run", input: input || undefined, provider, model, agentId });
}

export function sendLoadRun(runId: string): void {
  send({ cmd: "loadRun", runId });
}

/** Confirm a plan. `planId` is what makes the server build the plan the user approved rather
 *  than whatever the composer says now — see planner.take(). */
export function sendGenerate(
  prompt: string,
  connectors: string[],
  name?: string,
  planId?: string,
): void {
  send({ cmd: "generate", prompt, connectors, name, planId });
}

/** Ask for a plan. With `revisePlanId`, `prompt` is feedback on that plan, not a fresh brief. */
export function sendPlanAgent(
  prompt: string,
  connectors: string[],
  name?: string,
  revisePlanId?: string,
  /** Scoped MCP tools, as `"server/tool"` refs — per tool, never per server. */
  mcpTools?: string[],
): void {
  send({ cmd: "planAgent", prompt, connectors, mcpTools, name, revisePlanId });
}

export function sendDiscardPlan(planId: string): void {
  send({ cmd: "discardPlan", planId });
}

export function sendListAgents(): void {
  send({ cmd: "listAgents" });
}

// --- fix loop -------------------------------------------------------------

export function sendEdit(agentId: string, instruction: string): void {
  send({ cmd: "edit", agentId, instruction });
}

export function sendApplyEdit(proposalId: string): void {
  send({ cmd: "applyEdit", proposalId });
}

export function sendUndoEdit(agentId: string): void {
  send({ cmd: "undoEdit", agentId });
}

export function sendDiscardEdit(proposalId: string): void {
  send({ cmd: "discardEdit", proposalId });
}

export function sendLoadAgentFiles(agentId: string): void {
  send({ cmd: "loadAgentFiles", agentId });
}

export function sendLoadAgentGraph(agentId: string): void {
  useGraphStore.getState().markLoading(agentId);
  send({ cmd: "loadAgentGraph", agentId });
}

// Debug depth: pause the live run at its next node boundary, or resume a paused run from its
// durable checkpoint. The server answers on the "debug" channel (status) + "trace" (new steps).
export function sendPauseRun(runId: string): void {
  send({ cmd: "pauseRun", runId });
}
export function sendResumeRun(runId: string): void {
  send({ cmd: "resumeRun", runId });
}
// Fork a new run from `fromRunId` at step `atSeq` (its node boundary), optionally applying a
// validated domain-field edit (editedState) attributed to editNode before continuing.
export function sendBranchRun(
  fromRunId: string,
  atSeq: number,
  editNode?: string,
  editedState?: Record<string, unknown>,
): void {
  send({ cmd: "branchRun", fromRunId, atSeq, editNode, editedState });
}
// Unified composer "explain": ask for a prose answer about a step / node / the agent, built from
// in-context data. Answered on the "reply" channel (chatStore), never a code change.
export function sendExplain(agentId: string, question: string, subject: ExplainSubject): void {
  send({ cmd: "explain", agentId, question, subject });
}

// --- MCP: server registry --------------------------------------------------
// Answered on the "mcp" channel with a fresh snapshot of the whole server list, so callers
// never optimistically patch local state.

export function sendListMcpServers(): void {
  send({ cmd: "listMcpServers" });
}
/** Connect a server. `token` is written to runtime/.env server-side and never comes back. */
export function sendAddMcpServer(endpoint: string, label?: string, token?: string): void {
  send({ cmd: "addMcpServer", endpoint, label, token });
}
export function sendRemoveMcpServer(serverId: string): void {
  send({ cmd: "removeMcpServer", serverId });
}
/** Re-run the handshake. On failure the previously discovered tools are kept. */
export function sendRediscoverMcpServer(serverId: string): void {
  send({ cmd: "rediscoverMcpServer", serverId });
}
/** Store or clear a credential. `null` removes the key from runtime/.env entirely. */
export function sendSetMcpServerAuth(serverId: string, token: string | null): void {
  send({ cmd: "setMcpServerAuth", serverId, token });
}
/**
 * Answer a pending confirmation. The run is blocked until this lands.
 *
 * "once" allows this call, "run" allows this tool for the rest of this run and nothing
 * beyond it, "deny" refuses — and a refusal becomes a red step, never silence.
 */
export function sendResolveMcpConfirm(runId: string, nonce: string, verdict: McpConfirmVerdict): void {
  send({ cmd: "resolveMcpConfirm", runId, nonce, verdict });
}

/** Override the impact classification for one tool. `null` restores the classifier's call. */
export function sendSetMcpToolImpact(serverId: string, toolName: string, impact: McpImpact | null): void {
  send({ cmd: "setMcpToolImpact", serverId, toolName, impact });
}

// --- eval: dataset CRUD ----------------------------------------------------
// Each of these is answered on the "eval" channel with a fresh snapshot of whatever it
// changed, so callers never have to optimistically patch local state.

export function sendListDatasets(agentId?: string): void {
  send({ cmd: "listDatasets", agentId });
}
export function sendLoadDataset(datasetId: string): void {
  send({ cmd: "loadDataset", datasetId });
}
export function sendCreateDataset(agentId: string, name: string): void {
  send({ cmd: "createDataset", agentId, name });
}
export function sendRenameDataset(datasetId: string, name: string): void {
  send({ cmd: "renameDataset", datasetId, name });
}
export function sendDeleteDataset(datasetId: string, agentId: string): void {
  send({ cmd: "deleteDataset", datasetId, agentId });
}
export function sendAddExample(
  datasetId: string,
  input: string,
  expected?: string | null,
  notes?: string | null,
): void {
  send({ cmd: "addExample", datasetId, input, expected, notes });
}
export function sendUpdateExample(
  datasetId: string,
  exampleId: string,
  patch: { input?: string; expected?: string | null; notes?: string | null },
): void {
  send({ cmd: "updateExample", datasetId, exampleId, ...patch });
}
export function sendDeleteExample(datasetId: string, exampleId: string): void {
  send({ cmd: "deleteExample", datasetId, exampleId });
}

/** One-click "save this test input to the eval dataset" (doc §4.7.6). The target dataset
 *  is resolved server-side — the agent's most recent, or a new default — so this is one
 *  round trip and lands in the same table the dataset builder writes to. */
export function sendPromoteTestInput(
  agentId: string,
  input: string,
  agentName?: string,
  expected?: string | null,
): void {
  send({ cmd: "promoteTestInput", agentId, agentName, input, expected });
}

// --- eval runs -------------------------------------------------------------

/** Fan a dataset out across providers. `budgetUsd` is a hard ceiling on TRUE spend. */
export function sendStartEval(
  datasetId: string,
  agentId: string,
  targets: EvalTarget[],
  budgetUsd?: number | null,
): void {
  send({ cmd: "startEval", datasetId, agentId, targets, budgetUsd });
}
export function sendCancelEval(evalId: string): void {
  send({ cmd: "cancelEval", evalId });
}
export function sendLoadEvalResults(evalId: string): void {
  send({ cmd: "loadEvalResults", evalId });
}
export function sendListEvals(datasetId?: string): void {
  send({ cmd: "listEvals", datasetId });
}
/** Ask what a real-provider eval would roughly cost, BEFORE committing to it. */
export function sendEstimateEval(datasetId: string, agentId: string, targets: EvalTarget[]): void {
  send({ cmd: "estimateEval", datasetId, agentId, targets });
}
export function sendLoadRubric(datasetId: string): void {
  send({ cmd: "loadRubric", datasetId });
}
export function sendSaveRubric(datasetId: string, criteria: RubricCriterion[], name?: string): void {
  send({ cmd: "saveRubric", datasetId, criteria, name });
}
