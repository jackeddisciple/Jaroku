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

export function anthropicClient(): Anthropic {
  if (!client) {
    const key = process.env.ANTHROPIC_API_KEY;
    if (!key) throw new Error("ANTHROPIC_API_KEY is not set (expected in runtime/.env)");
    client = new Anthropic({ apiKey: key });
  }
  return client;
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
