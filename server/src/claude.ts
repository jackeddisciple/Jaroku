// Shared Anthropic plumbing for the generation and edit flows: one lazy client, one
// usage/cost accounting. The API key is read from the process env (loaded from runtime/.env
// by index.ts) and never logged, echoed to a client, or written anywhere.

import Anthropic from "@anthropic-ai/sdk";
import { costFor } from "./pricing.ts";

export interface UsageSummary {
  input_tokens: number;
  output_tokens: number;
  cache_read_input_tokens: number;
  cache_creation_input_tokens: number;
  cost_usd: number;
}

// The model generation/editing bills against. Its rates — and the cache multipliers —
// come from the shared runtime/pricing.json, not from constants here: a second copy of a
// price is a copy that drifts.
export const GENERATION_MODEL = "claude-haiku-4-5";

let client: Anthropic | null = null;
// The key the memoized client was built with.
//
// Memoizing on existence alone was fine while the key could only arrive before startup. It
// can now be written mid-session (the onboarding flow — see providers.ts), and a client built
// from a key the user has since replaced would keep authenticating as the old one for the rest
// of the process, with no way to tell from the outside. Comparing the value costs nothing and
// makes "connect a provider" take effect without a restart.
let clientKey: string | null = null;

export function anthropicClient(): Anthropic {
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) throw new Error("ANTHROPIC_API_KEY is not set (expected in runtime/.env)");
  if (!client || clientKey !== key) {
    client = new Anthropic({ apiKey: key });
    clientKey = key;
  }
  return client;
}

/**
 * Prove a key authenticates, without writing it anywhere.
 *
 * It lives here because this is the one module allowed to construct the Anthropic SDK, and a
 * key the user has typed but not yet saved is not in `process.env` — so `anthropicClient()`
 * cannot be the thing that tests it. Everything else about the discipline holds: the value is
 * used in this call and nowhere else, never logged, never returned, never stored.
 *
 * `models.list()` rather than a test completion: it authenticates just as conclusively and
 * costs nothing, and "Money asks first" should apply to the button that checks a key too.
 */
export async function verifyAnthropicKey(key: string): Promise<{ ok: boolean; message: string | null }> {
  try {
    await new Anthropic({ apiKey: key }).models.list({ limit: 1 });
    return { ok: true, message: null };
  } catch (err) {
    // The SDK's message names the status and the reason ("401 authentication_error: invalid
    // x-api-key"), which is what the user needs, and never contains the key itself.
    return { ok: false, message: (err as Error)?.message ?? String(err) };
  }
}

export function summarizeUsage(u: {
  input_tokens: number;
  output_tokens: number;
  cache_read_input_tokens?: number | null;
  cache_creation_input_tokens?: number | null;
}): UsageSummary {
  const cacheRead = u.cache_read_input_tokens ?? 0;
  const cacheWrite = u.cache_creation_input_tokens ?? 0;
  return {
    input_tokens: u.input_tokens,
    output_tokens: u.output_tokens,
    cache_read_input_tokens: cacheRead,
    cache_creation_input_tokens: cacheWrite,
    // The Anthropic SDK already reports `input_tokens` EXCLUSIVE of the cached counts
    // (unlike LangChain, which folds them in), so it maps straight onto the uncached slot.
    cost_usd:
      costFor(GENERATION_MODEL, {
        inputTokens: u.input_tokens,
        outputTokens: u.output_tokens,
        cacheReadTokens: cacheRead,
        cacheWriteTokens: cacheWrite,
      }) ?? 0,
  };
}

export function emptyUsage(): UsageSummary {
  return {
    input_tokens: 0, output_tokens: 0,
    cache_read_input_tokens: 0, cache_creation_input_tokens: 0, cost_usd: 0,
  };
}
