// The OpenAI-compatible transport, for the chat route's non-Anthropic providers.
//
// WHY THIS FILE EXISTS. Jaroku's own thinking has been Anthropic-only since it had any — planning,
// generation, the fix loop, explain and the judge all go through `claude.ts`, and `providers.ts`
// says so in as many words. The composer's model selector now offers a provider for "talking to
// Jaroku" as well as for the agent's runs, so one of those calls has to be able to reach somewhere
// else. This is that somewhere.
//
// ONE ENGINE, TWO TRANSPORTS — AND THIS IS NOT THE ENGINE. `streamExplain` is the answering engine:
// it owns the key resolution, the raw-context degradation, the fixture, the fault injection, the
// usage report that arrives before `onDone`, and the error path that still hands back the facts.
// What differs between providers is how bytes arrive, so that is all this file does. §5's
// instruction — do not write a second streaming hook — is about exactly this shape of temptation.
//
// CHAT COMPLETIONS RATHER THAN RESPONSES, WHICH IS A DEPARTURE FROM THE RUN PATH AND DELIBERATE.
// `runtime/jaroku_runner/models.py` asks for the Responses API for every OpenAI model and says why:
// "GPT-6 Astra answers on Chat Completions but calls tools only through Responses, and every
// generated agent binds tools." The chat route binds NO tools — §2.2 is that it can never call one —
// so Chat Completions is the right endpoint here, and it is the one Meta is compatible with. Two
// endpoints for two different jobs rather than one endpoint forced on both.
//
// AND META IS NOT A THIRD CLIENT. `providers.ts` already records how it is reached: Muse Spark is
// "the OpenAI client pointed at Meta's address", key as a Bearer token. One transport, two base
// URLs, and `models.py` has done it this way since v0.1.9.
//
//   npm run test:openai-chat

import { PROVIDER_ENV_KEY, type ProviderId } from "./providers.ts";

/**
 * Where each provider's OpenAI-compatible API lives.
 *
 * META'S IS BYTE-IDENTICAL TO `models.py`'s `META_BASE_URL`, and confirmed against Meta's own
 * documentation: the Model API is "drop-in compatible with the OpenAI SDK", Chat Completions, Bearer
 * token. Their examples name the variable `MODEL_API_KEY`; this codebase deliberately uses
 * `META_API_KEY` and `providers.ts` explains why — "in a product with three providers it names
 * none of them".
 *
 * ANTHROPIC IS ABSENT ON PURPOSE. It has its own SDK, its own streaming shape and its own cache
 * accounting, and `claude.ts` is where that lives. A base URL for it here would invite somebody to
 * route a Claude call through this file and lose the cached-token counts §10 prices apart.
 */
export const OPENAI_COMPATIBLE_BASE: Partial<Record<ProviderId, string>> = {
  openai: "https://api.openai.com/v1",
  meta: "https://api.meta.ai/v1",
};

/** Whether this provider answers on the shape above. Anthropic does not — see `claude.ts`. */
export function isOpenAiCompatible(provider: string): provider is ProviderId {
  return provider in OPENAI_COMPATIBLE_BASE;
}

/** The environment variable holding this provider's key. One name, from the one table. */
export function keyNameFor(provider: ProviderId): string {
  return PROVIDER_ENV_KEY[provider];
}

/** What one call consumed, in the shape `ExplainUsage` uses — see `streamOpenAiChat`. */
export interface OpenAiUsage {
  model: string;
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}

export interface OpenAiChatRequest {
  provider: ProviderId;
  model: string;
  /** The key, already resolved by the caller. Used once to build a header and never logged. */
  apiKey: string;
  system: string;
  /** The conversation, oldest first, ending with the question. */
  messages: readonly { role: "user" | "assistant"; content: string }[];
  maxTokens: number;
  /** Aborts the request. The caller's Stop control (§6.1) resolves to this. */
  signal?: AbortSignal;
}

export interface OpenAiChatCallbacks {
  onDelta: (text: string) => void;
  onUsage: (usage: OpenAiUsage) => void;
}

/**
 * Stream one Chat Completions call, delta by delta.
 *
 * `stream_options: { include_usage: true }` IS NOT OPTIONAL FOR US. Without it a streamed completion
 * reports no token counts at all — so §10's cost line would be permanently unknown on every
 * non-Anthropic chat turn, which is honest and useless, and avoidable with one request field.
 *
 * IT THROWS RATHER THAN REPORTING. Every failure here becomes a thrown error carrying the status and
 * the body, because that is what §7's classifier reads — `classifyProviderFailure` wants the status
 * and the `retry-after` header, not a sentence somebody composed. The engine catches it and the
 * classifier names it.
 *
 * PARTIAL OUTPUT SURVIVES A MID-STREAM FAILURE, because the deltas have already been handed over by
 * the time one can happen. §7.3: "if 200 tokens arrived before a mid-stream 5xx, those 200 tokens
 * stay." Nothing here buffers the answer to hand over at the end.
 */
export async function streamOpenAiChat(
  req: OpenAiChatRequest,
  cb: OpenAiChatCallbacks,
): Promise<void> {
  const base = OPENAI_COMPATIBLE_BASE[req.provider];
  if (!base) throw new Error(`${req.provider} has no OpenAI-compatible endpoint`);

  const res = await fetch(`${base}/chat/completions`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      // BEARER, FOR BOTH. Meta's Model API takes the key the same way OpenAI's does, which is the
      // whole of what "drop-in compatible" buys here.
      authorization: `Bearer ${req.apiKey}`,
    },
    ...(req.signal ? { signal: req.signal } : {}),
    body: JSON.stringify({
      model: req.model,
      max_tokens: req.maxTokens,
      stream: true,
      // See the header: without this a streamed completion reports no usage, and §10's figure would
      // be unknown on every turn rather than only on an unpriced model.
      stream_options: { include_usage: true },
      // THE SYSTEM PROMPT AS A MESSAGE, which is this API's shape — Anthropic takes it as its own
      // field. `prompt.ts` still owns every word of it; only the envelope differs.
      messages: [{ role: "system", content: req.system }, ...req.messages],
    }),
  });

  if (!res.ok) {
    // THE STATUS AND THE HEADER TRAVEL WITH THE ERROR, because §7's classifier reads fields rather
    // than prose: a 429 without its `retry-after` is a countdown with no number, and a body parsed
    // into a sentence is a body whose status has been thrown away.
    const body = await res.text().catch(() => "");
    throw Object.assign(new Error(`${res.status} ${body.slice(0, 600)}`), {
      status: res.status,
      headers: { "retry-after": res.headers.get("retry-after") ?? undefined },
    });
  }
  if (!res.body) throw new Error(`${req.provider} returned no body`);

  const reader = res.body.getReader();
  const decode = new TextDecoder();
  let buffer = "";
  let usage: OpenAiUsage | null = null;

  // SSE, PARSED BY HAND AND DELIBERATELY. The frames are `data: <json>` separated by blank lines and
  // terminated by `data: [DONE]`; a library for that would be a dependency for twenty lines, and the
  // twenty lines are the part somebody has to be able to read when a provider sends something
  // unexpected. The same argument this codebase's event transport already makes about delimiters.
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decode.decode(value, { stream: true });
    // SPLIT ON THE FRAME BOUNDARY, keeping the remainder — a frame can arrive across two chunks, and
    // parsing a half one is how a stream loses a token at every buffer edge.
    const frames = buffer.split("\n\n");
    buffer = frames.pop() ?? "";
    for (const frame of frames) {
      for (const line of frame.split("\n")) {
        if (!line.startsWith("data:")) continue;
        const payload = line.slice(5).trim();
        if (!payload || payload === "[DONE]") continue;
        let parsed: {
          choices?: { delta?: { content?: string | null } }[];
          usage?: {
            prompt_tokens?: number; completion_tokens?: number;
            prompt_tokens_details?: { cached_tokens?: number };
          };
        };
        try {
          parsed = JSON.parse(payload);
        } catch {
          // A FRAME THAT IS NOT JSON IS SKIPPED RATHER THAN FATAL. §16 attacks "a provider
          // returning malformed JSON", and the honest behaviour is that one bad frame costs one
          // frame: the answer so far stays on screen, and a stream that is entirely malformed ends
          // with no text and is classified by §7 like any other empty answer. Taking down a
          // finished answer because its last frame was mangled would be the worse outcome.
          continue;
        }
        const text = parsed.choices?.[0]?.delta?.content;
        if (typeof text === "string" && text.length > 0) cb.onDelta(text);
        if (parsed.usage) {
          const cached = parsed.usage.prompt_tokens_details?.cached_tokens ?? 0;
          usage = {
            model: req.model,
            // UNCACHED INPUT ONLY, because that is what `costFor` prices in its `inputTokens` slot
            // and what Anthropic's SDK already reports there. OpenAI's `prompt_tokens` INCLUDES the
            // cached ones — LangChain folds them in the same way and `pricing.ts`'s header names
            // that difference — so handing the total over would charge cache reads at the full
            // input rate and overstate cost by up to 10x on a long conversation.
            input: Math.max(0, (parsed.usage.prompt_tokens ?? 0) - cached),
            output: parsed.usage.completion_tokens ?? 0,
            cacheRead: cached,
            // NO CACHE-WRITE COUNT ON THIS SHAPE. These APIs cache implicitly and report no
            // creation figure, so it is 0 rather than a guess — and `costFor` multiplies 0 by the
            // write rate to nothing, which is the honest arithmetic for a number nobody reported.
            cacheWrite: 0,
          };
        }
      }
    }
  }

  // REPORTED ONCE, AT THE END, and only if the provider sent it. `streamExplain`'s contract is that
  // `onUsage` fires when a model was actually asked and not otherwise — a zeroed report would be a
  // charge of nothing where "we were not told" is the truth.
  if (usage) cb.onUsage(usage);
}
