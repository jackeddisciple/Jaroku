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
  name?: string;
};
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
  | ExplainCommand;

/** Commands the relay forwards to the app rather than answering locally. */
export type ForwardedCommand =
  | RunCommand
  | GenerateCommand
  | EditCommand
  | ApplyEditCommand
  | UndoEditCommand
  | DiscardEditCommand
  | PauseRunCommand
  | ResumeRunCommand
  | BranchRunCommand
  | ExplainCommand;

// Generation rides its own channel, deliberately parallel to "trace". It never enters the
// trace store or the event schema — schema/events.md v1 stays frozen.
export type GenEvent =
  | { type: "file_start"; path: string }
  | { type: "file_delta"; path: string; text: string }
  | { type: "file_end"; path: string }
  | { type: "started"; prompt: string }
  | { type: "done"; agentId: string; name: string; files: string[]; usage: unknown }
  | { type: "error"; message: string; problems?: string[] };

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
  // "loadRun", "listAgents", "loadAgentFiles" and "loadAgentGraph" are answered locally; the
  // rest are forwarded.
  onCommand?: (cmd: ForwardedCommand) => void;
  listAgents?: () => unknown[];
  listAgentFiles?: (agentId: string) => unknown[];
  getAgentGraph?: (agentId: string) => Promise<unknown>;
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
      this.sendTo(ws, { channel: "history", runs: this.store.listRuns() });
      this.sendTo(ws, { channel: "agents", agents: this.opts.listAgents?.() ?? [] });

      ws.on("message", (data) => {
        try {
          const msg = JSON.parse(data.toString()) as ClientCommand;
          if (!msg || typeof msg.cmd !== "string") return;
          if (msg.cmd === "run") {
            this.onCommand?.(msg);
          } else if (msg.cmd === "generate" && typeof msg.prompt === "string") {
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
          } else if (msg.cmd === "listAgents") {
            this.sendTo(ws, { channel: "agents", agents: this.opts.listAgents?.() ?? [] });
          } else if (msg.cmd === "loadRun" && typeof msg.runId === "string") {
            // Answer only the requesting client with that run's steps (ordered by seq).
            this.sendTo(ws, {
              channel: "runSteps",
              runId: msg.runId,
              steps: this.store.stepsForRun(msg.runId),
            });
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

  // Push a refreshed run-history snapshot to everyone (e.g. after a branch is created, so the new
  // branch run appears in history without needing a run_start event of its own).
  broadcastHistory(): void {
    const msg = JSON.stringify({ channel: "history", runs: this.store.listRuns() });
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
  broadcastAgents(): void {
    const msg = JSON.stringify({ channel: "agents", agents: this.opts.listAgents?.() ?? [] });
    for (const ws of this.clients) {
      if (ws.readyState === WebSocket.OPEN) ws.send(msg);
    }
  }
}
