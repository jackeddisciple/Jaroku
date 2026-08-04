// Model-provider credentials: which env var holds which key, whether one is set, and whether
// a key the user just typed actually works.
//
// The product is bring-your-own-key. Jaroku never proxies or resells access — a provider key
// is the user's, it goes into runtime/.env through the SAME writer everything else uses
// (envWriter.ts), and it is read from the environment at the moment of use. This module is
// the one place that knows the provider -> variable mapping, so nothing else has to guess it.
//
// Three rules, all inherited rather than invented:
//
//   * `configured` means A NAMED VARIABLE IS SET. It is deliberately not "this provider is
//     fine" and never carries the value — the same distinction McpRegistry.configured() draws
//     for MCP credentials, for the same reason: a client that learns a key exists can render
//     the truth; a client that learns the key has a secret to leak.
//
//   * The presence check reads process.env, which loadRuntimeEnv already populated from
//     runtime/.env at startup with the "environment wins" precedence. It is never a file read,
//     and there is no second copy of the check anywhere.
//
//   * A key passed to verifyProviderKey() is used in that call and dropped. Not logged, not
//     returned, not stored, not held past the await.

import { verifyAnthropicKey } from "./claude.ts";

/**
 * The variable each provider's key lives under.
 *
 * These names are not ours to choose — they are the ones the Python runtime's provider
 * selection expects (runtime/jaroku_runner/models.py, via langchain_anthropic /
 * langchain_openai) and the ones the README tells people to set by hand. Writing a different
 * name would produce a .env that looks right and works for nothing.
 */
export const PROVIDER_ENV_KEY = {
  anthropic: "ANTHROPIC_API_KEY",
  openai: "OPENAI_API_KEY",
} as const;

export type ProviderId = keyof typeof PROVIDER_ENV_KEY;

/** `fake` is not a provider you connect — it is the free dry-run path, and needs no key. */
export const PROVIDER_IDS = Object.keys(PROVIDER_ENV_KEY) as ProviderId[];

export function isProviderId(id: unknown): id is ProviderId {
  return typeof id === "string" && id in PROVIDER_ENV_KEY;
}

export interface ProviderStatus {
  id: ProviderId;
  /** The NAME of the variable holding this provider's key. Never a value. */
  env_key: string;
  configured: boolean;
  /**
   * Whether Jaroku ITSELF thinks with this provider.
   *
   * Worth reporting rather than leaving the UI to hardcode: planning, generation, the fix
   * loop, explain and the eval judge are Anthropic-only (claude.ts, planner.ts, explainer.ts,
   * judge/score.ts). Connecting OpenAI lets an AGENT run on GPT and nothing more, and a user
   * who is told that up front does not connect a key and then wonder why they still cannot
   * build anything.
   */
  powers_jaroku: boolean;
}

/** Which provider keys are set, by name. The single source is process.env, as everywhere else. */
export function providerStatus(): ProviderStatus[] {
  return PROVIDER_IDS.map((id) => ({
    id,
    env_key: PROVIDER_ENV_KEY[id],
    configured: Boolean(process.env[PROVIDER_ENV_KEY[id]]),
    powers_jaroku: id === "anthropic",
  }));
}

/** How long a validation call may take before it is called a failure. */
const VERIFY_TIMEOUT_MS = Number(process.env.JAROKU_PROVIDER_TIMEOUT_MS ?? 10_000);

/**
 * Ask OpenAI whether this key authenticates.
 *
 * A bare fetch rather than a dependency: there is no OpenAI SDK on the Node side (the Python
 * runtime owns the OpenAI path), and adding one so a button can say "connected" would be a
 * lot of supply chain for one GET. `/v1/models` is the lightest endpoint that answers the
 * only question being asked, and it costs nothing.
 */
async function verifyOpenAiKey(key: string): Promise<{ ok: boolean; message: string | null }> {
  try {
    const res = await fetch("https://api.openai.com/v1/models?limit=1", {
      headers: { authorization: `Bearer ${key}` },
      signal: AbortSignal.timeout(VERIFY_TIMEOUT_MS),
    });
    if (res.ok) return { ok: true, message: null };
    // The body carries OpenAI's own reason ("Incorrect API key provided: sk-...")— which is
    // more useful than a bare status — but it can echo a prefix of the key back, and this
    // string is about to be rendered in a browser and possibly pasted into an issue. The
    // status line says enough.
    return {
      ok: false,
      message:
        res.status === 401
          ? "OpenAI rejected that key (401). Check it was copied whole."
          : `OpenAI answered ${res.status} ${res.statusText}`,
    };
  } catch (err) {
    const message = (err as Error)?.name === "TimeoutError"
      ? `OpenAI did not answer within ${Math.round(VERIFY_TIMEOUT_MS / 1000)}s`
      : ((err as Error)?.message ?? String(err));
    return { ok: false, message };
  }
}

/**
 * Prove a key works, WITHOUT writing it.
 *
 * Separate from storing it on purpose: "Test connection" must not put a credential on disk
 * before the user has pressed Save. Both providers are checked with a models-list call, so
 * testing a key is free — the alternative, a one-token completion, bills a user for finding
 * out whether they typed their own key correctly.
 */
export async function verifyProviderKey(
  provider: ProviderId,
  key: string,
): Promise<{ ok: boolean; message: string | null }> {
  if (!key.trim()) return { ok: false, message: "no key was entered" };
  return provider === "anthropic" ? verifyAnthropicKey(key) : verifyOpenAiKey(key);
}
