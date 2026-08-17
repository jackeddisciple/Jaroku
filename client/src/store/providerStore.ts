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
import type { ProviderId, ProviderModel, ProviderStatus } from "../types.ts";

/** The answer to one "Test connection" press. Transient — it describes a moment, not state. */
export interface ProviderTestResult {
  provider: string;
  ok: boolean;
  message: string | null;
}

interface ProviderState {
  providers: ProviderStatus[];
  /**
   * Every model a run may be started on, from the server's price sheet.
   *
   * THE CATALOGUE USED TO BE A CONSTANT IN THIS CLIENT, and it had drifted four models behind
   * `runtime/pricing.json` — which declares itself the single source of truth for models and is read
   * by the Node estimator and the Python interceptor. So a model added to the priced table could not
   * be selected for a run, added as an eval leg, or deployed with, and nothing failed: the drift was
   * invisible because the two lists had no reason to be compared.
   *
   * It is the same channel `configured` arrives on, because the two are asked together — every model
   * selector renders a provider's models and whether that provider has a key.
   */
  models: ProviderModel[];
  /**
   * Whether the first snapshot has landed.
   *
   * Load-bearing rather than cosmetic: before it does, "no provider is configured" and "we have
   * not been told yet" look identical, and onboarding would flash the free-path framing at a
   * user who has a key. Everything that branches on configuration waits for this.
   */
  loaded: boolean;
  /**
   * Whether THIS WORKSPACE'S key pays for the calls Jaroku makes on its behalf.
   *
   * A preference rather than a credential, and the one thing on this channel a component may ask
   * the server to change. It rides the providers snapshot because it is meaningless without the
   * list beside it — a checkbox saying "my key pays for generation" is nonsense next to a provider
   * that has no key.
   */
  ownKeyForPlatform: boolean;
  /** Providers with a test in flight, so the button can say it is working. */
  testing: Record<string, true>;
  testResult: ProviderTestResult | null;
  error: string | null;
  notice: string | null;

  setProviders: (providers: ProviderStatus[], ownKeyForPlatform: boolean, models: ProviderModel[]) => void;
  startTest: (provider: string) => void;
  setTestResult: (result: ProviderTestResult) => void;
  clearTestResult: () => void;
  setError: (message: string | null) => void;
  setNotice: (message: string | null) => void;
}

export const useProviderStore = create<ProviderState>((set) => ({
  providers: [],
  models: [],
  loaded: false,
  ownKeyForPlatform: false,
  testing: {},
  testResult: null,
  error: null,
  notice: null,

  // A snapshot settles every question a test could still be waiting on, so in-flight state is
  // cleared wholesale rather than by key — a failure we did not anticipate cannot leave a
  // spinner running forever. Same reasoning as mcpStore.setServers.
  setProviders: (providers, ownKeyForPlatform, models) =>
    set({ providers, ownKeyForPlatform, models, loaded: true, testing: {} }),

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

/** A provider and the models a run may be started on with it. What every model selector renders. */
export interface RunProvider {
  id: string;
  label: string;
  models: string[];
}

/**
 * The dry-run path, for the moment before the first snapshot lands.
 *
 * NOT A FALLBACK CATALOGUE — one entry, and the one the app already defaults to. A selector with
 * nothing in it reads as "this product supports no models", and a hardcoded copy of the real
 * catalogue is exactly what this change exists to remove. `fake-dry-run` is guaranteed: it is in the
 * price sheet, it is `uiStore`'s default provider and model, and it costs nothing.
 */
const DRY_RUN: RunProvider[] = [{ id: "fake", label: "Dry run (free)", models: ["fake-dry-run"] }];

/**
 * The catalogue, grouped by provider, in the price sheet's own order.
 *
 * ORDER IS THE FILE'S. `pricing.json` is a curated list with the newest models first, and re-sorting
 * here would put a client's opinion in front of the one the price sheet already expresses.
 *
 * Pure, and takes the list rather than reading the store, so a component can memoise it against the
 * snapshot's array identity instead of rebuilding a catalogue on every unrelated render.
 */
export function runProviders(models: ProviderModel[]): RunProvider[] {
  if (models.length === 0) return DRY_RUN;
  const out: RunProvider[] = [];
  for (const m of models) {
    const existing = out.find((p) => p.id === m.provider);
    if (existing) existing.models.push(m.id);
    else out.push({ id: m.provider, label: m.label, models: [m.id] });
  }
  return out;
}

/** The model a provider defaults to: its first in the catalogue. Empty for one nothing offers. */
export function defaultModelFor(models: ProviderModel[], provider: string): string {
  return runProviders(models).find((p) => p.id === provider)?.models[0] ?? "";
}

/**
 * What a provider is CALLED, from the server's own table.
 *
 * THIS REPLACED TWO HARDCODED COPIES that disagreed. The composer's selector had one with four
 * entries; the top bar's provider menu had another with three and no `google` key, so it fell back to
 * the raw id — the same provider was "Gemini" where you picked it and `google` where you configured
 * it. The label now arrives beside the models it belongs to.
 *
 * Falls back to the id, which is what an unnamed provider should read as: a name nobody chose is
 * better than a name this client invented.
 */
export function providerLabelOf(models: ProviderModel[], provider: string): string {
  return models.find((m) => m.provider === provider)?.label ?? provider;
}
