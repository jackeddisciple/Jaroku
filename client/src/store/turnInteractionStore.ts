// Notes, pins and feedback, mirrored from the server.
//
// A STORE THAT MIRRORS, like composerSettingsStore and for a sharper reason on one of the three:
// a pin is PER USER, and the only thing that knows who is asking is the server. A store that
// optimistically added a pin locally would be right until somebody opened the same thread in a
// second window signed in as somebody else.
//
// NOTES ARE OPTIMISTIC AND PINS AND FEEDBACK ARE NOT, and that split is §9's:
//
//   "Note saved offline — Optimistic render with pending treatment; reconcile or surface failure —
//   never silently drop."
//
// A note is somebody's sentence, typed just now, and making them watch a spinner before it appears
// would make annotating a thread feel like filing a ticket. A pin and a thumb are one click with
// nothing to lose, and both have server-side rules — the five-pin cap, the one-row-per-person key
// — that a local guess would have to duplicate to be right about.
//
// SO A PENDING NOTE CARRIES `pending` AND A FAILED ONE CARRIES `error`. Neither is ever removed
// silently: §9's "never silently drop" means a note that could not be saved stays on screen saying
// so, because the alternative is somebody believing they warned their team.

import { create } from "zustand";
import { apiRequest } from "../lib/http.ts";

export interface TurnNote {
  id: string;
  turn_id: string;
  author_id: string | null;
  author_name: string | null;
  body: string;
  created_at: string;
  updated_at: string;
  /** True while the write is in flight — §9's "optimistic render with pending treatment". */
  pending?: boolean;
  /** Set when the write failed. The note stays on screen with a retry rather than vanishing. */
  error?: string;
}

export interface FeedbackSummary {
  up: number;
  down: number;
  mine: -1 | 1 | null;
}

/** §5.5's picker, in the order it renders. Mirrored from the server's closed set. */
export const FEEDBACK_REASONS = [
  { id: "wrong_code", label: "Wrong code" },
  { id: "ignored_instruction", label: "Ignored my instruction" },
  { id: "too_slow", label: "Too slow" },
  { id: "broke_something", label: "Broke something" },
  { id: "other", label: "Other" },
] as const;

export type FeedbackReason = (typeof FEEDBACK_REASONS)[number]["id"];

interface State {
  notes: Record<string, TurnNote[]>;
  /** Turn ids this user has pinned, in the conversation currently open. */
  pins: string[];
  feedback: Record<string, FeedbackSummary>;
  error: string | null;

  notesFor(turnId: string): TurnNote[];
  feedbackFor(turnId: string): FeedbackSummary;
  isPinned(turnId: string): boolean;

  loadTurn(turnId: string): Promise<void>;
  loadPins(conversationId: string): Promise<void>;
  addNote(turnId: string, body: string): Promise<void>;
  deleteNote(turnId: string, noteId: string): Promise<void>;
  togglePin(conversationId: string, turnId: string): Promise<void>;
  setFeedback(
    turnId: string,
    rating: -1 | 1 | null,
    reasons?: FeedbackReason[],
    comment?: string | null,
  ): Promise<void>;
  clearError(): void;
}

const EMPTY_FEEDBACK: FeedbackSummary = { up: 0, down: 0, mine: null };

/** A local id for a note that has not been saved yet. Replaced by the server's on reconcile. */
let pendingSeq = 0;
const pendingId = (): string => `pending-${++pendingSeq}`;

export const useTurnInteractionStore = create<State>((set, get) => ({
  notes: {},
  pins: [],
  feedback: {},
  error: null,

  notesFor: (turnId) => get().notes[turnId] ?? [],
  feedbackFor: (turnId) => get().feedback[turnId] ?? EMPTY_FEEDBACK,
  isPinned: (turnId) => get().pins.includes(turnId),

  loadTurn: async (turnId) => {
    try {
      const body = await apiRequest<{ notes: TurnNote[]; feedback: FeedbackSummary }>(
        "GET", `/v1/turns/${encodeURIComponent(turnId)}/interaction`,
      );
      set((s) => ({
        notes: { ...s.notes, [turnId]: body.notes ?? [] },
        feedback: { ...s.feedback, [turnId]: body.feedback ?? EMPTY_FEEDBACK },
      }));
    } catch {
      // Silent on read. A turn whose annotations could not be fetched renders without them, which
      // is honest; an error banner over a turn nobody touched is noise.
    }
  },

  loadPins: async (conversationId) => {
    try {
      const body = await apiRequest<{ pins: { turn_id: string }[] }>(
        "GET", `/v1/conversations/${encodeURIComponent(conversationId)}/pins`,
      );
      set({ pins: (body.pins ?? []).map((p) => p.turn_id) });
    } catch {
      // Same reasoning. An unreachable rail renders empty rather than wrong.
    }
  },

  addNote: async (turnId, body) => {
    // §9's optimistic render. The note appears the instant it is written, with `pending` on it, so
    // annotating a thread does not feel like filing a ticket.
    const local: TurnNote = {
      id: pendingId(), turn_id: turnId, author_id: null, author_name: null,
      body, created_at: new Date().toISOString(), updated_at: new Date().toISOString(),
      pending: true,
    };
    set((s) => ({ notes: { ...s.notes, [turnId]: [...(s.notes[turnId] ?? []), local] } }));

    try {
      const saved = await apiRequest<{ notes: TurnNote[] }>(
        "POST", `/v1/turns/${encodeURIComponent(turnId)}/notes`, { body },
      );
      // Reconciled by REPLACEMENT rather than by patching the pending row: the server's list is
      // the record, and a merge would leave a local note alive if the server had rejected it.
      set((s) => ({ notes: { ...s.notes, [turnId]: saved.notes ?? [] } }));
    } catch (err) {
      // NEVER SILENTLY DROPPED — §9. The note stays where the user put it, marked as failed, so
      // nobody walks away believing they warned their team.
      set((s) => ({
        notes: {
          ...s.notes,
          [turnId]: (s.notes[turnId] ?? []).map((n) =>
            n.id === local.id ? { ...n, pending: false, error: (err as Error)?.message ?? "Couldn't save this note." } : n,
          ),
        },
      }));
    }
  },

  deleteNote: async (turnId, noteId) => {
    try {
      const body = await apiRequest<{ notes: TurnNote[] }>(
        "DELETE", `/v1/turns/${encodeURIComponent(turnId)}/notes/${encodeURIComponent(noteId)}`,
      );
      set((s) => ({ notes: { ...s.notes, [turnId]: body.notes ?? [] } }));
    } catch (err) {
      set({ error: (err as Error)?.message ?? "Couldn't delete that note." });
    }
  },

  togglePin: async (conversationId, turnId) => {
    const pinned = get().isPinned(turnId);
    try {
      const body = await apiRequest<{ pins: { turn_id: string }[]; at_limit?: boolean }>(
        pinned ? "DELETE" : "PUT",
        `/v1/turns/${encodeURIComponent(turnId)}/pin?conversation=${encodeURIComponent(conversationId)}`,
      );
      set({ pins: (body.pins ?? []).map((p) => p.turn_id), error: null });
      // §5.3: "pinning a 6th prompts to unpin one." The server answers with the refusal rather
      // than an error status, because the client's response is a prompt and not a failure.
      if (body.at_limit) set({ error: "You can pin five turns in a conversation. Unpin one to add another." });
    } catch (err) {
      set({ error: (err as Error)?.message ?? "Couldn't change that pin." });
    }
  },

  setFeedback: async (turnId, rating, reasons = [], comment = null) => {
    try {
      const body = await apiRequest<FeedbackSummary>(
        "PUT", `/v1/turns/${encodeURIComponent(turnId)}/feedback`,
        { rating, reasons, comment },
      );
      set((s) => ({ feedback: { ...s.feedback, [turnId]: body }, error: null }));
    } catch (err) {
      set({ error: (err as Error)?.message ?? "Couldn't record that." });
    }
  },

  clearError: () => set({ error: null }),
}));
