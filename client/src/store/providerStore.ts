// The provider store — which model providers have a key, and how the last test went.
//
// Separate from uiStore for the reason every other store here is separate: a different
// invariant. uiStore holds view intent the user can flip freely; this holds a fact the SERVER
// owns and the client only mirrors. A component must never be able to set `configured` — the
// only thing that makes it true is a key existing in runtime/.env, and a store that let the UI
// assert otherwise would let a button claim a provider was connected when nothing was written.
//
// Every message on this channel is a FULL SNAPSHOT, so `setProviders` is a replace and never a
// merge — the same discipline as mcpStore and evalStore.
//
// Nothing in here ever holds a key. `configured` means A NAMED VARIABLE IS SET on the server,
// which is the whole of what the browser is ever told.

import { create } from "zustand";
import type { ProviderId, ProviderStatus } from "../types.ts";

/** The answer to one "Test connection" press. Transient — it describes a moment, not state. */
export interface ProviderTestResult {
  provider: string;
  ok: boolean;
  message: string | null;
}

interface ProviderState {
  providers: ProviderStatus[];
  /**
   * Whether the first snapshot has landed.
   *
   * Load-bearing rather than cosmetic: before it does, "no provider is configured" and "we have
   * not been told yet" look identical, and onboarding would flash the free-path framing at a
   * user who has a key. Everything that branches on configuration waits for this.
   */
  loaded: boolean;
  /** Providers with a test in flight, so the button can say it is working. */
  testing: Record<string, true>;
  testResult: ProviderTestResult | null;
  error: string | null;
  notice: string | null;

  setProviders: (providers: ProviderStatus[]) => void;
  startTest: (provider: string) => void;
  setTestResult: (result: ProviderTestResult) => void;
  clearTestResult: () => void;
  setError: (message: string | null) => void;
  setNotice: (message: string | null) => void;
}

export const useProviderStore = create<ProviderState>((set) => ({
  providers: [],
  loaded: false,
  testing: {},
  testResult: null,
  error: null,
  notice: null,

  // A snapshot settles every question a test could still be waiting on, so in-flight state is
  // cleared wholesale rather than by key — a failure we did not anticipate cannot leave a
  // spinner running forever. Same reasoning as mcpStore.setServers.
  setProviders: (providers) => set({ providers, loaded: true, testing: {} }),

  startTest: (provider) =>
    set((s) => ({ testing: { ...s.testing, [provider]: true }, testResult: null, error: null })),

  setTestResult: (testResult) =>
    set((s) => {
      const testing = { ...s.testing };
      delete testing[testResult.provider];
      return { testResult, testing };
    }),

  clearTestResult: () => set({ testResult: null }),

  // An error ends any test it could describe: the server answers a bad command on this channel
  // instead of a testResult, and without this the button spins until the page is reloaded.
  setError: (error) => set({ error, testing: {} }),
  setNotice: (notice) => set({ notice }),
}));

/** Whether a named provider has a key on the server. False until the first snapshot lands. */
export function isConfigured(providers: ProviderStatus[], id: ProviderId): boolean {
  return providers.some((p) => p.id === id && p.configured);
}

/**
 * Whether Jaroku itself can plan, generate, edit and explain.
 *
 * The distinction the run-provider dropdown does not make: `fake` runs an agent for free, but
 * BUILDING one goes through Anthropic. Asking the snapshot rather than hardcoding "anthropic"
 * keeps the rule in one place — the server flags which provider powers Jaroku.
 */
export function canBuild(providers: ProviderStatus[]): boolean {
  return providers.some((p) => p.powers_jaroku && p.configured);
}
