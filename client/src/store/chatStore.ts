// Conversation state for the center pane (doc §4.1): user request → Jaroku response,
// with diff cards inline. A SEPARATE store from traceStore (frozen-schema invariants) and
// buildStore (file streaming) — chat turns reference their results, never own them.
//
// Turns are appended by *server* events (gen/edit "started"), not by the submit click, so
// every connected client sees the same conversation and nothing double-appends.
//
// KEYED BY THREAD, NOT BY AGENT (§3.1). One agent carries several independent sessions — that is
// the whole premise of the feature — and while these were keyed by agent id, two threads on one
// agent rendered the SAME conversation, work started in one landed in whichever was touched last,
// and opening a thread after a reload showed nothing at all. The key has to be the thing the spec
// says is independent. Every event on the gen / edit / reply channels now carries the session it
// belongs to, so a tab that did not send the command can still file the turns where the sender
// meant them — which is what keeps the conversation shared rather than local to one browser.
//
// `pending` IS FOR TURNS THAT BELONG TO NO SESSION — a refusal answered to whoever asked is the one
// thing on these channels with no thread on it. Everything else has one.
//
// A reload no longer clears the conversation entirely: `hydrate` rebuilds one from the
// `thread_items` rows the server keeps, so reopening a thread shows what somebody said and what it
// caused. Jaroku's own prose is deliberately not stored (migration 044) and does not come back.

import { create } from "zustand";
import type { AgentPlan, FileDiff, GenUsage, ThreadItemView } from "../types.ts";

let nextId = 0;
const turnId = () => `t${++nextId}`;

export interface UserTurn {
  id: string;
  role: "user";
  text: string;
  /** See `TurnAnchor`. */
  itemId?: string;
}

/**
 * THE DURABLE TURN ID, on every turn that has one.
 *
 * `id` is a render key minted in this file and it changes on every reload — which is exactly what
 * a key should be and exactly what a foreign key must not be. `itemId` is the `thread_items` row
 * the server knows this turn by, and it is what §7's notes, pins, feedback and attachments hang
 * off.
 *
 * OPTIONAL, BECAUSE A LIVE TURN DOES NOT HAVE ONE YET. A turn appended by a socket event exists in
 * this store before the server has filed its row; the action row renders its annotation controls
 * only once the id arrives, which is honest — there is nothing to annotate until then.
 */
export interface TurnAnchor {
  itemId?: string;
}

/** The pre-generation plan (server/src/planProtocol.ts) awaiting the user's decision.
 *
 *  "accepted" is set when the generation the plan authorised starts, so a finished
 *  conversation still shows which plan produced which agent rather than a card frozen
 *  mid-decision. "stale" means the connector selection changed underneath it — the plan is
 *  still readable, but it no longer describes what would be built. */
export type PlanStatus =
  | "streaming"
  | "pending"
  | "accepted"
  | "stale"
  | "superseded" // a newer plan replaced it; the server already spent its id
  | "discarded"
  | "error";

export interface PlanTurn extends TurnAnchor {
  id: string;
  role: "jaroku";
  kind: "plan";
  status: PlanStatus;
  planId: string | null;
  revision: number;
  /** The brief this plan was written for — not necessarily what the composer says now. */
  prompt: string;
  /** Streamed text while live, then the settled raw plan. Always renderable, so a plan the
   *  parser could make nothing of is still shown rather than swallowed. */
  raw: string;
  plan: AgentPlan | null;
  warnings: string[];
  usage: GenUsage | null;
  error?: string;
}

/** A generation in flight / finished. Live file streaming stays in buildStore; this turn
 *  only records the outcome. */
export interface GenTurn extends TurnAnchor {
  id: string;
  role: "jaroku";
  kind: "gen";
  status: "generating" | "done" | "error";
  agentId: string | null;
  files: string[];
  usage: GenUsage | null;
  /** What the plan that authorised this generation cost, if there was one. Kept separate
   *  from `usage` so the card can show both halves rather than one opaque number. */
  planUsage: GenUsage | null;
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

export interface ProposalTurn extends TurnAnchor {
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

export interface InfoTurn extends TurnAnchor {
  id: string;
  role: "jaroku";
  kind: "info";
  text: string;
  tone: "muted" | "error";
}

/** A conversational answer with no code change — the unified composer's "explain" intent.
 *  Streams token-by-token like generation, but produces prose, not files. */
export interface ReplyTurn extends TurnAnchor {
  id: string;
  role: "jaroku";
  kind: "reply";
  status: "streaming" | "done" | "error";
  agentId: string;
  text: string;
  /**
   * §6.5's metadata, arriving with the answer rather than derived from it.
   *
   * The model that produced THIS reply, the effort actually spent on it, and §5.4's two counts once
   * there is more than one variant. Optional because every reply that predates §5.4 having a writer
   * has none, and because the no-key path streams the raw context with no model call to describe.
   */
  usage?: GenUsage;
  /**
   * §5.4: the answers this turn REPLACED, oldest first.
   *
   * IN MEMORY, WHICH IS NOT A SHORTCUT — it is the same decision migration 044 already made for the
   * whole conversation: Jaroku's replies are not stored, and `hydrate` rebuilds a reloaded thread
   * from stubs rather than from a transcript. `turn_variants` records what each answer COST so
   * "which model wrote this?" stays answerable forever; the prose itself lives as long as the tab
   * does, which is exactly as long as a comparison is being made.
   *
   * So the switcher is honest about its own lifetime: it appears when a regeneration produces a
   * second answer in this session, and a reload leaves the durable record intact and the bodies
   * gone. Storing them would be a transcript table §7 deliberately does not have.
   */
  priorVariants?: string[];
}

export type ChatTurn = UserTurn | PlanTurn | GenTurn | ProposalTurn | InfoTurn | ReplyTurn;

/**
 * Which session a message belongs to, as the envelope carried it.
 *
 * `undefined` means the server attached none — a refusal, which belongs to nobody's session and
 * goes to `pending`. It is deliberately not "the thread that happens to be open": filing another
 * tab's refusal into whatever this one is looking at is how a conversation acquires turns that
 * were never part of it.
 */
type In = { threadId?: string };

interface ChatState {
  /** Conversation per THREAD. See the header for why this is not per agent. */
  threads: Record<string, ChatTurn[]>;
  /** Turns belonging to no session: refusals, and anything a server sent without one. */
  pending: ChatTurn[];
  /** Agent whose edit is currently streaming (file events carry no agentId). */
  streamingAgentId: string | null;
  /** And which session it is streaming into, since file events carry no thread either. */
  streamingThreadId: string | null;

  /** Rebuild a thread's conversation from what the server kept about it (§4.5). */
  hydrate: (threadId: string, items: ThreadItemView[]) => void;

  planStarted: (e: In & { input: string; revision: number }) => void;
  planDelta: (e: In & { text: string }) => void;
  planReady: (p: In & {
    planId: string; prompt: string; plan: AgentPlan; warnings: string[]; usage: GenUsage;
    revision: number;
  }) => void;
  planDiscarded: (e: In & { planId: string }) => void;
  /** Called by the composer, not by the socket, so it names the thread it is looking at. */
  planStale: (threadId: string | null, stale: boolean) => void;
  planError: (e: In & { message: string }) => void;

  genStarted: (e: In & { prompt: string }) => void;
  genDone: (e: In & { agentId: string; files: string[]; usage: GenUsage; planUsage: GenUsage }) => void;
  genError: (e: In & { message: string; problems?: string[] }) => void;

  editStarted: (e: In & { agentId: string; instruction: string }) => void;
  editFileStart: (path: string) => void;
  editFileDelta: (path: string, bytes: number) => void;
  editFileEnd: (path: string) => void;
  proposal: (p: In & {
    proposalId: string; agentId: string; summary: string; files: FileDiff[]; usage: GenUsage;
  }) => void;
  applied: (e: In & { proposalId: string; agentId: string; version: number }) => void;
  undone: (e: In & { agentId: string; version: number; summary: string }) => void;
  discarded: (e: In & { proposalId: string; agentId: string }) => void;
  editError: (e: In & { message: string; problems?: string[]; agentId?: string; proposalId?: string }) => void;

  // --- explain (unified composer): a streaming prose reply, no code change ---
  replyStarted: (e: In & { agentId: string; question: string; regenerateOf?: string }) => void;
  /** §5.4: show a different one of this turn's answers. See the implementation. */
  switchVariant: (e: In & { turnId: string; ordinal: number }) => void;
  replyDelta: (e: In & { agentId: string; text: string }) => void;
  replyDone: (e: In & { agentId: string; usage?: GenUsage }) => void;
  replyError: (e: In & { agentId: string; message: string }) => void;
}

/** The turns a message belongs to. A message with no session reads and writes `pending`. */
function turnsIn(s: { threads: Record<string, ChatTurn[]>; pending: ChatTurn[] }, threadId?: string): ChatTurn[] {
  return threadId ? (s.threads[threadId] ?? []) : s.pending;
}

/** …and putting them back, which is the same decision and so belongs beside it. */
function putTurns(
  s: { threads: Record<string, ChatTurn[]> },
  threadId: string | undefined,
  turns: ChatTurn[],
): Partial<ChatState> {
  return threadId ? { threads: { ...s.threads, [threadId]: turns } } : { pending: turns };
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
  streamingThreadId: null,

  /**
   * The conversation as the server remembers it, replacing whatever this tab had (§4.5).
   *
   * A REPLACE, LIKE EVERY OTHER SNAPSHOT IN THIS CODEBASE. The rows are the durable record and
   * this tab's copy is not; merging would let a thread hold one turn from the record and one from
   * a socket that has since reconnected.
   *
   * What comes back is the user's turns plus a stub per run, plan, generation, proposal and eval —
   * Jaroku's replies were never stored (migration 044). A stub says what happened rather than
   * pretending to be the card it was, because a diff card with no diff behind it would offer an
   * Apply button for a proposal that has not existed since the process restarted.
   */
  hydrate: (threadId, items) =>
    set((s) => ({
      threads: {
        ...s.threads,
        // THE ROW'S OWN ID IS CARRIED THROUGH as `itemId`. It used to be discarded here, which is
        // why notes and pins had nothing to attach to: the local `id` beside it is a render key
        // that changes on every reload, and a note keyed on one would move to a different turn the
        // next time somebody opened the thread.
        [threadId]: items.map((it): ChatTurn =>
          it.kind === "message" && it.role === "user"
            ? { id: turnId(), itemId: it.id, role: "user", text: it.body ?? "" }
            : { id: turnId(), itemId: it.id, role: "jaroku", kind: "info", tone: "muted", text: stubText(it) },
        ),
      },
    })),

  // --- planning (the pre-generation gate) --------------------------------
  // A plan and the generation it authorises are the same session, so both write to the same
  // thread — the server resolves the generation's thread from the plan's own id — and a thread's
  // conversation therefore opens with the plan that authorised its agent.

  planStarted: ({ threadId, input, revision }) =>
    set((s) => {
      // Starting a plan consumes any plan still awaiting a decision — a revision takes its
      // predecessor's slot server-side. Marking it superseded is what stops the old card
      // sitting there with a Generate button whose id can now only be refused.
      const turns = turnsIn(s, threadId);
      const previous = livePlan(turns);
      const base = previous
        ? replaceTurn(turns, previous.id, { ...previous, status: "superseded" as const })
        : turns;
      return putTurns(s, threadId, [
        ...base,
        { id: turnId(), role: "user", text: input },
        {
          id: turnId(), role: "jaroku", kind: "plan", status: "streaming",
          planId: null, revision, prompt: input, raw: "", plan: null, warnings: [], usage: null,
        },
      ]);
    }),

  planDelta: ({ threadId, text }) =>
    set((s) => {
      const turns = turnsIn(s, threadId);
      const open = openPlan(turns);
      if (!open) return {};
      return putTurns(s, threadId, replaceTurn(turns, open.id, { ...open, raw: open.raw + text }));
    }),

  planReady: ({ threadId, planId, prompt, plan, warnings, usage, revision }) =>
    set((s) => {
      const turns = turnsIn(s, threadId);
      const open = openPlan(turns);
      const settled: PlanTurn = {
        id: open?.id ?? turnId(),
        role: "jaroku", kind: "plan", status: "pending",
        planId, revision, prompt, raw: plan.raw, plan, warnings, usage,
      };
      return putTurns(s, threadId, open ? replaceTurn(turns, open.id, settled) : [...turns, settled]);
    }),

  planDiscarded: ({ threadId, planId }) =>
    set((s) => {
      const turns = turnsIn(s, threadId);
      const turn = turns.find(
        (t): t is PlanTurn => t.role === "jaroku" && t.kind === "plan" && t.planId === planId,
      );
      // Only a plan still awaiting a decision can be discarded — never rewrite the history of
      // one already accepted.
      if (!turn || (turn.status !== "pending" && turn.status !== "stale")) return {};
      return putTurns(s, threadId, replaceTurn(turns, turn.id, { ...turn, status: "discarded" }));
    }),

  // The connector selection changed after the plan was written, so it no longer describes
  // what would be built. Deliberately NOT a blanking (which is what a stale cost estimate
  // gets): a plan is prose the user may be mid-read, so it stays legible and only loses its
  // Generate button.
  //
  // It takes a boolean because staleness is a comparison, not an event — the selection either
  // matches what the plan was written against or it doesn't. It used to be one-way: any change
  // marked the plan stale forever, so putting a mis-clicked connector back left the plan
  // unusable and the only way out was paying for another one. Ticking Slack and unticking it
  // is not a decision the user should have to buy their way out of.
  planStale: (threadId, stale) =>
    set((s) => {
      const key = threadId ?? undefined;
      const turns = turnsIn(s, key);
      const turn = livePlan(turns);
      if (!turn) return {};
      const next = stale ? "stale" : "pending";
      // Only these two statuses convert into each other. A plan that was generated, discarded or
      // superseded is finished, and the connector selection has no opinion about it any more.
      if (turn.status !== "pending" && turn.status !== "stale") return {};
      if (turn.status === next) return {};
      return putTurns(s, key, replaceTurn(turns, turn.id, { ...turn, status: next }));
    }),

  planError: ({ threadId, message }) =>
    set((s) => {
      const turns = turnsIn(s, threadId);
      const open = openPlan(turns);
      if (open) {
        return putTurns(s, threadId, replaceTurn(turns, open.id, {
          ...open, status: "error" as const, error: message,
        }));
      }
      // No plan was streaming — a refused confirm, or a stale card in another tab. It belongs
      // in the conversation as a note, not as a failed generation.
      const note: InfoTurn = { id: turnId(), role: "jaroku", kind: "info", tone: "error", text: message };
      return putTurns(s, threadId, [...turns, note]);
    }),

  // --- generation --------------------------------------------------------

  genStarted: ({ threadId, prompt }) =>
    set((s) => {
      // A confirmed plan already put the user's request in the conversation and is the thing
      // that authorised this generation — mark it accepted and don't echo the prompt again.
      const turns = turnsIn(s, threadId);
      const plan = livePlan(turns);
      const base = plan
        ? replaceTurn(turns, plan.id, { ...plan, status: "accepted" as const })
        : [...turns, { id: turnId(), role: "user" as const, text: prompt }];
      return putTurns(s, threadId, [
        ...base,
        {
          id: turnId(), role: "jaroku", kind: "gen", status: "generating",
          agentId: null, files: [], usage: null, planUsage: null,
        },
      ]);
    }),

  // No more moving a pending conversation into the agent it produced: the plan, the generation and
  // everything after it were already in the same session, which is what a thread is.
  genDone: ({ threadId, agentId, files, usage, planUsage }) =>
    set((s) => {
      const turns = turnsIn(s, threadId);
      const gen = lastGenTurn(turns);
      if (!gen) return {};
      return putTurns(s, threadId, replaceTurn(turns, gen.id, {
        ...gen, status: "done" as const, agentId, files, usage, planUsage,
      }));
    }),

  genError: ({ threadId, message, problems }) =>
    set((s) => {
      const turns = turnsIn(s, threadId);
      const gen = lastGenTurn(turns);
      if (!gen) return {};
      return putTurns(s, threadId, replaceTurn(turns, gen.id, {
        ...gen, status: "error", error: message, problems,
      }));
    }),

  // --- editing -----------------------------------------------------------

  editStarted: ({ threadId, agentId, instruction }) =>
    set((s) => ({
      streamingAgentId: agentId,
      streamingThreadId: threadId ?? null,
      ...putTurns(s, threadId, [
        ...turnsIn(s, threadId),
        { id: turnId(), role: "user", text: instruction },
        {
          id: turnId(), role: "jaroku", kind: "proposal", status: "streaming",
          agentId, proposalId: null, summary: null, files: [], streaming: [], usage: null,
        },
      ]),
    })),

  editFileStart: (path) => set((s) => touchStreaming(s, path, (f) => f ?? { path, bytes: 0, done: false })),
  editFileDelta: (path, bytes) =>
    set((s) => touchStreaming(s, path, (f) => (f ? { ...f, bytes: f.bytes + bytes } : { path, bytes, done: false }))),
  editFileEnd: (path) =>
    set((s) => touchStreaming(s, path, (f) => (f ? { ...f, done: true } : { path, bytes: 0, done: true }))),

  proposal: ({ threadId, proposalId, agentId, summary, files, usage }) =>
    set((s) => {
      const turns = turnsIn(s, threadId);
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
        streamingThreadId: null,
        ...putTurns(s, threadId, open ? replaceTurn(turns, open.id, done) : [...turns, done]),
      };
    }),

  applied: ({ threadId, proposalId, version }) =>
    set((s) => {
      const turns = turnsIn(s, threadId);
      const turn = turns.find(
        (t): t is ProposalTurn => t.role === "jaroku" && t.kind === "proposal" && t.proposalId === proposalId,
      );
      if (!turn) return {};
      return putTurns(s, threadId, replaceTurn(turns, turn.id, { ...turn, status: "applied", version }));
    }),

  undone: ({ threadId, version, summary }) =>
    set((s) => {
      const turns = turnsIn(s, threadId);
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
      return putTurns(s, threadId, [...updated, note]);
    }),

  discarded: ({ threadId, proposalId }) =>
    set((s) => {
      const turns = turnsIn(s, threadId);
      const turn = turns.find(
        (t): t is ProposalTurn => t.role === "jaroku" && t.kind === "proposal" && t.proposalId === proposalId,
      );
      if (!turn || turn.status !== "pending") return {};
      return putTurns(s, threadId, replaceTurn(turns, turn.id, { ...turn, status: "discarded" }));
    }),

  editError: ({ threadId, message, problems, agentId, proposalId }) =>
    set((s) => {
      // A refusal carries no session (see `In`), so it falls back to the one the edit was
      // streaming into — which is the session the refusal is actually about.
      const key = threadId ?? s.streamingThreadId ?? undefined;
      const owner = agentId ?? s.streamingAgentId;
      const turns = turnsIn(s, key);
      const open = owner
        ? findStreaming(turns, owner) ??
          (proposalId
            ? turns.find(
                (t): t is ProposalTurn =>
                  t.role === "jaroku" && t.kind === "proposal" && t.proposalId === proposalId,
              )
            : undefined)
        : undefined;
      if (open) {
        return {
          streamingAgentId: null,
          streamingThreadId: null,
          ...putTurns(s, key, replaceTurn(turns, open.id, {
            ...open, status: "error", error: message, problems, streaming: [],
          })),
        };
      }
      const note: InfoTurn = { id: turnId(), role: "jaroku", kind: "info", tone: "error", text: message };
      return { streamingAgentId: null, streamingThreadId: null, ...putTurns(s, key, [...turns, note]) };
    }),

  // --- explain (streaming prose reply, no code change) -------------------

  replyStarted: ({ threadId, agentId, question, regenerateOf }) =>
    set((s) => {
      const turns = turnsIn(s, threadId);
      // §5.4: A REGENERATION REPLACES THE ANSWER RATHER THAN APPENDING A SECOND CONVERSATION.
      //
      // Regenerate used to prefill the composer, so pressing it produced a second user turn with
      // the same sentence in it and a second reply beneath — two questions rather than two answers
      // to one. What somebody pressing it wants is the OTHER answer to the question they already
      // asked, which is what the `‹ n/m ›` switcher was built to move between and why the metadata
      // row reserves a slot for it.
      //
      // The replaced body moves into `priorVariants` so the switcher has something to show. See
      // `ReplyTurn.priorVariants` for why that is memory rather than a table.
      if (regenerateOf) {
        const prior = turns.find((t) => t.role === "jaroku" && t.kind === "reply" && t.itemId === regenerateOf);
        if (prior && prior.role === "jaroku" && prior.kind === "reply") {
          return {
            streamingAgentId: agentId,
            streamingThreadId: threadId ?? null,
            ...putTurns(s, threadId, replaceTurn(turns, prior.id, {
              ...prior,
              status: "streaming" as const,
              text: "",
              priorVariants: [...(prior.priorVariants ?? []), prior.text],
            })),
          };
        }
      }
      return {
        streamingAgentId: agentId,
        streamingThreadId: threadId ?? null,
        ...putTurns(s, threadId, [
          ...turns,
          { id: turnId(), role: "user", text: question },
          { id: turnId(), role: "jaroku", kind: "reply", status: "streaming", agentId, text: "" },
        ]),
      };
    }),

  /**
   * §5.4's switcher, moving between the answers this session has produced.
   *
   * A SWAP RATHER THAN A POINTER, because there is no list to index into: `text` is what is on
   * screen and `priorVariants` is what is not, so showing an older one means exchanging them. That
   * keeps every other reader of a `ReplyTurn` — the copy button, the notes rail, `turnSource` —
   * reading the same field it always did, rather than each learning which variant is current.
   */
  switchVariant: ({ threadId, turnId: itemId, ordinal }) =>
    set((s) => {
      const turns = turnsIn(s, threadId);
      const turn = turns.find((t) => t.role === "jaroku" && t.kind === "reply" && t.itemId === itemId);
      if (!turn || turn.role !== "jaroku" || turn.kind !== "reply") return {};
      const prior = turn.priorVariants ?? [];
      // Ordinals are 1-based and the last one is what is on screen, so anything outside the
      // priors' range is either the current answer or a number nothing produced.
      const at = ordinal - 1;
      if (at < 0 || at >= prior.length) return {};
      const swapped = [...prior];
      swapped[at] = turn.text;
      return putTurns(s, threadId, replaceTurn(turns, turn.id, {
        ...turn, text: prior[at]!, priorVariants: swapped,
      }));
    }),

  replyDelta: ({ threadId, agentId, text }) =>
    set((s) => {
      const turns = turnsIn(s, threadId);
      const open = findReply(turns, agentId);
      if (!open) return {};
      return putTurns(s, threadId, replaceTurn(turns, open.id, { ...open, text: open.text + text }));
    }),

  replyDone: ({ threadId, agentId, usage }) =>
    set((s) => {
      const turns = turnsIn(s, threadId);
      const open = findReply(turns, agentId);
      if (!open) return { streamingAgentId: null, streamingThreadId: null };
      return {
        streamingAgentId: null,
        streamingThreadId: null,
        // KEPT WHEN THE EVENT CARRIES NONE, rather than nulled. A `done` with no usage is an answer
        // that had nothing to report about itself — the no-key path streams the raw context and
        // never calls a model — not one whose metadata was withdrawn.
        ...putTurns(s, threadId, replaceTurn(turns, open.id, {
          ...open, status: "done" as const, ...(usage ? { usage } : {}),
        })),
      };
    }),

  replyError: ({ threadId, agentId, message }) =>
    set((s) => {
      const key = threadId ?? s.streamingThreadId ?? undefined;
      const turns = turnsIn(s, key);
      const open = findReply(turns, agentId);
      const next = open
        ? replaceTurn(turns, open.id, { ...open, status: "error" as const, text: open.text || message })
        : [...turns, { id: turnId(), role: "jaroku" as const, kind: "info" as const, tone: "error" as const, text: message }];
      return { streamingAgentId: null, streamingThreadId: null, ...putTurns(s, key, next) };
    }),
}));

/**
 * What a rehydrated non-message item says (§4.5).
 *
 * A SENTENCE, NOT A REVIVED CARD. `thread_items` records that a run, plan, generation, proposal or
 * eval happened in this session — the thing itself lives in its own table or, for a proposal, only
 * in the process that made it. Rendering a diff card from a row like this would offer an Apply
 * button for a proposal that no longer exists anywhere, which is exactly the "sending them to a
 * button that can only refuse" the derivation goes out of its way to avoid.
 */
function stubText(item: ThreadItemView): string {
  switch (item.kind) {
    case "run": return "Ran the agent.";
    case "eval": return "Started an eval.";
    case "plan": return "Wrote a plan.";
    case "generation": return "Generated the agent.";
    case "proposal": return "Proposed an edit.";
    // A message with no `user` role, which nothing writes today. Its body is still the truest
    // thing available about it, so it is shown rather than replaced with a category.
    default: return item.body ?? "";
  }
}

/** The plan turn currently streaming, if any. */
function openPlan(turns: ChatTurn[]): PlanTurn | undefined {
  for (let i = turns.length - 1; i >= 0; i--) {
    const t = turns[i];
    if (t && t.role === "jaroku" && t.kind === "plan" && t.status === "streaming") return t;
  }
  return undefined;
}

/** The plan turn still awaiting a decision (pending or gone stale), if any. */
function livePlan(turns: ChatTurn[]): PlanTurn | undefined {
  for (let i = turns.length - 1; i >= 0; i--) {
    const t = turns[i];
    if (t && t.role === "jaroku" && t.kind === "plan" && (t.status === "pending" || t.status === "stale")) {
      return t;
    }
  }
  return undefined;
}

/** True while a plan is streaming. Folded into the composer's `busy` so the disabled Send
 *  button — the affordance already in place for a generation or an edit — also gates a second
 *  plan, rather than relying on a server refusal the user only sees after clicking.
 *
 *  Over the turns of ONE session, since that is what the composer is looking at: a plan streaming
 *  in another thread is not something this composer's Send button should be waiting on. */
export function isPlanning(turns: ChatTurn[]): boolean {
  return turns.some((t) => t.role === "jaroku" && t.kind === "plan" && t.status === "streaming");
}

/** The id of the plan awaiting a decision in this session. The composer reads this to route a typed
 *  message as a revision rather than a fresh plan, and to invalidate on a connector change. */
export function pendingPlanId(turns: ChatTurn[]): string | null {
  return livePlan(turns)?.planId ?? null;
}

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

/**
 * Update (or insert) one streaming-file row on the currently streaming proposal turn.
 *
 * A file event carries neither an agent nor a session, so both come from what the `started` event
 * recorded. Two edits cannot be in flight at once — the editor is single-slot — so one slot each is
 * the whole of the state this needs.
 */
function touchStreaming(
  s: {
    threads: Record<string, ChatTurn[]>;
    pending: ChatTurn[];
    streamingAgentId: string | null;
    streamingThreadId: string | null;
  },
  path: string,
  update: (f: { path: string; bytes: number; done: boolean } | undefined) => { path: string; bytes: number; done: boolean },
): Partial<ChatState> {
  const agentId = s.streamingAgentId;
  if (!agentId) return {};
  const key = s.streamingThreadId ?? undefined;
  const turns = turnsIn(s, key);
  const open = findStreaming(turns, agentId);
  if (!open) return {};
  const existing = open.streaming.find((f) => f.path === path);
  const streaming = existing
    ? open.streaming.map((f) => (f.path === path ? update(f) : f))
    : [...open.streaming, update(undefined)];
  return putTurns(s, key, replaceTurn(turns, open.id, { ...open, streaming }));
}

/**
 * The turns to render for the current selection — one THREAD's conversation (§3.1, §4.5).
 *
 * Takes the thread rather than the agent, which is the whole of BUG-03: two sessions on one agent
 * used to resolve to the same array here, so opening either showed the other's work.
 */
export function threadFor(
  state: { threads: Record<string, ChatTurn[]>; pending: ChatTurn[] },
  threadId: string | null,
): ChatTurn[] {
  if (threadId) return state.threads[threadId] ?? [];
  return state.pending;
}
