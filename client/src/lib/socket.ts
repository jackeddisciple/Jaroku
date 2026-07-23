// WebSocket client for the Jaroku relay. Mirrors the reconnect pattern of the original
// debug-client.html (1s backoff) and dispatches each server message into the trace store.
// The relay only speaks WebSocket, so this is the single channel between UI and pipeline.

import { useTraceStore } from "../store/traceStore.ts";
import { useBuildStore } from "../store/buildStore.ts";
import { useChatStore } from "../store/chatStore.ts";
import { useGraphStore } from "../store/graphStore.ts";
import type { ClientCommand, ServerMessage } from "../types.ts";

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
        case "done": b.finish(msg.agentId, msg.usage); c.genDone(msg.agentId, msg.files, msg.usage); break;
        case "error": b.fail(msg.message, msg.problems); c.genError(msg.message, msg.problems); break;
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

export function sendGenerate(prompt: string, connectors: string[], name?: string): void {
  send({ cmd: "generate", prompt, connectors, name });
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
