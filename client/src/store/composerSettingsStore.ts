// What the conversation is set to — reasoning effort and permission mode, mirrored from the server.
//
// A STORE THAT MIRRORS, NEVER ONE THAT DECIDES. Same discipline as providerStore, and for a
// sharper reason here: the server resolves a conversation's settings through the workspace default
// and the admin's pin, so what a user picked and what is in effect are genuinely different values.
// A store that optimistically wrote the picked one would render a permission mode nobody is
// running under — which is exactly the failure §3.2 is trying to prevent when it makes a pinned
// control read-only.
//
// SO THE PATCH'S RESPONSE IS THE TRUTH, not the request. Every mutation here replaces local state
// with what came back. The visible cost is a control that waits for a round trip; the alternative
// is a shield that says Fast while the server confirms every tool call, and a user who concludes
// the setting does nothing.
//
// KEYED BY CONVERSATION, because that is the scope §7 gives these. `null` covers the composer
// before a thread exists — a brand-new agent's first message — which has no row and therefore
// simply reads the workspace defaults.
//
// PER-TURN OVERRIDES DO NOT LIVE HERE. §3.2: "Per-turn override is allowed and is not sticky
// unless 'Remember' is checked." An override that was not remembered is a property of the message
// being composed, so it is held beside the draft in the composer, and this store only ever sees
// what somebody asked to persist.

import { create } from "zustand";
import { apiRequest } from "../lib/http.ts";

export type Effort = "low" | "medium" | "high" | "xhigh";
export type PermissionMode = "strict" | "smart" | "fast";

export const EFFORT_LEVELS: readonly Effort[] = ["low", "medium", "high", "xhigh"];
export const PERMISSION_MODES: readonly PermissionMode[] = ["strict", "smart", "fast"];

/** What the server says is in effect, which is not always what was asked for. */
export interface ConversationSettings {
  reasoning_effort: Effort;
  permission_mode: PermissionMode;
  /** A workspace admin pinned the mode — the control renders read-only with a tooltip (§3.2). */
  permission_mode_pinned: boolean;
  /** Fast is disallowed workspace-wide — the option renders disabled, never hidden. */
  fast_disallowed: boolean;
  /** Whether this conversation has said anything of its own, or is inheriting. */
  explicit: { effort: boolean; permissionMode: boolean };
}

/** Jaroku's defaults, for the moment before the first snapshot lands. */
export const FALLBACK_SETTINGS: ConversationSettings = {
  reasoning_effort: "medium",
  permission_mode: "smart",
  permission_mode_pinned: false,
  fast_disallowed: false,
  explicit: { effort: false, permissionMode: false },
};

/** The key a conversation's settings live under. `__none` is the composer with no thread yet. */
const keyFor = (conversationId: string | null): string => conversationId ?? "__none";

interface State {
  byConversation: Record<string, ConversationSettings>;
  /** In flight, so a control can render as busy rather than as changed. */
  saving: Record<string, true>;
  /** The last refusal, in words, for the control that caused it. Cleared on the next success. */
  error: string | null;

  settingsFor(conversationId: string | null): ConversationSettings;
  load(conversationId: string | null): Promise<void>;
  patch(
    conversationId: string | null,
    patch: { reasoning_effort?: Effort | null; permission_mode?: PermissionMode | null },
  ): Promise<void>;
  clearError(): void;
}

export const useComposerSettingsStore = create<State>((set, get) => ({
  byConversation: {},
  saving: {},
  error: null,

  settingsFor: (conversationId) => get().byConversation[keyFor(conversationId)] ?? FALLBACK_SETTINGS,

  load: async (conversationId) => {
    // A composer with no thread has no row to read and no route to read it from — the id is part
    // of the path. It runs on the workspace defaults, which is what FALLBACK_SETTINGS already says.
    if (!conversationId) return;
    try {
      const body = await apiRequest<ConversationSettings>(
        "GET", `/v1/conversations/${encodeURIComponent(conversationId)}/settings`,
      );
      set((s) => ({ byConversation: { ...s.byConversation, [keyFor(conversationId)]: body } }));
    } catch {
      // SILENT ON READ, LOUD ON WRITE. A failed read leaves the defaults showing, which is both
      // honest and harmless; a failed write must be surfaced, because the user believes they just
      // changed something. An error banner over a control somebody never touched is noise.
    }
  },

  patch: async (conversationId, patch) => {
    if (!conversationId) {
      set({ error: "Start the conversation before changing its settings." });
      return;
    }
    const key = keyFor(conversationId);
    set((s) => ({ saving: { ...s.saving, [key]: true }, error: null }));
    try {
      const body = await apiRequest<ConversationSettings>(
        "PATCH", `/v1/conversations/${encodeURIComponent(conversationId)}/settings`, patch,
      );
      set((s) => ({
        byConversation: { ...s.byConversation, [key]: body },
        saving: omit(s.saving, key),
        error: null,
      }));
    } catch (err) {
      // The server's own sentence, which for a 409 names the policy that refused — "a workspace
      // admin has pinned the permission mode for this workspace". A generic "couldn't save" would
      // leave the user retrying a control that will refuse them every time.
      set((s) => ({ saving: omit(s.saving, key), error: (err as Error)?.message ?? "Couldn't save that setting." }));
    }
  },

  clearError: () => set({ error: null }),
}));

function omit<T>(map: Record<string, T>, key: string): Record<string, T> {
  const next = { ...map };
  delete next[key];
  return next;
}
