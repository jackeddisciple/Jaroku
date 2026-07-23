// UI intent store — the small amount of cross-component UI state the command palette and
// keyboard shortcuts need to reach (which right-tab is showing, focusing the chat, and the
// run provider/model so the palette can run or switch provider). Kept separate from the trace
// and build stores, which own real data; this is ephemeral view state only.

import { create } from "zustand";

export type RightTab = "graph" | "trace" | "evals" | "code";

export const RUN_PROVIDERS = [
  { id: "fake", label: "Dry run (free)", models: ["fake-dry-run"] },
  { id: "anthropic", label: "Claude", models: ["claude-haiku-4-5", "claude-sonnet-5", "claude-opus-4-8"] },
  { id: "openai", label: "OpenAI", models: ["gpt-4o-mini", "gpt-4o"] },
] as const;

interface UiState {
  paletteOpen: boolean;
  setPaletteOpen: (v: boolean) => void;

  // The right panel's active tab, lifted here so the palette / shortcuts can switch it while
  // RightPanel's own auto-follow (generation → code, new run → trace) still writes the same field.
  rightTab: RightTab;
  setRightTab: (t: RightTab) => void;

  // Bumped to ask the chat composer to take focus (Cmd+/). A nonce, not a boolean, so repeated
  // requests always fire an effect.
  focusChatNonce: number;
  focusChat: () => void;

  // One-Click Fix: pre-fill the composer with error + code context, then let the user send it
  // through the normal edit/fix loop. The nonce fires the effect even for identical text.
  chatPrefill: string;
  chatPrefillNonce: number;
  prefillChat: (text: string) => void;

  // Run config, lifted from RunTrigger so the palette can run and switch provider.
  provider: string;
  model: string;
  setProvider: (id: string) => void;
  setModel: (m: string) => void;
}

export const useUiStore = create<UiState>((set) => ({
  paletteOpen: false,
  setPaletteOpen: (paletteOpen) => set({ paletteOpen }),

  rightTab: "trace",
  setRightTab: (rightTab) => set({ rightTab }),

  focusChatNonce: 0,
  focusChat: () => set((s) => ({ focusChatNonce: s.focusChatNonce + 1 })),

  chatPrefill: "",
  chatPrefillNonce: 0,
  prefillChat: (text) => set((s) => ({ chatPrefill: text, chatPrefillNonce: s.chatPrefillNonce + 1 })),

  provider: "fake",
  model: "fake-dry-run",
  setProvider: (id) =>
    set({
      provider: id,
      model: RUN_PROVIDERS.find((p) => p.id === id)?.models[0] ?? "",
    }),
  setModel: (model) => set({ model }),
}));
