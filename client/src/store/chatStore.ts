// Conversation state for the center pane (doc §4.1): user request → Jaroku response,
// with diff cards inline. A SEPARATE store from traceStore (frozen-schema invariants) and
// buildStore (file streaming) — chat turns reference their results, never own them.
//
// Turns are appended by *server* events (gen/edit "started"), not by the submit click, so
// every connected client sees the same conversation and nothing double-appends.
//
// In-memory only this week: a reload clears the conversation (the applied edits themselves
// are on disk and remain undoable via the agent's history).

import { create } from "zustand";
import type { FileDiff, GenUsage } from "../types.ts";

let nextId = 0;
const turnId = () => `t${++nextId}`;

export interface UserTurn {
  id: string;
  role: "user";
  text: string;
}

/** A generation in flight / finished. Live file streaming stays in buildStore; this turn
 *  only records the outcome. */
export interface GenTurn {
  id: string;
  role: "jaroku";
  kind: "gen";
  status: "generating" | "done" | "error";
  agentId: string | null;
  files: string[];
  usage: GenUsage | null;
  error?: string;
  problems?: string[];
}

export type ProposalStatus =
  | "streaming" // model is rewriting files
  | "pending"   // diff card awaiting Apply / Discard
  | "noop"      // model emitted no files — summary explains why
  | "applied"
  | "undone"
  | "discarded"
  | "error";

export interface ProposalTurn {
  id: string;
  role: "jaroku";
  kind: "proposal";
  status: ProposalStatus;
  agentId: string;
  proposalId: string | null;
  summary: string | null;
  files: FileDiff[];
  /** Files being rewritten while streaming, with running byte counts. */
  streaming: { path: string; bytes: number; done: boolean }[];
  usage: GenUsage | null;
  version?: number;
  error?: string;
  problems?: string[];
}

export interface InfoTurn {
  id: string;
  role: "jaroku";
  kind: "info";
  text: string;
  tone: "muted" | "error";
}

/** A conversational answer with no code change — the unified composer's "explain" intent.
 *  Streams token-by-token like generation, but produces prose, not files. */
export interface ReplyTurn {
  id: string;
  role: "jaroku";
  kind: "reply";
  status: "streaming" | "done" | "error";
  agentId: string;
  text: string;
}

export type ChatTurn = UserTurn | GenTurn | ProposalTurn | InfoTurn | ReplyTurn;

interface ChatState {
  /** Conversation per agent. */
  threads: Record<string, ChatTurn[]>;
  /** Generation turns before the agent id exists; moved into threads on gen done. */
  pending: ChatTurn[];
  /** Agent whose edit is currently streaming (file events carry no agentId). */
  streamingAgentId: string | null;

  genStarted: (prompt: string) => void;
  genDone: (agentId: string, files: string[], usage: GenUsage) => void;
  genError: (message: string, problems?: string[]) => void;

  editStarted: (agentId: string, instruction: string) => void;
  editFileStart: (path: string) => void;
  editFileDelta: (path: string, bytes: number) => void;
  editFileEnd: (path: string) => void;
  proposal: (p: {
    proposalId: string; agentId: string; summary: string; files: FileDiff[]; usage: GenUsage;
  }) => void;
  applied: (proposalId: string, agentId: string, version: number) => void;
  undone: (agentId: string, version: number, summary: string) => void;
  discarded: (proposalId: string, agentId: string) => void;
  editError: (e: { message: string; problems?: string[]; agentId?: string; proposalId?: string }) => void;

  // --- explain (unified composer): a streaming prose reply, no code change ---
  replyStarted: (agentId: string, question: string) => void;
  replyDelta: (agentId: string, text: string) => void;
  replyDone: (agentId: string) => void;
  replyError: (agentId: string, message: string) => void;
}

function lastGenTurn(turns: ChatTurn[]): GenTurn | undefined {
  for (let i = turns.length - 1; i >= 0; i--) {
    const t = turns[i];
    if (t && t.role === "jaroku" && t.kind === "gen") return t;
  }
  return undefined;
}

/** Replace one turn (by id) inside a thread, immutably. */
function replaceTurn(turns: ChatTurn[], id: string, next: ChatTurn): ChatTurn[] {
  return turns.map((t) => (t.id === id ? next : t));
}

export const useChatStore = create<ChatState>((set) => ({
  threads: {},
  pending: [],
  streamingAgentId: null,

  // --- generation --------------------------------------------------------

  genStarted: (prompt) =>
    set((s) => ({
      pending: [
        ...s.pending,
        { id: turnId(), role: "user", text: prompt },
        { id: turnId(), role: "jaroku", kind: "gen", status: "generating", agentId: null, files: [], usage: null },
      ],
    })),

  genDone: (agentId, files, usage) =>
    set((s) => {
      const gen = lastGenTurn(s.pending);
      const finished = s.pending.map((t) =>
        gen && t.id === gen.id ? { ...gen, status: "done" as const, agentId, files, usage } : t,
      );
      // The new agent's conversation begins with its own creation.
      return {
        pending: [],
        threads: { ...s.threads, [agentId]: [...(s.threads[agentId] ?? []), ...finished] },
      };
    }),

  genError: (message, problems) =>
    set((s) => {
      const gen = lastGenTurn(s.pending);
      if (!gen) return {};
      return {
        pending: replaceTurn(s.pending, gen.id, {
          ...gen, status: "error", error: message, problems,
        }),
      };
    }),

  // --- editing -----------------------------------------------------------

  editStarted: (agentId, instruction) =>
    set((s) => ({
      streamingAgentId: agentId,
      threads: {
        ...s.threads,
        [agentId]: [
          ...(s.threads[agentId] ?? []),
          { id: turnId(), role: "user", text: instruction },
          {
            id: turnId(), role: "jaroku", kind: "proposal", status: "streaming",
            agentId, proposalId: null, summary: null, files: [], streaming: [], usage: null,
          },
        ],
      },
    })),

  editFileStart: (path) => set((s) => touchStreaming(s, path, (f) => f ?? { path, bytes: 0, done: false })),
  editFileDelta: (path, bytes) =>
    set((s) => touchStreaming(s, path, (f) => (f ? { ...f, bytes: f.bytes + bytes } : { path, bytes, done: false }))),
  editFileEnd: (path) =>
    set((s) => touchStreaming(s, path, (f) => (f ? { ...f, done: true } : { path, bytes: 0, done: true }))),

  proposal: ({ proposalId, agentId, summary, files, usage }) =>
    set((s) => {
      const turns = s.threads[agentId] ?? [];
      const open = findStreaming(turns, agentId);
      const done: ProposalTurn = {
        id: open?.id ?? turnId(),
        role: "jaroku",
        kind: "proposal",
        status: files.length ? "pending" : "noop",
        agentId,
        proposalId,
        summary,
        files,
        streaming: [],
        usage,
      };
      return {
        streamingAgentId: null,
        threads: {
          ...s.threads,
          [agentId]: open ? replaceTurn(turns, open.id, done) : [...turns, done],
        },
      };
    }),

  applied: (proposalId, agentId, version) =>
    set((s) => {
      const turns = s.threads[agentId] ?? [];
      const turn = turns.find(
        (t): t is ProposalTurn => t.role === "jaroku" && t.kind === "proposal" && t.proposalId === proposalId,
      );
      if (!turn) return {};
      return {
        threads: { ...s.threads, [agentId]: replaceTurn(turns, turn.id, { ...turn, status: "applied", version }) },
      };
    }),

  undone: (agentId, version, summary) =>
    set((s) => {
      const turns = s.threads[agentId] ?? [];
      const turn = turns.find(
        (t): t is ProposalTurn =>
          t.role === "jaroku" && t.kind === "proposal" && t.status === "applied" && t.version === version,
      );
      const updated = turn ? replaceTurn(turns, turn.id, { ...turn, status: "undone" as const }) : turns;
      // Always leave a line in the conversation — the undone edit may predate this session.
      const note: InfoTurn = {
        id: turnId(), role: "jaroku", kind: "info", tone: "muted",
        text: `Reverted edit v${version} — ${summary}`,
      };
      return { threads: { ...s.threads, [agentId]: [...updated, note] } };
    }),

  discarded: (proposalId, agentId) =>
    set((s) => {
      const turns = s.threads[agentId] ?? [];
      const turn = turns.find(
        (t): t is ProposalTurn => t.role === "jaroku" && t.kind === "proposal" && t.proposalId === proposalId,
      );
      if (!turn || turn.status !== "pending") return {};
      return {
        threads: { ...s.threads, [agentId]: replaceTurn(turns, turn.id, { ...turn, status: "discarded" }) },
      };
    }),

  editError: ({ message, problems, agentId, proposalId }) =>
    set((s) => {
      const owner = agentId ?? s.streamingAgentId;
      if (owner) {
        const turns = s.threads[owner] ?? [];
        const open =
          findStreaming(turns, owner) ??
          (proposalId
            ? turns.find(
                (t): t is ProposalTurn =>
                  t.role === "jaroku" && t.kind === "proposal" && t.proposalId === proposalId,
              )
            : undefined);
        if (open) {
          return {
            streamingAgentId: null,
            threads: {
              ...s.threads,
              [owner]: replaceTurn(turns, open.id, {
                ...open, status: "error", error: message, problems, streaming: [],
              }),
            },
          };
        }
        const note: InfoTurn = { id: turnId(), role: "jaroku", kind: "info", tone: "error", text: message };
        return { streamingAgentId: null, threads: { ...s.threads, [owner]: [...turns, note] } };
      }
      const note: InfoTurn = { id: turnId(), role: "jaroku", kind: "info", tone: "error", text: message };
      return { streamingAgentId: null, pending: [...s.pending, note] };
    }),

  // --- explain (streaming prose reply, no code change) -------------------

  replyStarted: (agentId, question) =>
    set((s) => ({
      streamingAgentId: agentId,
      threads: {
        ...s.threads,
        [agentId]: [
          ...(s.threads[agentId] ?? []),
          { id: turnId(), role: "user", text: question },
          { id: turnId(), role: "jaroku", kind: "reply", status: "streaming", agentId, text: "" },
        ],
      },
    })),

  replyDelta: (agentId, text) =>
    set((s) => {
      const turns = s.threads[agentId] ?? [];
      const open = findReply(turns, agentId);
      if (!open) return {};
      return {
        threads: { ...s.threads, [agentId]: replaceTurn(turns, open.id, { ...open, text: open.text + text }) },
      };
    }),

  replyDone: (agentId) =>
    set((s) => {
      const turns = s.threads[agentId] ?? [];
      const open = findReply(turns, agentId);
      if (!open) return { streamingAgentId: null };
      return {
        streamingAgentId: null,
        threads: { ...s.threads, [agentId]: replaceTurn(turns, open.id, { ...open, status: "done" }) },
      };
    }),

  replyError: (agentId, message) =>
    set((s) => {
      const turns = s.threads[agentId] ?? [];
      const open = findReply(turns, agentId);
      const next = open
        ? replaceTurn(turns, open.id, { ...open, status: "error" as const, text: open.text || message })
        : [...turns, { id: turnId(), role: "jaroku" as const, kind: "info" as const, tone: "error" as const, text: message }];
      return { streamingAgentId: null, threads: { ...s.threads, [agentId]: next } };
    }),
}));

/** The streaming reply turn currently open on an agent's thread, if any. */
function findReply(turns: ChatTurn[], agentId: string): ReplyTurn | undefined {
  for (let i = turns.length - 1; i >= 0; i--) {
    const t = turns[i];
    if (t && t.role === "jaroku" && t.kind === "reply" && t.agentId === agentId && t.status === "streaming") {
      return t;
    }
  }
  return undefined;
}

function findStreaming(turns: ChatTurn[], agentId: string): ProposalTurn | undefined {
  for (let i = turns.length - 1; i >= 0; i--) {
    const t = turns[i];
    if (t && t.role === "jaroku" && t.kind === "proposal" && t.agentId === agentId && t.status === "streaming") {
      return t;
    }
  }
  return undefined;
}

/** Update (or insert) one streaming-file row on the currently streaming proposal turn. */
function touchStreaming(
  s: { threads: Record<string, ChatTurn[]>; streamingAgentId: string | null },
  path: string,
  update: (f: { path: string; bytes: number; done: boolean } | undefined) => { path: string; bytes: number; done: boolean },
): Partial<ChatState> {
  const agentId = s.streamingAgentId;
  if (!agentId) return {};
  const turns = s.threads[agentId] ?? [];
  const open = findStreaming(turns, agentId);
  if (!open) return {};
  const existing = open.streaming.find((f) => f.path === path);
  const streaming = existing
    ? open.streaming.map((f) => (f.path === path ? update(f) : f))
    : [...open.streaming, update(undefined)];
  return {
    threads: {
      ...s.threads,
      [agentId]: replaceTurn(turns, open.id, { ...open, streaming }),
    },
  };
}

/** The turns to render for the current selection. */
export function threadFor(
  state: { threads: Record<string, ChatTurn[]>; pending: ChatTurn[] },
  agentId: string | null,
): ChatTurn[] {
  if (agentId) return state.threads[agentId] ?? [];
  return state.pending;
}
